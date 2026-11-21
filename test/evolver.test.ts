import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { evolve, parseProposal } from "../src/evolver.ts";

const source = "---\r\nname: example\r\ndescription: An example\r\n---\r\nOld procedure.\r\n";

test("accepts only a replacement body and preserves the original metadata", () => {
  assert.equal(parseProposal('{"decision":"no_change"}', source), undefined);
  assert.throws(() => parseProposal('{"decision":"proposal","body":42}', source));
  assert.throws(() => parseProposal('{"decision":"proposal","body":"   "}', source));
  assert.equal(
    parseProposal('{"decision":"proposal","body":"New procedure."}', source),
    source.replace("Old procedure.\r\n", "New procedure.\n"),
  );
});

test("Pi loads the package; a separate tool-free SDK worker leaves the parent chat unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-skill-evolution-"));
  try {
    const faux = fauxProvider({ tokensPerSecond: Infinity });
    faux.setResponses([fauxAssistantMessage(JSON.stringify({ decision: "proposal", body: "Check the exit code first." }))]);
    const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(faux.provider);
    const model = runtime.getModels(faux.provider.id)[0];
    assert.ok(model);

    const pkg = fileURLToPath(new URL("../", import.meta.url));
    await writeFile(join(dir, "settings.json"), JSON.stringify({ packages: [pkg] }));
    const settingsManager = SettingsManager.create(dir, dir);
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    assert.deepEqual(loader.getSkills().skills, []);
    const { session: parent } = await createAgentSession({
      cwd: dir, model, modelRuntime: runtime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir),
    });
    try {
      await parent.bindExtensions({});
      assert.ok(parent.extensionRunner.getRegisteredCommands().some((cmd) => cmd.name === "skill-evolution"));
      assert.ok(parent.getActiveToolNames().includes("bash"));
      const result = await evolve(source, "A nonzero exit code was missed.", {
        cwd: dir, model, modelRuntime: runtime, signal: AbortSignal.timeout(10_000),
      });
      assert.equal(result, source.replace("Old procedure.\r\n", "Check the exit code first.\n"));
      assert.deepEqual(parent.messages, []);
    } finally {
      parent.dispose();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
