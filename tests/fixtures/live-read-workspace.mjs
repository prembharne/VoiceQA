// Owned persistent workspace. Validation patterns must be discovered from the
// actual field; no VoiceQA fixture marker or planner contract is supplied.
import http from 'node:http';
const corruptStatus = process.argv.includes('--incorrect-status');
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Release Studio</title>
<style>body{font:16px system-ui;margin:32px;background:#f5f7fb;color:#19243a}nav{display:flex;gap:6px;flex-wrap:wrap}button,input{font:inherit;padding:10px}nav button{padding:4px}label{display:block;margin:16px 0}section{background:white;border:1px solid #ccd5e3;border-radius:12px;padding:24px;margin:24px 0;max-width:700px}[role=listbox]{border:1px solid #ccd5e3;padding:10px}output{font-weight:600}</style>
<h1>Release Studio</h1><p>A synthetic workspace for preparing release notes. Saves stay in this browser profile.</p><nav aria-label="Workspace shortcuts">${Array.from({ length: 65 }, (_, i) => '<button>Workspace ' + (i + 1) + '</button>').join('')}</nav>
<button id="create-release">Create release</button><main></main><section id="record"><h2>Latest release</h2><div id="receipt"></div></section>
<script>
const $=s=>document.querySelector(s);let data=JSON.parse(localStorage.getItem('release-studio')||'null');
function receipt(){const root=$('#receipt');root.replaceChildren();if(!data){root.textContent='No saved release';return}for(const [id,value]of Object.entries({title:data.title,handle:data.handle,status:data.status,saves:String(data.saves)})){const line=document.createElement('p');line.id='saved-'+id;line.textContent=value;root.append(line)}}
receipt();
$('#create-release').onclick=()=>{document.querySelector('main').innerHTML='<section role="dialog" aria-label="New release"><h2>New release</h2><form id="release-form"><label>Release title<input id="release-title" required maxlength="60"></label><label>Release handle<input id="release-handle" required pattern="rel-[a-z]{4,8}" minlength="8" maxlength="12" aria-describedby="handle-help"></label><p id="handle-help">Use a handle matching the field constraints. Saved handles identify this release.</p><button type="button" role="combobox" aria-label="Release status" aria-expanded="false" aria-controls="status-options" id="release-status">Draft</button><div id="status-options" role="listbox" aria-label="Statuses" hidden><button type="button" role="option" aria-selected="true">Draft</button><button type="button" role="option" aria-selected="false">Ready</button><button type="button" role="option" aria-selected="false">Archived</button></div><p id="form-error" role="alert"></p><button>Save release</button></form></section>';const picker=$('#release-status'),options=$('#status-options');picker.onclick=()=>{options.hidden=!options.hidden;picker.setAttribute('aria-expanded',String(!options.hidden))};options.onclick=e=>{if(e.target.getAttribute('role')!=='option')return;picker.textContent=e.target.textContent;for(const option of options.children)option.setAttribute('aria-selected',String(option===e.target));options.hidden=true;picker.setAttribute('aria-expanded','false')};$('#release-form').onsubmit=e=>{e.preventDefault();data={title:$('#release-title').value,handle:$('#release-handle').value,status:picker.textContent,saves:(data?.saves||0)+1};localStorage.setItem('release-studio',JSON.stringify({...data,status:${corruptStatus}?'Archived':data.status}));document.querySelector('main').replaceChildren();receipt()}};
</script></html>`;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = req.url === '/' ? 200 : 404;
    res.end(req.url === '/' ? html : 'Not found');
  })
  .listen(4177, '127.0.0.1', () => console.log('Owned live-read release workspace on 4177'));
