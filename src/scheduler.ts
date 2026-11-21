import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { evidenceText } from "./collector.ts";
import { optimizer, propose, readSkill, type Meter, type WorkerOptions } from "./evolver.ts";
import { adopt, createRevision, skillPath, validateFiles } from "./registry.ts";
import { claim, digest, leaseMs, owns, type Job, type Profile, type Store } from "./store.ts";
import { evaluate } from "./validation.ts";

export const modelKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
export const createRuntime = (agentDir: string, signal?: AbortSignal) =>
  ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), signal });

export function scheduler(store: Store, agentDir: string, show: (status: string) => void, runtimeForJob = createRuntime) {
  const owner = randomUUID();
  let running: Promise<void> | undefined;
  let stop: AbortController | undefined;
  let closed = false;
  const tick = () => {
    if (closed || running) return;
    const data = store.read();
    if (!Object.values(data.jobs).some((job) => job.owner || ["queued", "interrupted"].includes(job.state))) return;
    const job = store.update((state) => claim(state, owner));
    if (!job) return;
    const control = stop = new AbortController();
    running = run(job, control).catch(() => show("Could not save job state")).finally(() => { running = undefined; stop = undefined; });
  };
  const wake = () => { try { tick(); } catch { show("Store temporarily unavailable"); } };
  const timer = setInterval(wake, 2_000);
  timer.unref();

  async function run(job: Job, control: AbortController) {
    const data = store.read();
    const skill = data.skills[job.skill];
    const timeout = AbortSignal.timeout(data.config.timeoutMs ?? 300_000);
    const signal = AbortSignal.any([control.signal, timeout]);
    const meter: Meter = { tokens: 0, cost: 0 };
    const lease = setInterval(() => {
      try {
        if (!store.update((state) => {
          const current = state.jobs[job.id];
          if (!owns(current, job)) return false;
          current.lease = Date.now() + leaseMs;
          return true;
        })) control.abort();
      } catch { control.abort(); }
    }, 5_000);
    lease.unref();
    const transition = (fn: (current: Job, state: ReturnType<Store["read"]>) => void, finish = false) =>
      store.update((state) => {
        const current = state.jobs[job.id];
        if (!owns(current, job)) return false;
        fn(current, state);
        if (finish) {
          current.owner = undefined;
          current.lease = undefined;
          current.tokens = (current.tokens ?? 0) + meter.tokens;
          current.cost = (current.cost ?? 0) + meter.cost;
          state.tokens += meter.tokens;
          state.cost += meter.cost;
        }
        return true;
      });
    const allowCall = async () => {
      while (Object.values(store.read().foreground).some((until) => until > Date.now())) await delay(250, undefined, { signal });
      signal.throwIfAborted();
      if (!transition((current, state) => {
        if ((current.calls ?? 0) >= (data.config.callsPerJob ?? 32)) throw new Error("Model call budget reached.");
        current.calls = (current.calls ?? 0) + 1;
        state.calls++;
      })) throw new Error("Job ownership was lost.");
    };
    try {
      if (job.candidate) {
        // A previous attempt was interrupted during evaluation. The candidate remains available for review.
        if (!transition((current) => { current.state = "validating"; })) return;
      }
      show(`${skill.name}: improving`);
      const runtime = await runtimeForJob(agentDir, signal);
      const inputs = job.evidence.slice(-12).map((id) => data.evidence[id]).filter(Boolean);
      const options = (profile: Profile | undefined): WorkerOptions | undefined => {
        const model = runtime.getAvailableSnapshot().find((item) => modelKey(item) === profile?.id);
        if (model) return {
          cwd: store.root, model, modelRuntime: runtime, signal,
          thinking: profile?.thinking, outputTokens: data.config.outputTokens ?? 4096,
        };
      };
      const evolver = options(job.model);
      const base = skillPath(store.root, skill, job.base);
      const before = await readSkill(base);
      let candidate = job.candidate;
      if (!candidate) {
        if (!evolver) throw new Error(`Unavailable improvement model: ${job.model?.id ?? "not configured"}`);
        const instructions = await optimizer();
        const proposal = await propose(instructions, job.base, before, inputs.map((item) => ({
          id: item.id, summary: JSON.stringify({ usage: item.usage, relatedObservation: item.previous, model: item.target,
            aborted: item.aborted, history: evidenceText(item) }),
        })), { ...evolver, beforeModelCall: allowCall }, meter);
        signal.throwIfAborted();
        if (proposal.decision !== "proposal" || proposal.proposedSkillContent === before) {
          transition((current) => { current.state = "no_change"; current.note = proposal.decision;
            current.rationale = proposal.rationale; current.optimizerRevision = digest(instructions); }, true);
          return;
        }
        const after = proposal.proposedSkillContent!;
        candidate = await createRevision(store.root, skill, base, after);
        const directory = join(store.root, "jobs", job.id, `attempt-${job.attempt}`);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "proposal.json"), JSON.stringify(proposal, null, 2), { flag: "wx", mode: 0o600 });
        signal.throwIfAborted();
        if (!transition((current) => {
          current.candidate = candidate; current.state = "validating"; current.rationale = proposal.rationale;
          current.optimizerRevision = digest(instructions); current.usedEvidence = proposal.evidenceIds;
        })) return;
      }
      show(`${skill.name}: validating`);
      const path = skillPath(store.root, skill, candidate);
      const after = await readSkill(path);
      await validateFiles(path, skill.name, after);
      const target = options(job.target);
      let validation;
      try {
        validation = target
          ? await evaluate(before, after, job.checks ?? [], target, meter, allowCall)
          : { passed: false, reason: `Evaluation model unavailable: ${job.target?.id ?? "not configured"}` };
      } catch (error) {
        if (control.signal.aborted) throw error;
        validation = { passed: false, reason: error instanceof Error ? error.message.slice(0, 500) : "Evaluation unavailable." };
      }
      control.signal.throwIfAborted();
      transition((current, state) => {
        control.signal.throwIfAborted();
        current.validation = validation;
        if (state.skills[current.skill]?.active !== current.base) current.state = "stale";
        else if (!timeout.aborted && validation.passed) adopt(state, current, candidate);
        else current.state = "candidate";
      }, true);
    } catch (error) {
      transition((current) => {
        current.state = control.signal.aborted ? "interrupted" : "failed";
        current.note = timeout.aborted ? "Job timed out." : (error instanceof Error ? error.message : "Job failed.").slice(0, 500);
      }, true);
    } finally {
      clearInterval(lease);
      if (!closed) show(`${skill.name}: ${store.read().jobs[job.id]?.state ?? "unknown"}`);
    }
  }
  return {
    wake,
    async close() {
      closed = true;
      clearInterval(timer);
      stop?.abort();
      try { await running; } finally { store.close(); }
    },
  };
}
