export function splitSpeech(text, limit = 1800) {
  const words = String(text).trim().split(/\s+/);
  const chunks = [];
  let chunk = '';
  for (const word of words) {
    if (!word) continue;
    if (word.length > limit) {
      if (chunk) {
        chunks.push(chunk);
        chunk = '';
      }
      for (let i = 0; i < word.length; i += limit) chunks.push(word.slice(i, i + limit));
      continue;
    }
    if (chunk.length + word.length + 1 > limit) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += (chunk ? ' ' : '') + word;
  }
  if (chunk) chunks.push(chunk);
  return chunks;
}

// Playback is injected so cancellation, failure and cleanup can be tested without an API key.
export class SpeechPlayer {
  generation = 0;
  audio = null;
  url = null;
  speechID = null;
  browserStop = null;
  finishPlayback = null;
  constructor(deps) {
    this.deps = deps;
  }
  cancel() {
    this.generation++;
    this.browserStop?.();
    this.browserStop = null;
    if (this.speechID) void this.deps.cancelRequest(this.speechID).catch(() => {});
    this.audio?.pause();
    if (this.audio) this.audio.src = '';
    this.audio = null;
    this.finishPlayback?.();
    this.finishPlayback = null;
    if (this.url) this.deps.revokeURL(this.url);
    this.url = null;
    this.speechID = null;
  }
  async speak(text, provider, onDone, onError) {
    this.cancel();
    const generation = this.generation;
    try {
      if (provider === 'browser') {
        await new Promise((resolve) => {
          this.finishPlayback = resolve;
          this.browserStop = this.deps.browserSay(text, resolve);
        });
      } else if (provider === 'openai') {
        for (const chunk of splitSpeech(text)) {
          if (generation !== this.generation) return;
          const speechID = this.deps.id();
          this.speechID = speechID;
          let response;
          try {
            response = await this.deps.synthesize(chunk, speechID);
            if (generation !== this.generation) return;
            const bytes = await this.deps.load(response.artifactId);
            if (generation !== this.generation) return;
            const url = this.deps.createURL(new Blob([bytes], { type: response.mime }));
            this.url = url;
            const audio = this.deps.makeAudio(url);
            this.audio = audio;
            await new Promise((resolve, reject) => {
              this.finishPlayback = resolve;
              audio.onended = resolve;
              audio.onerror = () => reject(new Error('Speech audio could not be played'));
              try {
                Promise.resolve(audio.play()).catch(reject);
              } catch (e) {
                reject(e);
              }
            });
            if (this.url === url) {
              audio.src = '';
              this.deps.revokeURL(url);
              this.url = null;
              this.audio = null;
            }
          } finally {
            if (response?.artifactId) await this.deps.release(response.artifactId).catch(() => {});
            if (this.speechID === speechID) this.speechID = null;
          }
        }
      } else throw new Error('Unknown speech provider');
    } catch (e) {
      if (generation === this.generation) onError?.(e);
    } finally {
      if (generation === this.generation) {
        this.browserStop = null;
        this.finishPlayback = null;
        if (this.url) this.deps.revokeURL(this.url);
        this.url = null;
        this.audio = null;
        onDone?.();
      }
    }
  }
}
