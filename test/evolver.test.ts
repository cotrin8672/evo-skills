import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
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
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "local-model" }],
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
      assert.deepEqual((await command.getArgumentCompletions("target example evo-test/"))?.map((item) => item.value), ["target example evo-test/local-model"]);
      assert.deepEqual((await command.getArgumentCompletions("target example orig"))?.map((item) => item.value), ["target example origin"]);
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
