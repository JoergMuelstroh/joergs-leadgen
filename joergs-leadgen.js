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
    linkedin_url TEXT,
    source TEXT,
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
    return (response.data.results || []).map(place => ({
      company_name: place.name,
      plz: plz,
      industry: industry,
      phone: place.formatted_phone_number || 'N/A'
    })).slice(0, 10);
  } catch (error) {
    console.error('Error:', error.message);
    return [];
  }
}

function enrichLead(lead) {
  const domain = lead.company_name.toLowerCase().replace(/\s+/g, '').substring(0, 10);
  return {
    ...lead,
    email: 'info@' + domain + '.de',
    linkedin_url: 'https://linkedin.com/company/' + domain,
    contact_name: 'Geschaeftsfuehrer'
  };
}

app.get('/api/stats', (req, res) => {
  db.all('SELECT COUNT(*) as total_leads, SUM(CASE WHEN status = "new" THEN 1 ELSE 0 END) as new_leads, SUM(CASE WHEN status = "contacted" THEN 1 ELSE 0 END) as contacted FROM leads', (err, rows) => {
    res.json(rows && rows[0] ? rows[0] : { total_leads: 0, new_leads: 0, contacted: 0 });
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
    for (let i = 0; i < CONFIG.target_plz.length; i++) {
      for (let j = 0; j < CONFIG.industries.length; j++) {
        const leads = await findLeadsGoogleMaps(CONFIG.target_plz[i], CONFIG.industries[j]);
        allLeads.push(...leads);
      }
    }
    const enriched = allLeads.map(enrichLead);
    let inserted = 0;
    for (let lead of enriched) {
      db.run(
        'INSERT OR IGNORE INTO leads (company_name, contact_name, email, phone, plz, industry, linkedin_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, "new")',
        [lead.company_name, lead.contact_name, lead.email, lead.phone, lead.plz, lead.industry, lead.linkedin_url],
        function(err) { if (!err) inserted++; }
      );
    }
    res.json({ message: 'Finder abgeschlossen', total_found: enriched.length, inserted });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joergs Leadgenerierung</title><script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script><script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script><script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"></script><style>*{margin:0;padding:0;box-sizing:border-box;}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f5;}.container{max-width:1200px;margin:0 auto;padding:20px;}header{background:#1a1a1a;color:#fff;padding:20px;border-radius:8px;margin-bottom:20px;}h1{font-size:28px;margin-bottom:10px;}.subtitle{font-size:14px;opacity:0.8;}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:15px;margin:20px 0;}.stat-box{background:#fff;padding:20px;border-radius:8px;border-left:4px solid #4CAF50;}.stat-number{font-size:28px;font-weight:bold;color:#4CAF50;}.stat-label{font-size:12px;color:#666;margin-top:5px;text-transform:uppercase;}button{background:#4CAF50;color:#fff;border:none;padding:10px 20px;border-radius:5px;cursor:pointer;font-weight:bold;}button:hover{background:#45a049;}button:disabled{opacity:0.6;cursor:not-allowed;}.leads-table{background:#fff;border-collapse:collapse;width:100%;border-radius:8px;margin-top:20px;}.leads-table th{background:#f0f0f0;padding:12px;text-align:left;font-weight:600;border-bottom:1px solid #ddd;}.leads-table td{padding:12px;border-bottom:1px solid #eee;}.message{padding:12px;border-radius:5px;margin-bottom:15px;background:#d4edda;color:#155724;}</style></head><body><div id="root"></div><script type="text/babel">const {useState,useEffect}=React;function App(){const [leads,setLeads]=useState([]);const [stats,setStats]=useState({});const [loading,setLoading]=useState(false);const [message,setMessage]=useState('');useEffect(()=>{fetchData();},[]);const fetchData=async()=>{try{const res1=await fetch('/api/leads');const leads_data=await res1.json();setLeads(leads_data);const res2=await fetch('/api/stats');const stats_data=await res2.json();setStats(stats_data);}catch(e){setMessage('Fehler beim Laden');}};const runFinder=async()=>{setLoading(true);try{const res=await fetch('/api/finder/run',{method:'POST'});const data=await res.json();setMessage('✓ '+data.message+': '+data.inserted+' neue Leads');setTimeout(()=>{fetchData();setLoading(false);},2000);}catch(e){setMessage('✗ Fehler');setLoading(false);}};return React.createElement('div',{className:'container'},React.createElement('header',null,React.createElement('h1',null,'🚀 Joergs Leadgenerierung'),React.createElement('p',{className:'subtitle'},'Automatisierte Leadgenerierung für Baumaschinen-Verkauf')),message&&React.createElement('div',{className:'message'},message),React.createElement('div',{className:'stats'},React.createElement('div',{className:'stat-box'},React.createElement('div',{className:'stat-number'},stats.total_leads||0),React.createElement('div',{className:'stat-label'},'Gesamt Leads')),React.createElement('div',{className:'stat-box'},React.createElement('div',{className:'stat-number'},stats.new_leads||0),React.createElement('div',{className:'stat-label'},'Neue Leads')),React.createElement('div',{className:'stat-box'},React.createElement('div',{className:'stat-number'},stats.contacted||0),React.createElement('div',{className:'stat-label'},'Kontaktiert'))),React.createElement('div',{style:{marginTop:'20px'}},React.createElement('button',{onClick:runFinder,disabled:loading},loading?'Läuft...':'🔍 Finder starten')),React.createElement('h2',{style:{marginBottom:'15px',marginTop:'20px'}},'Aktuelle Leads'),leads.length===0?React.createElement('div',{style:{padding:'20px',textAlign:'center',color:'#666'}},'Keine Leads - Finder starten!'):React.createElement('table',{className:'leads-table'},React.createElement('thead',null,React.createElement('tr',null,React.createElement('th',null,'Unternehmen'),React.createElement('th',null,'Email'),React.createElement('th',null,'Branche'),React.createElement('th',null,'PLZ'),React.createElement('th',null,'Status'))),React.createElement('tbody',null,leads.map(lead=>React.createElement('tr',{key:lead.id},React.createElement('td',null,React.createElement('strong',null,lead.company_name)),React.createElement('td',null,lead.email),React.createElement('td',null,lead.industry),React.createElement('td',null,lead.plz),React.createElement('td',null,lead.status)))))));}ReactDOM.render(React.createElement(App),document.getElementById('root'));</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✓ Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
  console.log('✓ Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
