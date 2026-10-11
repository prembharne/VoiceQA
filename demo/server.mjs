import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { labRequest } from './lab-server.mjs';
const [shop, advanced, child] = await Promise.all(
  ['shop.html', 'advanced.html', 'child.html'].map((name) =>
    readFile(new URL(name, import.meta.url)),
  ),
);
function codeAt(seconds) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / 30)));
  const digest = createHmac('sha1', Buffer.from('12345678901234567890')).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const server = http.createServer(async (req, res) => {
  if (await labRequest(req, res)) return;
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  if (path === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (path === '/advanced/verify-otp' && req.method === 'POST') {
    let body = '';
    try {
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 4096) throw new Error('oversize');
      }
      const p = JSON.parse(body);
      const now = Math.floor(Date.now() / 1000);
      const candidate = Buffer.from(String(p.code || ''));
      const valid = [now - 30, now, now + 30].some((t) => {
        const expected = Buffer.from(codeAt(t));
        return candidate.length === expected.length && timingSafeEqual(candidate, expected);
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(
        JSON.stringify({
          ok: p.username === 'qa@voiceqa.test' && p.password === 'fixture-only' && valid,
        }),
      );
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"ok":false}');
    }
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(path === '/advanced' ? advanced : path === '/advanced/child' ? child : shop);
});
server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () =>
  console.log(`VoiceQA demo: http://127.0.0.1:${process.env.PORT || 4173}`),
);
