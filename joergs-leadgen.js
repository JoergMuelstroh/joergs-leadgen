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
    contact_name TEXT,
    email TEXT UNIQUE,
    phone TEXT,
    plz TEXT,
    industry TEXT,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
    return [];
  }
}

app.get('/api/stats', (req, res) => {
  db.all('SELECT COUNT(*) as total_leads FROM leads', (err, rows) => {
    const total = (rows && rows[0]) ? rows[0].total_leads : 0;
    res.json({ total_leads: total, new_leads: total, contacted: 0, responses: 0 });
  });
});

app.get('/api/leads', (req, res) => {
  db.all('SELECT * FROM leads ORDER BY created_at DESC LIMIT 50', (err, rows) => {
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
    for (let lead of allLeads) {
      db.run(
        'INSERT OR IGNORE INTO leads (company_name, contact_name, email, phone, plz, industry, status) VALUES (?, ?, ?, ?, ?, ?, "new")',
        [lead.company_name, 'Geschaeftsfuehrer', 'info@' + lead.company_name.substring(0, 5) + '.de', lead.phone, lead.plz, lead.industry],
        function(err) { if (!err) inserted++; }
      );
    }
    
    res.json({ message: 'Finder abgeschlossen', total_found: allLeads.length, inserted: inserted });
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joergs Leadgenerierung</title><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:Arial,sans-serif;background:#f5f5f5;}.container{max-width:1200px;margin:0 auto;padding:20px;}header{background:#1a1a1a;color:#fff;padding:20px;border-radius:8px;margin-bottom:20px;}h1{font-size:28px;margin-bottom:10px;}.subtitle{font-size:14px;opacity:0.8;}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin:20px 0;}.stat-box{background:white;padding:20px;border-radius:8px;border-left:4px solid #4CAF50;}.stat-number{font-size:28px;font-weight:bold;color:#4CAF50;}.stat-label{font-size:12px;color:#666;margin-top:5px;text-transform:uppercase;}.controls{margin:20px 0;}button{background:#4CAF50;color:white;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:16px;}button:hover{background:#45a049;}button:disabled{opacity:0.6;cursor:not-allowed;}.message{padding:12px;border-radius:5px;margin-bottom:15px;background:#d4edda;color:#155724;display:none;}.message.show{display:block;}table{background:white;border-collapse:collapse;width:100%;border-radius:8px;margin-top:20px;}th{background:#f0f0f0;padding:12px;text-align:left;font-weight:600;border-bottom:1px solid #ddd;}td{padding:12px;border-bottom:1px solid #eee;}tr:hover{background:#f9f9f9;}.empty{padding:20px;text-align:center;color:#666;}</style></head><body><div class="container"><header><h1>🚀 Joergs Leadgenerierung</h1><p class="subtitle">Automatisierte Leadgenerierung für Baumaschinen-Verkauf</p></header><div class="message" id="message"></div><div class="stats"><div class="stat-box"><div class="stat-number" id="total">0</div><div class="stat-label">Gesamt Leads</div></div><div class="stat-box"><div class="stat-number" id="new">0</div><div class="stat-label">Neue Leads</div></div><div class="stat-box"><div class="stat-number" id="contacted">0</div><div class="stat-label">Kontaktiert</div></div></div><div class="controls"><button id="finder-btn" onclick="runFinder()">🔍 Finder starten</button></div><h2 style="margin-top:30px;margin-bottom:15px;">Aktuelle Leads</h2><div id="leads-container"><div class="empty">Keine Leads - Finder starten!</div></div></div><script>async function loadData(){try{const res=await fetch('/api/stats');const stats=await res.json();document.getElementById('total').textContent=stats.total_leads;document.getElementById('new').textContent=stats.new_leads;document.getElementById('contacted').textContent=stats.contacted;const res2=await fetch('/api/leads');const leads=await res2.json();const container=document.getElementById('leads-container');if(leads.length===0){container.innerHTML='<div class="empty">Keine Leads - Finder starten!</div>';return;}let html='<table><thead><tr><th>Unternehmen</th><th>Email</th><th>Branche</th><th>PLZ</th><th>Status</th></tr></thead><tbody>';for(let lead of leads){html+='<tr><td><strong>'+lead.company_name+'</strong></td><td>'+lead.email+'</td><td>'+lead.industry+'</td><td>'+lead.plz+'</td><td>'+lead.status+'</td></tr>';}html+='</tbody></table>';container.innerHTML=html;}catch(e){console.error('Error:',e);}}async function runFinder(){const btn=document.getElementById('finder-btn');btn.disabled=true;btn.textContent='Läuft...';const msg=document.getElementById('message');msg.classList.remove('show');try{const res=await fetch('/api/finder/run',{method:'POST'});const data=await res.json();msg.textContent='✓ '+data.message+': '+data.inserted+' neue Leads';msg.classList.add('show');setTimeout(()=>{loadData();btn.disabled=false;btn.textContent='🔍 Finder starten';},2000);}catch(e){msg.textContent='✗ Fehler beim Ausführen';msg.classList.add('show');btn.disabled=false;btn.textContent='🔍 Finder starten';}}loadData();</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✓ Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
