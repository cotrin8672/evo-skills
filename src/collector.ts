import { resolve } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesSource, skillPath, visible } from "./registry.ts";
import { digest, enqueue, type Evidence, type Profile, type Store } from "./store.ts";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
const boundary = "evo-skills:boundary";
const isBoundary = (entry: Entry) => entry.type === "custom" &&
  (entry.customType === boundary || entry.customType === "pi-skill-evolution:boundary");
const text = (value: unknown, max = 1200) => typeof value === "string" ? value.slice(0, max)
  .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]+|github_pat_[\w]+|Bearer\s+[\w.-]+)\b/gi, "[redacted]")
  .replace(/((?:api[_-]?key|password|token|secret)\s*[=:]\s*)[^\s,;]+/gi, "$1[redacted]") : "";
const pathKey = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
function words(content: unknown) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((item) => item?.type === "text").map((item) => item.text).join("\n") : "";
}
export function materialize(entries: readonly Entry[], from?: string) {
  const start = from ? entries.findIndex((entry) => entry.id === from) + 1 : 0;
  return entries.slice(start).slice(-50).flatMap((entry) => {
    if (entry.type !== "message") return [];
    const m = entry.message;
    if (m.role === "user") return [{ type: "user request or correction", id: entry.id, text: text(words(m.content).replace(/^<skill [\s\S]*?<\/skill>\s*/i, "")) }];
    if (m.role === "assistant") return [
      ...m.content.flatMap((part) => part.type === "toolCall" ? [{ type: "operation", id: part.id, text: text(part.name, 100) }] : []),
      { type: m.stopReason === "error" || m.stopReason === "aborted" ? m.stopReason : "agent self-report", id: entry.id, text: text(words(m.content)) },
    ];
    if (m.role === "toolResult") return [{
      type: m.isError ? "tool error" : "tool result (not a success judgment)", id: entry.id,
      text: m.toolName === "read" ? "File content omitted" : text(words(m.content)),
    }];
    return [];
  }).slice(-30);
}
export function evidenceText(item: Evidence) {
  if (item.text) return item.text;
  if (!item.file) return "";
  const session = SessionManager.open(item.file);
  if (session.getSessionId() !== item.session || !session.getEntry(item.through)) throw new Error("Evidence history is no longer available.");
  const branch = session.getBranch(item.through);
  if (item.from && !branch.some((entry) => entry.id === item.from)) throw new Error("Evidence branch no longer matches.");
  return JSON.stringify(materialize(branch, item.from)).slice(0, 8000);
}

export function collect(store: Store, ctx: ExtensionContext, pin: Record<string, string>, target: Profile | undefined, aborted: boolean, append: (id: string) => void, previousLeaf?: string) {
  const branch = ctx.sessionManager.getBranch();
  const end = branch.at(-1);
  if (!end || isBoundary(end)) return;
  const index = branch.findLastIndex(isBoundary);
  const leafIndex = previousLeaf ? branch.findIndex((entry) => entry.id === previousLeaf) : -1;
  const latest = branch.slice(index + 1).filter((entry) => entry.type === "message");
  if (!latest.some((entry) => entry.message.role === "user")) return;

  const state = store.read();
  if (state.config.paused) return;
  const usage = new Map<string, { kind: string; entry: string }>();
  const paths = new Map<string, string>();
  for (const skill of Object.values(state.skills)) if (pin[skill.id] && visible(skill, ctx.cwd))
    paths.set(pathKey(skill.inPlace ? skill.original : skillPath(store.root, skill, pin[skill.id])), skill.id);
  const reads = new Map<string, { path: string; partial: boolean; index: number }>();
  const record = (id: string, kind: string, entry: Entry, at: number) => {
    if (state.skills[id].inPlace && (kind === "read failed" || at <= leafIndex || (previousLeaf && leafIndex < 0))) return;
    if (!usage.has(id) || kind !== "read failed") usage.set(id, { kind, entry: entry.id });
  };
  const scanFrom = Object.keys(pin).some((id) => !state.skills[id]?.inPlace) ? 0 : leafIndex + 1;
  for (let i = scanFrom; i < branch.length; i++) {
    const entry = branch[i];
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") {
      const hit = /^<skill name="[^"]+" location="([^"]+)">/.exec(words(m.content));
      const id = hit && paths.get(pathKey(hit[1]));
      if (id) record(id, "expanded /skill", entry, i);
    } else if (m.role === "assistant") {
      for (const part of m.content) if (part.type === "toolCall" && part.name === "read" && typeof part.arguments.path === "string")
        reads.set(part.id, { path: resolve(ctx.cwd, part.arguments.path), partial: part.arguments.offset !== undefined || part.arguments.limit !== undefined, index: i });
    } else if (m.role === "toolResult" && m.toolName === "read") {
      const input = reads.get(m.toolCallId);
      const id = input && paths.get(pathKey(input.path));
      if (id && input) {
        const kind = m.isError ? "read failed" : input.partial || !!(m.details as { truncation?: unknown } | undefined)?.truncation ? "partial read" : "read";
        record(id, kind, entry, input.index);
      }
    }
  }
  for (const id of usage.keys()) if (state.skills[id].inPlace && !matchesSource(store.root, state.skills[id])) usage.delete(id);
  if (!usage.size) return;
  const session = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  store.update((data) => {
    if (data.config.paused) return;
    for (const [skill, seen] of usage) {
      const inPlace = state.skills[skill].inPlace;
      const base = inPlace ? state.skills[skill].active : pin[skill];
      if (inPlace && data.skills[skill]?.active !== base) continue;
      const from = branch[inPlace ? leafIndex : index]?.id;
      const id = digest(JSON.stringify([session, end.id, skill, base, "v1"]));
      const previous = Object.values(data.evidence).findLast((item) => item.skill === skill && item.session === session &&
        branch.slice(0, (inPlace ? leafIndex : index) + 1).some((entry) => entry.id === item.through));
      enqueue(data, {
        id, skill, base, session, through: end.id, from, file, previous: previous?.id,
        usage: `${seen.kind} (${seen.entry}); does not establish effectiveness`, target, aborted, cwd: ctx.cwd,
        text: file ? undefined : JSON.stringify(materialize(branch, from)).slice(0, 8000),
      });
    }
  });
  append(boundary);
}
