import http from 'node:http';

// An operator-selected negative fixture changes only the final receipt. The
// pricing and review remain correct, so an independently derived oracle detects it.
const receiptError = process.argv.includes('--incorrect-total') ? 25 : 0;

// Only the current stage exists in the DOM. There is no fixture marker or hidden
// planner contract: the actor must observe the new controls after each Next click.
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>TravelForge Reservations</title>
<style>body{font:16px system-ui;margin:48px;max-width:720px}label{display:block;margin:20px 0}input,select,button{font:inherit;padding:12px}button{margin-right:12px}output{font-weight:bold}</style>
<h1>TravelForge Reservations</h1><p>Complete the reservation journey. All reservations and charges are synthetic.</p><main id="stage"></main>
<script>
let step=0,count=0;const data={name:'',city:'',people:1};const main=document.querySelector('#stage');
function render(){
 if(step===0){main.innerHTML='<h2>Traveller details</h2><form><label>Full name<input id="traveller" required></label><button>Next</button></form>';main.querySelector('form').onsubmit=e=>{e.preventDefault();data.name=document.querySelector('#traveller').value;step=1;render()}}
 if(step===1){main.innerHTML='<h2>Choose a destination</h2><form><label>Destination<select id="destination" required><option value="">Choose a city</option><option value="tokyo">Tokyo</option><option value="osaka">Osaka</option></select></label><button>Next</button></form>';main.querySelector('form').onsubmit=e=>{e.preventDefault();data.city=document.querySelector('#destination').value;step=2;render()}}
 if(step===2){main.innerHTML='<h2>Party size</h2><p>Tokyo costs $200 per traveller. Osaka costs $150 per traveller. A $10 service fee is added once per reservation.</p><form><label>Travellers<input id="people" type="number" min="1" max="6" value="1" required></label><button>Review</button></form>';main.querySelector('form').onsubmit=e=>{e.preventDefault();data.people=Number(document.querySelector('#people').value);step=3;render()}}
 if(step===3){main.innerHTML='<h2>Review reservation</h2><p id="review-name"></p><p id="review-city"></p><p id="review-people"></p><p>Total: <output id="review-total"></output></p><button id="confirm">Confirm reservation</button>';document.querySelector('#review-name').textContent=data.name;document.querySelector('#review-city').textContent=data.city==='tokyo'?'Tokyo':'Osaka';document.querySelector('#review-people').textContent=data.people+' travellers';document.querySelector('#review-total').textContent='$'+((data.city==='tokyo'?200:150)*data.people+10).toFixed(2);document.querySelector('#confirm').onclick=()=>{count++;step=4;render()}}
 if(step===4){main.innerHTML='<h2>Reservation confirmed</h2><p id="receipt" role="status"></p><p id="submitted"></p>';document.querySelector('#receipt').textContent='Reservation R-'+count+' confirmed for '+data.name+': '+data.people+' travellers to '+(data.city==='tokyo'?'Tokyo':'Osaka')+', total $'+((data.city==='tokyo'?200:150)*data.people+10+${receiptError}).toFixed(2);document.querySelector('#submitted').textContent='Reservations submitted: '+count}
}
render();
</script></html>`;
http
  .createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/') res.end(html);
    else {
      res.statusCode = 404;
      res.end('Not found');
    }
  })
  .listen(4178, '127.0.0.1', () =>
    console.log(`Owned adaptive wizard on 4178 (receipt error: ${receiptError})`),
  );
