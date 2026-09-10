export const MODEL = "gemma4-heretical";
export const STT_MODEL = "nova-3";
export const TTS_MODEL = "sonic-3.6-2026-08-27";
export const CARTESIA_VERSION = "2026-08-14";

export function validateModelUrl(value) {
  if (!value) return "";
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid HTTPS model-server address."); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      !host.includes(".") || /[\[\]:]/.test(host) || /^[\d.]+$/.test(host) ||
      /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(host) ||
      /\.(nip\.io|sslip\.io|localtest\.me)$/.test(host)) {
    throw new Error("Use your model server's public HTTPS domain, without credentials or query parameters.");
  }
  return url.toString().replace(/\/+$/, "");
}

export const SYSTEM_PROMPT = `You are Companion, a warm, perceptive AI conversation partner.
Be curious, candid, and natural. Have your own judgment. Avoid flattery, canned reassurance, and repetitive questions.
Speak in plain conversational English, usually two to four sentences. Match the user's mood and requested depth.
Your replies are spoken aloud: use sentences, not Markdown, stage directions, XML, or lists unless requested.
Be honest that you are AI. Do not invent an offline life, memories, feelings, capabilities, or experiences.
Use only supplied memory and conversation as personal context. Say when you do not know.
Support the user's independence and real-world relationships. Do not imply exclusivity or emotional dependence.
Do not claim to browse, contact people, run code, or perform actions: this companion only converses.
When uncertain, explain uncertainty. Offer a useful perspective, not an automatic agreement.`;

export async function* readNdjson(stream) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (line) yield JSON.parse(line);
      }
      if (buffer.length > 131072) throw new Error("Model stream exceeded the response limit.");
      if (done) { if (buffer.trim()) yield JSON.parse(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

// Ollama's reasoning and tool fields are deliberately never voiced.
export function answerDelta(event) {
  if (event.error) throw new Error("The model server could not generate a reply.");
  return typeof event.message?.content === "string" ? event.message.content : "";
}

export function takeSentence(buffer, flush = false) {
  const match = /[.!?](?:["”']?)(?=\s|$)/.exec(buffer);
  if (match && match.index >= 8) {
    const end = match.index + match[0].length;
    return [buffer.slice(0, end).trim(), buffer.slice(end).trimStart()];
  }
  if (buffer.length > 260) {
    const end = buffer.lastIndexOf(" ", 240);
    if (end > 0) return [buffer.slice(0, end).trim(), buffer.slice(end).trimStart()];
  }
  return flush ? [buffer.trim(), ""] : ["", buffer];
}

export class UtteranceBuffer {
  parts = [];
  seen = new Set();
  accept(event) {
    if (event.type === "UtteranceEnd") return this.flush();
    if (event.type !== "Results") return "";
    const transcript = event.channel?.alternatives?.[0]?.transcript?.trim();
    if (event.is_final && transcript) {
      const key = `${event.start}:${event.duration}:${transcript}`;
      if (!this.seen.has(key)) { this.seen.add(key); this.parts.push(transcript); }
      if (this.seen.size > 1000) this.seen.delete(this.seen.values().next().value);
    }
    return event.speech_final ? this.flush() : "";
  }
  flush() { const text = this.parts.join(" "); this.parts = []; return text; }
}

export function ollamaPayload(messages, thinking = false) {
  return { model: MODEL, messages, stream: true, think: thinking, keep_alive: "10m",
    options: { temperature: 0.8, top_p: 0.95, top_k: 64, num_ctx: 8192, num_predict: thinking ? 2048 : 512 } };
}

export function speechPayload(text, voiceId) {
  return { model_id: TTS_MODEL, transcript: text, voice: voiceId,
    language: "en", output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 } };
}
