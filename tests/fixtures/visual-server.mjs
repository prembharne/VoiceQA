import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const html = await readFile(new URL('./visual-workspace.html', import.meta.url));
createServer((req, res) => {
  res.writeHead(req.url === '/' ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(req.url === '/' ? html : 'Not found');
}).listen(4181, '127.0.0.1', () => console.log('Owned visual fixture at http://127.0.0.1:4181/'));
