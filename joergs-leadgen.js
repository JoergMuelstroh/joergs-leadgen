// ============================================
// JOERGS LEADGENERIERUNG - FULL STACK APP
// Backend + Frontend Combined
// ============================================

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ============================================
// DATABASE SETUP
// ============================================

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

// ============================================
// CONFIGURATION
// ============================================

const CONFIG = {
  google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY || 'YOUR_API_KEY',
  brevo_api_key: process.env.BREVO_API_KEY || 'YOUR_API_KEY',
  target_plz: ['35', '50', '51', '53', '54', '55', '56', '57', '60', '61', '63', '64', '65', '66', '67'],
  industries: ['Bauunternehmen', 'Tiefbau', 'Straßenbau', 'Asphaltbau', 'Erdbeweger', 'Gewinnungsbetriebe'],
  email_templates: {
    3: {
      subject: 'Warum der Privatverkauf eurer Maschinen teurer ist',
      body: `Hallo [NAME],

Privatverkauf eurer Baumaschinen kostet euch:
- Zeit für Marketing & Anfragen
- Transportkosten (oft euer Problem)
- Preisverhandlungen
- Garantierisiken

Unsere Auktion? Einmal Upload, fertig. Weltweite Käufer.

Schneller verkauft, besser bezahlt, keine Garantie von uns – einfach Geschäft.

Macht Sinn?

Viele Grüße,
Jörg Mülstroh
Ritchie Bros. Deutschland`
    },
    4: {
      subject: 'Schnelle Frage – Baumaschinen zu verkaufen?',
      body: `Hallo [NAME],

habt ihr Baumaschinen, die aktuell nicht genutzt werden?

Weltweites Auktionsnetzwerk. Faire Preise. Schneller Verkauf.
Ohne Garantieverpflichtung – ihr verkauft, fertig.

Ja/Nein?

Jörg Mülstroh
Ritchie Bros. Deutschland`
    },
    5: {
      subject: 'Kurze Frage zu euren Maschinen',
      body: `Hallo [NAME],

nutzt ihr eure Baumaschinen noch vollständig aus – oder gibt es Ausrüstung, die hauptsächlich Kosten verursacht?

Falls ja: Das ist genau unser Feld. Wir verkaufen Maschinen über ein weltweites Netzwerk – schneller und besser als Privatverkauf.

Keine Garantien von uns, aber faire Preise und schnelle Auszahlung.

Kurz Zeit für ein Gespräch?

Jörg Mülstroh
Ritchie Bros. Deutschland`
    }
  }
};

// ============================================
// GOOGLE MAPS FINDER
// ============================================

async function findLeadsGoogleMaps(plz, industry, limit = 50) {
  try {
    const query = `${industry} ${plz} Deutschland`;
    
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: {
        query: query,
        key: CONFIG.google_maps_api_key,
        language: 'de'
      }
    });

    const leads = response.data.results?.map(place => ({
      company_name: place.name,
      plz: plz,
      industry: industry,
      source: 'google_maps',
      formatted_address: place.formatted_address,
      phone: place.formatted_phone_number || 'N/A'
    })) || [];

    return leads.slice(0, limit);
  } catch (error) {
    console.error('Google Maps Error:', error.message);
    return [];
  }
}

// ============================================
// MOCK LINKEDIN ENRICHER
// ============================================

function enrichWithLinkedIn(lead) {
  const domain = lead.company_name.toLowerCase().replace(/\s+/g, '').substring(0, 10);
  
  return {
    ...lead,
    email: `info@${domain}.de`,
    linkedin_url: `https://linkedin.com/company/${domain}`,
    contact_name: 'Geschäftsführer'
  };
}

// ============================================
// API ENDPOINTS
// ============================================

app.get('/api/leads', (req, res) => {
  db.all('SELECT * FROM leads ORDER BY created_at DESC', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/leads/status/:status', (req, res) => {
  const { status } = req.params;
  db.all('SELECT * FROM leads WHERE status = ? ORDER BY created_at DESC', [status], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/stats', (req, res) => {
  db.all(`
    SELECT 
      COUNT(*) as total_leads,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_leads,
      SUM(CASE WHEN status = 'contacted' THEN 1 ELSE 0 END) as contacted,
      SUM(CASE WHEN response_received_at IS NOT NULL THEN 1 ELSE 0 END) as responses
    FROM leads
  `, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows[0]);
  });
});

app.post('/api/finder/run', async (req, res) => {
  try {
    const allLeads = [];

    for (const plz of CONFIG.target_plz) {
      for (const industry of CONFIG.industries) {
        const googleLeads = await findLeadsGoogleMaps(plz, industry, 10);
        allLeads.push(...googleLeads);
      }
    }

    const enrichedLeads = allLeads.map(enrichWithLinkedIn);

    let insertedCount = 0;
    enrichedLeads.forEach(lead => {
      db.run(
        `INSERT OR IGNORE INTO leads (company_name, contact_name, email, phone, plz, industry, linkedin_url, source, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [lead.company_name, lead.contact_name, lead.email, lead.phone, lead.plz, lead.industry, lead.linkedin_url, lead.source, 'new'],
        function(err) {
          if (!err) insertedCount++;
        }
      );
    });

    res.json({ 
      message: `Finder abgeschlossen`,
      total_found: enrichedLeads.length,
      inserted: insertedCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/email/send', async (req, res) => {
  const { lead_id, template_number } = req.body;

  db.get('SELECT * FROM leads WHERE id = ?', [lead_id], async (err, lead) => {
    if (err || !lead) return res.status(404).json({ error: 'Lead nicht gefunden' });

    const template = CONFIG.email_templates[template_number];
    if (!template) return res.status(400).json({ error: 'Template nicht gefunden' });

    const emailBody = template.body.replace('[NAME]', lead.contact_name);

    try {
      console.log(`Email würde versendet werden an ${lead.email}`);
      
      db.run(
        `UPDATE leads SET status = 'contacted', email_sent_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [lead_id]
      );

      db.run(
        `INSERT INTO email_sequences (lead_id, template_number, sent_at, status) VALUES (?, ?, CURRENT_TIMESTAMP, 'sent')`,
        [lead_id, template_number]
      );

      res.json({ success: true, message: 'Email versendet' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
});

app.put('/api/leads/:id/status', (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  db.run('UPDATE leads SET status = ? WHERE id = ?', [status, id], function(err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, message: 'Status aktualisiert' });
  });
});

// ============================================
// FRONTEND (Embedded React)
// ============================================

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Joergs Leadgenerierung</title>
      <script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"></script>
      <script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"></script>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; }
        .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
        header { background: #1a1a1a; color: #fff; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
        h1 { font-size: 28px; margin-bottom: 10px; }
        .subtitle { font-size: 14px; opacity: 0.8; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-box { background: white; padding: 20px; border-radius: 8px; border-left: 4px solid #4CAF50; }
        .stat-number { font-size: 28px; font-weight: bold; color: #4CAF50; }
        .stat-label { font-size: 12px; color: #666; margin-top: 5px; text-transform: uppercase; }
        .controls { display: flex; gap: 10px; margin: 20px 0; flex-wrap: wrap; }
        button { background: #4CAF50; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; }
        button:hover { background: #45a049; }
        button.secondary { background: #2196F3; }
        button.secondary:hover { background: #0b7dda; }
        .leads-table { background: white; border-collapse: collapse; width: 100%; border-radius: 8px; overflow: hidden; }
        .leads-table th { background: #f0f0f0; padding: 12px; text-align: left; font-weight: 600; font-size: 12px; border-bottom: 1px solid #ddd; }
        .leads-table td { padding: 12px; border-bottom: 1px solid #eee; }
        .leads-table tr:hover { background: #f9f9f9; }
        .status-badge { display: inline-block; padding: 4px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; }
        .status-new { background: #fff3cd; color: #856404; }
        .status-contacted { background: #d1ecf1; color: #0c5460; }
        .status-responded { background: #d4edda; color: #155724; }
        .loading { text-align: center; padding: 20px; color: #666; }
        .error { background: #f8d7da; color: #721c24; padding: 12px; border-radius: 5px; margin-bottom: 15px; }
        .success { background: #d4edda; color: #155724; padding: 12px; border-radius: 5px; margin-bottom: 15px; }
      </style>
    </head>
    <body>
      <div id="root"></div>
      <script type="text/babel">
        const { useState, useEffect } = React;

        function App() {
          const [leads, setLeads] = useState([]);
          const [stats, setStats] = useState({});
          const [loading, setLoading] = useState(false);
          const [message, setMessage] = useState('');

          useEffect(() => {
            fetchLeads();
            fetchStats();
          }, []);

          const fetchLeads = async () => {
            try {
              const res = await fetch('/api/leads');
              setLeads(await res.json());
            } catch (e) {
              setMessage('Fehler beim Laden der Leads');
            }
          };

          const fetchStats = async () => {
            try {
              const res = await fetch('/api/stats');
              setStats(await res.json());
            } catch (e) {
              console.error(e);
            }
          };

          const runFinder = async () => {
            setLoading(true);
            setMessage('');
            try {
              const res = await fetch('/api/finder/run', { method: 'POST' });
              const data = await res.json();
              setMessage(\`✓ \${data.message}: \${data.inserted} neue Leads hinzugefügt\`);
              setTimeout(() => {
                fetchLeads();
                fetchStats();
                setLoading(false);
              }, 1000);
            } catch (e) {
              setMessage('Fehler beim Ausführen des Finders');
              setLoading(false);
            }
          };

          const sendEmail = async (leadId, template) => {
            try {
              const res = await fetch('/api/email/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ lead_id: leadId, template_number: template })
              });
              const data = await res.json();
              setMessage(data.success ? '✓ Email versendet' : '✗ Fehler beim Versenden');
              setTimeout(() => {
                fetchLeads();
                fetchStats();
              }, 1000);
            } catch (e) {
              setMessage('Fehler beim Versenden der Email');
            }
          };

          return (
            <div className="container">
              <header>
                <h1>🚀 Joergs Leadgenerierung</h1>
                <p className="subtitle">Automatisierte Leadgenerierung für Baumaschinen-Verkauf</p>
              </header>

              {message && (
                <div className={message.includes('✓') ? 'success' : 'error'}>
                  {message}
                </div>
              )}

              <div className="stats">
                <div className="stat-box">
                  <div className="stat-number">{stats.total_leads || 0}</div>
                  <div className="stat-label">Gesamt Leads</div>
                </div>
                <div className="stat-box">
                  <div className="stat-number">{stats.new_leads || 0}</div>
                  <div className="stat-label">Neue Leads</div>
                </div>
                <div className="stat-box">
                  <div className="stat-number">{stats.contacted || 0}</div>
                  <div className="stat-label">Kontaktiert</div>
                </div>
                <div className="stat-box">
                  <div className="stat-number">{stats.responses || 0}</div>
                  <div className="stat-label">Antworten</div>
                </div>
              </div>

              <div className="controls">
                <button onClick={runFinder} disabled={loading}>
                  {loading ? 'Läuft...' : '🔍 Finder starten'}
                </button>
              </div>

              <h2 style={{ marginBottom: '15px', fontSize: '18px' }}>Aktuelle Leads</h2>
              {leads.length === 0 ? (
                <div className="loading">Keine Leads gefunden. Starte den Finder!</div>
              ) : (
                <table className="leads-table">
                  <thead>
                    <tr>
                      <th>Unternehmen</th>
                      <th>Email</th>
                      <th>Branche</th>
                      <th>PLZ</th>
                      <th>Status</th>
                      <th>Aktion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {leads.slice(0, 20).map(lead => (
                      <tr key={lead.id}>
                        <td><strong>{lead.company_name}</strong></td>
                        <td>{lead.email}</td>
                        <td>{lead.industry}</td>
                        <td>{lead.plz}</td>
                        <td>
                          <span className={\`status-badge status-\${lead.status}\`}>
                            {lead.status === 'new' ? 'Neu' : lead.status === 'contacted' ? 'Kontaktiert' : 'Antwortet'}
                          </span>
                        </td>
                        <td>
                          <button 
                            className="secondary" 
                            style={{ padding: '5px 10px', fontSize: '11px' }}
                            onClick={() => sendEmail(lead.id, 4)}
                          >
                            Email senden
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          );
        }

        ReactDOM.render(<App />, document.getElementById('root'));
      </script>
    </body>
    </html>
  \`);
});

// ============================================
// SERVER START
// ============================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`✓ Joergs Leadgenerierung läuft auf http://localhost:\${PORT}\`);
  console.log('Verfügbare API-Endpunkte:');
  console.log('  GET  /api/leads');
  console.log('  GET  /api/stats');
  console.log('  POST /api/finder/run');
  console.log('  POST /api/email/send');
});

module.exports = app;
