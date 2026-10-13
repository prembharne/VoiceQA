// Owned live-AI acceptance application. No VoiceQA metadata or planner contracts.
import http from 'node:http';
const page = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Atlas Workshops</title>
<style>body{font:16px system-ui;margin:40px;max-width:720px}label{display:block;margin:18px 0}input,select,button{font:inherit;padding:10px}button{cursor:pointer}</style>
<h1>Atlas Workshops</h1><p>Basic workshop costs $15 per seat. Advanced workshop costs $25 per seat. Choose between 1 and 4 seats. Bookings are synthetic test data. A successful submission displays Booking confirmed for the attendee name.</p>
<a href="/help">Workshop help</a><form id="booking"><label>Attendee<input id="attendee" required pattern="[A-Za-z][A-Za-z .-]{1,39}" minlength="2" maxlength="40"></label>
<label>Workshop<select id="workshop"><option value="basic">Basic</option><option value="advanced">Advanced</option></select></label>
<label>Seats<input id="seats" type="number" value="1" min="1" max="4" required></label>
<p>Total: <output id="total" aria-label="Booking total">$15.00</output></p><button>Book workshop</button></form>
<p role="status" id="confirmation"></p><label>Theme<select id="theme"><option value="light">Light</option><option value="dark">Dark</option></select></label>
<script>
const form=document.querySelector('#booking'), total=document.querySelector('#total');
form.addEventListener('input',()=>{total.textContent='$'+((document.querySelector('#workshop').value==='advanced'?25:15)*Number(document.querySelector('#seats').value)).toFixed(2)});
form.addEventListener('submit',e=>{e.preventDefault();document.querySelector('#confirmation').textContent='Booking pending';setTimeout(()=>{document.querySelector('#confirmation').textContent='Booking confirmed for '+document.querySelector('#attendee').value},350)});
const theme=document.querySelector('#theme');theme.value=localStorage.getItem('theme')||'light';theme.addEventListener('change',()=>localStorage.setItem('theme',theme.value));
</script></html>`;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/') res.end(page);
    else if (req.url === '/help')
      res.end(
        '<!doctype html><html lang="en"><title>Workshop Help</title><h1>Workshop Help</h1><p>Bookings are synthetic. Select 1 to 4 seats. Cancellation is allowed until 24 hours before the workshop starts.</p><a href="/">Return to workshops</a></html>',
      );
    else {
      res.statusCode = 404;
      res.end('Not found');
    }
  })
  .listen(4177, '127.0.0.1', () => console.log('Owned generic browser lab on 4177'));
