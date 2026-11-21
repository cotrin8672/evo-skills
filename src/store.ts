import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type Profile = { id: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" };
export type Check = { kind: "regression" | "repair" | "non_applicable"; task: string; includes: string[]; excludes?: string[] };
export type Skill = { id: string; name: string; original: string; scope: string; active: string; checks: Check[]; target?: Profile };
export type Evidence = {
  id: string; skill: string; base: string; session: string; through: string; from?: string;
  file?: string; previous?: string; text?: string; usage: string;
  target?: Profile; aborted?: boolean; cwd: string;
};
export type State = "queued" | "running" | "validating" | "published" | "candidate" | "no_change" | "stale" | "failed" | "interrupted";
export type Job = {
  id: string; skill: string; base: string; evidence: string[]; state: State; due: number;
  attempt: number; owner?: string; lease?: number; model?: Profile; target?: Profile; checks?: Check[];
  started?: number; candidate?: string; note?: string; validation?: unknown; calls?: number; tokens?: number; cost?: number;
  optimizerRevision?: string; rationale?: string; usedEvidence?: string[];
};
export type Config = { model?: Profile; paused?: boolean; idleMs?: number; cooldownMs?: number; jobsPerDay?: number; callsPerJob?: number; outputTokens?: number; timeoutMs?: number };
export type Data = {
  config: Config; skills: Record<string, Skill>; pins: Record<string, Record<string, string>>;
  files: Record<string, string>; evidence: Record<string, Evidence>; jobs: Record<string, Job>;
  foreground: Record<string, number>; attempts: number[]; calls: number; tokens: number; cost: number;
};
export class Store {
  readonly root: string;
  readonly #db: DatabaseSync;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(root, "state.sqlite"));
    this.#db.exec("PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    this.#db.prepare("INSERT OR IGNORE INTO state VALUES(1, ?)").run(JSON.stringify({
      config: {}, skills: {}, pins: {}, files: {}, evidence: {}, jobs: {}, foreground: {}, attempts: [], calls: 0, tokens: 0, cost: 0,
    }));
  }
  close() { this.#db.close(); }
  read(): Data {
    const row = this.#db.prepare("SELECT value FROM state WHERE id=1").get();
    return JSON.parse(String(row?.value)) as Data;
  }
  update<T>(fn: (data: Data) => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const data = this.read();
      const next = fn(data);
      this.#db.prepare("UPDATE state SET value=? WHERE id=1").run(JSON.stringify(data));
      this.#db.exec("COMMIT");
      return next;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

export function enqueue(data: Data, item: Evidence, now = Date.now(), manual = false) {
  if (Object.hasOwn(data.evidence, item.id)) return;
  data.evidence[item.id] = item;
  const skill = data.skills[item.skill];
  if (!skill || skill.active !== item.base) return;
  const target = skill.target ?? item.target;
  const compatible = (job: Job) => job.skill === item.skill && job.base === item.base &&
    JSON.stringify(job.target) === JSON.stringify(target);
  const pending = Object.values(data.jobs).find((job) => compatible(job) && job.state === "queued");
  if (pending) {
    pending.evidence.push(item.id);
    if (manual) pending.due = now;
    return pending.id;
  }
  const last = Math.max(0, ...Object.values(data.jobs).filter((job) => job.skill === item.skill).map((job) => job.started ?? 0));
  const id = randomUUID();
  data.jobs[id] = {
    id, skill: skill.id, base: item.base, evidence: [item.id], state: "queued", attempt: 0, target,
    due: manual ? now : Math.max(now + (data.config.idleMs ?? 15_000), last + (data.config.cooldownMs ?? 30 * 60_000)),
  };
  return id;
}

export const leaseMs = 30_000;
export function claim(data: Data, owner: string, now = Date.now()) {
  for (const job of Object.values(data.jobs)) {
    if (job.owner && (job.lease ?? 0) <= now) {
      job.owner = undefined;
      job.lease = undefined;
      job.state = "interrupted";
    }
  }
  for (const [id, until] of Object.entries(data.foreground)) if (until <= now) delete data.foreground[id];
  data.attempts = data.attempts.filter((at) => now - at < 86_400_000);
  if (data.config.paused || !data.config.model || Object.keys(data.foreground).length ||
    data.attempts.length >= (data.config.jobsPerDay ?? 6) || Object.values(data.jobs).some((job) => job.owner)) return;
  for (const job of Object.values(data.jobs).sort((a, b) => a.due - b.due)) {
    if (!["queued", "interrupted"].includes(job.state) || job.due > now) continue;
    if (data.skills[job.skill]?.active !== job.base) { job.state = "stale"; continue; }
    job.state = "running";
    job.attempt++;
    job.started = now;
    job.owner = owner;
    job.lease = now + leaseMs;
    job.model ??= data.config.model;
    job.checks ??= data.skills[job.skill].checks;
    data.attempts.push(now);
    return structuredClone(job);
  }
}

export function owns(job: Job | undefined, current: Job, now = Date.now()): job is Job {
  return !!job && !!job.owner && job.owner === current.owner && job.attempt === current.attempt && (job.lease ?? 0) > now;
}
