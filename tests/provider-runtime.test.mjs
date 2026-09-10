import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare, Log, LogLevel } from "miniflare";
import ts from "typescript";

const origin = "https://companion.mydomain.com";
const credentials = {
  provider: "kindroid", kinId: "kin-runtime", kindroidKey: "kn_runtime_fixture",
  deepgramKey: "deepgram-runtime-fixture", cartesiaKey: "cartesia-runtime-fixture", voiceId: "runtime-voice",
};

test("provider routes run in Workers and never forward credentials through redirects", async t => {
  const calls = [];
  let redirectHost = null;
  let recover = false, sentText = "", sentAt = 0;
  const serverRoot = fileURLToPath(new URL("../dist/server/", import.meta.url));
  const modulePaths = (await readdir(serverRoot, { recursive: true }))
    .filter(path => path.endsWith(".js"))
    .sort((a, b) => Number(b === "index.js") - Number(a === "index.js"));
  const mf = new Miniflare({
    modules: modulePaths.map(path => ({ type: "ESModule", path: resolve(serverRoot, path) })),
    modulesRoot: serverRoot,
    compatibilityDate: "2026-04-01",
    compatibilityFlags: ["nodejs_compat"],
    log: new Log(LogLevel.ERROR),
    d1Databases: ["DB"],
    bindings: { COMPANION_SECRETS_KEY: Buffer.alloc(32, 4).toString("base64") },
    outboundService: async request => {
      const url = new URL(request.url);
      calls.push({ host: url.hostname, path: url.pathname, auth: request.headers.get("authorization") });
      if (url.hostname === redirectHost) return new Response(null, { status: 307, headers: { Location: "https://unexpected.mydomain.com/collect" } });
      if (url.hostname === "api.deepgram.com" && url.pathname === "/v1/auth/grant") return Response.json({ access_token: "runtime-session-token" });
      if (url.hostname === "api.cartesia.ai" && url.pathname === "/voices") return Response.json([{ id: "runtime-voice", name: "Test voice" }]);
      if (url.hostname === "api.cartesia.ai" && url.pathname === "/tts/bytes") return new Response(new Uint8Array(1024));
      if (url.hostname === "api.kindroid.ai" && url.pathname === "/v1/get-chat-messages") return Response.json({ messages: !recover ? [] : !url.searchParams.has("start_after_timestamp") ? [{ timestamp: sentAt - 86400000 }] : [
        { sender_type: "user", timestamp: sentAt, message: sentText },
        { sender_type: "ai", sender: credentials.kinId, timestamp: sentAt + 1, message: "The recovered reply works." },
      ], pagination: { hasMore: false } });
      if (url.hostname === "api.kindroid.ai" && url.pathname === "/v1/send-message") {
        const body = await request.json();
        assert.equal(body.stream, false);
        sentText = body.message; sentAt = Date.now() + 1;
        return new Response(recover ? "" : "The connection works.", { headers: { "Content-Type": "text/plain" } });
      }
      if (url.hostname === "models.mydomain.com" && url.pathname === "/api/tags") return Response.json({ models: [{ name: "gemma4-heretical" }] });
      return new Response("Unexpected destination", { status: 500 });
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const migration = await readFile(new URL("../drizzle/0000_jazzy_blonde_phantom.sql", import.meta.url), "utf8");
  for (const sql of migration.split("--> statement-breakpoint")) await db.prepare(sql.trim()).run();
  const request = (path, data) => mf.dispatchFetch(`${origin}/api/${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", Origin: origin, "oai-authenticated-user-id": "runtime-user" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

  assert.equal((await request("settings", credentials)).status, 200);
  const listen = await request("listen-token", {});
  assert.equal(listen.status, 200, await listen.clone().text());
  assert.equal((await listen.json()).token, "runtime-session-token");
  const voices = await request("voices");
  assert.equal(voices.status, 200, await voices.clone().text());
  assert.equal((await voices.json()).voices[0].id, "runtime-voice");
  const checks = await (await request("check", {})).json();
  assert.ok(checks.checks.every(result => result.ok), JSON.stringify(checks));
  assert.equal(calls.find(call => call.host === "api.deepgram.com").auth, "Token deepgram-runtime-fixture");
  assert.equal(calls.find(call => call.host === "api.cartesia.ai").auth, "Bearer cartesia-runtime-fixture");
  assert.equal(calls.find(call => call.host === "api.kindroid.ai").auth, "Bearer kn_runtime_fixture");

  const chatReply = await request("chat", { id: crypto.randomUUID(), text: "Complete reply fixture." });
  assert.equal(chatReply.status, 200);
  const replyEvents = (await chatReply.text()).trim().split("\n").map(JSON.parse);
  assert.equal(replyEvents.filter(event => event.type === "text").map(event => event.text).join(""), "The connection works.", JSON.stringify(replyEvents));
  assert.equal(replyEvents.at(-1).type, "done", JSON.stringify(replyEvents));
  const spokenReply = await request("speak", { text: "The connection works." });
  assert.equal(spokenReply.status, 200);
  assert.ok((await spokenReply.arrayBuffer()).byteLength > 0);

  // Exercise the actual client parser, speech queue, PCM decoder and commit
  // against the compiled Worker; only browser hardware/providers are faked.
  const voiceSource = (await readFile(new URL("../lib/voice.ts", import.meta.url), "utf8"))
    .replace('"./core.mjs"', JSON.stringify(new URL("../lib/core.mjs", import.meta.url).href));
  const voiceJs = ts.transpileModule(voiceSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  const { VoiceSession } = await import(`data:text/javascript;base64,${Buffer.from(voiceJs).toString("base64")}`);
  const originalFetch = globalThis.fetch, originalAudio = globalThis.AudioContext;
  const played = [];
  globalThis.AudioContext = class {
    sampleRate = 48000; currentTime = 0; destination = {};
    async resume() {} async close() {}
    createBuffer(channels, length, sampleRate) { return { length, duration: length / sampleRate, getChannelData: () => new Float32Array(length) }; }
    createBufferSource() { return {
      connect() {}, disconnect() {}, stop() { this.onended?.(); },
      start() { played.push(this.buffer.length); queueMicrotask(() => this.onended?.()); },
    }; }
  };
  globalThis.fetch = async (url, init) => request(String(url).replace(/^\/api\//, ""), init?.body === undefined ? undefined : JSON.parse(init.body));
  try {
    for (const recovery of [false, true]) {
      recover = recovery;
      const before = calls.filter(call => call.path === "/v1/send-message").length;
      const errors = [], replies = [], phases = [];
      const session = new VoiceSession({ phase: value => phases.push(value), active() {}, reply: value => replies.push(value), error: value => { if (value) errors.push(value); }, level() {} });
      await session.turn("Speak this complete reply.", true);
      assert.deepEqual(errors, []);
      assert.equal(replies.at(-1), recovery ? "The recovered reply works." : "The connection works.");
      assert.ok(phases.includes("speaking"));
      assert.equal(phases.at(-1), "idle");
      assert.equal(calls.filter(call => call.path === "/v1/send-message").length - before, 1);
      await session.dispose();
    }
    assert.ok(played.filter(length => length > 1).length >= 2, "Both complete replies reach audio playback");
  } finally { globalThis.fetch = originalFetch; globalThis.AudioContext = originalAudio; recover = false; }

  for (const [host, path, data, provider] of [
    ["api.deepgram.com", "listen-token", {}, "Deepgram"],
    ["api.cartesia.ai", "voices", undefined, "Cartesia"],
    ["api.kindroid.ai", "chat", { id: crypto.randomUUID(), text: "Runtime fixture." }, "Kindroid"],
  ]) {
    redirectHost = host;
    const previous = calls.length;
    const response = await request(path, data);
    assert.equal(response.status, 502, await response.clone().text());
    const error = await response.json();
    assert.match(error.error, new RegExp(`${provider}.*redirect`));
    assert.equal(calls.length - previous, 1, "Do not follow redirects or retry a chat");
  }
  redirectHost = null;
  assert.equal((await request("settings", { provider: "gemma", modelUrl: "https://models.mydomain.com", modelKey: "gemma-runtime-fixture" })).status, 200);
  const gemmaChecks = await (await request("check", {})).json();
  assert.ok(gemmaChecks.checks.every(result => result.ok), JSON.stringify(gemmaChecks));
  assert.ok(calls.every(call => call.host !== "unexpected.mydomain.com"));
});
