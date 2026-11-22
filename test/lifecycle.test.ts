import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { collect } from "../src/collector.ts";
import { adopt, createRevision, discover, pins, register, rollback, skillPath } from "../src/registry.ts";
import { modelKey, scheduler } from "../src/scheduler.ts";
import { claim, enqueue, leaseMs, owns, Store } from "../src/store.ts";

const source = "---\nname: example\ndescription: Example procedure\n---\nUse the old procedure.\n";
const candidate = source.replace("the old procedure", "the revised procedure");

function skillCommand(path: string, baseDir: string, scope: "user" | "project" | "temporary" = "project",
  origin: "top-level" | "package" = "top-level", label = "auto"): ReturnType<ExtensionAPI["getCommands"]>[number] {
  return { name: "skill:example", source: "skill", sourceInfo: { path, baseDir, scope, origin, source: label } };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "evo-skills-life-"));
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
  const announcements: string[] = [];
  const runner = scheduler(store, root, (_status, published) => {
    if (published) announcements.push(published.id);
  }, async () => runtime);
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
    assert.deepEqual(announcements, [jobId]);
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

test("automatic discovery observes only eligible skills used in the current turn and never overwrites prior edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "evo-skills-auto-"));
  const store = new Store(join(root, "state"));
  try {
    const baseDir = join(root, ".pi");
    const original = join(baseDir, "skills", "example", "SKILL.md");
    const bundled = join(baseDir, "skills", "bundled", "SKILL.md");
    for (const path of [original, bundled]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, source);
    }
    const commands = [skillCommand(original, baseDir), skillCommand(bundled, baseDir, "project", "package"),
      skillCommand(bundled, baseDir, "temporary", "top-level", "extension:example")];
    const enrolled = await discover(store, commands, root);
    assert.equal(enrolled.length, 1);
    const skill = store.read().skills[enrolled[0]];
    assert.equal(skill.original, original);
    const selected = store.update((data) => pins(data, "s", root, undefined, undefined, false, enrolled));
    const turn = (id: string, path: string) => ({
      type: "message", id, message: { role: "user", content: `<skill name="example" location="${path}">` },
    });
    const ownTurn = turn("first", original);
    const foreignTurn = turn("second", bundled);
    let branch = [ownTurn, foreignTurn];
    const ctx = { cwd: root, sessionManager: { getSessionId: () => "s", getBranch: () => branch, getSessionFile: () => undefined } } as unknown as ExtensionContext;
    collect(store, ctx, selected, undefined, false, () => assert.fail("bundled skill was observed"), ownTurn.id);
    assert.deepEqual(store.read().evidence, {});
    branch = [...branch, turn("third", original)];
    collect(store, ctx, selected, undefined, false, () => {}, foreignTurn.id);
    const [job] = Object.values(store.read().jobs);
    assert.ok(job);
    const revision = await createRevision(store.root, skill, original, candidate);
    const edited = source.replace("old", "hand-edited");
    await writeFile(original, edited);
    const publish = () => store.update((data) => adopt(data, data.jobs[job.id], store.root, revision));
    assert.equal(publish(), false);
    assert.equal(await readFile(original, "utf8"), edited);
    assert.equal(store.read().jobs[job.id].state, "candidate");
    await writeFile(original, source);
    assert.equal(publish(), true);
    assert.equal(await readFile(original, "utf8"), candidate);
    assert.equal(await readFile(skillPath(store.root, skill, skill.active), "utf8"), source);
    await rollback(store, store.read().skills[skill.id], skill.active);
    assert.equal(await readFile(original, "utf8"), source);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true, maxRetries: 8 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});
