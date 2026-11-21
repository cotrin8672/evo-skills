import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { collect } from "./collector.ts";
import { adopt, pins, register, rollback, skillPath, validateFiles, visible } from "./registry.ts";
import { createRuntime, modelKey, scheduler } from "./scheduler.ts";
import { digest, enqueue, leaseMs, Store, type Profile } from "./store.ts";
import { diffBody, parseChecks } from "./validation.ts";

const command = "evo-skills";
const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
export default function evoSkills(pi: ExtensionAPI) {
  const agentDir = getAgentDir();
  let store: Store | undefined;
  let runner: ReturnType<typeof scheduler> | undefined;
  let selected: Record<string, string> = {};
  let cwd = "";
  let activeInput = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const foreground = randomUUID();
  const profile = (ctx: ExtensionContext): Profile | undefined => ctx.model
    ? { id: modelKey(ctx.model), thinking: ctx.thinkingLevel as Profile["thinking"] } : undefined;
  const status = (ctx: ExtensionContext, message: string) => {
    if (ctx.hasUI) ctx.ui.setStatus(command, `Evo Skills: ${message}`);
  };
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
    selected = db.update((data) => pins(data, ctx.sessionManager.getSessionId(), cwd,
      ctx.sessionManager.getSessionFile(), event.previousSessionFile, event.reason === "fork"));
    runner = scheduler(db, agentDir, (message) => status(ctx, message));
    runner.wake();
  });
  pi.on("resources_discover", (_event, ctx) => {
    const data = store?.read();
    const ordinary = new Set(pi.getCommands().filter((cmd) => cmd.source === "skill").map((cmd) => cmd.name));
    const skillPaths = [];
    for (const [id, revision] of Object.entries(selected)) {
      const skill = data?.skills[id];
      if (!skill || !visible(skill, cwd)) continue;
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
  pi.on("session_tree", () => { activeInput = false; });
  pi.on("agent_settled", (event, ctx) => {
    try {
      if (store && activeInput && ctx.hasUI)
        collect(store, ctx, selected, profile(ctx), event.aborted, (type) => pi.appendEntry(type));
    } catch {
      status(ctx, "Could not record skill usage");
    } finally {
      activeInput = false;
      clearForeground();
      runner?.wake();
    }
  });
  pi.on("session_shutdown", () => {
    try { clearForeground(); } finally {
      void runner?.close().catch(() => {});
      runner = undefined;
      store = undefined;
    }
  });
  pi.registerCommand(command, {
    description: "Track, evaluate, and improve skills using a separate model",
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
          const skill = Object.values(state.skills).find((item) => item.name === name && visible(item, cwd));
          if (!skill) throw new Error(`Unknown managed skill: ${name ?? "(missing)"}`);
          return skill;
        };
        if (action === "model") {
          const runtime = await createRuntime(agentDir, AbortSignal.timeout(30_000));
          const choices = runtime.getAvailableSnapshot().map(modelKey).sort();
          const id = name || await ctx.ui.select("Evo Skills model", choices);
          if (!choices.length) throw new Error("No models available in Pi's standalone configuration.");
          if (!id) return;
          if (!choices.includes(id)) throw new Error("Model is not available to the improvement session.");
          const thinking = detail ? levels.find((value) => value === detail) : undefined;
          if (detail && !thinking) throw new Error(`Thinking level must be one of: ${levels.join(", ")}`);
          db.update((data) => { data.config.model = { id, thinking }; });
          notify(`Evo Skills model: ${id}`);
        } else if (action === "track") {
          if (!arg) throw new Error("Provide the path to SKILL.md.");
          const discovered = pi.getCommands().filter((cmd) => cmd.source === "skill")
            .filter((cmd) => !resolve(cmd.sourceInfo.path).startsWith(resolve(db.root) + sep))
            .map((cmd) => ({ name: cmd.name.replace(/^skill:/, "") }));
          const skill = await register(db, resolve(cwd, arg), cwd, agentDir, discovered);
          notify(`Tracking ${skill.name} at ${skill.active}. New sessions will use the managed copy.`);
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
          if (id !== "origin" && !(await createRuntime(agentDir, AbortSignal.timeout(30_000))).getAvailableSnapshot().some((model) => modelKey(model) === id))
            throw new Error("The evaluation model is not available.");
          db.update((data) => { data.skills[skill.id].target = id === "origin" ? undefined : { id, thinking }; });
          notify(`${skill.name}: evaluation model ${id}.`);
        } else if (action === "run") {
          const skill = find();
          const text = (await ctx.ui.input("Observation (will be sent to the improvement model)"))?.trim();
          if (!text) return;
          if (text.length > 4_000) throw new Error("Observation exceeds 4,000 characters.");
          const id = digest(randomUUID());
          const job = db.update((data) => enqueue(data, {
            id, skill: skill.id, base: selected[skill.id] ?? skill.active, cwd, session: ctx.sessionManager.getSessionId(),
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
          if (!job?.candidate || !skill || !visible(skill, cwd)) throw new Error("No visible candidate for that job.");
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
              return current.state === "candidate" && adopt(data, current, job.candidate!);
            });
            if (!applied) throw new Error("The base revision changed; candidate not applied.");
            notify(`Published ${skill.name}; existing sessions keep their assigned revisions.`);
          } else {
            const before = skillPath(db.root, skill, job.base);
            const details = `${job.state}: ${job.rationale ?? job.note ?? ""}\nEvidence: ${job.usedEvidence?.join(", ") ?? ""}\n${JSON.stringify(job.validation ?? {})}\n\nBefore: ${before}\nAfter: ${path}`;
            const [oldText, newText] = await Promise.all([readFile(before, "utf8"), readFile(path, "utf8")]);
            await ctx.ui.editor("Evo Skills comparison (review only)",
              `${details}\n\n${diffBody(oldText, newText)}`);
          }
        } else if (action === "rollback") {
          if (!detail) throw new Error("Usage: rollback <skill> <revision>");
          await rollback(db, find(), detail);
          notify("Rolled back the active revision for new sessions.");
        } else if (!action || action === "status") {
          const recent = Object.values(state.jobs).filter((job) => state.skills[job.skill] && visible(state.skills[job.skill], cwd))
            .slice(-12).reverse().map((job) => `${state.skills[job.skill].name} ${job.state} ${job.id}${job.note ? ` · ${job.note}` : ""}`);
          await ctx.ui.editor("Evo Skills status (review only)",
            [`${state.config.paused ? "Paused" : "Enabled"} · model: ${state.config.model?.id ?? "not configured"}`,
              `${state.calls} calls · ${state.tokens} tokens · $${state.cost.toFixed(4)}`,
              ...Object.values(state.skills).filter((skill) => visible(skill, cwd)).map((skill) => `${skill.name}: active ${skill.active}, session ${selected[skill.id] ?? "not pinned"}`),
              ...recent].join("\n"));
        } else throw new Error("Commands: model, track, checks, target, run, status, pause, resume, budget, diff, apply, reevaluate, rollback.");
        runner?.wake();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Evo Skills failed", "warning");
      }
    },
  });
}
