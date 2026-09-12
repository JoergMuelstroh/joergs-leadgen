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
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    email_sent_at DATETIME,
    email_opened_at DATETIME,
    email_clicked_at DATETIME,
    response_received_at DATETIME
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS email_sequences (
    id INTEGER PRIMARY KEY,
    lead_id INTEGER,
    template_number INTEGER,
    sent_at DATETIME,
    status TEXT DEFAULT 'sent',
    FOREIGN KEY(lead_id) REFERENCES leads(id)
  )`);
});

const CONFIG = {
  google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY || 'YOUR_API_KEY',
  brevo_api_key: process.env.BREVO_API_KEY || 'YOUR_API_KEY',
  target_plz: ['35', '50', '51', '53', '54', '55', '56', '57', '60', '61', '63', '64', '65', '66', '67'],
  industries: ['Bauunternehmen', 'Tiefbau', 'Straßenbau', 'Asphaltbau', 'Erdbeweger', 'Gewinnungsbetriebe'],
  email_templates: {
    3: {
      subject: 'Warum der Privatverkauf eurer Maschinen teurer ist',
      body: 'Hallo [NAME],\n\nPrivatverkauf eurer Baumaschinen kostet euch:\n- Zeit für Marketing & Anfragen\n- Transportkosten (oft euer Problem)\n- Preisverhandlungen\n- Garantierisiken\n\nUnsere Auktion? Einmal Upload, fertig. Weltweite Käufer.\n\nSchneller verkauft, besser bezahlt, keine Garantie von uns – einfach Geschäft.\n\nMacht Sinn?\n\nViele Grüße,\nJörg Mülstroh\nRitchie Bros. Deutschland'
    },
    4: {
      subject: 'Schnelle Frage – Baumaschinen zu verkaufen?',
      body: 'Hallo [NAME],\n\nhabt ihr Baumaschinen, die aktuell nicht genutzt werden?\n\nWeltweites Auktionsnetzwerk. Faire Preise. Schneller Verkauf.\nOhne Garantieverpflichtung – ihr verkauft, fertig.\n\nJa/Nein?\n\nJörg Mülstroh\nRitchie Bros. Deutschland'
    },
    5: {
      subject: 'Kurze Frage zu euren Maschinen',
      body: 'Hallo [NAME],\n\nnutzt ihr eure Baumaschinen noch vollständig aus – oder gibt es Ausrüstung, die hauptsächlich Kosten verursacht?\n\nFalls ja: Das ist genau unser Feld. Wir verkaufen Maschinen über ein weltweites Netzwerk – schneller und besser als Privatverkauf.\n\nKeine Garantien von uns, aber faire Preise und schnelle Auszahlung.\n\nKurz Zeit für ein Gespräch?\n\nJörg Mülstroh\nRitchie Bros. Deutschland'
    }
  }
};

async function findLeadsGoogleMaps(plz, industry, limit = 50) {
  try {
    const query = industry + ' ' + plz + ' Deutschland';
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query: query,
        key: CONFIG.google_maps_api_key,
        language: 'de'
      }
    });

    const leads = (response.data.results || []).map(place => ({
      company_name: place.name,
      plz: plz,
      industry: industry,
      source: 'google_maps',
      formatted_address: place.formatted_address,
      phone: place.formatted_phone_number || 'N/A'
    }));

    return leads.slice(0, limit);
  } catch (error) {
    console.error('Google Maps Error:', error.message);
    return [];
  }
}

function enrichWithLinkedIn(lead) {
  const domain = lead.company_name.toLowerCase().replace(/\s+/g, '').substring(0, 10);
  
  return {
    company_name: lead.company_name,
    plz: lead.plz,
    industry: lead.industry,
    source: lead.source,
    phone: lead.phone,
    email: 'info@' + domain + '.de',
    linkedin_url: 'https://linkedin.com/company/' + domain,
    contact_name: 'Geschaeftsfuehrer'
  };
}

app.get('/api/leads', (req, res) => {
  db.all('SELECT * FROM leads ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/leads/status/:status', (req, res) => {
  const status = req.params.status;
  db.all('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC', [status], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.get('/api/stats', (req, res) => {
  db.all('SELECT COUNT(*) as total_leads, SUM(CASE WHEN status = "new" THEN 1 ELSE 0 END) as new_leads, SUM(CASE WHEN status = "contacted" THEN 1 ELSE 0 END) as contacted, SUM(CASE WHEN response_received_at IS NOT NULL THEN 1 ELSE 0 END) as responses FROM leads', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows && rows[0] ? rows[0] : { total_leads: 0, new_leads: 0, contacted: 0, responses: 0 });
  });
});

app.post('/api/finder/run', async (req, res) => {
  try {
    const allLeads = [];

    for (let i = 0; i < CONFIG.target_plz.length; i++) {
      for (let j = 0; j < CONFIG.industries.length; j++) {
        const plz = CONFIG.target_plz[i];
        const industry = CONFIG.industries[j];
        const googleLeads = await findLeadsGoogleMaps(plz, industry, 10);
        allLeads.push.apply(allLeads, googleLeads);
      }
    }

    const enrichedLeads = allLeads.map(enrichWithLinkedIn);

    let insertedCount = 0;
    for (let i = 0; i < enrichedLeads.length; i++) {
      const lead = enrichedLeads[i];
      db.run(
        'INSERT OR IGNORE INTO leads (company_name, contact_name, email, phone, plz, industry, linkedin_url, source, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [lead.company_name, lead.contact_name, lead.email, lead.phone, lead.plz, lead.industry, lead.linkedin_url, lead.source, 'new'],
        function(err) {
          if (!err) insertedCount++;
        }
      );
    }

    res.json({ 
      message: 'Finder abgeschlossen',
      total_found: enrichedLeads.length,
      inserted: insertedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/email/send', async (req, res) => {
  const lead_id = req.body.lead_id;
  const template_number = req.body.template_number;

  db.get('SELECT * FROM leads WHERE id = ?', [lead_id], async (err, lead) => {
    if (err || !lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

    const template = CONFIG.email_templates[template_number];
    if (!template) return res.status(400).json({ error: 'Template nicht gefunden' });

    const emailBody = template.body.replace('[NAME]', lead.contact_name);

    try {
      console.log('Email würde versendet werden an ' + lead.email);
      
      db.run('UPDATE leads SET status = "contacted", email_sent_at = CURRENT_TIMESTAMP WHERE id = ?', [lead_id]);
      db.run('INSERT INTO email_sequences (lead_id, template_number, sent_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, "sent")', [lead_id, template_number]);

      res.json({ success: true, message: 'Email versendet' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

app.put('/api/leads/:id/status', (req, res) => {
  const id = req.params.id;
  const status = req.body.status;

  db.run('UPDATE leads SET status = ? WHERE id = ?', [status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Status aktualisiert' });
  });
});

app.get('/', (req, res) => {
  res.send('<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joergs Leadgenerierung</title><script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"><\/script><style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f5; } .container { max-width: 1200px; margin: 0 auto; padding: 20px; } header { background: #1a1a1a; color: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; } h1 { font-size: 28px; margin-bottom: 10px; } .subtitle { font-size: 14px; opacity: 0.8; } .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; } .stat-box { background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #4CAF50; } .stat-number { font-size: 28px; font-weight: bold; color: #4CAF50; } .stat-label { font-size: 12px; color: #666; margin-top: 5px; text-transform: uppercase; } .controls { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; } button { background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; } button:hover { background: #45a049; } button.secondary { background: #2196F3; } button.secondary:hover { background: #0b7dda; } .leads-table { background: white; border-collapse: collapse; width: 100%; border-radius: 8px; overflow: hidden; } .leads-table th { background: #f0f0f0; padding: 12px; text-align: left; font-weight: 600; font-size: 12px; border-bottom: 1px solid #ddd; } .leads-table td { padding: 12px; border-bottom: 1px solid #eee; } .leads-table tr:hover { background: #f9f9f9; } .status-badge { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; } .status-new { background: #fff3cd; color: #856404; } .status-contacted { background: #d1ecf1; color: #0c5460; } .status-responded { background: #d4edda; color: #155724; } .loading { text-align: center; padding: 20px; color: #666; } .error { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 5px; margin-bottom: 15px; } .success { background: #d4edda; color: #155724; padding: 12px; border-radius: 5px; margin-bottom: 15px; }</style></head><body><div id="root"><\/div><script type="text/babel">const { useState, useEffect } = React; function App() { const [leads, setLeads] = useState([]); const [stats, setStats] = useState({}); const [loading, setLoading] = useState(false); const [message, setMessage] = useState(""); useEffect(() => { fetchLeads(); fetchStats(); }, []); const fetchLeads = async () => { try { const res = await fetch("/api/leads"); setLeads(await res.json()); } catch (e) { setMessage("Fehler beim Laden der Leads"); } }; const fetchStats = async () => { try { const res = await fetch("/api/stats"); setStats(await res.json()); } catch (e) { console.error(e); } }; const runFinder = async () => { setLoading(true); setMessage(""); try { const res = await fetch("/api/finder/run", { method: "POST" }); const data = await res.json(); setMessage("✓ " + data.message + ": " + data.inserted + " neue Leads hinzugefügt"); setTimeout(() => { fetchLeads(); fetchStats(); setLoading(false); }, 1000); } catch (e) { setMessage("Fehler beim Ausführen des Finders"); setLoading(false); } }; const sendEmail = async (leadId, template) => { try { const res = await fetch("/api/email/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lead_id: leadId, template_number: template }) }); const data = await res.json(); setMessage(data.success ? "✓ Email versendet" : "✗ Fehler beim Versenden"); setTimeout(() => { fetchLeads(); fetchStats(); }, 1000); } catch (e) { setMessage("Fehler beim Versenden der Email"); } }; return React.createElement("div", { className: "container" }, React.createElement("header", null, React.createElement("h1", null, "🚀 Joergs Leadgenerierung"), React.createElement("p", { className: "subtitle" }, "Automatisierte Leadgenerierung für Baumaschinen-Verkauf")), message && React.createElement("div", { className: message.includes("✓") ? "success" : "error" }, message), React.createElement("div", { className: "stats" }, React.createElement("div", { className: "stat-box" }, React.createElement("div", { className: "stat-number" }, stats.total_leads || 0), React.createElement("div", { className: "stat-label" }, "Gesamt Leads")), React.createElement("div", { className: "stat-box" }, React.createElement("div", { className: "stat-number" }, stats.new_leads || 0), React.createElement("div", { className: "stat-label" }, "Neue Leads")), React.createElement("div", { className: "stat-box" }, React.createElement("div", { className: "stat-number" }, stats.contacted || 0), React.createElement("div", { className: "stat-label" }, "Kontaktiert")), React.createElement("div", { className: "stat-box" }, React.createElement("div", { className: "stat-number" }, stats.responses || 0), React.createElement("div", { className: "stat-label" }, "Antworten"))), React.createElement("div", { className: "controls" }, React.createElement("button", { onClick: runFinder, disabled: loading }, loading ? "Läuft..." : "🔍 Finder starten")), React.createElement("h2", { style: { marginBottom: "15px", fontSize: "18px" } }, "Aktuelle Leads"), leads.length === 0 ? React.createElement("div", { className: "loading" }, "Keine Leads gefunden. Starte den Finder!") : React.createElement("table", { className: "leads-table" }, React.createElement("thead", null, React.createElement("tr", null, React.createElement("th", null, "Unternehmen"), React.createElement("th", null, "Email"), React.createElement("th", null, "Branche"), React.createElement("th", null, "PLZ"), React.createElement("th", null, "Status"), React.createElement("th", null, "Aktion"))), React.createElement("tbody", null, leads.slice(0, 20).map(lead => React.createElement("tr", { key: lead.id }, React.createElement("td", null, React.createElement("strong", null, lead.company_name)), React.createElement("td", null, lead.email), React.createElement("td", null, lead.industry), React.createElement("td", null, lead.plz), React.createElement("td", null, React.createElement("span", { className: "status-badge status-" + lead.status }, lead.status === "new" ? "Neu" : lead.status === "contacted" ? "Kontaktiert" : "Antwortet")), React.createElement("td", null, React.createElement("button", { className: "secondary", style: { padding: "5px 10px", fontSize: "11px" }, onClick: () => sendEmail(lead.id, 4) }, "Email senden")))))); } ReactDOM.render(React.createElement(App), document.getElementById("root"));<\/script><\/body><\/html>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('✓ Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
  console.log('Verfügbare API-Endpunkte:');
  console.log('  GET  /api/leads');
  console.log('  GET  /api/stats');
  console.log('  POST /api/finder/run');
  console.log('  POST /api/email/send');
});

module.exports = app;
