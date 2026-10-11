import { createHmac, timingSafeEqual } from 'node:crypto';
export function codeAt(seconds) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
export function validCode(candidate, now = Math.floor(Date.now() / 1000)) {
  const actual = Buffer.from(String(candidate || ''));
  return [now - 30, now, now + 30].some((t) => {
    const expected = Buffer.from(codeAt(t));
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
