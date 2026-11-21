import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolated, type Meter, type WorkerOptions } from "./evolver.ts";
import type { Check } from "./store.ts";

export function parseChecks(input: unknown): Check[] {
  if (!Array.isArray(input) || input.length > 6) throw new Error("Expected an array of at most six evaluation cases.");
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 12 &&
    value.every((item) => typeof item === "string" && item.trim() && item.length <= 500);
  return input.map((value) => {
    if (!value || !["regression", "repair", "non_applicable"].includes(value.kind) ||
        typeof value.task !== "string" || !value.task.trim() || value.task.length > 4000 ||
        !strings(value.includes) || !value.includes.length || (value.excludes !== undefined && !strings(value.excludes)))
      throw new Error("Invalid evaluation case. Each needs kind, task, and nonempty includes; excludes is optional.");
    return { kind: value.kind, task: value.task, includes: value.includes, excludes: value.excludes };
  });
}

export function judge(rows: { kind: Check["kind"]; old: boolean[]; next: boolean[] }[]) {
  return ["regression", "repair", "non_applicable"].every((kind) => rows.some((row) => row.kind === kind)) &&
    rows.every((row) => row.next.length === 2 && row.next.every(Boolean) &&
      (row.kind === "repair" || row.old.every(Boolean))) &&
    rows.some((row) => row.kind === "repair" && row.old.every((pass) => !pass));
}

export function diffBody(before: string, after: string) {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  let first = 0, endA = a.length, endB = b.length;
  while (first < endA && first < endB && a[first] === b[first]) first++;
  while (endA > first && endB > first && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return [`@@ lines ${first + 1} onward @@`, ...a.slice(first, endA).map((line) => `-${line}`), ...b.slice(first, endB).map((line) => `+${line}`)].join("\n");
}

export async function evaluate(
  before: string, after: string, checks: Check[], options: WorkerOptions, meter: Meter,
  allowCall: () => Promise<void>,
) {
  if (!["regression", "repair", "non_applicable"].every((kind) => checks.some((check) => check.kind === kind)))
    return { passed: false, reason: "Need regression, repair, and non-applicable fixtures." };
  const rows = [];
  for (const check of checks) {
    const row = { kind: check.kind, old: [] as boolean[], next: [] as boolean[] };
    for (let repeat = 0; repeat < 2; repeat++) {
      for (const [source, results] of [[before, row.old], [after, row.next]] as const) {
        await allowCall();
        const cwd = await mkdtemp(join(tmpdir(), "pi-skill-eval-"));
        try {
          const output = (await isolated(
            "Solve the user task. The supplied skill is optional: use it only if applicable. Begin with a line SKILL: USED or SKILL: SKIPPED. Do not claim to run tools.",
            JSON.stringify({ availableSkill: source, task: check.task }), { ...options, cwd }, [], meter,
          )).text;
          const used = output.match(/^\s*SKILL:\s*(USED|SKIPPED)\s*(?:\r?\n|$)/i)?.[1]?.toUpperCase();
          const body = output.replace(/^\s*SKILL:.*\r?\n/, "");
          results.push(used === (check.kind === "non_applicable" ? "SKIPPED" : "USED") &&
            check.includes.every((needle) => body.includes(needle)) && !(check.excludes ?? []).some((needle) => body.includes(needle)));
        } finally {
          await rm(cwd, { recursive: true, force: true });
        }
      }
    }
    rows.push(row);
  }
  return { passed: judge(rows), rows };
}
