import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { readNdjson, answerDelta, ollamaPayload, speechPayload, UtteranceBuffer, validateModelUrl, takeSentence } from "../lib/core.mjs";
import { seal, unseal } from "../lib/crypto.mjs";

test("model streaming handles split Unicode and final unterminated JSON", async () => {
  const data = new TextEncoder().encode('{"message":{"content":"café ☀"}}\n{"done":true}');
  const stream = new ReadableStream({ start(c) { for (const byte of data) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const events = []; for await (const event of readNdjson(stream)) events.push(event);
  assert.equal(answerDelta(events[0]), "café ☀"); assert.equal(events[1].done, true);
});
test("reasoning traces never become spoken answer content", () => {
  assert.equal(answerDelta({ message: { thinking: "private reasoning" } }), "");
  assert.equal(answerDelta({ message: { thinking: "private", content: "Hello." } }), "Hello.");
  assert.throws(() => answerDelta({ error: "OOM" }));
});
test("chosen models and speech format stay pinned without a fallback", () => {
  const llm = ollamaPayload([{ role: "user", content: "Hello" }], true);
  assert.equal(llm.model, "gemma4-heretical"); assert.equal(llm.think, true);
  const tts = speechPayload("Hello.", "owned-voice");
  assert.equal(tts.model_id, "sonic-3.6-2026-08-27"); assert.equal(tts.voice, "owned-voice");
  assert.equal(tts.output_format.encoding, "pcm_s16le");
});
test("utterance assembly ignores interim, combines finals and does not submit duplicate endpoints", () => {
  const buffer = new UtteranceBuffer();
  const event = (text, start, final = true, end = false) => ({ type: "Results", start, duration: 1, is_final: final, speech_final: end, channel: { alternatives: [{ transcript: text }] } });
  assert.equal(buffer.accept(event("I think", 0, false)), "");
  assert.equal(buffer.accept(event("I think", 0)), "");
  assert.equal(buffer.accept(event("I think", 0)), "");
  assert.equal(buffer.accept(event("we should talk.", 1, true, true)), "I think we should talk.");
  assert.equal(buffer.accept({ type: "UtteranceEnd" }), "");
  assert.equal(buffer.accept(event("we should talk.", 1, true, true)), "");
});
test("public model destinations reject local and credential-bearing URLs", () => {
  for (const value of ["http://api.mydomain.com", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://a.internal", "https://user:pass@api.mydomain.com", "https://api.mydomain.com?key=secret", "https://127.0.0.1.nip.io"]) assert.throws(() => validateModelUrl(value));
  assert.equal(validateModelUrl("https://models.mydomain.com/"), "https://models.mydomain.com");
});
test("saved credentials authenticate the user and cannot be decrypted across accounts", async () => {
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const a = await seal({ cartesiaKey: "test-only" }, "alice", key);
  const b = await seal({ cartesiaKey: "test-only" }, "alice", key);
  assert.notEqual(a, b); assert.ok(!a.includes("test-only"));
  assert.deepEqual(await unseal(a, "alice", key), { cartesiaKey: "test-only" });
  await assert.rejects(unseal(a, "bob", key));
});
test("speech segmentation keeps unfinished thoughts until ready", () => {
  assert.deepEqual(takeSentence("Let's think this through. One more thought"), ["Let's think this through.", "One more thought"]);
  assert.deepEqual(takeSentence("An unfinished thought"), ["", "An unfinished thought"]);
});

test("interrupting an in-flight reply prevents stale output and commits only delivered text", async () => {
  const source = await readFile(new URL("../lib/voice.ts", import.meta.url), "utf8");
  const moduleText = ts.transpileModule(source.replace('"./core.mjs"', JSON.stringify(new URL("../lib/core.mjs", import.meta.url).href)), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  const { VoiceSession } = await import("data:text/javascript;base64," + Buffer.from(moduleText).toString("base64"));
  const originalFetch = globalThis.fetch, replies = [], commits = [];
  let firstController, calls = 0;
  const encode = obj => new TextEncoder().encode(JSON.stringify(obj) + "\n");
  globalThis.fetch = async (url, init) => {
    const data = JSON.parse(init.body || "{}");
    if (url === "/api/commit") { commits.push(data); return Response.json({ ok: true }); }
    if (url !== "/api/chat") throw new Error("Unexpected provider use");
    calls++;
    if (calls === 1) return new Response(new ReadableStream({
      start(c) { firstController = c; c.enqueue(encode({ type: "text", text: "First words." })); },
      cancel() {}
    }));
    return new Response(new ReadableStream({ start(c) { c.enqueue(encode({ type: "text", text: "New answer." })); c.enqueue(encode({ type: "done" })); c.close(); } }));
  };
  try {
    const voice = new VoiceSession({ phase() {}, active() {}, level() {}, error() {}, reply: text => replies.push(text) });
    const first = voice.turn("First question", false);
    for (let i = 0; i < 20 && !replies.includes("First words."); i++) await new Promise(r => setImmediate(r));
    assert.ok(replies.includes("First words."));
    await voice.turn("Second question", false);
    firstController.enqueue(encode({ type: "text", text: "Stale continuation" }));
    firstController.close();
    await first;
    assert.equal(replies.at(-1), "New answer.");
    assert.ok(!replies.some(v => v.includes("Stale continuation")));
    assert.equal(commits[0].text, "First words."); assert.equal(commits[0].interrupted, true);
    assert.equal(commits.at(-1).text, "New answer.");
  } finally { globalThis.fetch = originalFetch; }
});
