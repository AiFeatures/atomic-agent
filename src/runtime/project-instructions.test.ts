import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { instructionImports, loadProjectInstructions } from "./project-instructions.js";

describe("cloud project instructions", () => {
  let base: string;
  let root: string;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), "project-rules-"))); root = join(base, "workspace"); mkdirSync(root); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  function put(path: string, text = path) { const target = join(root, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); }

  it.each([true, false])("finds all scopes within the boundary (Git=%s)", git => {
    if (git) execFileSync("git", ["init", "-q", root]);
    writeFileSync(join(base, "AGENTS.md"), "PARENT MUST NOT LOAD");
    for (const name of ["AGENTS.md", "AGENT.md", "CLAUDE.md", ".claude/CLAUDE.md", "src/AGENTS.md", "src/deep/.claude/CLAUDE.md", "node_modules/pkg/AGENTS.md", ".git/CLAUDE.md"]) put(name);
    const rules = loadProjectInstructions(root).instructions;
    expect(rules).toHaveLength(6);
    expect(rules.filter(r => r.scope === ".").map(r => r.priority)).toEqual([4, 3, 2, 1]);
    expect(rules.find(r => r.body === "src/deep/.claude/CLAUDE.md")?.scope).toBe("src/deep");
    expect(JSON.stringify(rules)).not.toContain("PARENT MUST NOT LOAD");
  });

  it("uses tracked and nonignored paths, including ignored root instructions", () => {
    execFileSync("git", ["init", "-q", root]);
    put(".gitignore", "AGENTS.md\nignored/\n");
    put("AGENTS.md"); put("ignored/CLAUDE.md"); put("tracked/AGENTS.md"); put("untracked/CLAUDE.md");
    execFileSync("git", ["-C", root, "add", "-f", "tracked/AGENTS.md"]);
    expect(loadProjectInstructions(root).instructions.map(r => r.body).sort()).toEqual(["AGENTS.md", "tracked/AGENTS.md", "untracked/CLAUDE.md"]);
  });

  it("expands relative imports once, reports cycles and skips external imports/symlinks", () => {
    put("CLAUDE.md", "@rules/a.md @rules/a.md @../missing.md @~/personal.md\n`@missing.md`\n```\n@missing.md\n```");
    put("rules/a.md", "@b.md\nFIRST"); put("rules/b.md", "@a.md\nSECOND");
    writeFileSync(join(base, "outside.md"), "OUTSIDE");
    symlinkSync(join(base, "outside.md"), join(root, "AGENT.md"));
    const result = loadProjectInstructions(root);
    expect(result.instructions).toHaveLength(3);
    expect(result.instructions.every(r => r.scope === ".")).toBe(true);
    expect(result.diagnostics.join("\n")).toMatch(/cycle/);
    expect(result.diagnostics.join("\n")).toMatch(/external/);
    expect(result.instructions.some(r => r.body === "OUTSIDE")).toBe(false);
  });

  it("does not expand imports in fences or inline code", () => {
    expect(instructionImports("@real.md `@no.md` ``@also-no.md``\n~~~md\n@no.md\n~~~\n(@last.md)")).toEqual(["real.md", "last.md"]);
  });

  it("does not expand imports in indented code blocks", () => {
    expect(instructionImports("Intro\n\n    @code.md\n\n    @still-code.md\nText @real.md\n- item\n    @continued.md")).toEqual(["real.md", "continued.md"]);
  });

  it("skips missing and directory imports with grouped, relative diagnostics", () => {
    const mentions = Array.from({ length: 8 }, (_, i) => `@user${i}`).join(" ");
    put("CLAUDE.md", `Ask @nadya, install @types/node, see @src for code. ${mentions}\nBODY`); mkdirSync(join(root, "src"));
    const result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body)).toHaveLength(1);
    const missing = result.diagnostics.filter(d => /missing instruction imports/.test(d));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatch(/and 5 more$/);
    expect(result.diagnostics.join("\n")).toMatch(/non-file instruction: src/);
    expect(result.diagnostics.join("\n")).not.toContain(base);
  });

  it("skips an imported file over the size limit without dropping other rules", () => {
    put("big.md", "x".repeat(1024 * 1024 + 1)); put("CLAUDE.md", "see @big.md"); put("AGENTS.md", "KEEP");
    const result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body).sort()).toEqual(["KEEP", "see @big.md"]);
    expect(result.diagnostics.join("\n")).toMatch(/unreadable instruction: big\.md/);
  });

  it("falls back to the walk when Git refuses the folder, skipping dependency trees", () => {
    const runGit = () => ({ status: 128, stdout: "", stderr: "fatal: detected dubious ownership in repository at '/x'\n" });
    put("nested/AGENTS.md"); put("dist/AGENTS.md"); put(".venv/lib/CLAUDE.md"); put("vendor/pkg/AGENTS.md");
    const result = loadProjectInstructions(root, undefined, { runGit });
    expect(result.instructions.map(r => r.body)).toEqual(["nested/AGENTS.md"]);
    expect(result.diagnostics.join("\n")).toMatch(/dubious ownership/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("skips unreadable directories in the walk", () => {
    put("AGENTS.md", "ROOT"); put("locked/AGENTS.md", "LOCKED"); chmodSync(join(root, "locked"), 0o000);
    try {
      const result = loadProjectInstructions(root);
      expect(result.instructions.map(r => r.body)).toEqual(["ROOT"]);
      expect(result.diagnostics.join("\n")).toMatch(/unreadable directories: locked/);
    } finally { chmodSync(join(root, "locked"), 0o755); }
  });

  it("stops the walk and the file/byte budgets with diagnostics instead of failing", () => {
    for (let i = 0; i < 6; i++) put(`d${i}/AGENTS.md`, `rule ${i}`);
    put("AGENTS.md", "ROOT");
    const capped = loadProjectInstructions(root, undefined, { maxEntries: 3 });
    expect(capped.instructions.map(r => r.body)).toContain("ROOT");
    expect(capped.diagnostics.join("\n")).toMatch(/stopped at 3 entries/);
    const files = loadProjectInstructions(root, undefined, { maxFiles: 2 });
    expect(files.instructions).toHaveLength(2);
    expect(files.instructions[0]?.body).toBe("ROOT");
    expect(files.diagnostics.join("\n")).toMatch(/exceed 2 files/);
    const sized = loadProjectInstructions(root, undefined, { maxBytes: 10 });
    expect(sized.instructions.map(r => r.body)).toEqual(["ROOT", "rule 0"]);
    expect(sized.diagnostics.join("\n")).toMatch(/exceed 10 bytes/);
  });

  it("skips deep imports, special files and oversized root files without throwing", () => {
    for (let i = 0; i < 5; i++) put(`rules/${i}.md`, `@${i + 1}.md`);
    put("rules/5.md", "last"); put("CLAUDE.md", "@rules/0.md");
    let result = loadProjectInstructions(root);
    expect(result.instructions.some(r => r.body === "last")).toBe(false);
    expect(result.diagnostics.join("\n")).toMatch(/four hops: rules\/4\.md/);
    put("CLAUDE.md", "x".repeat(1024 * 1024 + 1));
    rmSync(join(root, "AGENTS.md"), { force: true }); mkdirSync(join(root, "AGENTS.md")); put("AGENT.md", "STILL LOADED");
    result = loadProjectInstructions(root);
    expect(result.instructions.map(r => r.body)).toEqual(["STILL LOADED"]);
    expect(result.diagnostics.join("\n")).toMatch(/non-file instruction: AGENTS\.md/);
    expect(result.diagnostics.join("\n")).toMatch(/unreadable instruction: CLAUDE\.md/);
  });

  it("reports a missing workspace instead of throwing", () => {
    const result = loadProjectInstructions(join(base, "gone"));
    expect(result.instructions).toEqual([]);
    expect(result.diagnostics.join("\n")).toMatch(/unavailable/);
  });

  it("reflects edits and removals without a cache", () => {
    put("AGENTS.md", "first"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("first");
    put("AGENTS.md", "second"); expect(loadProjectInstructions(root).instructions[0]?.body).toBe("second");
    rmSync(join(root, "AGENTS.md")); expect(loadProjectInstructions(root).instructions).toEqual([]);
  });
});
