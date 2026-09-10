import test from "node:test";
import assert from "node:assert/strict";
import { testEnv } from "./worker-runtime.mjs";
const { default: worker } = await import("../dist/server/index.js");
const origin = "https://companion.mydomain.com";
const context = { waitUntil() {}, passThroughOnException() {} };
function request(path, data, user = "kindroid-user", signal) {
  return worker.fetch(new Request(`${origin}/api/${path}`, {
    signal,
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "oai-authenticated-user-id": user },
    body: data === undefined ? undefined : JSON.stringify(data)
  }), testEnv, context);
}
const credentials = { provider: "kindroid", kinId: "kin-owned", kindroidKey: "kn_fixture_secret", deepgramKey: "fixture-deepgram", cartesiaKey: "fixture-cartesia", voiceId: "owned-voice" };
test("the key and Kin ID can be saved on separate visits without resetting existing voice connections", async () => {
  const user = "kindroid-switch-apps-user";
  await request("settings", { deepgramKey: "fixture-deepgram", cartesiaKey: "fixture-cartesia", voiceId: "owned-voice" }, user);
  assert.equal((await request("settings", { provider: "kindroid", kindroidKey: "kn_separate_save" }, user)).status, 200);
  const afterKey = await (await request("settings", undefined, user)).json();
  assert.equal(afterKey.keys.kindroid, true);
  assert.equal(afterKey.kinId, "");
  assert.equal(afterKey.textReady, false);
  assert.ok(!JSON.stringify(afterKey).includes("kn_separate_save"));
  assert.equal((await request("settings", { provider: "kindroid", kinId: "kin-copied-later" }, user)).status, 200);
  const afterId = await (await request("settings", undefined, user)).json();
  assert.equal(afterId.voiceReady, true);
  assert.equal(afterId.kinId, "kin-copied-later");
  assert.equal(afterId.voiceId, "owned-voice");
  assert.deepEqual(afterId.keys, { kindroid: true, model: false, deepgram: true, cartesia: true });
});
test("Kindroid setup is private, readiness needs both key and AI ID, and blank keys preserve saved connections", async () => {
  assert.equal((await (await request("settings")).json()).provider, "kindroid");
  const partial = await (await request("settings", { kindroidKey: credentials.kindroidKey })).json();
  assert.equal(partial.textReady, false);
  const saved = await (await request("settings", credentials)).json();
  assert.equal(saved.textReady, true); assert.equal(saved.voiceReady, true);
  assert.ok(!JSON.stringify(saved).includes(credentials.kindroidKey));
  const stored = await testEnv.DB.prepare("SELECT config FROM profiles WHERE user_id = ?").bind("kindroid-user").first();
  assert.ok(!stored.config.includes(credentials.kindroidKey));
  assert.equal((await (await request("settings", { kindroidKey: "" })).json()).keys.kindroid, true);
  assert.equal((await (await request("settings", undefined, "other-user")).json()).keys.kindroid, false);
  assert.equal((await request("settings", { kindroidKey: "wrong-format" })).status, 400);
});
test("complete replies preserve split Unicode, send only the new message, and do not pollute local Gemma memory", async () => {
  await request("settings", credentials);
  const original = globalThis.fetch, calls = [];
  const message = "Hello Kasey. Café ☀ — let's talk.";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new ReadableStream({ start(c) {
      for (const byte of new TextEncoder().encode(message)) c.enqueue(Uint8Array.of(byte));
      c.close();
    } }), { headers: { "Content-Type": "text/plain" } });
  };
  try {
    const id = crypto.randomUUID();
    const response = await request("chat", { id, text: "Hello, it's Kasey." });
    assert.equal(response.status, 200);
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    assert.equal(events.filter(x => x.type === "text").map(x => x.text).join(""), message);
    assert.equal(events.at(-1).type, "done");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kindroid.ai/v1/send-message");
    assert.deepEqual(JSON.parse(calls[0].init.body), { ai_id: "kin-owned", message: "Hello, it's Kasey.", stream: false });
    assert.equal(calls[0].init.headers.Authorization, "Bearer kn_fixture_secret");
    assert.equal(calls[0].init.redirect, "manual");
    await request("commit", { id, text: message, interrupted: false });
    assert.equal(await testEnv.DB.prepare("SELECT id FROM turns WHERE id = ?").bind(id).first(), null);
  } finally { globalThis.fetch = original; }
});
test("connection check reads Kin history without sending a message and verifies current Cartesia audio contract", async () => {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).startsWith("https://api.kindroid.ai/v1/get-chat-messages?")) return Response.json({ messages: [] });
    if (String(url).includes("deepgram.com")) return Response.json({ access_token: "temporary-token" });
    if (String(url).includes("cartesia.ai")) return new Response(new Uint8Array(1024));
    throw new Error("Unexpected endpoint");
  };
  try {
    const result = await (await request("check", {})).json();
    assert.ok(result.checks.every(x => x.ok));
    assert.equal(calls.length, 3);
    assert.ok(!calls.some(c => c.url.includes("send-message")));
    const speech = calls.find(c => c.url.includes("cartesia.ai"));
    assert.equal(speech.init.headers["Cartesia-Version"], "2026-08-14");
    const payload = JSON.parse(speech.init.body);
    assert.equal(payload.voice, "owned-voice");
    assert.equal(payload.model_id, "sonic-3.6-2026-08-27");
    assert.deepEqual(payload.output_format, { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 });
  } finally { globalThis.fetch = original; }
});
test("provider failure is actionable and never retries a potentially accepted chat message", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("provider internal secret", { status: 429 }); };
  try {
    const response = await request("chat", { id: crypto.randomUUID(), text: "Hello." });
    assert.equal(response.status, 429);
    const data = await response.json();
    assert.match(data.error, /too many requests/); assert.ok(!data.error.includes("internal secret"));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
test("empty responses are distinct from cancellation, and cancellation stops upstream reading", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async url => String(url).includes("get-chat-messages") ? Response.json({ messages: [] }) : new Response("");
  try {
    const response = await request("chat", { id: crypto.randomUUID(), text: "Hello." });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /empty reply/);
    let cancelled = false, notifyRead;
    const reading = new Promise(resolve => { notifyRead = resolve; });
    globalThis.fetch = async () => new Response(new ReadableStream({
      pull(c) { c.enqueue(new TextEncoder().encode("First words.")); notifyRead(); return new Promise(() => {}); },
      cancel() { cancelled = true; }
    }));
    const abort = new AbortController();
    const pending = request("chat", { id: crypto.randomUUID(), text: "Another question." }, "kindroid-user", abort.signal);
    await reading;
    abort.abort();
    assert.equal((await pending).status, 499);
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = original; }
});

for (const mode of ["empty", "broken"]) test(`${mode} reply is recovered from the matching new exchange without sending twice`, async () => {
  const original = globalThis.fetch, calls = [];
  const message = "Recover this exact exchange.";
  let timestamp;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("send-message")) {
      timestamp = Date.now() + 1;
      assert.equal(JSON.parse(init.body).stream, false);
      if (mode === "empty") return new Response("");
      let chunks = 0;
      return new Response(new ReadableStream({ pull(c) {
        if (!chunks++) c.enqueue(new TextEncoder().encode("Incomplete fragment"));
        else c.error(new Error("Simulated transport failure"));
      } }));
    }
    if (String(url).includes("limit=1") && !String(url).includes("start_after_timestamp")) return Response.json({ messages: [{ timestamp: timestamp - 86400000 }] });
    assert.ok(String(url).includes("start_after_timestamp="));
    return Response.json({ messages: [
      { id: "new-user", sender_type: "user", timestamp, message },
      { id: "new-ai", sender_type: "ai", sender: "kin-owned", timestamp: timestamp + 1, message: "The recovered complete answer." },
    ], pagination: { hasMore: false } });
  };
  try {
    const response = await request("chat", { id: crypto.randomUUID(), text: message });
    assert.equal(response.status, 200, await response.clone().text());
    const events = (await response.text()).trim().split("\n").map(JSON.parse);
    assert.equal(events[0].text, "The recovered complete answer.");
    assert.equal(events.at(-1).type, "done");
    assert.equal(calls.filter(url => url.includes("send-message")).length, 1);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});

test("recovery rejects ambiguous repeated questions and oversized responses remain explicit", async () => {
  const original = globalThis.fetch;
  let timestamp, sends = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("send-message")) { sends++; timestamp = Date.now() + 1; return new Response(""); }
    if (!String(url).includes("start_after_timestamp")) return Response.json({ messages: [{ timestamp: timestamp - 86400000 }] });
    return Response.json({ messages: [
      { sender_type: "user", timestamp, message: "Same question." },
      { sender_type: "ai", timestamp: timestamp + 1, message: "Do not substitute this answer." },
      { sender_type: "user", timestamp: timestamp + 2, message: "Same question." },
    ] });
  };
  try {
    const failed = await request("chat", { id: crypto.randomUUID(), text: "Same question." });
    assert.equal(failed.status, 502);
    assert.match((await failed.json()).error, /empty reply/);
    assert.equal(sends, 1);
    globalThis.fetch = async () => new Response("x".repeat(12001));
    const oversized = await request("chat", { id: crypto.randomUUID(), text: "Long reply." });
    assert.equal(oversized.status, 502);
    assert.match((await oversized.json()).error, /12,000-character limit/);
  } finally { globalThis.fetch = original; }
});

test("recovery never speaks an old answer and performs only a bounded number of lookups", async () => {
  const original = globalThis.fetch;
  const staleTime = Date.now() - 86400000;
  let lookups = 0, sends = 0;
  globalThis.fetch = async url => {
    if (String(url).includes("send-message")) { sends++; return new Response(""); }
    lookups++;
    return Response.json({ messages: [
      { sender_type: "user", timestamp: staleTime, message: "Previous question." },
      { sender_type: "ai", timestamp: staleTime + 1, message: "Old answer that must not play." },
    ] });
  };
  try {
    const response = await request("chat", { id: crypto.randomUUID(), text: "Previous question." });
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("Old answer that must not play"));
    assert.equal(sends, 1);
    assert.equal(lookups, 4);
  } finally { globalThis.fetch = original; }
});
