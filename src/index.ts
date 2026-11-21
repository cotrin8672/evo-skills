import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type ExtensionAPI, getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { evolve, readSkill } from "./evolver.ts";

const command = "skill-evolution";

async function selectedModel(file: string): Promise<string | undefined> {
  const value = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  return value?.trim() || undefined;
}

export default function skillEvolution(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  const stateDir = join(agentDir, command);
  const modelFile = join(stateDir, "model");
  const modelRuntime = (signal?: AbortSignal) =>
    ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), signal });
  let job: AbortController | undefined;
  let status = "Idle";
  let closed = false;

  pi.on("session_shutdown", () => {
    closed = true;
    job?.abort();
  });
  pi.registerCommand(command, {
    description: "Choose an improvement model or propose a revision to a SKILL.md",
    async handler(input, ctx) {
      const [action] = input.trim().split(/\s+/, 1);
      const arg = input.trim().slice(action.length).trim();
      try {
        if (action === "model") {
          const current = await selectedModel(modelFile);
          const runtime = await modelRuntime();
          const choices = [...new Set(runtime.getAvailableSnapshot().map((model) => `${model.provider}/${model.id}`))].sort();
          if (!choices.length) throw new Error("No models are available in the standalone Pi model configuration.");
          const choice = arg || (await ctx.ui.select(`Improvement model${current ? ` (current: ${current})` : ""}`, choices));
          if (!choice) return;
          if (!choices.includes(choice)) throw new Error("Model is not available to the improvement session.");
          await mkdir(stateDir, { recursive: true });
          const temp = join(stateDir, `model-${randomUUID()}.tmp`);
          try {
            await writeFile(temp, choice + "\n", { flag: "wx", mode: 0o600 });
            await rename(temp, modelFile);
          } finally {
            await rm(temp, { force: true });
          }
          ctx.ui.notify(`Skill Evolution model: ${choice}`, "info");
          return;
        }
        if (action === "status") {
          ctx.ui.notify(`Skill Evolution · ${status} · model: ${(await selectedModel(modelFile)) ?? "not configured"}`, "info");
          return;
        }
        if (action !== "run" || !arg) {
          ctx.ui.notify("Usage: /skill-evolution model [provider/model-id] | run <path to SKILL.md> | status", "info");
          return;
        }
        if (job) throw new Error("An improvement is already running in this session.");
        const modelId = await selectedModel(modelFile);
        if (!modelId) throw new Error("Choose an improvement model with /skill-evolution model first.");
        const path = resolve(ctx.cwd, arg);
        const evidence = (await ctx.ui.input("What should improve? This note and the selected skill will be sent to the improvement model."))?.trim();
        if (!evidence) return;
        if (evidence.length > 4_000) throw new Error("Keep the observation under 4,000 characters.");
        if (job) throw new Error("An improvement is already running in this session.");

        const source = await readSkill(path);
        if (closed) return;
        if (job) throw new Error("An improvement is already running in this session.");
        const controller = new AbortController();
        job = controller;
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
        const ui = ctx.ui;
        const cwd = ctx.cwd;
        status = `Running with ${modelId}`;
        void (async () => {
          let pendingDir: string | undefined;
          try {
            ui.setStatus(command, `Skill Evolution: ${status}`);
            const runtime = await modelRuntime(signal);
            const model = runtime.getAvailableSnapshot().find((item) => `${item.provider}/${item.id}` === modelId);
            if (!model) {
              status = `Unavailable model: ${modelId}`;
              return;
            }
            const candidate = await evolve(source, evidence, { cwd, model, modelRuntime: runtime, signal });
            signal.throwIfAborted();
            if (!candidate) {
              status = "No change proposed";
              return;
            }
            const proposals = join(stateDir, "proposals");
            await mkdir(proposals, { recursive: true });
            pendingDir = await mkdtemp(join(proposals, ".pending-"));
            await writeFile(join(pendingDir, "before.md"), source, { mode: 0o600 });
            await writeFile(join(pendingDir, "after.md"), candidate, { mode: 0o600 });
            signal.throwIfAborted();
            const destination = join(proposals, randomUUID());
            await rename(pendingDir, destination);
            pendingDir = undefined;
            status = `Proposal: ${destination}`;
          } catch {
            status = signal.aborted ? "Interrupted or timed out" : "Failed to generate or save a valid proposal";
          } finally {
            if (pendingDir) await rm(pendingDir, { recursive: true, force: true }).catch(() => {});
            job = undefined;
            if (!controller.signal.aborted) ui.setStatus(command, `Skill Evolution: ${status}`);
          }
        })().catch(() => {});
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Skill Evolution failed", "warning");
      }
    },
  });
}
