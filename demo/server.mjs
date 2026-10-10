import http from 'node:http';
import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('./shop.html',import.meta.url));
const server=http.createServer((req,res)=>{
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'text/plain'});res.end('ok');return;}
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end(html);
});
server.listen(Number(process.env.PORT||4173),'127.0.0.1',()=>console.log('VoiceQA demo shop: http://127.0.0.1:4173'));
