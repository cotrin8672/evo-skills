import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { pins, register, rollback, skillPath } from "../src/registry.ts";
import { modelKey, scheduler } from "../src/scheduler.ts";
import { claim, enqueue, leaseMs, owns, Store } from "../src/store.ts";

const source = "---\nname: example\ndescription: Example procedure\n---\nUse the old procedure.\n";
const candidate = source.replace("the old procedure", "the revised procedure");

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "pi-evolution-life-"));
  const cwd = join(root, "project");
  const original = join(cwd, "example", "SKILL.md");
  await mkdir(join(cwd, "example"), { recursive: true });
  await writeFile(original, source);
  await writeFile(join(cwd, "example", "notes.md"), "Attached notes");
  const store = new Store(join(root, "state"));
  const skill = await register(store, original, cwd, root, []);
  return { root, cwd, original, store, skill };
}

test("Windows-safe transactions dedupe evidence, fence abandoned jobs, and respect foreground priority", async () => {
  const { root, cwd, store, skill } = await setup();
  const other = new Store(store.root);
  try {
    const time = Date.now();
    const evidence = { id: "e1", skill: skill.id, base: skill.active, session: "s", through: "leaf", text: "A correction", cwd, usage: "read" };
    const id = store.update((data) => {
      data.config.model = { id: "tests/model" };
      data.foreground.busy = time + 1;
      return enqueue(data, evidence, time, true);
    })!;
    assert.equal(other.update((data) => enqueue(data, evidence, time, true)), undefined);
    assert.equal(other.update((data) => claim(data, "blocked", time)), undefined);
    const first = other.update((data) => claim(data, "first", time + 5))!;
    assert.equal(first.id, id);
    assert.equal(store.update((data) => claim(data, "early", time + 10)), undefined);
    const module = new URL("../src/store.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, ["--eval", `
      import { claim, Store } from ${JSON.stringify(module)};
      const store = new Store(${JSON.stringify(store.root)});
      console.log(store.update((data) => claim(data, "other process", ${time + 10})) ? "claimed" : "blocked");
      store.close();
    `], { timeout: 15_000 });
    assert.equal(stdout.trim(), "blocked");
    const second = store.update((data) => claim(data, "replacement", time + 10 + leaseMs))!;
    assert.equal(second.attempt, first.attempt + 1);
    assert.equal(owns(second, first, time + 10 + leaseMs), false);
    assert.equal(other.read().jobs[id].evidence.length, 1);
  } finally {
    other.close();
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});

test("queue generates, validates, adopts, pins older and forked sessions, and rolls back", async () => {
  const { root, cwd, original, store, skill } = await setup();
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  const faux = fauxProvider({ tokensPerSecond: Infinity });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModels(faux.provider.id)[0];
  assert.ok(model);
  const modelId = modelKey(model);
  const parentFile = join(root, "parent.jsonl");
  const jobId = store.update((data) => {
    data.config.model = { id: modelId };
    data.skills[skill.id].checks = [
      { kind: "regression", task: "Known success", includes: ["correct"] },
      { kind: "repair", task: "Missed condition", includes: ["fixed"] },
      { kind: "non_applicable", task: "Unrelated task", includes: ["separate"] },
    ];
    assert.equal(pins(data, "parent", cwd, parentFile)[skill.id], skill.active);
    return enqueue(data, {
      id: "e1", skill: skill.id, base: skill.active, session: "parent", through: "leaf", text: "Missed condition", cwd,
      usage: "read", target: { id: modelId },
    }, Date.now(), true);
  })!;
  const evaluation = [
    ...Array.from({ length: 4 }, () => "SKILL: USED\ncorrect"),
    "SKILL: USED\nwrong", "SKILL: USED\nfixed", "SKILL: USED\nwrong", "SKILL: USED\nfixed",
    ...Array.from({ length: 4 }, () => "SKILL: SKIPPED\nseparate"),
  ];
  faux.setResponses([
    fauxAssistantMessage([
      fauxToolCall("submit_proposal", {
        decision: "proposal", baseRevision: skill.active, evidenceIds: ["e1"],
        rationale: "Handle the missed condition", proposedSkillContent: candidate,
      }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage("Submitted."),
    ...evaluation.map((value) => fauxAssistantMessage(value)),
  ]);
  // The faux provider has no configured credential; the test explicitly exposes its sole model.
  runtime.getAvailableSnapshot = () => [model];
  const runner = scheduler(store, root, () => {}, async () => runtime);
  const inspect = new Store(store.root);
  try {
    runner.wake();
    const until = Date.now() + 10_000;
    let job = inspect.read().jobs[jobId];
    while (Date.now() < until && ["queued", "running", "validating"].includes(job.state)) {
      await delay(10);
      job = inspect.read().jobs[jobId];
    }
    assert.equal(job.state, "published", JSON.stringify(job));
    assert.equal(job.calls, 14);
    const changed = inspect.read().skills[skill.id];
    assert.notEqual(changed.active, skill.active);
    assert.equal(await readFile(original, "utf8"), source);
    assert.equal(await readFile(skillPath(inspect.root, skill, skill.active), "utf8"), source);
    assert.equal(await readFile(skillPath(inspect.root, skill, changed.active), "utf8"), candidate);
    assert.equal(inspect.update((data) => pins(data, "parent", cwd, parentFile)[skill.id]), skill.active);
    assert.equal(inspect.update((data) => pins(data, "fork", cwd, join(root, "fork.jsonl"), parentFile, true)[skill.id]), skill.active);
    assert.equal(inspect.update((data) => pins(data, "new", cwd)[skill.id]), changed.active);
    await rollback(inspect, changed, skill.active);
    assert.equal(inspect.update((data) => pins(data, "newer", cwd)[skill.id]), skill.active);
    assert.equal(inspect.update((data) => pins(data, "new", cwd)[skill.id]), changed.active);
  } finally {
    await runner.close();
    inspect.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});
