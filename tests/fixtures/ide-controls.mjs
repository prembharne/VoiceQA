// Owned control regression fixture based on inspected IDE DOM patterns. This
// saves source text; it deliberately does not pretend to compile Solidity.
import http from 'node:http';

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Source Studio</title>
<style>body{font:16px system-ui;margin:32px;background:#171b25;color:#eef1f8}button,input{font:inherit;padding:10px;margin:8px}main{display:flex;gap:30px}aside{width:260px}[draggable]{padding:16px;cursor:pointer;border:1px solid #6f82a0}[role=code]{position:relative;width:650px;height:360px;border:1px solid #6f82a0;padding:16px;overflow:auto}textarea{position:absolute;top:16px;left:16px;width:1px;height:1px;padding:0;border:0}pre{white-space:pre-wrap;pointer-events:none}#saved-source{max-width:850px}</style>
<h1>Source Studio</h1><p>Create a file inside the selected folder, edit its source and save. All files exist only in this synthetic browser session.</p>
<main><aside><div data-id="treeViewDivDraggableItemcontracts" draggable="true">contracts</div><p id="selected">No folder selected</p><button id="create">Create</button><div id="new-file"></div><ul id="files"></ul></aside><section id="workspace"><h2>No file open</h2></section></main><section id="saved"></section>
<script>
let folder='',filename='',source='',saves=0;
const $=s=>document.querySelector(s);
$('[draggable]').onclick=()=>{folder='contracts';$('#selected').textContent='Selected folder: contracts'};
$('#create').onclick=()=>{if(!folder){$('#selected').textContent='Select a folder first';return}$('#new-file').innerHTML='<button id="new">New file</button>';$('#new').onclick=()=>{$('#new-file').innerHTML='<input data-id="fileExplorerTreeItemInput">';const field=$('#new-file input');field.focus();field.onkeydown=e=>{if(e.key!=='Enter'||!field.value.trim())return;filename=field.value.trim();$('#files').textContent=folder+'/'+filename;$('#new-file').replaceChildren();$('#workspace').innerHTML='<h2 id="open-path"></h2><div role="code"><pre></pre><textarea aria-label="Editor content;Press Alt+F1 for Accessibility Options." aria-roledescription="editor" role="textbox" aria-multiline="true"></textarea></div><button id="save">Save file</button>';$('#open-path').textContent=folder+'/'+filename;const editor=$('[role=code]'),input=editor.querySelector('textarea');editor.onclick=()=>input.focus();input.oninput=()=>{source=input.value;editor.querySelector('pre').textContent=source};input.focus();$('#save').onclick=()=>{saves++;$('#saved').innerHTML='<h2>File saved</h2><p id="saved-path"></p><pre id="saved-source"></pre><p id="save-count"></p>';$('#saved-path').textContent=folder+'/'+filename;$('#saved-source').textContent=source;$('#save-count').textContent='Saves: '+saves}}}};
</script></html>`;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.statusCode = req.url === '/' ? 200 : 404;
    res.end(req.url === '/' ? html : 'Not found');
  })
  .listen(4177, '127.0.0.1', () => console.log('Owned IDE control fixture on 4177'));
