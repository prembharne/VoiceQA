// Owned server-backed multi-tab acceptance app; no VoiceQA planner contract.
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const sessions = new Map();
const staleOriginal = process.argv.includes('--stale-original');
function session(req, res) {
  const id = /(?:^|;\s*)workspace_session=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1];
  if (id && sessions.has(id)) return sessions.get(id);
  if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
  const key = randomBytes(16).toString('hex');
  const value = {
    csrf: randomBytes(20).toString('hex'),
    project: null,
    theme: 'light',
    creations: 0,
  };
  sessions.set(key, value);
  res.setHeader('Set-Cookie', `workspace_session=${key}; HttpOnly; SameSite=Strict; Path=/`);
  return value;
}
function page(review, state) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>WorkLedger ${review ? 'Review workspace' : 'Projects'}</title>
<meta name="csrf-token" content="${state.csrf}"><style>body{font:16px system-ui;margin:40px;max-width:760px}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:12px}output{display:block;margin:20px 0}a{display:block;margin:20px 0}</style>
<h1>WorkLedger ${review ? 'Review workspace' : 'Projects'}</h1><p>All data is synthetic. Starter costs $10 per seat; Pro costs $24 per seat. A $12 setup fee is added once per project. Theme changes must not change project details.</p>
${review ? `<h2>Project review</h2><output id="review-project" role="status"></output><form id="preferences"><label>Theme<select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label><button>Save preferences</button></form><output id="saved-theme" role="status"></output><a href="/">Original projects page</a>` : `<h2>Create a project</h2><form id="create"><label>Project name<input id="name" required maxlength="40" pattern="[A-Za-z0-9 ._-]+"></label><label>Plan<select id="plan"><option value="starter">Starter</option><option value="pro">Pro</option></select></label><label>Seats<input id="seats" type="number" value="1" min="1" max="10" required></label><button>Create project</button></form><output id="project-summary" role="status"></output><output id="creation-count"></output><a href="/review">Review workspace</a>`}
<script>
const review=${review}, broken=${staleOriginal};const channel=new BroadcastChannel('workledger-updates');
const csrf=document.querySelector('meta[name=csrf-token]').content;
const describe=p=>p?'Project '+p.name+' | '+(p.plan==='pro'?'Pro':'Starter')+' | '+p.seats+' seats | Total $'+p.total.toFixed(2):'No project yet';
async function refresh(){const state=await fetch('/api/state').then(r=>r.json());document.querySelector(review?'#review-project':'#project-summary').textContent=describe(state.project);if(review){document.querySelector('#theme').value=state.theme;document.querySelector('#saved-theme').textContent='Saved theme: '+state.theme}else document.querySelector('#creation-count').textContent='Projects created: '+state.creations;}
async function write(path,body){const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify(body)});if(!response.ok)throw new Error('Request rejected');return response.json()}
if(review){document.querySelector('#preferences').onsubmit=async e=>{e.preventDefault();await write('/api/preferences',{theme:document.querySelector('#theme').value});await refresh();channel.postMessage('theme-saved')}}else{document.querySelector('#create').onsubmit=async e=>{e.preventDefault();await write('/api/projects',{name:document.querySelector('#name').value,plan:document.querySelector('#plan').value,seats:Number(document.querySelector('#seats').value)});await refresh()};channel.onmessage=()=>{if(broken)document.querySelector('#project-summary').textContent='Project details unavailable after workspace update';else refresh()};}
refresh();
</script></html>`;
}
const server = http.createServer(async (req, res) => {
  const state = session(req, res);
  if (req.method === 'GET' && ['/', '/review'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(page(req.url === '/review', state));
    return;
  }
  res.setHeader('Content-Type', 'application/json');
  const send = (status, value) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  if (req.method === 'GET' && req.url === '/api/state') {
    send(200, { project: state.project, theme: state.theme, creations: state.creations });
    return;
  }
  if (req.method !== 'POST' || !['/api/projects', '/api/preferences'].includes(req.url)) {
    send(404, { error: 'Not found' });
    return;
  }
  if (req.headers['x-csrf-token'] !== state.csrf) {
    send(403, { error: 'CSRF token required' });
    return;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 4096) {
      send(413, { error: 'Body too large' });
      return;
    }
  }
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    send(400, { error: 'Invalid JSON' });
    return;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(422, { error: 'Object body required' });
    return;
  }
  if (req.url === '/api/projects') {
    if (state.project) {
      send(409, { error: 'Project already exists' });
      return;
    }
    if (
      !/^[A-Za-z0-9 ._-]{1,40}$/.test(body.name || '') ||
      !['starter', 'pro'].includes(body.plan) ||
      !Number.isInteger(body.seats) ||
      body.seats < 1 ||
      body.seats > 10
    ) {
      send(422, { error: 'Invalid project' });
      return;
    }
    state.project = {
      name: body.name,
      plan: body.plan,
      seats: body.seats,
      total: (body.plan === 'pro' ? 24 : 10) * body.seats + 12,
    };
    state.creations++;
  } else {
    if (!['light', 'dark'].includes(body.theme)) {
      send(422, { error: 'Invalid theme' });
      return;
    }
    state.theme = body.theme;
  }
  send(200, { saved: true });
});
server.listen(4179, '127.0.0.1', () =>
  console.log(`Owned WorkLedger multi-tab app on 4179 (stale original: ${staleOriginal})`),
);
