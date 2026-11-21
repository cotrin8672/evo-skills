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

test("Pi loads the package; a separate tool-free SDK worker leaves the parent chat unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-skill-evolution-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const store = new Store(join(dir, "skill-evolution"));
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
      assert.ok(parent.extensionRunner.getRegisteredCommands().some((cmd) => cmd.name === "skill-evolution"));
      assert.ok(parent.getActiveToolNames().includes("bash"));
      assert.equal(loader.getSkills().skills.find(({ name }) => name === "example")?.filePath, skillPath(store.root, skill, skill.active));
      const result = await isolated("Follow only the maintenance instructions.", "A nonzero exit code was missed.", {
        cwd: dir, model, modelRuntime: runtime, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(result.text, "Check the exit code first.");
      assert.deepEqual(parent.messages, []);
      faux.setResponses([fauxAssistantMessage("I checked the exit code."), fauxAssistantMessage("I'll distinguish failure from success.")]);
      await parent.prompt("/skill:example Review the task.", { source: "rpc" });
      await parent.prompt("Correction: the nonzero exit code indicates a failure.", { source: "rpc" });
      const observations = Object.values(store.read().evidence);
      assert.equal(observations.length, 2);
      assert.match(observations[0].usage, /expanded/);
      assert.equal(observations[1].previous, observations[0].id);
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
