import { ApiError, providerFetch, type Config } from "./server";

// Kindroid owns the Kin's persona and conversation memory. Send only the new
// user message, without a substitute system prompt or the Gemma chat history.
export async function kindroidFetch(config: Config, path: string, init: RequestInit = {}) {
  if (!config.kindroidKey || !config.kinId) throw new ApiError("Add your Kindroid API key and Kin AI ID in Connections.", 503);
  const response = await providerFetch("Kindroid", `https://api.kindroid.ai/v1${path}`, {
    ...init, headers: {
      Authorization: `Bearer ${config.kindroidKey}`, "Content-Type": "application/json"
    }
  });
  if (!response.ok) {
    await response.body?.cancel();
    const message = response.status === 401 ? "Kindroid rejected the API key. Check the saved key."
      : response.status === 403 ? "Kindroid denied access. Check your subscription and that this Kin belongs to your account."
      : response.status === 429 ? "Kindroid is receiving too many requests. Wait a moment before speaking again."
      : response.status === 400 || response.status === 404 ? "Kindroid could not find or accept this Kin. Check the AI ID."
      : "Kindroid could not respond. It may still have received your message; check its chat before resending.";
    throw new ApiError(message, response.status === 429 ? 429 : 502);
  }
  return response;
}

export async function checkKindroid(config: Config) {
  const params = new URLSearchParams({ ai_id: config.kinId, limit: "1" });
  const response = await kindroidFetch(config, `/get-chat-messages?${params}`, { signal: AbortSignal.timeout(15000) });
  // Verify access without sending a test message or changing the Kin's memory.
  const result = await response.json() as { messages?: unknown[] };
  if (!Array.isArray(result.messages)) throw new ApiError("Kindroid returned an unexpected connection check.", 502);
  return "Your Kin is accessible. No message was sent.";
}

const replyLimit = 12000;
class ReplyError extends Error {
  constructor(public reason: "empty_reply" | "reply_limit" | "response_read_failed") { super(reason); }
}
type HistoryMessage = { id?: string; sender?: string; sender_type?: string; timestamp?: number; message?: string };
type HistoryPage = { messages?: HistoryMessage[]; pagination?: { hasMore?: boolean } };

async function completeReply(response: Response, signal: AbortSignal) {
  if (!response.body) throw new ReplyError("empty_reply");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let reply = "";
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      reply += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (reply.length > replyLimit) throw new ReplyError("reply_limit");
      if (done) break;
    }
    if (!reply.trim()) throw new ReplyError("empty_reply");
    return reply;
  } catch (error) {
    if (signal.aborted || error instanceof ReplyError) throw error;
    throw new ReplyError("response_read_failed");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function history(config: Config, params: Record<string, string>, signal: AbortSignal) {
  const response = await kindroidFetch(config, `/get-chat-messages?${new URLSearchParams({ ai_id: config.kinId, ...params })}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)])
  });
  return await response.json() as HistoryPage;
}
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", aborted); resolve(); }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function recoverReply(config: Config, text: string, startedAt: number, signal: AbortSignal) {
  // History is oldest-first and rate-limited. Probe timestamp units once, then
  // inspect only new messages, at most three times and only after a failed send.
  const sample = (await history(config, { limit: "1" }, signal)).messages?.[0]?.timestamp;
  if (typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0) return null;
  const unit = sample > 100000000000 ? 1 : 1000;
  const cursor = String(Math.floor((startedAt - 1000) / unit));
  for (const delay of [0, 1500, 3500]) {
    if (delay) await pause(delay, signal);
    signal.throwIfAborted();
    const page = await history(config, { limit: "20", start_after_timestamp: cursor }, signal);
    // An incomplete page or an ambiguous repeated question cannot safely be
    // associated with this request. Never substitute an older reply.
    if (page.pagination?.hasMore || !Array.isArray(page.messages)) return null;
    const messages = page.messages;
    const matches = messages.flatMap((message, index) => {
      const user = ["user", "human"].includes((message.sender_type ?? "").toLowerCase());
      return user && message.message?.trim() === text && typeof message.timestamp === "number" &&
        message.timestamp * unit >= startedAt ? [index] : [];
    });
    if (matches.length > 1) return null;
    if (matches.length !== 1) continue;
    const next = messages[matches[0] + 1];
    const ai = next && (next.sender === config.kinId || ["ai", "assistant", "kindroid"].includes((next.sender_type ?? "").toLowerCase()));
    if (ai && typeof next.message === "string" && next.message.trim() && next.message.length <= replyLimit &&
        typeof next.timestamp === "number" && next.timestamp >= messages[matches[0]].timestamp!) return next.message;
  }
  return null;
}

export async function kindroidChat(config: Config, text: string, id: string, request: Request) {
  const startedAt = Date.now();
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(120000)]);
  let reply: string;
  try {
    const response = await kindroidFetch(config, "/send-message", {
      method: "POST", signal, body: JSON.stringify({ ai_id: config.kinId, message: text, stream: false })
    });
    // Validate the entire upstream reply before returning success or starting
    // speech. This does not depend on Kindroid's optional streaming transport.
    reply = await completeReply(response, signal);
  } catch (error) {
    if (request.signal.aborted) throw new ApiError("Reply canceled.", 499);
    if (error instanceof ApiError) throw error;
    const reason = signal.aborted ? "timeout" : error instanceof ReplyError ? error.reason : "request_failed";
    const recovered = reason !== "reply_limit" && !signal.aborted
      ? await recoverReply(config, text, startedAt, signal).catch(() => null) : null;
    if (request.signal.aborted) throw new ApiError("Reply canceled.", 499);
    // Log diagnostic codes only, never chat text, account IDs, or API keys.
    console.warn(JSON.stringify({ event: "kindroid_reply_delivery", reason, recovered: !!recovered, elapsedMs: Date.now() - startedAt }));
    if (!recovered) {
      const message = reason === "empty_reply" ? "Kindroid returned an empty reply, and no matching saved response was available. Your message was not resent."
        : reason === "reply_limit" ? "Kindroid's reply exceeds this app's 12,000-character limit. The full reply is available in Kindroid."
        : reason === "timeout" ? "Kindroid took too long to reply. Your message may be saved there; it was not resent."
        : "Kindroid's response could not be retrieved, including from its chat history. Your message was not resent.";
      throw new ApiError(message, 502);
    }
    reply = recovered;
  }
  const body = JSON.stringify({ type: "text", text: reply }) + "\n" + JSON.stringify({ type: "done", id }) + "\n";
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
