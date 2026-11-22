import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { collect } from "./collector.ts";
import { adopt, discover, matchesSource, pins, rollback, skillInventory, skillPath, validateFiles, visible } from "./registry.ts";
import { createRuntime, modelKey, scheduler } from "./scheduler.ts";
import { digest, enqueue, leaseMs, Store, type Profile } from "./store.ts";
import { diffBody, parseChecks } from "./validation.ts";

const command = "evo-skills";
const subcommands = {
  status: "Show the queue, usage, and skill revisions",
  model: "Choose the improvement model",
  enable: "Opt in to automatic improvement of personal and project skills",
  checks: "Set evaluation fixtures",
  target: "Set the evaluation model",
  run: "Queue an improvement manually",
  pause: "Pause new jobs",
  resume: "Resume new jobs",
  budget: "Set a worker limit",
  diff: "Review a proposal and its evaluation",
  apply: "Adopt a held proposal",
  reevaluate: "Evaluate a held proposal again",
  rollback: "Restore an earlier revision",
};
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export default function evoSkills(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let store: Store | undefined;
  let runner: ReturnType<typeof scheduler> | undefined;
  let selected: Record<string, string> = {};
  let cwd = "";
  let activeInput = false;
  let previousLeaf: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inventoryTimer: ReturnType<typeof setInterval> | undefined;
  let refreshPending = false;
  const foreground = randomUUID();
  const availableModels = async () =>
    (await createRuntime(agentDir, AbortSignal.timeout(30_000))).getAvailableSnapshot();
  let modelSuggestions: { until: number; models: ReturnType<typeof availableModels> } | undefined;
  const profile = (ctx: ExtensionContext): Profile | undefined => ctx.model
    ? { id: modelKey(ctx.model), thinking: ctx.thinkingLevel as Profile["thinking"] } : undefined;
  const status = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.setStatus(command, `Evo Skills: ${message}`);
  };
  const isVisible = (skill: Parameters<typeof visible>[0]) => visible(skill, cwd) && (!skill.inPlace || !!selected[skill.id]);
  const markForeground = () => { store?.update((state) => { state.foreground[foreground] = Date.now() + leaseMs; }); };
  const clearForeground = () => {
    clearInterval(timer);
    timer = undefined;
    store?.update((state) => { delete state.foreground[foreground]; });
  };
  pi.on("session_start", async (event, ctx) => {
    cwd = await realpath(ctx.cwd).catch(() => ctx.cwd);
    const root = join(agentDir, command);
    const legacy = join(agentDir, "skill-evolution");
    // Existing sessions pin real file paths, so leave their store where it is.
    const db = store = new Store(!existsSync(root) && existsSync(legacy) ? legacy : root);
    const automatic = ctx.hasUI && db.read().config.automatic;
    const inventory = automatic ? skillInventory(agentDir, cwd, ctx.isProjectTrusted()) : undefined;
    const enrolled = automatic ? await discover(db, pi.getCommands(), cwd) : [];
    previousLeaf = ctx.sessionManager.getLeafId() ?? undefined;
    selected = db.update((data) => pins(data, ctx.sessionManager.getSessionId(), cwd,
      ctx.sessionManager.getSessionFile(), event.previousSessionFile, event.reason === "fork", enrolled));
    runner = scheduler(db, agentDir, (message, published) => {
      status(ctx, message);
      if (ctx.hasUI && published) ctx.ui.notify(`Evo Skills: Updated ${published.name}.${published.inPlace
        ? "" : " Available in new sessions."} Review: /evo-skills diff ${published.id}`, "info");
    }, createRuntime, isVisible);
    runner.wake();
    if (inventory !== undefined) {
      inventoryTimer = setInterval(() => {
        if (refreshPending || !ctx.isIdle() || ctx.hasPendingMessages()) return;
        try {
          if (skillInventory(agentDir, cwd, ctx.isProjectTrusted()) === inventory) return;
          refreshPending = true;
          // Pi only allows resource reloads from command context; dispatch without a model turn.
          pi.sendUserMessage(`/${command} _refresh ${foreground}`, { expandPromptTemplates: true });
        } catch {
          refreshPending = false;
          status(ctx, "Could not check for skill changes.");
        }
      }, 2_000);
      inventoryTimer.unref();
    }
  });
  pi.on("resources_discover", (_event, ctx) => {
    const data = store?.read();
    const ordinary = new Set(pi.getCommands().filter((cmd) => cmd.source === "skill").map((cmd) => cmd.name));
    const skillPaths = [];
    for (const [id, revision] of Object.entries(selected)) {
      const skill = data?.skills[id];
      if (!skill || skill.inPlace || !visible(skill, cwd)) continue;
      if (ordinary.has(`skill:${skill.name}`)) status(ctx, `Duplicate skill ${skill.name}; exclude its original and reload.`);
      else if (store) skillPaths.push(skillPath(store.root, skill, revision));
    }
    return { skillPaths };
  });
  pi.on("input", (event) => { if (event.source !== "extension") activeInput = true; });
  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI || timer) return;
    markForeground();
    timer = setInterval(() => { try { markForeground(); } catch { /* Lease expires on shutdown. */ } }, 5_000);
    timer.unref();
  });
  pi.on("session_tree", (_event, ctx) => {
    activeInput = false;
    previousLeaf = ctx.sessionManager.getLeafId() ?? undefined;
  });
  pi.on("agent_settled", (event, ctx) => {
    try {
      if (store && activeInput && ctx.hasUI && Object.keys(selected).length)
        collect(store, ctx, selected, profile(ctx), event.aborted, (type) => pi.appendEntry(type), previousLeaf);
    } catch {
      status(ctx, "Could not record skill usage");
    } finally {
      activeInput = false;
      previousLeaf = ctx.sessionManager.getLeafId() ?? undefined;
      clearForeground();
      runner?.wake();
    }
  });
  pi.on("session_shutdown", () => {
    clearInterval(inventoryTimer);
    try { clearForeground(); } finally {
      void runner?.close().catch(() => {});
      runner = undefined;
      store = undefined;
    }
  });
  pi.registerCommand(command, {
    description: "Track, evaluate, and improve skills using a separate model",
    async getArgumentCompletions(prefix) {
      const input = prefix.trimStart();
      const target = /^target\s+(\S*)$/.exec(input);
      const selection = /^(model\s+|target\s+\S+\s+)(\S*)(?:\s+(\S*))?$/.exec(input);
      const complete = (start: string, partial: string, choices: string[]) =>
        choices.filter((name) => name.toLowerCase().includes(partial.toLowerCase()))
          .map((name) => ({ value: start + name, label: name }));
      if (target) {
        const skills = Object.values(store?.read().skills ?? {}).filter(isVisible);
        return complete("target ", target[1], skills.map(({ name }) => name).sort());
      }
      if (selection) {
        if (!modelSuggestions || modelSuggestions.until <= Date.now()) {
          modelSuggestions = { until: Date.now() + 30_000, models: availableModels().catch(() => []) };
        }
        const models = await modelSuggestions.models;
        const [, start, id, effort] = selection;
        if (effort !== undefined) {
          const model = models.find((item) => modelKey(item) === id);
          return model ? getSupportedThinkingLevels(model)
            .filter((level) => level.startsWith(effort.toLowerCase()))
            .map((level) => ({ value: `${start}${id} ${level}`, label: level })) : null;
        }
        const choices = models.map(modelKey).sort();
        return complete(start, id, start.startsWith("target") ? ["origin", ...choices] : choices);
      }
      const items = Object.entries(subcommands)
        .filter(([name]) => name.startsWith(input))
        .map(([name, description]) => ({ value: name, label: name, description }));
      return items.length ? items : null;
    },
    async handler(input, ctx) {
      const [action] = input.trim().split(/\s+/, 1);
      const arg = input.trim().slice(action.length).trim();
      const [name, detail] = /^(\S+)(?:\s+([\s\S]+))?$/.exec(arg)?.slice(1) ?? [];
      try {
        if (!store) throw new Error("Evo Skills is not initialized.");
        const db = store;
        const state = db.read();
        const notify = (message: string) => ctx.ui.notify(message, "info");
        const find = () => {
          const skill = Object.values(state.skills).find((item) => item.name === name && isVisible(item));
          if (!skill) throw new Error(`Unknown managed skill: ${name ?? "(missing)"}`);
          return skill;
        };
        if (action === "_refresh" && arg === foreground) {
          try {
            if (ctx.isIdle() && !ctx.hasPendingMessages()) await ctx.reload();
          } finally {
            refreshPending = false;
          }
          return;
        } else if (action === "model") {
          const choices = (await availableModels()).map(modelKey).sort();
          if (!choices.length) throw new Error("No models available in Pi's standalone configuration.");
          const id = name || await ctx.ui.select("Evo Skills model", choices);
          if (!id) return;
          if (!choices.includes(id)) throw new Error("Model is not available to the improvement session.");
          const thinking = detail ? levels.find((value) => value === detail) : undefined;
          if (detail && !thinking) throw new Error(`Thinking level must be one of: ${levels.join(", ")}`);
          db.update((data) => { data.config.model = { id, thinking }; });
          notify(`Evo Skills model: ${id}`);
        } else if (action === "enable") {
          if (state.config.automatic) { notify("Automatic skill improvement is already enabled."); return; }
          if (!await ctx.ui.confirm("Enable automatic skill improvement?",
            "Evo Skills can send skill content and excerpts from future skill-using turns to the improvement model. Passing revisions can update personal and trusted project SKILL.md files.")) return;
          db.update((data) => { data.config.automatic = true; });
          notify("Automatic skill improvement enabled.");
          await ctx.reload();
          return;
        } else if (action === "checks") {
          const skill = find();
          if (!detail) throw new Error("Usage: checks <skill> <fixtures.json>");
          const raw = await readFile(resolve(cwd, detail), "utf8");
          if (raw.length > 64 * 1024) throw new Error("Fixtures exceed 64 KiB.");
          const checks = parseChecks(JSON.parse(raw));
          db.update((data) => { data.skills[skill.id].checks = checks; });
          notify(`${skill.name}: saved ${checks.length} evaluation cases for future jobs.`);
        } else if (action === "target") {
          const skill = find();
          const [id, level, extra] = (detail ?? "").split(/\s+/);
          const thinking = level ? levels.find((value) => value === level) : undefined;
          if (!id || extra || (level && !thinking)) throw new Error("Usage: target <skill> <provider/model-id|origin> [thinking]");
          if (id !== "origin" && !(await availableModels()).some((model) => modelKey(model) === id))
            throw new Error("The evaluation model is not available.");
          db.update((data) => { data.skills[skill.id].target = id === "origin" ? undefined : { id, thinking }; });
          notify(`${skill.name}: evaluation model ${id}.`);
        } else if (action === "run") {
          const skill = find();
          if (skill.inPlace && !matchesSource(db.root, skill)) throw new Error("Reload to pick up changes to this skill.");
          const text = (await ctx.ui.input("Observation (will be sent to the improvement model)"))?.trim();
          if (!text) return;
          if (text.length > 4_000) throw new Error("Observation exceeds 4,000 characters.");
          const id = digest(randomUUID());
          const job = db.update((data) => enqueue(data, {
            id, skill: skill.id, base: skill.inPlace ? skill.active : selected[skill.id] ?? skill.active, cwd, session: ctx.sessionManager.getSessionId(),
            through: id, usage: "explicitly requested improvement", text, target: profile(ctx),
          }, Date.now(), true));
          if (!job) throw new Error("This session is pinned to an older revision. Start a new session to improve the active version.");
          notify(`Queued ${skill.name}: ${job}`);
        } else if (action === "pause" || action === "resume") {
          db.update((data) => { data.config.paused = action === "pause"; });
          notify(action === "pause" ? "New Evo Skills jobs are paused." : "Evo Skills resumed.");
        } else if (action === "budget") {
          const keys = { jobsPerDay: [1, 100], callsPerJob: [1, 100], outputTokens: [128, 32768],
            timeoutMs: [1000, 3_600_000], idleMs: [0, 300_000], cooldownMs: [0, 86_400_000] } as const;
          if (!name || !Object.hasOwn(keys, name)) throw new Error(`Usage: budget <${Object.keys(keys).join("|")}> <integer>`);
          const key = name as keyof typeof keys;
          const [min, max] = keys[key], n = Number(detail);
          if (!detail || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Enter an integer from ${min} to ${max}.`);
          db.update((data) => { data.config[key] = n; });
          notify(`${key} = ${n}`);
        } else if (action === "diff" || action === "apply" || action === "reevaluate") {
          const job = name && Object.hasOwn(state.jobs, name) ? state.jobs[name] : undefined;
          const skill = job && state.skills[job.skill];
          if (!job?.candidate || !skill || !isVisible(skill)) throw new Error("No visible candidate for that job.");
          const path = skillPath(db.root, skill, job.candidate);
          if (action === "reevaluate") {
            db.update((data) => {
              const current = data.jobs[job.id];
              if (current.state !== "candidate" || data.skills[skill.id]?.active !== current.base)
                throw new Error("Only a held candidate based on the active revision can be evaluated again.");
              current.state = "queued";
              current.due = Date.now();
              current.checks = data.skills[skill.id].checks;
              current.target = data.skills[skill.id].target ?? current.target;
              current.calls = 0;
            });
            notify(`Queued evaluation for ${job.id}.`);
          } else if (action === "apply") {
            if (job.state !== "candidate") throw new Error("Only validated, held candidates can be applied.");
            await validateFiles(path, skill.name, await readFile(path, "utf8"));
            const applied = db.update((data) => {
              const current = data.jobs[job.id];
              return current.state === "candidate" && adopt(data, current, db.root, job.candidate!);
            });
            if (!applied) throw new Error(db.read().jobs[job.id].note ?? "The base revision changed; candidate not applied.");
            notify(`Updated ${skill.name}.${skill.inPlace ? "" : " Available in new sessions."}`);
          } else {
            const before = skillPath(db.root, skill, job.base);
            const details = `${job.state}: ${job.rationale ?? job.note ?? ""}\nEvidence: ${job.usedEvidence?.join(", ") ?? ""}\n${JSON.stringify(job.validation ?? {})}\n\nBefore: ${before}\nAfter: ${path}`;
            const [oldText, newText] = await Promise.all([readFile(before, "utf8"), readFile(path, "utf8")]);
            await ctx.ui.editor("Evo Skills comparison (review only)",
              `${details}\n\n${diffBody(oldText, newText)}`);
          }
        } else if (action === "rollback") {
          if (!detail) throw new Error("Usage: rollback <skill> <revision>");
          const skill = find();
          await rollback(db, skill, detail);
          notify(`Rolled back ${skill.name}.${skill.inPlace ? "" : " Available in new sessions."}`);
        } else if (!action || action === "status") {
          const recent = Object.values(state.jobs).filter((job) => state.skills[job.skill] && isVisible(state.skills[job.skill]))
            .slice(-12).reverse().map((job) => `${state.skills[job.skill].name} ${job.state} ${job.id}${job.note ? ` · ${job.note}` : ""}`);
          await ctx.ui.editor("Evo Skills status (review only)",
            [`${state.config.paused ? "Paused" : "Ready"} · automatic discovery: ${state.config.automatic ? "on" : "off"} · model: ${state.config.model?.id ?? "not configured"}`,
              `${state.calls} calls · ${state.tokens} tokens · $${state.cost.toFixed(4)}`,
              ...Object.values(state.skills).filter(isVisible)
                .map((skill) => `${skill.name}: active ${skill.active}, ${skill.inPlace ? "in place" : `session ${selected[skill.id] ?? "not pinned"}`}`),
              ...recent].join("\n"));
        } else throw new Error(`Commands: ${Object.keys(subcommands).join(", ")}.`);
        runner?.wake();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Evo Skills failed", "warning");
      }
    },
  });
}
