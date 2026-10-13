import type { ToolCardEntry } from "../tui-state.js";

/**
 * One plain-language line saying what a turn's tool calls did, e.g.
 * `read 3 files, edited 1 file, ran 2 commands · 1 failed`.
 *
 * Computed from the cards alone: no model call, no I/O, so it costs
 * nothing per frame and a reloaded chat shows the same line it did live.
 * The tool cards above it already carry the detail; this is the gist a
 * reader skims before the reply.
 *
 * Returns `null` when there is nothing worth a line: fewer than
 * {@link MIN_ANNOTATED_CARDS} cards would only repeat the card itself.
 * `ChatLog` and `estimateMessageHeight` both ask this function, so the
 * row is either drawn and counted or neither.
 */
export function toolCardsAnnotation(
  cards: readonly Pick<ToolCardEntry, "tool" | "args" | "status">[],
): string | null {
  const counted = cards.filter((card) => !UNCOUNTED_TOOLS.has(card.tool));
  if (counted.length < MIN_ANNOTATED_CARDS) return null;

  const buckets = new Map<BucketId, Bucket>();
  let failed = 0;
  for (const card of counted) {
    if (card.status === "error") failed += 1;
    const id = bucketOf(card.tool);
    const bucket = buckets.get(id) ?? {
      calls: 0,
      paths: new Set<string>(),
      pathless: 0,
    };
    bucket.calls += 1;
    const path = card.args["path"];
    if (typeof path === "string" && path.length > 0) bucket.paths.add(path);
    else bucket.pathless += 1;
    buckets.set(id, bucket);
  }

  const parts: string[] = [];
  for (const id of BUCKET_ORDER) {
    const bucket = buckets.get(id);
    if (!bucket) continue;
    parts.push(PHRASES[id](countFor(id, bucket)));
  }
  const line = parts.join(", ");
  return failed > 0 ? `${line} · ${failed} failed` : line;
}

/**
 * A single call is already its own card; the annotation starts paying
 * for its row at two.
 */
export const MIN_ANNOTATED_CARDS = 2;

/**
 * Terminal tools: `reply` is the bubble below, `finish` ends the
 * session. Neither is something the agent "did" on the way.
 */
const UNCOUNTED_TOOLS: ReadonlySet<string> = new Set(["reply", "finish"]);

type BucketId =
  | "read"
  | "search"
  | "edit"
  | "shell"
  | "git"
  | "web"
  | "memory"
  | "other";

interface Bucket {
  calls: number;
  /** Distinct `args.path` values, so re-reading one file reads as one. */
  paths: Set<string>;
  /** Calls that named no single path (a multi-file patch, say). */
  pathless: number;
}

const BUCKET_ORDER: readonly BucketId[] = [
  "read",
  "search",
  "edit",
  "shell",
  "git",
  "web",
  "memory",
  "other",
];

const READ_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.read",
  "os.fs.read_document",
  "os.fs.archive.read_entry",
  "vision.describe",
]);

const SEARCH_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.list",
  "os.fs.glob",
  "os.fs.grep",
  "os.fs.locate_project",
  "os.fs.archive.list",
]);

const EDIT_TOOLS: ReadonlySet<string> = new Set([
  "os.fs.write",
  "os.fs.edit",
  "os.fs.patch",
  "os.fs.restore",
]);

function bucketOf(tool: string): BucketId {
  if (READ_TOOLS.has(tool)) return "read";
  if (SEARCH_TOOLS.has(tool)) return "search";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (tool === "os.shell.run") return "shell";
  if (tool.startsWith("os.git.")) return "git";
  if (
    tool.startsWith("browser.") ||
    tool.startsWith("web") ||
    tool === "os.http.request"
  ) {
    return "web";
  }
  if (tool.startsWith("memory.")) return "memory";
  return "other";
}

/**
 * Files are counted by distinct path, so reading one file three times
 * is "read 1 file"; a call that named no path counts as one more.
 * Everything else counts calls.
 */
function countFor(id: BucketId, bucket: Bucket): number {
  if (id !== "read" && id !== "edit") return bucket.calls;
  return bucket.paths.size + bucket.pathless;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const PHRASES: Record<BucketId, (n: number) => string> = {
  read: (n) => `read ${plural(n, "file", "files")}`,
  search: (n) => `ran ${plural(n, "search", "searches")}`,
  edit: (n) => `edited ${plural(n, "file", "files")}`,
  shell: (n) => `ran ${plural(n, "command", "commands")}`,
  git: (n) => `ran ${plural(n, "git command", "git commands")}`,
  web: (n) => plural(n, "web step", "web steps"),
  memory: (n) => plural(n, "memory call", "memory calls"),
  other: (n) => plural(n, "other tool call", "other tool calls"),
};
