export class VoiceRecorder {
  recording = false;
  async start(onAudio, onState, onError) {
    if (this.recording) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) =>
        MediaRecorder.isTypeSupported(m),
      );
      if (!mime) throw new Error('This browser has no supported audio recorder');
      this.recorder = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      const chunks = [];
      let heard = false;
      let lastLoud = Date.now();
      const began = Date.now();
      this.context = new AudioContext();
      const source = this.context.createMediaStreamSource(this.stream);
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const samples = new Float32Array(512);
      this.recording = true;
      onState('Listening');
      this.recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      this.recorder.onstop = async () => {
        const discard = this.discard;
        this.recording = false;
        this.release();
        onState('Idle');
        if (discard || !heard) return;
        try {
          const blob = new Blob(chunks, { type: mime });
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192)
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          await onAudio({ data: btoa(binary), mime });
        } catch (e) {
          onError(e);
        }
      };
      this.recorder.start(250);
      this.discard = false;
      this.interval = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(samples.reduce((s, x) => s + x * x, 0) / samples.length);
        if (rms > 0.018) {
          heard = true;
          lastLoud = Date.now();
        }
        if (
          (heard && Date.now() - lastLoud > 1400) ||
          Date.now() - began > 60000 ||
          (!heard && Date.now() - began > 10000)
        )
          this.stop(false);
      }, 100);
    } catch (e) {
      this.recording = false;
      this.release();
      onState('Idle');
      onError(e);
    }
  }
  stop(discard = true) {
    clearInterval(this.interval);
    this.discard = discard;
    if (this.recorder?.state === 'recording') this.recorder.stop();
    else {
      this.recording = false;
      this.release();
    }
  }
  release() {
    clearInterval(this.interval);
    this.stream?.getTracks().forEach((track) => track.stop());
    this.context?.close().catch(() => {});
  }
}
export function say(text, onDone) {
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.onend = onDone;
  u.onerror = onDone;
  speechSynthesis.speak(u);
  return () => speechSynthesis.cancel();
}
