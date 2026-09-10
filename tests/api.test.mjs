import test from "node:test";
import assert from "node:assert/strict";
import { testEnv } from "./worker-runtime.mjs";
const { default: worker } = await import("../dist/server/index.js");
const origin = "https://companion.mydomain.com";
const ctx = { waitUntil() {}, passThroughOnException() {} };
function request(path, { user = "alice", data, method = data ? "POST" : "GET", originHeader = origin } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (user) headers["oai-authenticated-user-id"] = user;
  if (method !== "GET") headers.origin = originHeader;
  return worker.fetch(new Request(origin + "/api/" + path, { method, headers, body: data ? JSON.stringify(data) : undefined }), testEnv, ctx);
}
test("all companion API state is authenticated and isolated by user", async () => {
  assert.equal((await request("settings", { user: "" })).status, 401);
  assert.equal((await request("settings", { data: { memory: "test" }, originHeader: "https://unrelated.mydomain.com" })).status, 403);
  const saved = await request("settings", { data: { provider: "gemma", modelUrl: "https://models.mydomain.com", modelKey: "test-model-key", cartesiaKey: "test-cartesia-key", deepgramKey: "test-deepgram-key", memory: "Alice likes hiking.", voiceId: "test-voice" } });
  assert.equal(saved.status, 200);
  const status = await saved.json();
  assert.equal(status.voiceReady, true);
  const publicText = JSON.stringify(status);
  assert.ok(!publicText.includes("test-cartesia-key"));
  const alice = await (await request("settings")).json();
  const bob = await (await request("settings", { user: "bob" })).json();
  assert.equal(alice.memory, "Alice likes hiking."); assert.equal(bob.memory, ""); assert.equal(bob.voiceReady, false);
  const stored = await testEnv.DB.prepare("SELECT config FROM profiles WHERE user_id = ?").bind("alice").first();
  assert.ok(!stored.config.includes("test-model-key"));
  await request("memory", { method: "DELETE" });
  assert.equal((await (await request("settings")).json()).memory, "");
});
