import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const limit = 48 * 1024;
const frontmatter = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m;
type Model = NonNullable<CreateAgentSessionOptions["model"]>;

export async function readSkill(path: string): Promise<string> {
  if (basename(path) !== "SKILL.md") throw new Error("Choose a SKILL.md file.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Expected a regular SKILL.md of at most 48 KiB.");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("SKILL.md exceeds 48 KiB.");
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
    const header = frontmatter.exec(source);
    if (header?.index !== 0 || !header[0].endsWith("\n")) throw new Error("SKILL.md needs a YAML frontmatter block.");
    return source;
  } finally {
    await file.close();
  }
}

export function parseProposal(raw: string, source: string): string | undefined {
  if (Buffer.byteLength(raw) > 2 * limit) throw new Error("Model output is too large.");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || !("decision" in value)) throw new Error("Expected a proposal decision.");
  if (value.decision === "no_change") return;
  if (value.decision !== "proposal" || !("body" in value) || typeof value.body !== "string" || !value.body.trim() || value.body.includes("\0")) {
    throw new Error("Expected a non-empty replacement body.");
  }
  const header = frontmatter.exec(source);
  if (header?.index !== 0) throw new Error("Missing base frontmatter.");
  const body = value.body.trimEnd();
  const candidate = header[0] + body + "\n";
  if (Buffer.byteLength(candidate) > limit) throw new Error("Proposed SKILL.md exceeds 48 KiB.");
  if (source.slice(header[0].length).trimEnd() !== body) return candidate;
}

export async function evolve(
  source: string,
  evidence: string,
  options: { cwd: string; model: Model; modelRuntime: ModelRuntime; signal: AbortSignal },
): Promise<string | undefined> {
  const { cwd, model, modelRuntime, signal } = options;
  const instructions = await readFile(new URL("./evolution/SKILL.md", import.meta.url), "utf8");
  signal.throwIfAborted();
  const runtime = createExtensionRuntime();
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => instructions,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
  const { session } = await createAgentSession({
    cwd,
    model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
    noTools: "all",
    tools: [],
  });
  const stop = () => { void session.abort().catch(() => {}); };
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    if (session.getActiveToolNames().length) throw new Error("The worker must not have access to tools.");
    await session.prompt(JSON.stringify({ skill: source, evidence }), { expandPromptTemplates: false });
    signal.throwIfAborted();
    const output = session.messages.at(-1);
    if (output?.role !== "assistant" || output.stopReason !== "stop") throw new Error("The improvement model did not finish normally.");
    return parseProposal(session.getLastAssistantText() ?? "", source);
  } finally {
    signal.removeEventListener("abort", stop);
    session.dispose();
  }
}
