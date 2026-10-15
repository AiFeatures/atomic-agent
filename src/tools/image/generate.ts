import { constants as fsConstants } from "node:fs";
import { copyFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { compressToolResult, type CompressedToolResult } from "../../compressor/result-compressor.js";
import { requireApproval, type DangerousToolOptions } from "../../approval/dangerous-tool.js";
import type { ImageGeneratedContext } from "../../analytics/analytics-events.js";
import {
  configureCoreDiffusion,
  CoreImageError,
  defaultImageModel,
  listCoreImageModels,
  registerOpenRouterMedia,
  runCoreImageJob,
  withImageCore,
  type CoreImageJob,
  type CoreImageOutput,
  type CoreImageRequest,
  type CoreMediaModel,
} from "../../local-llm/core/core-image.js";
import type { ToolDefinition } from "../tool-registry.js";

export const IMAGE_GENERATE_TOOL = "image.generate";
export const IMAGE_COUNT_MAX = 4;
const PROMPT_MAX_CHARS = 4_000;

/**
 * Aspect ratios the tool takes, with the pixel size a local model draws
 * for each (about one megapixel, multiples of 64). A cloud model gets
 * the ratio itself; its catalog decides the pixels.
 */
const RATIOS: Readonly<Record<string, readonly [number, number]>> = {
  "1:1": [1024, 1024],
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};
const SIZE_WORDS: Readonly<Record<string, string>> = {
  square: "1:1", landscape: "16:9", wide: "16:9", portrait: "9:16", tall: "9:16",
};

/**
 * Sampler settings for a local job until the local model catalog
 * (ATO-411) supplies each model's own: the turbo distillations the
 * catalog defaults to want few steps and no guidance. A cloud job
 * ignores them, but Core requires the fields.
 */
const LOCAL_STEPS = 8;
const LOCAL_CFG_SCALE = 1;

export interface ImageGenerateToolOptions extends DangerousToolOptions {
  /** `config.paths.localModelsDataDir`, read per call. */
  dataDir: () => string;
  /** The user's OpenRouter key, read per call; undefined when none is set. */
  openRouterKey: () => string | undefined;
  /** One shape-only analytics record per call (`captureImageGenerated`). */
  report?: (event: ImageGeneratedContext) => void;
  /** Test seam. */
  withCore?: typeof withImageCore;
  now?: () => Date;
}

interface ParsedArgs {
  prompt: string;
  ratio: string;
  count: number;
  seed?: number;
  model?: string;
  local: boolean;
}

function parseArgs(raw: Record<string, unknown>): ParsedArgs {
  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (prompt.length === 0) throw new Error("`prompt` must be a non-empty string describing the picture");
  if (prompt.length > PROMPT_MAX_CHARS) throw new Error(`\`prompt\` is longer than ${PROMPT_MAX_CHARS} characters; shorten it`);

  let ratio = "1:1";
  if (raw.size !== undefined && raw.size !== null && raw.size !== "") {
    if (typeof raw.size !== "string") throw new Error("`size` must be a string such as \"square\", \"landscape\", \"portrait\" or \"16:9\"");
    const word = raw.size.trim().toLowerCase();
    ratio = SIZE_WORDS[word] ?? word;
    if (!(ratio in RATIOS)) {
      throw new Error(`\`size\` "${raw.size}" is not supported; use square, landscape, portrait or one of ${Object.keys(RATIOS).join(", ")}`);
    }
  }

  let count = 1;
  if (raw.count !== undefined && raw.count !== null) {
    if (typeof raw.count !== "number" || !Number.isInteger(raw.count) || raw.count < 1 || raw.count > IMAGE_COUNT_MAX) {
      throw new Error(`\`count\` must be a whole number from 1 to ${IMAGE_COUNT_MAX}`);
    }
    count = raw.count;
  }

  let seed: number | undefined;
  if (raw.seed !== undefined && raw.seed !== null) {
    if (typeof raw.seed !== "number" || !Number.isSafeInteger(raw.seed) || raw.seed < 0 || raw.seed > 0xffff_ffff) {
      throw new Error("`seed` must be a whole number from 0 to 4294967295");
    }
    seed = raw.seed;
  }

  let model: string | undefined;
  let local = false;
  if (typeof raw.model === "string" && raw.model.trim().length > 0) {
    const name = raw.model.trim();
    if (name.toLowerCase() === "local") local = true;
    else if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)) throw new Error(`\`model\` "${name}" is not a model id such as google/gemini-nano-banana-2.1`);
    else model = name;
  } else if (raw.model !== undefined && raw.model !== null && raw.model !== "") {
    throw new Error("`model` must be a string");
  }

  return { prompt, ratio, count, ...(seed !== undefined ? { seed } : {}), ...(model ? { model } : {}), local };
}

/** `image-20261015-142233.png`, `image-20261015-142233-2.png`, never an existing file. */
async function saveIntoWorkingDir(outputs: readonly CoreImageOutput[], workingDir: string, now: Date): Promise<string[]> {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const saved: string[] = [];
  let n = 0;
  for (const output of outputs) {
    const ext = /^\.(png|jpe?g|webp)$/i.test(extname(output.path)) ? extname(output.path).toLowerCase() : ".png";
    for (let attempt = 0; ; attempt++) {
      n += 1;
      const name = n === 1 && attempt === 0 ? `image-${stamp}${ext}` : `image-${stamp}-${n}${ext}`;
      const dest = join(workingDir, name);
      try {
        await copyFile(output.path, dest, fsConstants.COPYFILE_EXCL);
        saved.push(dest);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 50) throw err;
      }
    }
  }
  return saved;
}

/**
 * Jobs for `count` pictures on a cloud model: one job when the model
 * draws that many at once (`params.n.max`), else one job per picture
 * (Core runs up to 4 cloud jobs at a time).
 */
export function cloudBatches(count: number, model: CoreMediaModel | undefined): number[] {
  const nMax = model?.params?.n?.max ?? 1;
  return count <= nMax ? [count] : Array.from({ length: count }, () => 1);
}

/** The ratio when the model takes it; undefined (the model's default) when its catalog lists others only. */
export function cloudAspectRatio(ratio: string, model: CoreMediaModel | undefined): string | undefined {
  const values = model?.params?.aspect_ratios?.values;
  if (!values || values.length === 0) return ratio;
  return values.includes(ratio) ? ratio : undefined;
}

function plural(count: number): string { return count === 1 ? "1 image" : `${count} images`; }

/**
 * `image.generate { prompt, size?, count?, seed?, model? }` — draw
 * pictures through Atomic Chat Core and save them as files in the
 * session's working folder. The agent shows them by passing the paths
 * to `reply { attachments }`.
 *
 * With an OpenRouter key the picture is made in the cloud (paid, so it
 * asks for approval below approval level 3); `model: "local"`, or no
 * key, uses the image model loaded in Core on this computer (free, no
 * question). The first image on a computer without Core downloads the
 * Core binary once.
 */
export function buildImageGenerateTool(options: ImageGenerateToolOptions): ToolDefinition {
  const withCore = options.withCore ?? withImageCore;
  const now = options.now ?? (() => new Date());
  return {
    name: IMAGE_GENERATE_TOOL,
    description: "Generate pictures from a text prompt and save them as PNG files in the working folder. Show them to the user by passing the returned paths to reply.attachments.",
    readonly: false,
    async run(rawArgs, ctx): Promise<CompressedToolResult> {
      let args: ParsedArgs;
      try { args = parseArgs(rawArgs); }
      catch (err) { return errorResult((err as Error).message); }

      const key = args.local ? undefined : options.openRouterKey();
      const cloud = key !== undefined;
      if (args.model && !cloud) {
        return errorResult(`Cloud model ${args.model} needs an OpenRouter API key. Add one in the provider settings, or call again without \`model\` to use a local image model.`);
      }

      if (cloud) {
        await requireApproval(options, {
          sessionId: ctx.sessionId,
          tool: IMAGE_GENERATE_TOOL,
          category: "paid_generation",
          reason: `generate ${plural(args.count)} on OpenRouter with ${args.model ?? "the default image model"} (paid by the OpenRouter account)`,
          preview: args.prompt,
          affectedResources: ["openrouter.ai"],
        }, ctx.signal);
      }

      const started = Date.now();
      let modelId = cloud ? (args.model ?? "default") : "local";
      const report = (success: boolean, count: number, errorCode?: string) => options.report?.({
        kind: cloud ? "cloud" : "local", model: modelId, durationMs: Date.now() - started, success, count,
        ...(errorCode !== undefined ? { errorCode } : {}),
      });

      try {
        const result = await withCore(options.dataDir(), async (client, dataFolder) => {
          const [width, height] = RATIOS[args.ratio]!;
          const base: CoreImageRequest = {
            prompt: args.prompt, width, height, steps: LOCAL_STEPS, cfgScale: LOCAL_CFG_SCALE, batchSize: args.count,
            ...(args.seed !== undefined ? { seed: args.seed } : {}),
          };
          if (key === undefined) {
            await configureCoreDiffusion(client, dataFolder, ctx.signal);
            const job = await runCoreImageJob(client, base, { signal: ctx.signal });
            return { jobs: [job], notes: [] as string[] };
          }
          await registerOpenRouterMedia(client, key, ctx.signal);
          const models = await listCoreImageModels(client, "openrouter", ctx.signal);
          modelId = args.model ?? defaultImageModel(models);
          const info = models.find(m => m.id === modelId);
          const notes: string[] = [];
          const aspectRatio = cloudAspectRatio(args.ratio, info);
          if (aspectRatio === undefined) notes.push(`${modelId} does not offer ${args.ratio}, so it used its default shape.`);
          const request: CoreImageRequest = {
            ...base,
            target: { provider: "openrouter", model: modelId },
            ...(aspectRatio ? { remote: { aspectRatio } } : {}),
          };
          const settled = await Promise.allSettled(cloudBatches(args.count, info).map(batchSize =>
            runCoreImageJob(client, { ...request, batchSize }, { signal: ctx.signal })));
          const jobs = settled.flatMap(s => s.status === "fulfilled" ? [s.value] : []);
          const failed = settled.flatMap(s => s.status === "rejected" ? [s.reason as unknown] : []);
          if (jobs.length === 0) throw failed[0];
          if (failed.length > 0) notes.push(`${failed.length} of the ${settled.length} requests failed: ${(failed[0] as Error).message}`);
          return { jobs, notes };
        }, { signal: ctx.signal });

        const outputs = result.jobs.flatMap((job: CoreImageJob) => job.outputs);
        const paths = await saveIntoWorkingDir(outputs, ctx.workingDir, now());
        report(true, paths.length);
        const lines = [
          `Saved ${plural(paths.length)} made with ${cloud ? `${modelId} on OpenRouter` : "the local image model"}:`,
          ...paths.map(p => `- ${p}`),
          ...result.notes,
          `To show ${paths.length === 1 ? "it" : "them"} to the user, pass ${paths.length === 1 ? "this path" : "these paths"} in reply.attachments.`,
        ];
        return compressToolResult({
          tool: IMAGE_GENERATE_TOOL,
          status: "ok",
          output: lines.join("\n"),
          details: {
            paths,
            kind: cloud ? "cloud" : "local",
            model: modelId,
            durationMs: Date.now() - started,
            images: outputs.map(o => ({ width: o.width, height: o.height, bytes: o.sizeBytes })),
          },
        }, { maxSummaryLength: 2_000, maxTailLines: Number.MAX_SAFE_INTEGER });
      } catch (err) {
        if (ctx.signal.aborted) { report(false, 0, "cancelled"); throw err; }
        const code = err instanceof CoreImageError ? err.code : (err as { reasonCode?: unknown })?.reasonCode;
        report(false, 0, typeof code === "string" ? code : "unknown");
        return errorResult(err instanceof Error ? err.message : String(err), {
          kind: cloud ? "cloud" : "local", model: modelId,
          ...(err instanceof CoreImageError ? { code: err.code } : {}),
        });
      }
    },
  };
}

function errorResult(message: string, details?: Record<string, unknown>): CompressedToolResult {
  return compressToolResult({
    tool: IMAGE_GENERATE_TOOL,
    status: "error",
    output: `image.generate: ${message}`,
    ...(details ? { details } : {}),
  });
}
