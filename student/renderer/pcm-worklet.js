class Pcm16Processor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions?.targetRate ?? 16000;
    this.packetSamples = options.processorOptions?.packetSamples ?? 3200;
    this.ratio = sampleRate / this.targetRate;
    this.pendingInput = [];
    this.readPosition = 0;
    this.output = new Int16Array(this.packetSamples);
    this.outputOffset = 0;
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length || !channels[0]?.length) return true;
    for (let index = 0; index < channels[0].length; index += 1) {
      let sample = 0;
      for (const channel of channels) sample += channel[index] ?? 0;
      this.pendingInput.push(sample / channels.length);
    }
    while (this.readPosition + 1 < this.pendingInput.length) {
      const leftIndex = Math.floor(this.readPosition);
      const fraction = this.readPosition - leftIndex;
      const value = this.pendingInput[leftIndex] * (1 - fraction) + this.pendingInput[leftIndex + 1] * fraction;
      const clamped = Math.max(-1, Math.min(1, value));
      this.output[this.outputOffset++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      this.readPosition += this.ratio;
      if (this.outputOffset === this.output.length) {
        this.port.postMessage(this.output.buffer, [this.output.buffer]);
        this.output = new Int16Array(this.packetSamples);
        this.outputOffset = 0;
      }
    }
    const consumed = Math.min(Math.floor(this.readPosition), Math.max(0, this.pendingInput.length - 1));
    if (consumed > 0) {
      this.pendingInput.splice(0, consumed);
      this.readPosition -= consumed;
    }
    return true;
  }
}

registerProcessor('pcm16-processor', Pcm16Processor);
