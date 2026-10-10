import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer, splitSpeech } from '../../shared/speech-player.js';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function dependencies(overrides = {}) {
  return {
    id: () => 'speech-id',
    synthesize: async () => ({ artifactId: 'clip', mime: 'audio/mpeg' }),
    load: async () => new Blob(['audio']),
    release: async () => {},
    cancelRequest: async () => {},
    browserSay: (_text, done) => {
      done();
      return () => {};
    },
    createURL: () => 'blob:clip',
    revokeURL: () => {},
    makeAudio: () => ({
      play() {
        queueMicrotask(() => this.onended());
        return Promise.resolve();
      },
      pause() {},
    }),
    ...overrides,
  };
}
test('long speech is split into API-sized chunks without dropping words', () => {
  const text = 'hello '.repeat(1000).trim();
  const chunks = splitSpeech(text);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 1800));
  assert.equal(chunks.join(' '), text);
});
test('API playback releases temporary artifacts and revokes URLs', async () => {
  const releases = [],
    revoked = [];
  let done = false;
  const player = new SpeechPlayer(
    dependencies({
      release: async (id) => releases.push(id),
      revokeURL: (url) => revoked.push(url),
    }),
  );
  await player.speak('Hello', 'openai', () => (done = true), assert.fail);
  assert.equal(done, true);
  assert.deepEqual(releases, ['clip']);
  assert.deepEqual(revoked, ['blob:clip']);
});
test('cancellation during generation prevents late audio playback', async () => {
  const response = deferred();
  let played = false;
  const released = [];
  const player = new SpeechPlayer(
    dependencies({
      synthesize: () => response.promise,
      makeAudio: () => {
        played = true;
        throw new Error('should not play');
      },
      release: async (id) => released.push(id),
    }),
  );
  const task = player.speak('Hello', 'openai', () => {}, assert.fail);
  player.cancel();
  response.resolve({ artifactId: 'late', mime: 'audio/mpeg' });
  await task;
  assert.equal(played, false);
  assert.deepEqual(released, ['late']);
});
test('API errors remain explicit and never silently switch to browser speech', async () => {
  let error,
    browserUsed = false;
  const player = new SpeechPlayer(
    dependencies({
      synthesize: async () => {
        throw new Error('key missing');
      },
      browserSay: () => {
        browserUsed = true;
      },
    }),
  );
  await player.speak(
    'Hello',
    'openai',
    () => {},
    (e) => (error = e),
  );
  assert.equal(error.message, 'key missing');
  assert.equal(browserUsed, false);
});
