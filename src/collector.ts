import { resolve } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { skillPath, visible } from "./registry.ts";
import { digest, enqueue, type Evidence, type Profile, type Store } from "./store.ts";

type Entry = ReturnType<ExtensionContext["sessionManager"]["getBranch"]>[number];
const boundary = "pi-skill-evolution:boundary";
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

export function collect(store: Store, ctx: ExtensionContext, pin: Record<string, string>, target: Profile | undefined, aborted: boolean, append: (id: string) => void) {
  const branch = ctx.sessionManager.getBranch();
  const end = branch.at(-1);
  if (!end || (end.type === "custom" && end.customType === boundary)) return;
  const index = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === boundary);
  const latest = branch.slice(index + 1).filter((entry) => entry.type === "message");
  if (!latest.some((entry) => entry.message.role === "user")) return;

  const state = store.read();
  const usage = new Map<string, { kind: string; entry: string }>();
  const paths = new Map<string, string>();
  for (const skill of Object.values(state.skills)) if (pin[skill.id] && visible(skill, ctx.cwd))
    paths.set(pathKey(skillPath(store.root, skill, pin[skill.id])), skill.id);
  const reads = new Map<string, { path: string; partial: boolean }>();
  for (const entry of branch) {
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role === "user") {
      const hit = /^<skill name="[^"]+" location="([^"]+)">/.exec(words(m.content));
      const id = hit && paths.get(pathKey(hit[1]));
      if (id) usage.set(id, { kind: "expanded /skill", entry: entry.id });
    } else if (m.role === "assistant") {
      for (const part of m.content) if (part.type === "toolCall" && part.name === "read" && typeof part.arguments.path === "string")
        reads.set(part.id, { path: resolve(ctx.cwd, part.arguments.path), partial: part.arguments.offset !== undefined || part.arguments.limit !== undefined });
    } else if (m.role === "toolResult" && m.toolName === "read") {
      const input = reads.get(m.toolCallId);
      const id = input && paths.get(pathKey(input.path));
      if (id && input) {
        const kind = m.isError ? "read failed" : input.partial || !!(m.details as { truncation?: unknown } | undefined)?.truncation ? "partial read" : "read";
        if (!usage.has(id) || kind !== "read failed") usage.set(id, { kind, entry: entry.id });
      }
    }
  }
  if (!usage.size) return;
  const session = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  const from = branch[index]?.id;
  store.update((data) => {
    for (const [skill, seen] of usage) {
      const id = digest(JSON.stringify([session, end.id, skill, pin[skill], "v1"]));
      const previous = Object.values(data.evidence).findLast((item) => item.skill === skill && item.session === session &&
        branch.slice(0, index + 1).some((entry) => entry.id === item.through));
      enqueue(data, {
        id, skill, base: pin[skill], session, through: end.id, from, file, previous: previous?.id,
        usage: `${seen.kind} (${seen.entry}); does not establish effectiveness`, target, aborted, cwd: ctx.cwd,
        text: file ? undefined : JSON.stringify(materialize(branch, from)).slice(0, 8000),
      });
    }
  });
  append(boundary);
}
