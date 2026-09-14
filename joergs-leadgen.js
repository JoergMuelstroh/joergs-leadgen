const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Persistente Datei statt ':memory:' — Leads überleben jetzt einen normalen
// Prozess-Neustart. WICHTIG: Render Free-Tier-Instanzen haben ein ephemeres
// Dateisystem, das bei jedem Deploy und jedem Spin-down/Spin-up (Idle nach
// ~15 Min) NEU aufgesetzt wird — dann ist auch diese Datei wieder leer. Für
// echte Persistenz über Deploys/Idle-Zyklen hinweg braucht es entweder einen
// Render Persistent Disk (kostenpflichtiger Plan) oder eine externe DB wie
// Turso/Supabase. Sag Bescheid, wenn wir das als Nächstes anbinden sollen.
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'leads.db');

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('DB-Verbindung fehlgeschlagen:', err.message);
  else console.log('SQLite-Datei geöffnet:', DB_PATH);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    place_id TEXT,
    company_name TEXT,
    address TEXT,
    website TEXT,
    email TEXT,
    email_status TEXT,
    email_source TEXT,
    phone TEXT,
    plz TEXT,
    industry TEXT,
    status TEXT DEFAULT 'new',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  // Kein UNIQUE-Constraint auf email/place_id mehr in der Tabellendefinition,
  // weil in echten Daten beide erstmal NULL sein können (Email kommt erst aus
  // dem Enrichment-Schritt). Duplikate werden stattdessen aktiv vor dem
  // Insert per place_id bzw. company_name+plz geprüft (siehe leadExists()).
  //
  // email_status: null/leer = noch nicht versucht, 'found' = Email gefunden,
  // 'not_found' = versucht, aber keine Email auf Homepage/Impressum entdeckt.
  // Verhindert, dass derselbe Lead bei jedem Enrichment-Lauf erneut gecrawlt
  // wird. email_source sagt, wo die Email herkam (homepage/impressum).
});

function shutdown() {
  db.close((err) => {
    if (err) console.error('Fehler beim Schließen der DB:', err.message);
    else console.log('DB sauber geschlossen.');
    process.exit(err ? 1 : 0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const CONFIG = {
  google_maps_api_key: process.env.GOOGLE_MAPS_API_KEY || '',
  target_plz: ['35', '50', '51', '53', '54', '55', '56', '57', '60', '61', '63', '64', '65', '66', '67'],
  industries: ['Bauunternehmen', 'Tiefbau', 'Straßenbau', 'Asphaltbau', 'Erdbeweger', 'Gewinnungsbetriebe'],
  // Jede Place-Details-Anfrage (Telefon/Website) kostet ca. $3 pro 1000 Calls
  // (Google "Contact Data", Stand 2026) — bei max. 840 möglichen Leads pro
  // vollem Lauf (14 PLZ x 6 Branchen x bis zu 10 Treffer) sind das im
  // Extremfall ca. $2,50 pro Lauf, meist deutlich weniger, weil Duplikate
  // jetzt VOR der Details-Anfrage rausgefiltert werden. Der Text-Search-Call
  // selbst (ca. $32/1000) läuft für jede PLZ+Branche-Kombination sowieso,
  // unabhängig von diesem Deckel.
  //
  // Praktisch kein Deckel mehr (Default 100000): ein Budget, das während
  // des Laufs ausgeht, trifft IMMER die zuerst verarbeiteten PLZ (35, 50...)
  // zuerst - genau die, die im Dashboard zuletzt angezeigt werden (neueste
  // oben). Bei jedem endlichen Deckel unter der Gesamtzahl gehen also
  // ausgerechnet die Leads leer aus, die man sich zuerst anschaut. Da die
  // echten Kosten pro Lauf im niedrigen einstelligen Dollarbereich liegen,
  // lohnt sich das Kosten-Risiko eines Deckels hier nicht. Per Env trotzdem
  // einstellbar, falls gewünscht.
  max_details_per_run: parseInt(process.env.MAX_DETAILS_PER_RUN || '100000', 10)
};

// Ohne echten Key läuft die App im Demo-Modus mit klar markierten Fake-Leads
// statt so zu tun, als wären es reale Treffer (das war vorher der Bug: der
// Fallback griff bei JEDEM Fehler, auch bei fehlendem/falschem Key, und
// niemand hätte es am Ergebnis gesehen).
const DEMO_MODE = !CONFIG.google_maps_api_key || CONFIG.google_maps_api_key === 'YOUR_API_KEY';
if (DEMO_MODE) {
  console.warn('⚠️  Kein gültiger GOOGLE_MAPS_API_KEY gesetzt — Finder läuft im DEMO-MODUS mit Fake-Leads.');
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchPlaceDetails(placeId) {
  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/details/json', {
      params: {
        place_id: placeId,
        fields: 'formatted_phone_number,website',
        key: CONFIG.google_maps_api_key,
        language: 'de'
      }
    });
    const result = response.data.result || {};
    return { phone: result.formatted_phone_number || null, website: result.website || null };
  } catch (error) {
    console.error('Place Details fehlgeschlagen für', placeId, '-', error.message);
    return { phone: null, website: null };
  }
}

// Google Text Search behandelt die PLZ nur als lockeres Suchwort, nicht als
// geografischen Filter - "66 Deutschland" im Query reicht nicht, um Treffer
// aus anderen PLZ-Gebieten oder sogar anderen Ländern (Österreich!)
// auszuschließen. Deshalb wird die tatsächliche PLZ aus der von Google
// zurückgegebenen Adresse extrahiert und hart nachgeprüft. Erwartetes
// Adressformat: "Straße Hausnr., PLZ Ort, Deutschland".
function extractGermanPostalCode(formattedAddress) {
  if (!formattedAddress) return null;
  const match = formattedAddress.match(/,\s*(\d{5})\s+[^,]+,\s*Deutschland\s*$/i);
  return match ? match[1] : null;
}

async function findLeadsGoogleMaps(plz, industry, runStats) {
  if (DEMO_MODE) {
    return [
      { place_id: null, company_name: `Test ${industry} ${plz}`, address: null, website: null, plz, industry, phone: '0123456789', demo: true },
      { place_id: null, company_name: `Demo ${industry} GmbH`, address: null, website: null, plz, industry, phone: '0987654321', demo: true }
    ];
  }

  const query = `${industry} ${plz} Deutschland`;
  let response;
  try {
    response = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: CONFIG.google_maps_api_key, language: 'de' }
    });
  } catch (error) {
    console.error(`Google Maps Anfrage fehlgeschlagen für "${query}":`, error.message);
    return [];
  }

  if (response.data.status !== 'OK' && response.data.status !== 'ZERO_RESULTS') {
    console.error(`Google Places Fehler (${response.data.status}) für "${query}":`, response.data.error_message || '(keine Details)');
    return [];
  }

  const results = (response.data.results || []).slice(0, 10);
  const leads = [];
  for (const place of results) {
    const postalCode = extractGermanPostalCode(place.formatted_address);
    if (!postalCode || !postalCode.startsWith(plz)) {
      // Kein deutsches Adressformat erkannt, oder PLZ passt nicht zur
      // gesuchten Region (z.B. "20537 Hamburg" bei einer Suche nach "66") -
      // Lead wird verworfen statt falsch zugeordnet gespeichert.
      if (runStats) runStats.plz_mismatch++;
      continue;
    }
    leads.push({
      place_id: place.place_id,
      company_name: place.name,
      address: place.formatted_address || null,
      website: null,
      plz,
      industry,
      phone: null,
      demo: false
    });
  }
  return leads;
}

// Details (Telefon/Website) NUR für Leads holen, die wir noch nicht kennen —
// vorher wurde das Budget schon bei den ersten PLZ verbraucht, sodass die
// später verarbeiteten PLZ nie Details bekamen, unabhängig davon ob sie neu
// oder Duplikate waren. Jetzt: erst auf "ist das neu?" prüfen (kostenlos),
// dann erst die kostenpflichtige Details-Anfrage für die neuen ausgeben.
async function enrichWithDetails(lead, detailsBudget) {
  if (lead.demo || !lead.place_id || detailsBudget.remaining <= 0) return lead;
  const details = await fetchPlaceDetails(lead.place_id);
  detailsBudget.remaining--;
  return { ...lead, phone: details.phone, website: details.website };
}

function leadExists(lead) {
  return new Promise((resolve, reject) => {
    if (lead.place_id) {
      db.get('SELECT id FROM leads WHERE place_id = ?', [lead.place_id], (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      });
    } else {
      // Demo-Leads haben keine place_id — nach Firma+PLZ dedupen
      db.get('SELECT id FROM leads WHERE company_name = ? AND plz = ?', [lead.company_name, lead.plz], (err, row) => {
        if (err) return reject(err);
        resolve(!!row);
      });
    }
  });
}

function insertLead(lead) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO leads (place_id, company_name, address, website, phone, plz, industry, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'new')`,
      [lead.place_id, lead.company_name, lead.address, lead.website, lead.phone, lead.plz, lead.industry],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

// --- Email-Enrichment: Homepage + Impressum nach echter Email durchsuchen ---
// Kein Rätselraten mehr ("info@" + Firmenname + ".de", das oft gar nicht
// existierte) - stattdessen wird die tatsächlich hinterlegte Website
// gecrawlt. In Deutschland ist eine Kontakt-Email im Impressum Pflicht, das
// macht diesen Weg zuverlässiger als reines Homepage-Scraping.
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const JUNK_EMAIL_PATTERNS = [
  /wixpress\.com$/i, /sentry\.io$/i, /example\.(com|de)$/i, /godaddy\.com$/i,
  /schema\.org$/i, /\.(png|jpg|jpeg|gif|svg|webp)$/i, /wordpress\.(com|org)$/i
];

function extractEmails(html) {
  const matches = (html || '').match(EMAIL_REGEX) || [];
  const seen = new Set();
  const clean = [];
  for (const raw of matches) {
    const m = raw.toLowerCase();
    if (JUNK_EMAIL_PATTERNS.some((p) => p.test(m))) continue;
    if (seen.has(m)) continue;
    seen.add(m);
    clean.push(m);
  }
  return clean;
}

function findImpressumUrl(html, baseUrl) {
  const hrefRegex = /href\s*=\s*["']([^"'#]+)["']/gi;
  let match;
  while ((match = hrefRegex.exec(html || '')) !== null) {
    if (/impressum|imprint/i.test(match[1])) {
      try { return new URL(match[1], baseUrl).href; } catch { /* ungültige URL, ignorieren */ }
    }
  }
  return null;
}

async function fetchHtml(url) {
  const response = await axios.get(url, {
    timeout: 8000,
    maxRedirects: 5,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JoergsLeadgenBot/1.0)' },
    validateStatus: (s) => s < 500 // 4xx trotzdem auswerten statt zu werfen
  });
  return typeof response.data === 'string' ? response.data : '';
}

async function findEmailForWebsite(website) {
  let baseUrl;
  try {
    baseUrl = new URL(website).href;
  } catch {
    return { email: null, source: null };
  }

  let homepageHtml;
  try {
    homepageHtml = await fetchHtml(baseUrl);
  } catch (error) {
    return { email: null, source: null, error: error.message };
  }

  const homepageEmails = extractEmails(homepageHtml);
  if (homepageEmails.length > 0) {
    return { email: homepageEmails[0], source: 'homepage' };
  }

  const impressumUrl = findImpressumUrl(homepageHtml, baseUrl);
  if (impressumUrl) {
    try {
      const impressumHtml = await fetchHtml(impressumUrl);
      const impressumEmails = extractEmails(impressumHtml);
      if (impressumEmails.length > 0) {
        return { email: impressumEmails[0], source: 'impressum' };
      }
    } catch {
      // Impressum nicht erreichbar - kein Absturz, einfach kein Ergebnis
    }
  }

  return { email: null, source: null };
}

function getLeadsNeedingEmail(limit) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT id, website FROM leads
       WHERE website IS NOT NULL AND (email_status IS NULL OR email_status = '')
       ORDER BY created_at DESC LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      }
    );
  });
}

function updateLeadEmail(id, email, emailStatus, emailSource) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE leads SET email = ?, email_status = ?, email_source = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [email, emailStatus, emailSource, id],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

app.get('/api/stats', (req, res) => {
  db.all(
    `SELECT status, COUNT(*) as count FROM leads GROUP BY status`,
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const byStatus = {};
      let total = 0;
      for (const r of rows || []) {
        byStatus[r.status] = r.count;
        total += r.count;
      }
      db.get(
        `SELECT COUNT(*) as cnt FROM leads WHERE website IS NOT NULL AND (email_status IS NULL OR email_status = '')`,
        (err2, row2) => {
          if (err2) return res.status(500).json({ error: err2.message });
          res.json({
            total_leads: total,
            new_leads: byStatus['new'] || 0,
            contacted: byStatus['contacted'] || 0,
            pending_email: row2 ? row2.cnt : 0,
            demo_mode: DEMO_MODE
          });
        }
      );
    }
  );
});

app.get('/api/leads', (req, res) => {
  // Vorher fest LIMIT 50 - dadurch waren ältere Leads in der Tabelle nicht
  // mehr sichtbar. Jetzt per ?limit= steuerbar, Default zeigt praktisch
  // alles (bis zu 5000, als grobe Notbremse gegen Endlosladen).
  const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 5000);
  db.all('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?', [limit], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});

app.post('/api/finder/run', async (req, res) => {
  try {
    const detailsBudget = { remaining: CONFIG.max_details_per_run };
    const runStats = { plz_mismatch: 0 };
    let inserted = 0;
    let skipped = 0;

    for (const plz of CONFIG.target_plz) {
      for (const industry of CONFIG.industries) {
        const leads = await findLeadsGoogleMaps(plz, industry, runStats);
        for (let lead of leads) {
          if (await leadExists(lead)) {
            skipped++;
            continue;
          }
          lead = await enrichWithDetails(lead, detailsBudget);
          await insertLead(lead);
          inserted++;
        }
        if (!DEMO_MODE) await sleep(200); // etwas Abstand zwischen Requests, gegen Rate-Limit-Fehler
      }
    }

    res.json({ success: true, inserted, skipped, plz_mismatch: runStats.plz_mismatch, demo_mode: DEMO_MODE });
  } catch (error) {
    console.error('Finder-Lauf fehlgeschlagen:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/enrich/run', async (req, res) => {
  try {
    // Bewusst als eigener Schritt statt Teil von /api/finder/run: Crawlen von
    // Dutzenden fremden Websites nacheinander würde den Finder-Request sonst
    // sehr lange blockieren. So kann man in überschaubaren Batches nachladen.
    const batchSize = Math.min(parseInt(req.body && req.body.limit, 10) || 50, 200);
    const leads = await getLeadsNeedingEmail(batchSize);

    let found = 0;
    let notFound = 0;
    for (const lead of leads) {
      const result = await findEmailForWebsite(lead.website);
      if (result.email) {
        await updateLeadEmail(lead.id, result.email, 'found', result.source);
        found++;
      } else {
        await updateLeadEmail(lead.id, null, 'not_found', null);
        notFound++;
      }
      await sleep(300); // Höflichkeitspause zwischen Anfragen an fremde Websites
    }

    res.json({ success: true, processed: leads.length, found, not_found: notFound });
  } catch (error) {
    console.error('Email-Enrichment fehlgeschlagen:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Joergs Leadgenerierung</title><style>body{font-family:Arial;background:#f5f5f5;margin:0}.container{max-width:1200px;margin:0 auto;padding:20px}header{background:#1a1a1a;color:#fff;padding:20px;border-radius:8px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:center}h1{margin:0;font-size:28px}.badge{background:#e67e22;color:#fff;padding:4px 10px;border-radius:12px;font-size:12px;font-weight:bold}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:15px;margin:20px 0}.stat{background:#fff;padding:20px;border-radius:8px;border-left:4px solid #4CAF50;text-align:center}.number{font-size:32px;font-weight:bold;color:#4CAF50}.label{font-size:12px;color:#666;margin-top:10px}button{background:#4CAF50;color:#fff;border:none;padding:12px 20px;border-radius:5px;cursor:pointer;font-weight:bold;font-size:16px;margin:20px 0}button:disabled{opacity:.6}button:hover:not(:disabled){background:#45a049}table{width:100%;border-collapse:collapse;background:#fff;margin-top:20px}th,td{padding:12px;text-align:left;border-bottom:1px solid #ddd}th{background:#f0f0f0;font-weight:bold}.message{padding:12px;margin-bottom:15px;border-radius:5px;background:#d4edda;color:#155724;display:none}.message.show{display:block}</style></head><body><div class="container"><header><h1>🚀 Joergs Leadgenerierung</h1><span class="badge" id="demoBadge" style="display:none">DEMO-MODUS</span></header><div class="message" id="msg"></div><div class="stats"><div class="stat"><div class="number" id="total">0</div><div class="label">Gesamt Leads</div></div><div class="stat"><div class="number" id="new">0</div><div class="label">Neue Leads</div></div><div class="stat"><div class="number" id="contacted">0</div><div class="label">Kontaktiert</div></div></div><button id="btn" onclick="runFinder()">🔍 Finder starten</button><button id="enrichBtn" onclick="runEnrich()">📧 Emails suchen (<span id="pendingEmail">0</span> wartend)</button><h2>Leads</h2><p id="leadCount" style="color:#666;font-size:14px"></p><div id="table-container"></div></div><script>async function load(){try{const r1=await fetch('/api/stats');const s=await r1.json();document.getElementById('total').textContent=s.total_leads;document.getElementById('new').textContent=s.new_leads;document.getElementById('contacted').textContent=s.contacted;document.getElementById('demoBadge').style.display=s.demo_mode?'inline-block':'none';document.getElementById('pendingEmail').textContent=s.pending_email||0;const r2=await fetch('/api/leads?limit=5000');const leads=await r2.json();document.getElementById('leadCount').textContent='Zeige '+leads.length+' von '+s.total_leads+' Leads';let html='';if(leads.length===0){html='<p>Keine Leads - Finder starten!</p>'}else{html='<table><tr><th>Unternehmen</th><th>Adresse</th><th>Website</th><th>Email</th><th>Telefon</th><th>Branche</th><th>PLZ</th></tr>';for(let l of leads){html+='<tr><td>'+l.company_name+'</td><td>'+(l.address||'–')+'</td><td>'+(l.website?('<a href="'+l.website+'" target="_blank" rel="noopener">Link</a>'):'–')+'</td><td>'+(l.email||(l.email_status==='not_found'?'<span style=\'color:#999\'>keine gefunden</span>':'–'))+'</td><td>'+(l.phone||'–')+'</td><td>'+l.industry+'</td><td>'+l.plz+'</td></tr>'}html+='</table>'}document.getElementById('table-container').innerHTML=html}catch(e){console.error(e)}}async function runFinder(){const btn=document.getElementById('btn');const msg=document.getElementById('msg');btn.disabled=true;btn.textContent='Läuft...';msg.classList.remove('show');try{const r=await fetch('/api/finder/run',{method:'POST'});const d=await r.json();msg.textContent=d.success?('✓ '+d.inserted+' neue Leads, '+d.skipped+' Duplikate, '+(d.plz_mismatch||0)+' falsche PLZ verworfen'+(d.demo_mode?' (Demo-Modus)':'')):('✗ '+(d.error||'Fehler'));msg.classList.add('show');setTimeout(()=>{load();btn.disabled=false;btn.textContent='🔍 Finder starten'},2000)}catch(e){msg.textContent='✗ Error';msg.classList.add('show');btn.disabled=false;btn.textContent='🔍 Finder starten'}}async function runEnrich(){const btn=document.getElementById('enrichBtn');const msg=document.getElementById('msg');btn.disabled=true;const oldText=btn.innerHTML;btn.textContent='Sucht...';msg.classList.remove('show');try{const r=await fetch('/api/enrich/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:50})});const d=await r.json();msg.textContent=d.success?('✓ '+d.found+' Emails gefunden, '+d.not_found+' ohne Treffer (von '+d.processed+' geprüft)'):('✗ '+(d.error||'Fehler'));msg.classList.add('show');setTimeout(()=>{load();btn.disabled=false;btn.innerHTML=oldText},2000)}catch(e){msg.textContent='✗ Error';msg.classList.add('show');btn.disabled=false;btn.innerHTML=oldText}}load()</script></body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Joergs Leadgenerierung läuft auf http://localhost:' + PORT);
});

module.exports = app;
