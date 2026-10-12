import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../local-llm/engine-selection.js", () => ({
  // The real guard probes ports and takes the engine lock; only its persist step matters here.
  selectManagedEngine: vi.fn(async (_dir: string, _chat: number, _emb: number, persist: () => void) => persist()),
}));
vi.mock("../persist-user-local-models-config.js", () => ({ persistUserLocalModelsConfig: vi.fn() }));

import { resetConfigCache } from "../../config/index.js";
import { persistUserLocalModelsConfig } from "../persist-user-local-models-config.js";
import { LocalModelsOrchestrator } from "./local-models-orchestrator.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "local-models-engine-"));
  process.env.ATOMIC_AGENT_STATE_DIR = stateDir;
  resetConfigCache();
  vi.mocked(persistUserLocalModelsConfig).mockReset();
});
afterEach(() => {
  delete process.env.ATOMIC_AGENT_STATE_DIR;
  resetConfigCache();
  rmSync(stateDir, { recursive: true, force: true });
});

function orchestratorWithSlowStart() {
  const orchestrator = new LocalModelsOrchestrator({ emit() {}, subscribe: () => () => {} });
  const internals = orchestrator as unknown as {
    startDaemonNow: () => Promise<boolean>; stopDaemonNow: () => Promise<void>; refresh: () => Promise<void>;
  };
  let finishStart!: (ok: boolean) => void;
  vi.spyOn(internals, "startDaemonNow").mockImplementation(() => new Promise(resolve => { finishStart = resolve; }));
  vi.spyOn(internals, "stopDaemonNow").mockResolvedValue();
  vi.spyOn(internals, "refresh").mockResolvedValue();
  return { orchestrator, finishStart: (ok: boolean) => finishStart(ok) };
}

it("saves an engine choice queued behind a loading model once the load ends", async () => {
  const { orchestrator, finishStart } = orchestratorWithSlowStart();
  const starting = orchestrator.startDaemon();
  const choosing = orchestrator.chooseEngine("atomic-core");
  await Promise.resolve();
  finishStart(true);
  await starting;
  await expect(choosing).resolves.toBe(true);
  expect(persistUserLocalModelsConfig).toHaveBeenCalledWith({ managed: { engine: "atomic-core" } });
});

it("Stop cancels an engine choice still queued behind the load it stops", async () => {
  const { orchestrator, finishStart } = orchestratorWithSlowStart();
  const starting = orchestrator.startDaemon();
  const choosing = orchestrator.chooseEngine("atomic-core");
  const stopping = orchestrator.stopDaemon();
  finishStart(false);
  await Promise.all([starting, stopping]);
  await expect(choosing).resolves.toBe(false);
  expect(persistUserLocalModelsConfig).not.toHaveBeenCalled();
});
