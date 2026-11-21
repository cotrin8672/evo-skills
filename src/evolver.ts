import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  type CreateAgentSessionOptions,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { Profile } from "./store.ts";

const limit = 48 * 1024;
const frontmatter = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m;
type Model = NonNullable<CreateAgentSessionOptions["model"]>;
export type WorkerOptions = { cwd: string; model: Model; modelRuntime: ModelRuntime; signal: AbortSignal; thinking?: Profile["thinking"]; outputTokens?: number; beforeModelCall?: () => Promise<void> };
export type Meter = { tokens: number; cost: number };
export const optimizer = () => readFile(new URL("./evolution/SKILL.md", import.meta.url), "utf8");

export async function readSkill(path: string): Promise<string> {
  if (basename(path) !== "SKILL.md") throw new Error("Choose a SKILL.md file.");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error("Expected a regular SKILL.md of at most 48 KiB.");
    const buffer = Buffer.alloc(limit + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > limit) throw new Error("SKILL.md exceeds 48 KiB.");
    const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, bytesRead));
    const header = frontmatter.exec(source);
    if (header?.index !== 0 || !header[0].endsWith("\n")) throw new Error("SKILL.md needs a YAML frontmatter block.");
    return source;
  } finally {
    await file.close();
  }
}

const schema = Type.Object({
  decision: Type.Union([Type.Literal("proposal"), Type.Literal("no_change"), Type.Literal("needs_evidence")]),
  baseRevision: Type.String(),
  evidenceIds: Type.Array(Type.String(), { maxItems: 12 }),
  rationale: Type.String({ minLength: 1, maxLength: 2_000 }),
  proposedSkillContent: Type.Optional(Type.String({ maxLength: limit })),
  expectedEffect: Type.Optional(Type.String({ maxLength: 1_000 })),
  suggestedChecks: Type.Optional(Type.Array(Type.String({ maxLength: 250 }), { maxItems: 5 })),
});
type Proposal = Static<typeof schema>;
export async function propose(instructions: string, base: string, source: string, evidence: { id: string; summary: string }[], options: WorkerOptions, meter: Meter) {
  let proposal: Proposal | undefined;
  const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
  await isolated(instructions,
    JSON.stringify({ baseRevision: base, evidenceIds: evidence.map(({ id }) => id) }), options, [
      defineTool({
        name: "read_evidence", label: "Read evidence", description: "Read one assigned observation by exact ID.",
        parameters: Type.Object({ id: Type.String() }),
        async execute(_id, { id }) {
          return result(evidence.find((item) => item.id === id)?.summary ?? "Unknown observation ID.");
        },
      }),
      defineTool({
        name: "read_skill_file", label: "Read snapshot", description: "Read the assigned immutable SKILL.md. Accepts no path.",
        parameters: Type.Object({}),
        async execute() { return result(source); },
      }),
      defineTool({
        name: "submit_proposal", label: "Submit proposal", description: "Submit exactly one decision about the assigned revision.",
        parameters: schema,
        async execute(_id, value) {
          if (proposal) return result("A decision has already been submitted.");
          if (value.baseRevision !== base || value.evidenceIds.some((id) => !evidence.some((item) => item.id === id)) ||
              (value.decision === "proposal" && (!value.evidenceIds.length || !value.proposedSkillContent?.trim() ||
                Buffer.byteLength(value.proposedSkillContent) > limit || value.proposedSkillContent.includes("\0"))))
            return result("Invalid basis, evidence, or replacement content.");
          proposal = value;
          return result("Decision recorded. End the turn without more calls.");
        },
      }),
    ], meter);
  if (!proposal) throw new Error("The model did not submit a valid decision.");
  return proposal;
}

export async function isolated(
  instructions: string, input: string, options: WorkerOptions,
  tools: NonNullable<CreateAgentSessionOptions["customTools"]> = [], meter?: Meter,
) {
  const { cwd, model, modelRuntime, signal } = options;
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
    model: options.outputTokens ? { ...model, maxTokens: Math.min(model.maxTokens, options.outputTokens) } : model,
    modelRuntime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ cacheWarming: "off", retry: { enabled: false } }),
    noTools: "all",
    tools: tools.map(({ name }) => name),
    customTools: tools,
    thinkingLevel: options.thinking,
  });
  const stop = () => { void session.abort().catch(() => {}); };
  if (options.beforeModelCall || options.outputTokens) {
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = async (chosen, context, request) => {
      await options.beforeModelCall?.();
      signal.throwIfAborted();
      return stream(chosen, context, options.outputTokens
        ? { ...request, maxTokens: Math.min(request?.maxTokens ?? chosen.maxTokens, options.outputTokens) }
        : request);
    };
  }
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    if (session.getActiveToolNames().sort().join() !== tools.map(({ name }) => name).sort().join())
      throw new Error("The worker has an unexpected tool set.");
    await session.prompt(input, { expandPromptTemplates: false });
    signal.throwIfAborted();
    const output = session.messages.at(-1);
    if (output?.role !== "assistant" || output.stopReason !== "stop") throw new Error("The improvement model did not finish normally.");
    return { text: session.getLastAssistantText() ?? "" };
  } finally {
    if (meter) for (const message of session.messages) if (message.role === "assistant") {
      meter.tokens += message.usage.totalTokens;
      meter.cost += message.usage.cost.total;
    }
    signal.removeEventListener("abort", stop);
    session.dispose();
  }
}
