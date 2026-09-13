const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

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
    return [];
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
    for (let lead of allLeads) {
      db.run(
        'INSERT OR IGNORE INTO leads (company_name, email, phone, plz, industry, status) VALUES (?, ?, ?, ?, ?, "new")',
        [lead.company_name, 'info@test.de', lead.phone, lead.plz, lead.industry],
        function(err) { if (!err) inserted++; }
      );
    }
    
    res.json({ success: true, inserted: inserted });
  } catch (error) {
    res.json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
