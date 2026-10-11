// Browser speech recognition supplies editable text only. It never submits a
// prompt or executes a command. Older sessions cannot update a newer composer.
export class Dictation {
  constructor(
    createRecognition = () => {
      const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
      if (!Recognition)
        throw new Error(
          'Speech recognition is unavailable in this browser. Use Google Chrome or type your request.',
        );
      return new Recognition();
    },
  ) {
    this.createRecognition = createRecognition;
  }
  static supported() {
    return Boolean(globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition);
  }
  start(onText, onState, onError) {
    this.stop(true);
    let recognition;
    try {
      recognition = this.createRecognition();
    } catch (error) {
      onError(error);
      return;
    }
    const session = { recognition, onState };
    this.session = session;
    const current = () => this.session === session;
    const end = () => {
      if (!current()) return;
      clearTimeout(session.timer);
      this.session = null;
      onState('Idle');
    };
    recognition.lang = globalThis.navigator?.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => {
      if (current()) onState('Listening');
    };
    recognition.onresult = (event) => {
      if (!current()) return;
      const text = Array.from(event.results, (result) => result[0]?.transcript || '')
        .join(' ')
        .trim();
      onText(text.slice(0, 8000));
    };
    recognition.onend = end;
    recognition.onerror = (event) => {
      if (!current()) return;
      const messages = {
        'not-allowed':
          'Microphone access was denied. Allow microphone access for VoiceQA in Chrome, then try again.',
        'service-not-allowed':
          'Chrome speech recognition is unavailable for this session. Use a regular Google Chrome profile or type your request.',
        'audio-capture':
          'No microphone is available. Check your microphone connection and Windows microphone permissions.',
        network:
          'Chrome could not reach its speech recognition service. Check your connection, then try again.',
        'no-speech': 'No speech was detected. Click the microphone and try again.',
      };
      end();
      if (event.error !== 'aborted')
        onError(
          new Error(
            messages[event.error] || 'Transcription failed. Try again or type your request.',
          ),
        );
    };
    onState('Starting microphone…');
    try {
      recognition.start();
      session.timer = setTimeout(() => this.stop(false), 60000);
    } catch (error) {
      end();
      onError(error);
    }
  }
  stop(discard = true) {
    const session = this.session;
    if (!session) return;
    clearTimeout(session.timer);
    if (discard) {
      this.session = null;
      session.onState('Idle');
      try {
        session.recognition.abort();
      } catch {}
    } else {
      // Give the recognizer its final result; bound an absent onend callback.
      session.onState('Finishing transcription…');
      try {
        session.recognition.stop();
      } catch {
        this.stop(true);
        return;
      }
      if (this.session === session) session.timer = setTimeout(() => this.stop(true), 3000);
    }
  }
}
