import { describe, expect, it } from "vitest";
import type { ToolCardEntry } from "../tui-state.js";
import { toolCardsAnnotation } from "./tool-cards-annotation.js";

type Card = Pick<ToolCardEntry, "tool" | "args" | "status">;

function card(
  tool: string,
  args: Record<string, unknown> = {},
  status: Card["status"] = "ok",
): Card {
  return { tool, args, status };
}

describe("toolCardsAnnotation", () => {
  it("says nothing for zero or one call — the card already says it", () => {
    expect(toolCardsAnnotation([])).toBeNull();
    expect(toolCardsAnnotation([card("os.shell.run")])).toBeNull();
  });

  it("does not count the terminal reply / finish calls", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }),
        card("reply", { text: "done" }),
        card("finish"),
      ]),
    ).toBeNull();
  });

  it("groups calls into one line in a fixed order, whatever order they ran in", () => {
    const line = toolCardsAnnotation([
      card("os.shell.run", { command: "npm test" }),
      card("os.fs.edit", { path: "c.ts" }),
      card("os.fs.read", { path: "a.ts" }),
      card("os.shell.run", { command: "git status" }),
      card("os.fs.read", { path: "b.ts" }),
    ]);
    expect(line).toBe("read 2 files, edited 1 file, ran 2 commands");
  });

  it("counts files by distinct path, so a re-read is not a new file", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }),
        card("os.fs.read", { path: "a.ts" }),
        card("os.fs.read", { path: "a.ts" }),
      ]),
    ).toBe("read 1 file");
  });

  it("counts a call that names no path as one more file", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.patch", { patch: "--- a\n+++ b" }),
        card("os.fs.edit", { path: "x.ts" }),
      ]),
    ).toBe("edited 2 files");
  });

  it("names searches, git, web, memory and everything else", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.grep", { pattern: "foo" }),
        card("os.fs.glob", { pattern: "*.ts" }),
        card("os.git.status"),
        card("browser.navigate", { url: "https://example.com" }),
        card("os.http.request", { url: "https://example.com" }),
        card("memory.notes.recall", { query: "x" }),
        card("tasks.list"),
      ]),
    ).toBe(
      "ran 2 searches, ran 1 git command, 2 web steps, 1 memory call, 1 other tool call",
    );
  });

  it("appends the failures, counted across every kind", () => {
    expect(
      toolCardsAnnotation([
        card("os.fs.read", { path: "a.ts" }, "error"),
        card("os.shell.run", { command: "false" }, "error"),
        card("os.shell.run", { command: "true" }),
      ]),
    ).toBe("read 1 file, ran 2 commands · 2 failed");
  });
});
