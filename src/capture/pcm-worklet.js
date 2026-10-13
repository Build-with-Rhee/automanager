class PCMRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(4000);
    this.index = 0;
    this.firstFrame = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "flush") {
        this.flush();
        this.port.postMessage({ flushed: true });
      }
    };
  }
  flush() {
    if (this.index) {
      const samples = this.samples.slice(0, this.index);
      this.port.postMessage({ samples, firstFrame: this.firstFrame }, [
        samples.buffer,
      ]);
      this.index = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    if (!input?.length) return true;
    for (let i = 0; i < input[0].length; i++) {
      if (this.index === 0) this.firstFrame = currentFrame + i;
      let sample = 0;
      for (const channel of input) sample += channel[i];
      this.samples[this.index++] = sample / input.length;
      if (this.index === this.samples.length) this.flush();
    }
    return true;
  }
}
registerProcessor("automanager-pcm", PCMRecorder);
