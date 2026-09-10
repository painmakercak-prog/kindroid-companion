class CompanionCapture extends AudioWorkletProcessor {
  constructor() { super(); this.samples = new Int16Array(2048); this.offset = 0; }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      const x = Math.max(-1, Math.min(1, channel[i]));
      this.samples[this.offset++] = x < 0 ? x * 32768 : x * 32767;
      if (this.offset === this.samples.length) {
        this.port.postMessage(this.samples.buffer, [this.samples.buffer]);
        this.samples = new Int16Array(2048); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("companion-capture", CompanionCapture);
