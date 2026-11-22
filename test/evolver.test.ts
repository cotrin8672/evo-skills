import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionUIContext, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isolated } from "../src/evolver.ts";
import { register, skillPath } from "../src/registry.ts";
import { Store } from "../src/store.ts";

for (const directory of ["evo-skills", "skill-evolution"]) test(`Pi loads Evo Skills with the ${directory} store and keeps the worker separate`, async () => {
  const dir = await mkdtemp(join(tmpdir(), "evo-skills-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const store = new Store(join(dir, directory));
  try {
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    faux.setResponses([fauxAssistantMessage("Check the exit code first.")]);
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModels(faux.provider.id)[0];
    assert.ok(model);
    const project = join(dir, "project");
    const original = join(project, "example", "SKILL.md");
    await mkdir(join(project, "example"), { recursive: true });
    await writeFile(original, "---\nname: example\ndescription: An example\n---\nRecord the exit code.\n");
    const skill = await register(store, original, project, dir, []);

    const pkg = fileURLToPath(new URL("../", import.meta.url));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { "evo-test": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture",
      models: [
        { id: "local-model" },
        { id: "reasoning-model", reasoning: true, thinkingLevelMap: { high: null, max: "max" } },
      ],
    } } }));
    const settingsManager = SettingsManager.create(dir, dir);
    const loader = new DefaultResourceLoader({ cwd: project, agentDir: dir, settingsManager });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getSkills().skills, []);
    const { session: parent } = await createAgentSession({
      cwd: project, model, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(project),
    });
    try {
      await parent.bindExtensions({ mode: "rpc", uiContext: { setStatus() {} } as Partial<ExtensionUIContext> as ExtensionUIContext });
      const command = parent.extensionRunner.getRegisteredCommands().find((cmd) => cmd.name === "evo-skills");
      assert.ok(command?.getArgumentCompletions);
      assert.equal((await command.getArgumentCompletions(""))?.length, 13);
      assert.deepEqual((await command.getArgumentCompletions("re"))?.map((item) => item.value), ["resume", "reevaluate"]);
      assert.equal(await command.getArgumentCompletions("run "), null);
      assert.deepEqual((await command.getArgumentCompletions("model local-model"))?.map((item) => item.value), ["model evo-test/local-model"]);
      assert.deepEqual((await command.getArgumentCompletions("target ex"))?.map((item) => item.value), ["target example"]);
      assert.deepEqual((await command.getArgumentCompletions("target example evo-test/"))?.map((item) => item.value),
        ["target example evo-test/local-model", "target example evo-test/reasoning-model"]);
      assert.deepEqual((await command.getArgumentCompletions("target example orig"))?.map((item) => item.value), ["target example origin"]);
      assert.deepEqual((await command.getArgumentCompletions("model evo-test/local-model "))?.map((item) => item.value), ["model evo-test/local-model off"]);
      assert.deepEqual((await command.getArgumentCompletions("target example evo-test/reasoning-model ma"))?.map((item) => item.value),
        ["target example evo-test/reasoning-model max"]);
      assert.deepEqual(await command.getArgumentCompletions("model evo-test/reasoning-model high"), []);
      assert.equal(await command.getArgumentCompletions("target example origin "), null);
      await parent.prompt("/evo-skills model evo-test/reasoning-model max");
      assert.deepEqual(store.read().config.model, { id: "evo-test/reasoning-model", thinking: "max" });
      assert.ok(parent.getActiveToolNames().includes("bash"));
      assert.equal(loader.getSkills().skills.find(({ name }) => name === "example")?.filePath, skillPath(store.root, skill, skill.active));
      const result = await isolated("Follow only the maintenance instructions.", "A nonzero exit code was missed.", {
        cwd: dir, model, modelRuntime: runtime, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(result.text, "Check the exit code first.");
      assert.deepEqual(parent.messages, []);
      faux.setResponses([fauxAssistantMessage("I checked the exit code."), fauxAssistantMessage("I'll distinguish failure from success.")]);
      await parent.prompt("/skill:example Review the task.", { source: "rpc" });
      const boundary = directory === "skill-evolution"
        ? parent.sessionManager.appendCustomEntry("pi-skill-evolution:boundary")
        : parent.sessionManager.getLeafId();
      await parent.prompt("Correction: the nonzero exit code indicates a failure.", { source: "rpc" });
      const observations = Object.values(store.read().evidence);
      assert.equal(observations.length, 2);
      assert.match(observations[0].usage, /expanded/);
      assert.equal(observations[1].previous, observations[0].id);
      assert.equal(observations[1].from, boundary);
      assert.match(observations[1].text ?? "", /Correction/);
    } finally {
      await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      parent.dispose();
    }
  } finally {
    store.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});

test("one opt-in automatically discovers later additions without reloading another project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "evo-skills-discovery-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const store = new Store(join(dir, "evo-skills"));
  try {
    const addSkill = async (skills: string, name: string) => {
      const path = join(skills, name, "SKILL.md");
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `---\nname: ${name}\ndescription: An example\n---\nRecord the exit code.\n`);
      return path;
    };
    const globalSkills = join(dir, "skills");
    const original = await addSkill(globalSkills, "personal");
    const first = join(dir, "first");
    const second = join(dir, "second");
    const firstSkills = join(first, ".pi", "skills");
    const firstSkill = await addSkill(firstSkills, "first-skill");
    const pkg = fileURLToPath(new URL("../", import.meta.url));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModels(faux.provider.id)[0];
    assert.ok(model);
    const open = async (cwd: string) => {
      const settingsManager = SettingsManager.create(cwd, dir, { projectTrusted: true });
      const loader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager });
      await loader.reload();
      const { session } = await createAgentSession({
        cwd, model, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        await session.bindExtensions({
          mode: "rpc",
          uiContext: { confirm: async () => true, notify() {}, setStatus() {} } as Partial<ExtensionUIContext> as ExtensionUIContext,
          commandContextActions: {
            reload: () => session.reload(), waitForIdle: () => session.waitForIdle(),
            newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
            navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }),
          },
        });
        return { session, loader };
      } catch (error) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        throw error;
      }
    };
    const { session, loader } = await open(first);
    let lateGlobal: string;
    try {
      assert.deepEqual(Object.keys(store.read().skills), []);
      await session.prompt("/evo-skills enable", { source: "rpc" });
      assert.equal(store.read().config.automatic, true);
      assert.deepEqual(Object.values(store.read().skills).map(({ original }) => original).sort(), [original, firstSkill].sort());

      lateGlobal = await addSkill(globalSkills, "late-global");
      const lateProject = await addSkill(join(first, ".agents", "skills"), "late-project");
      const until = Date.now() + 9_000;
      while (Object.keys(store.read().skills).length < 4 && Date.now() < until) await delay(25);
      assert.equal(Object.keys(store.read().skills).length, 4);
      assert.deepEqual(loader.getSkills().skills.map(({ filePath }) => filePath).sort(), [original, firstSkill, lateGlobal, lateProject].sort());
      assert.deepEqual(session.messages, []);
      faux.setResponses([fauxAssistantMessage("Done."), fauxAssistantMessage("Done.")]);
      await session.prompt("/skill:late-project Review the task.", { source: "rpc" });
      await session.prompt("Unrelated question.", { source: "rpc" });
      assert.equal(Object.keys(store.read().evidence).length, 1);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    const secondSkill = await addSkill(join(second, ".pi", "skills"), "second-skill");
    const next = await open(second);
    try {
      assert.deepEqual(next.loader.getSkills().skills.map(({ filePath }) => filePath).sort(), [original, lateGlobal, secondSkill].sort());
      const command = next.session.extensionRunner.getRegisteredCommands().find((cmd) => cmd.name === "evo-skills");
      assert.deepEqual((await command?.getArgumentCompletions?.("target "))?.map(({ value }) => value),
        ["target late-global", "target personal", "target second-skill"]);
    } finally {
      await next.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      next.session.dispose();
    }
  } finally {
    store.close();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true, maxRetries: 8 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EBUSY") throw error;
    });
  }
});
