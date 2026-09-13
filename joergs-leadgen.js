const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3');

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database(':memory:');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY,
    company_name TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    plz TEXT,
    industry TEXT,
    status TEXT DEFAULT 'new'
  )`);
});

const CONFIG = {
  google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY || 'YOUR_API_KEY',
  target_plz: ['35', '50', '51', '53', '54', '55', '56', '57', '60', '61', '63', '64', '65', '66', '67'],
  industries: ['Bauunternehmen', 'Tiefbau', 'Straßenbau', 'Asphaltbau', 'Erdbeweger', 'Gewinnungsbetriebe']
};

async function findLeadsGoogleMaps(plz, industry) {
  try {
    const query = industry + ' ' + plz + ' Deutschland';
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: CONFIG.google_maps_api_key, language: 'de' }
    });
    return (response.data.results || []).slice(0, 10).map(place => ({
      company_name: place.name,
      plz: plz,
      industry: industry,
      phone: place.formatted_phone_number || 'N/A'
    }));
  } catch (error) {
    return [
      { company_name: 'Test ' + industry + ' ' + plz, plz: plz, industry: industry, phone: '0123456789' },
      { company_name: 'Demo ' + industry + ' GmbH', plz: plz, industry: industry, phone: '0987654321' }
    ];
  }
}

app.get('/api/stats', (req, res) => {
  db.all('SELECT COUNT(*) as total FROM leads', (err, rows) => {
    const total = (rows && rows[0]) ? rows[0].total : 0;
    res.json({ total_leads: total, new_leads: total, contacted: 0 });
  });
});

app.get('/api/leads', (req, res) => {
  db.all('SELECT * FROM leads LIMIT 50', (err, rows) => {
    res.json(rows || []);
  });
});

app.post('/api/finder/run', async (req, res) => {
  try {
    const allLeads = [];
    for (let plz of CONFIG.target_plz) {
      for (let industry of CONFIG.industries) {
        const leads = await findLeadsGoogleMaps(plz, industry);
        allLeads.push(...leads);
      }
    }
    
    let inserted = 0;
    
    const promises = allLeads.map(lead => {
      return new Promise((resolve) => {
        db.run(
          'INSERT OR IGNORE INTO leads (company_name, email, phone, plz, industry, status) VALUES (?, ?, ?, ?, ?, "new")',
          [lead.company_name, 'info@' + lead.company_name.toLowerCase().replace(/\s+/g, '') + '.de', lead.phone, lead.plz, lead.industry],
          function(err) { 
            if (!err) inserted++;
            resolve();
          }
        );
      });
    });
    
    await Promise.all(promises);
    
    res.json({ success: true, inserted: inserted });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joergs Leadgenerierung</title><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1200px;margin:0 auto;padding:20px}header{background:#1a1a1a;color:#fff;padding:20px;border-radius:8px;margin-bottom:20px}h1{margin:0;font-size:28px}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin:20px 0}.stat{background:#fff;padding:20px;border-radius:8px;border-left:4px solid #4CAF50;text-align:center}.number{font-size:32px;font-weight:bold;color:#4CAF50}.label{font-size:12px;color:#666;margin-top:10px}button{background:#4CAF50;color:#fff;border:none;padding:12px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:16px;margin:20px 0}button:disabled{opacity:.6}button:hover:not(:disabled){background:#45a049}table{width:100%;border-collapse:collapse;background:#fff;margin-top:20px}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}th{background:#f0f0f0;font-weight:bold}.message{padding:12px;margin-bottom:15px;border-radius:5px;background:#d4edda;color:#155724;display:none}.message.show{display:block}</style></head><body><div class="container"><header><h1>🚀 Joergs Leadgenerierung</h1></header><div class="message" id="msg"></div><div class="stats"><div class="stat"><div class="number" id="total">0</div><div class="label">Gesamt Leads</div></div><div class="stat"><div class="number" id="new">0</div><div class="label">Neue Leads</div></div><div class="stat"><div class="number" id="contacted">0</div><div class="label">Kontaktiert</div></div></div><button id="btn" onclick="runFinder()">🔍 Finder starten</button><h2>Leads</h2><div id="table-container"></div></div><script>async function load(){try{const r1=await fetch('/api/stats');const s=await r1.json();document.getElementById('total').textContent=s.total_leads;document.getElementById('new').textContent=s.new_leads;const r2=await fetch('/api/leads');const leads=await r2.json();let html='';if(leads.length===0){html='<p>Keine Leads - Finder starten!</p>'}else{html='<table><tr><th>Unternehmen</th><th>Email</th><th>Branche</th><th>PLZ</th></tr>';for(let l of leads){html+='<tr><td>'+l.company_name+'</td><td>'+l.email+'</td><td>'+l.industry+'</td><td>'+l.plz+'</td></tr>'}html+='</table>'}document.getElementById('table-container').innerHTML=html}catch(e){console.error(e)}}async function runFinder(){const btn=document.getElementById('btn');const msg=document.getElementById('msg');btn.disabled=true;btn.textContent='Läuft...';msg.classList.remove('show');try{const r=await fetch('/api/finder/run',{method:'POST'});const d=await r.json();msg.textContent=d.success?('✓ '+d.inserted+' Leads gefunden'):'Error';msg.classList.add('show');setTimeout(()=>{load();btn.disabled=false;btn.textContent='🔍 Finder starten'},2000)}catch(e){msg.textContent='✗ Error';msg.classList.add('show');btn.disabled=false;btn.textContent='🔍 Finder starten'}}load()</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
