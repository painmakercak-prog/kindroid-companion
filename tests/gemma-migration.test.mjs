import test from "node:test";
import assert from "node:assert/strict";
import { testEnv } from "./worker-runtime.mjs";
import { seal } from "../lib/crypto.mjs";
const { default: worker } = await import("../dist/server/index.js");
const origin = "https://companion.mydomain.com";
function request(path, data) {
  return worker.fetch(new Request(`${origin}/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "oai-authenticated-user-id": "migration-user" },
    body: data === undefined ? undefined : JSON.stringify(data),
  }), testEnv, { waitUntil() {}, passThroughOnException() {} });
}
test("existing Kindroid settings switch to Gemma while voice credentials and memory survive", async () => {
  const legacy = { provider: "kindroid", kinId: "old-kin", kindroidKey: "kn_test_fixture", deepgramKey: "test-deepgram", cartesiaKey: "test-cartesia", voiceId: "test-voice" };
  const encrypted = await seal(legacy, "migration-user", testEnv.COMPANION_SECRETS_KEY);
  await testEnv.DB.prepare("INSERT INTO profiles (user_id, config, memory, updated_at) VALUES (?, ?, ?, ?)").bind("migration-user", encrypted, "Remember this note.", Date.now()).run();
  const settings = await (await request("settings")).json();
  assert.equal(settings.provider, "gemma");
  assert.equal(settings.textReady, false);
  assert.equal(settings.voiceReady, false);
  assert.equal(settings.keys.deepgram, true);
  assert.equal(settings.keys.cartesia, true);
  assert.equal(settings.voiceId, "test-voice");
  assert.equal(settings.memory, "Remember this note.");
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Should not contact Kindroid"); };
  try {
    const chat = await request("chat", { id: crypto.randomUUID(), text: "Hello" });
    assert.equal(chat.status, 503);
    assert.match((await chat.json()).error, /Gemma model server/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
  const saved = await (await request("settings", { provider: "kindroid", modelUrl: "https://model.mydomain.com", modelKey: "test-model" })).json();
  assert.equal(saved.provider, "gemma");
  assert.equal(saved.voiceReady, true);
  assert.equal(saved.memory, "Remember this note.");
  assert.ok(!JSON.stringify(saved).includes("test-model"));
  const row = await testEnv.DB.prepare("SELECT config FROM profiles WHERE user_id = ?").bind("migration-user").first();
  assert.ok(!row.config.includes("test-model"));
});
