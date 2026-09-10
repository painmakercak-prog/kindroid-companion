import { readNdjson, takeSentence, UtteranceBuffer, STT_MODEL } from "./core.mjs";

export async function api(path: string, data?: unknown, method = data === undefined ? "GET" : "POST", signal?: AbortSignal) {
  const r = await fetch("/api/" + path, { method, signal, headers: { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), cache: "no-store" });
  if (!r.ok) { const error = await r.json().catch(() => ({})); throw new Error(error.error || "The connection failed. Please try again."); }
  return r;
}
export type Phase = "idle" | "connecting" | "listening" | "thinking" | "speaking";
type Callbacks = { phase: (p: Phase) => void; active: (value: boolean) => void; reply: (value: string) => void; error: (value: string) => void; level: (value: number) => void; latency?: (ms: number | null) => void };

export class VoiceSession {
  private context: AudioContext | null = null;
  private media: MediaStream | null = null;
  private ws: WebSocket | null = null;
  private capture: AudioWorkletNode | null = null;
  private input: MediaStreamAudioSourceNode | null = null;
  private gain: GainNode | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private connectAbort: AbortController | null = null;
  private controller: AbortController | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private turnId: string | null = null;
  private heard = "";
  private generation = 0;
  private sequence = 0;
  private audioEnd = 0;
  private turnStarted = 0;
  private firstAudio = false;
  private ack: Promise<unknown> = Promise.resolve();
  private utterance = new UtteranceBuffer();
  active = false;
  muted = false;
  constructor(private callbacks: Callbacks) {}
  private async unlock() {
    this.context ??= new AudioContext();
    await this.context.resume();
    const node = this.context.createBufferSource();
    node.buffer = this.context.createBuffer(1, 1, this.context.sampleRate);
    node.connect(this.context.destination); node.start();
  }
  private save(interrupted: boolean) {
    if (!this.turnId) return;
    const id = this.turnId, text = this.heard;
    this.turnId = null; this.heard = "";
    this.ack = this.ack.then(() => api("commit", { id, text, interrupted })).catch(() => {
      this.callbacks.error("That reply could not be saved to memory.");
    });
  }
  interrupt() {
    this.generation++;
    this.controller?.abort(); this.controller = null;
    for (const node of this.sources) { try { node.stop(); } catch {} }
    this.sources.clear(); this.audioEnd = 0;
    this.save(true);
    this.callbacks.phase(this.active ? "listening" : "idle");
  }
  setMuted(muted: boolean) {
    this.muted = muted; this.utterance = new UtteranceBuffer();
    this.media?.getAudioTracks().forEach(t => { t.enabled = !muted; });
  }
  async start() {
    if (this.active || this.connectAbort) return;
    const attempt = ++this.sequence;
    const abort = new AbortController(); this.connectAbort = abort;
    this.callbacks.error(""); this.callbacks.phase("connecting");
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) throw new Error("Use a current browser with microphone support over HTTPS.");
      await this.unlock();
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (attempt !== this.sequence) { media.getTracks().forEach(t => t.stop()); return; }
      this.media = media;
      const context = this.context!;
      await context.audioWorklet.addModule("/pcm-worklet.js");
      const { token } = await (await api("listen-token", {}, "POST", abort.signal)).json();
      if (attempt !== this.sequence) return;
      const params = new URLSearchParams({ model: STT_MODEL, language: "en-US", encoding: "linear16",
        sample_rate: String(context.sampleRate), channels: "1", interim_results: "true",
        punctuate: "true", smart_format: "true", endpointing: "400", utterance_end_ms: "1000", vad_events: "true" });
      const ws = new WebSocket("wss://api.deepgram.com/v1/listen?" + params, ["bearer", token]);
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { ws.close(); reject(new Error("Deepgram connection timed out.")); }, 12000);
        const cancel = () => { clearTimeout(timeout); ws.close(); reject(new DOMException("Aborted", "AbortError")); };
        abort.signal.addEventListener("abort", cancel, { once: true });
        ws.onopen = () => { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancel); resolve(); };
        ws.onerror = () => { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancel); reject(new Error("Deepgram could not connect. Check Connections and try again.")); };
        ws.onclose = () => { clearTimeout(timeout); abort.signal.removeEventListener("abort", cancel); reject(new Error("Deepgram closed the connection.")); };
      });
      if (attempt !== this.sequence) { ws.close(); return; }
      this.active = true; this.callbacks.active(true); this.callbacks.phase("listening");
      this.utterance = new UtteranceBuffer();
      ws.onmessage = event => {
        if (!this.active || this.muted || attempt !== this.sequence) return;
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === "Error") { this.stop(); this.callbacks.error("Deepgram stopped listening. Check your connection and try again."); return; }
        // Raw VAD events can be background noise or the speaker's echo. Require
        // recognized words before interrupting an in-flight reply.
        if (data.type === "Results" && !data.is_final && data.channel?.alternatives?.[0]?.transcript?.trim()) {
          if (this.controller) this.interrupt();
        }
        const text = this.utterance.accept(data);
        if (text) void this.turn(text, true);
      };
      ws.onclose = () => { if (this.active && attempt === this.sequence) { this.stop(); this.callbacks.error("Listening disconnected. Tap Start talking to reconnect."); } };
      ws.onerror = () => { if (this.active) { this.stop(); this.callbacks.error("The speech connection was lost."); } };
      this.input = context.createMediaStreamSource(media);
      this.capture = new AudioWorkletNode(context, "companion-capture");
      this.gain = context.createGain(); this.gain.gain.value = 0;
      this.capture.port.onmessage = event => {
        if (ws.readyState !== WebSocket.OPEN || !this.active) return;
        if (ws.bufferedAmount > 512000) { this.stop(); this.callbacks.error("Your connection is too slow for live audio. Please reconnect."); return; }
        ws.send(event.data);
        const pcm = new Int16Array(event.data);
        let sum = 0; for (let i = 0; i < pcm.length; i++) sum += (pcm[i] / 32768) ** 2;
        this.callbacks.level(Math.min(1, Math.sqrt(sum / pcm.length) * 6));
      };
      this.input.connect(this.capture); this.capture.connect(this.gain); this.gain.connect(context.destination);
      this.keepalive = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "KeepAlive" })); }, 5000);
      this.setMuted(false);
    } catch (error) {
      if (attempt === this.sequence) { this.stop(); this.callbacks.error(error instanceof Error && error.name === "NotAllowedError" ? "Microphone access was denied. Allow the microphone in Safari or your browser settings, then try again." : error instanceof Error && error.name === "NotFoundError" ? "No microphone was found. Connect your microphone or AirPods and try again." : error instanceof Error ? error.message : "Could not start the microphone."); }
    } finally { if (attempt === this.sequence) this.connectAbort = null; }
  }
  stop() {
    this.sequence++; this.connectAbort?.abort(); this.connectAbort = null;
    this.active = false; this.interrupt(); this.callbacks.active(false); this.callbacks.level(0);
    if (this.keepalive) clearInterval(this.keepalive); this.keepalive = null;
    this.ws?.close(); this.ws = null;
    this.capture?.disconnect(); this.capture = null;
    this.input?.disconnect(); this.input = null; this.gain?.disconnect(); this.gain = null;
    this.media?.getTracks().forEach(t => t.stop()); this.media = null;
  }
  async dispose() { this.stop(); await this.context?.close(); this.context = null; }
  async turn(text: string, speak: boolean) {
    this.interrupt();
    const generation = this.generation, controller = new AbortController(); this.controller = controller;
    this.turnStarted = performance.now(); this.firstAudio = false; this.callbacks.latency?.(null);
    this.callbacks.error(""); this.callbacks.reply(""); this.callbacks.phase("thinking");
    let full = "", buffer = "", finished = false, speechError: unknown;
    let queue: Promise<void> = Promise.resolve();
    const enqueue = (sentence: string) => {
      if (!sentence) return;
      queue = queue.then(async () => {
        if (generation !== this.generation || controller.signal.aborted) return;
        await this.play(sentence, controller.signal, generation);
        if (generation === this.generation) this.heard += (this.heard ? " " : "") + sentence;
      }).catch(error => { speechError = error; controller.abort(); });
    };
    try {
      if (speak) await this.unlock();
      await this.ack;
      if (generation !== this.generation) return;
      this.turnId = crypto.randomUUID(); this.heard = "";
      const response = await api("chat", { id: this.turnId, text }, "POST", controller.signal);
      if (!response.body) throw new Error("Your companion returned no response.");
      for await (const event of readNdjson(response.body)) {
        if (generation !== this.generation) return;
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "done") finished = true;
        if (event.type !== "text") continue;
        full += event.text; buffer += event.text;
        this.callbacks.reply(full);
        if (!speak) this.heard = full;
        else {
          while (true) { const [sentence, rest] = takeSentence(buffer); if (!sentence) break; buffer = rest; enqueue(sentence); }
        }
      }
      if (!finished) throw new Error("Your companion stopped before completing the reply.");
      if (speak && buffer.trim()) enqueue(buffer.trim());
      await queue;
      if (speechError) throw speechError;
      if (generation === this.generation) {
        this.save(false); await this.ack; this.controller = null;
        this.callbacks.phase(this.active ? "listening" : "idle");
      }
    } catch (error) {
      if (generation === this.generation) {
        const failure = speechError ?? error;
        this.interrupt();
        this.callbacks.error(failure instanceof Error && failure.name !== "AbortError" ? failure.message : "The reply could not finish. Please try again.");
      }
    }
  }
  private async play(text: string, signal: AbortSignal, generation: number) {
    const response = await api("speak", { text }, "POST", signal);
    if (!response.body) throw new Error("Cartesia returned no audio.");
    const reader = response.body.getReader(), context = this.context!;
    let leftover: number | null = null;
    let receivedBytes = 0;
    const ended: Promise<void>[] = [];
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (signal.aborted || generation !== this.generation) return;
        if (done) break;
        receivedBytes += value.length;
        let bytes = value;
        if (leftover !== null) { bytes = new Uint8Array(value.length + 1); bytes[0] = leftover; bytes.set(value, 1); leftover = null; }
        if (bytes.length % 2) { leftover = bytes[bytes.length - 1]; bytes = bytes.subarray(0, bytes.length - 1); }
        if (!bytes.length) continue;
        const buffer = context.createBuffer(1, bytes.length / 2, 24000), samples = buffer.getChannelData(0);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
        const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
        this.sources.add(source);
        ended.push(new Promise(resolve => { source.onended = () => { this.sources.delete(source); source.disconnect(); resolve(); }; }));
        this.audioEnd = Math.max(context.currentTime + 0.04, this.audioEnd);
        if (!this.firstAudio) { this.firstAudio = true; this.callbacks.latency?.(performance.now() - this.turnStarted + Math.max(0, this.audioEnd - context.currentTime) * 1000); }
        source.start(this.audioEnd); this.audioEnd += buffer.duration;
        this.callbacks.phase("speaking");
      }
      await Promise.all(ended);
      if (!receivedBytes) throw new Error("Cartesia returned no playable audio. Check your voice and credits.");
      if (leftover !== null) throw new Error("Cartesia returned incomplete audio.");
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
