import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./visual-workspace.html', import.meta.url));
const timing = await readFile(new URL('./timing-workspace.html', import.meta.url));
createServer((req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1:4181').pathname;
  const page = path === '/' ? html : path === '/timing' ? timing : null;
  res.writeHead(page ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(page || 'Not found');
}).listen(4181, '127.0.0.1', () => console.log('Owned visual fixture at http://127.0.0.1:4181/'));
