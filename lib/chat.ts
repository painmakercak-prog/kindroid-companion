import { getRawDb } from "@/db";
import { ApiError, modelFetch, profile } from "./server";
import { SYSTEM_PROMPT, ollamaPayload, readNdjson, answerDelta } from "./core.mjs";

export async function chat(user: string, input: { id?: string; text?: string }, request: Request) {
  const id = input.id, text = input.text?.trim();
  if (!id || !/^[a-f0-9-]{36}$/.test(id) || !text || text.length > 4000) throw new ApiError("Enter a message under 4,000 characters.");
  const { config, memory } = await profile(user), db = getRawDb();
  if (!config.modelUrl || !config.modelKey) throw new ApiError("Connect your Gemma model server in Connections.", 503);
  const existing = await db.prepare("SELECT id FROM turns WHERE id = ?").bind(id).first();
  if (existing) throw new ApiError("This turn was already submitted. Please send a new message.", 409);
  await db.prepare("UPDATE turns SET status = 'interrupted' WHERE user_id = ? AND status = 'generating'").bind(user).run();
  const rows = await db.prepare("SELECT user_text, assistant_text FROM turns WHERE user_id = ? AND status IN ('completed', 'interrupted') ORDER BY created_at DESC LIMIT 24")
    .bind(user).all<{ user_text: string; assistant_text: string }>();
  const history: { role: string; content: string }[] = [];
  let budget = 14000;
  for (const row of rows.results) {
    const cost = row.user_text.length + row.assistant_text.length;
    if (cost > budget) break;
    budget -= cost;
    const pair = [{ role: "user", content: row.user_text }];
    if (row.assistant_text) pair.push({ role: "assistant", content: row.assistant_text });
    history.unshift(...pair);
  }
  await db.prepare("INSERT INTO turns (id, user_id, user_text, assistant_text, status, created_at) VALUES (?, ?, ?, '', 'generating', ?)").bind(id, user, text, Date.now()).run();
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(120000)]);
  let upstream: Response;
  try {
    upstream = await modelFetch(config, "/api/chat", { method: "POST", signal,
      body: JSON.stringify(ollamaPayload([
        { role: "system", content: SYSTEM_PROMPT + (memory ? "\nSaved context supplied by the user:\n" + memory : "") },
        ...history, { role: "user", content: text }], config.thinking)) });
    if (!upstream.ok || !upstream.body) throw new ApiError(`Gemma could not respond (${upstream.status}). Check the model server and installed model.`, 502);
  } catch (error) {
    await db.prepare("UPDATE turns SET status = 'interrupted' WHERE id = ? AND user_id = ? AND status = 'generating'").bind(id, user).run();
    throw error;
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (value: unknown) => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      try {
        let complete = false, length = 0;
        for await (const event of readNdjson(upstream.body!)) {
          if (signal.aborted) throw new DOMException("Aborted", "AbortError");
          const delta = answerDelta(event);
          length += delta.length;
          if (length > 12000) throw new Error("Reply too long.");
          if (delta) emit({ type: "text", text: delta });
          if (event.done) { complete = true; break; }
        }
        if (!complete || !length) throw new Error("The model returned an incomplete reply.");
        emit({ type: "done", id });
      } catch {
        if (!signal.aborted) { try { emit({ type: "error", error: "Gemma lost the connection or returned no answer. Please try again." }); } catch {} }
      } finally {
        abort.abort();
        try { controller.close(); } catch {}
      }
    },
    cancel() { abort.abort(); }
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}

export async function commitTurn(user: string, input: { id?: string; text?: string; interrupted?: boolean }) {
  if (!input.id || typeof input.text !== "string" || input.text.length > 12000) throw new ApiError("Invalid turn.");
  const db = getRawDb();
  // Store only the text displayed or fully spoken, never an unheard generated continuation.
  await db.prepare("UPDATE turns SET assistant_text = ?, status = ? WHERE id = ? AND user_id = ? AND status IN ('generating', 'interrupted')")
    .bind(input.text, input.interrupted ? "interrupted" : "completed", input.id, user).run();
  await db.prepare("DELETE FROM turns WHERE user_id = ? AND id NOT IN (SELECT id FROM turns WHERE user_id = ? ORDER BY created_at DESC LIMIT 24)").bind(user, user).run();
}
