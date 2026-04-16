const axios = require('axios');
const fs = require('fs');
const path = require('path');
const express = require('express');
const nodemailer = require('nodemailer');

const config = require('./config');

// Main monitor and server
// This script periodically fetches a BoligPortal search page, extracts
// embedded JSON listing data, keeps a local baseline of seen ads, and
// notifies connected browser clients (SSE) and email subscribers about
// new postings. Configuration is read from `config.js` / `.env`.

const SEARCH_URL = config.SEARCH_URL;
const SEEN_FILE = path.join(__dirname, 'seen.json');
const POLL_MS = config.POLL_MS;
const INITIAL_COUNT = config.INITIAL_COUNT;
const SUBSCRIBERS_FILE = config.SUBSCRIBERS_FILE;

// SMTP defaults (from config)
const SMTP_HOST = config.SMTP_HOST;
const SMTP_PORT = config.SMTP_PORT;
const SMTP_USER = config.SMTP_USER;
const SMTP_PASS = config.SMTP_PASS;
const SENDER = config.SENDER;

function formatCopenhagen(date = new Date()) {
  const opts = {
    timeZone: 'Europe/Copenhagen',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  };
  // Return a formatted timestamp in Europe/Copenhagen timezone.
  // We use formatToParts to ensure consistent zero-padded fields.
  const parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(date);
  const part = (type) => (parts.find(p => p.type === type) || {}).value || '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

function loadSeen() {
  // Load previously seen ads from disk. Returns { ids: Set, data: Array }.
  // If the file does not exist or is invalid, returns empty structures.
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      const ids = new Set(arr.map(item => String(item && item.id ? item.id : item)));
      return { ids, data: arr };
    }
    return { ids: new Set(), data: [] };
  } catch (e) {
    return { ids: new Set(), data: [] };
  }
}

function saveSeen(arrayOfAds) {
  // Persist current seen ads to disk (used as baseline between runs).
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify(arrayOfAds, null, 2));
  } catch (e) {
    console.error('Failed to write seen file', e.message);
  }
}

function cleanupSeenFile(){
  // Remove the local `seen.json` file. Called on shutdown so the app
  // presents the fresh initial batch on next start (per user preference).
  try{
    if (fs.existsSync(SEEN_FILE)) fs.unlinkSync(SEEN_FILE);
  }catch(e){ /* ignore */ }
}

// --- email / subscribers helpers ---
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: false,
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});
let smtpAvailable = true;

// Subscribers are stored as a simple array in `subscribers.json`.
function loadSubscribers(){
  try{
    const raw = fs.readFileSync(SUBSCRIBERS_FILE,'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}

function saveSubscribers(arr){
  // Persist subscriber list to disk.
  try{ fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(arr, null, 2)); } catch(e){ console.error('Failed saving subscribers', e.message); }
}

async function sendEmail(to, subject, html){
  // Send a single email via configured SMTP transporter.
  if (!smtpAvailable) {
    console.error('SMTP unavailable: skipping send to', to);
    return false;
  }
  try{
    await transporter.sendMail({ from: SENDER, to, subject, html });
    return true;
  }catch(e){ console.error('Failed sending email to', to, e && e.message); return false; }
}

function createNewAdsHtml(newAds){
  // Build a compact HTML summary used for notification emails.
  const rows = newAds.map(ad => {
    const img = ad.image ? `<img src="${ad.image}" style="width:120px;height:auto;border-radius:6px;display:block;margin-bottom:6px">` : '';
    return `
      <div style="padding:10px 0;border-bottom:1px solid #eee">
        ${img}
        <div><strong><a href="${ad.url}">${ad.title}</a></strong></div>
        <div>${ad.location || ad.city} — ${ad.size_m2}m2 — ${ad.rent} kr</div>
      </div>`;
  }).join('\n');
  return `<div><h2>New BoligPortal postings</h2>${rows}</div>`;
}

async function notifySubscribersAboutNewAds(newAds){
  // Send the same summary email to all subscribers (best-effort).
  try{
    if (!smtpAvailable) { console.warn('SMTP unavailable: skipping email notifications'); return; }
    const subs = loadSubscribers();
    if(!subs.length) return;
    const html = createNewAdsHtml(newAds);
    await Promise.allSettled(subs.map(email => sendEmail(email, `New BoligPortal postings (${newAds.length})`, html)));
  }catch(e){ console.error('notify error', e && e.message); }
}

// --- end email helpers ---

async function fetchPage(url) {
  // Fetch raw HTML for the search page. Caller extracts embedded JSON.
  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; boligportal-monitor/0.1)'
    },
    timeout: 10000,
  });
  return res.data;
}

function extractStoreJson(html) {
  // The site embeds a JSON blob inside <script id="store"> which
  // contains structured data including the `results` array used below.
  const match = html.match(/<script id="store" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch (e) {
    return null;
  }
}

function getResultsFromStore(store){
  // Normalize different possible locations of the `results` array.
  if(!store || !store.props) return [];
  if(store.props.page_props && Array.isArray(store.props.page_props.results)) return store.props.page_props.results;
  if(Array.isArray(store.props.results)) return store.props.results;
  return [];
}

function formatAd(ad) {
  // Convert raw ad object from site JSON into a smaller, consistent
  // shape used by the app and sent to the frontend / emails.
  const rawUrl = ad.url || '';
  const fullUrl = rawUrl.startsWith('http') ? rawUrl : `https://www.boligportal.dk${rawUrl}`;
  const imageUrl = (ad.images && Array.isArray(ad.images) && ad.images.length > 0 && ad.images[0].url)
    ? ad.images[0].url
    : null;
  return {
    id: ad.id,
    title: ad.title,
    city: ad.city,
    location: buildLocation(ad),
    rent: ad.monthly_rent,
    size_m2: ad.size_m2,
    url: fullUrl,
    image: imageUrl,
    advertised_date: ad.advertised_date,
    rental_period: ad.rental_period
  };
}

function buildLocation(ad){
  // Build a readable location string: prefer street+number and a small
  // administrative area (e.g. "København N") when available.
  if(!ad) return '';
  const parts = [];
  if(ad.street_name) parts.push(String(ad.street_name) + (ad.street_number ? ' ' + String(ad.street_number) : ''));
  const areaRaw = ad.city_area || ad.city_level_2 || ad.city_level_1 || ad.city || '';
  let area = areaRaw ? String(areaRaw) : '';
  // normalize lowercase area to Title Case (e.g. "københavn n" -> "København N")
  if(area && area === area.toLowerCase()){
    area = area.split(/\s+/).map(w => w.length ? (w[0].toUpperCase() + w.slice(1)) : w).join(' ');
  }
  if(area) parts.push(area);
  return parts.join(', ');
}

async function poll(seen, broadcastEvent) {
  // Poll the search page, detect new postings, persist seen list,
  // broadcast SSE updates and notify email subscribers on change.
  try {
    const html = await fetchPage(SEARCH_URL);
    const store = extractStoreJson(html);
    const results = getResultsFromStore(store);
    if (!Array.isArray(results) || results.length === 0) {
      console.error('Could not find embedded results JSON in page');
      return;
    }
    const lastBatch = results.slice(0, INITIAL_COUNT).map(formatAd);

    const now = formatCopenhagen(new Date());

    const isInitial = !Array.isArray(seen.data) || seen.data.length === 0;

    if (isInitial) {
      console.log(`\n[${now}] Initial fetch — latest ${INITIAL_COUNT} postings:`);
      for (const ad of lastBatch) {
        console.log(`   | ${ad.title} — ${ad.location || ad.city} — ${ad.size_m2}m2 — ${ad.rent} kr — ${ad.url}`);
      }
      // persist baseline (newest-first)
      saveSeen(lastBatch);
      for (const ad of lastBatch) seen.ids.add(String(ad.id));
      seen.data = lastBatch;
      if (typeof broadcastEvent === 'function') {
        broadcastEvent('initial', { lastBatch, timestamp: now });
      }
      return;
    }

    const newAds = lastBatch.filter(a => !seen.ids.has(String(a.id)));

    if (newAds.length > 0) {
      console.log(`\n[${now}] NEW: ${newAds.length} new posting(s)`);
      for (const ad of newAds) {
        console.log(`NEW | ${ad.title} — ${ad.city} — ${ad.size_m2}m2 — ${ad.rent} kr — ${ad.url}`);
      }
      // prepend new ads to seen list so newest items are first, then persist
      const updated = newAds.concat(seen.data);
      saveSeen(updated);
      for (const ad of newAds) seen.ids.add(String(ad.id));
      seen.data = updated;
      if (typeof broadcastEvent === 'function') {
        const payloadLastBatch = seen.data.slice(0, INITIAL_COUNT);
        broadcastEvent('update', { type: 'new-ads', newAds, lastBatch: payloadLastBatch, timestamp: now });
      }
      // notify email subscribers asynchronously
      notifySubscribersAboutNewAds(newAds).catch(()=>{});
    } else {
      console.log(`\n[${now}] No new postings`);
      if (typeof broadcastEvent === 'function') {
        broadcastEvent('update', { type: 'no-new', timestamp: now });
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

async function main() {
  const seen = loadSeen();
  console.log('Starting boligportal monitor — polling every', POLL_MS / 1000, 's');

  // --- start express server + SSE ---
  const app = express();
  const clients = new Set();

  app.use(express.static(path.join(__dirname, 'public')));

  // subscribe endpoint
  app.post('/subscribe', express.json(), async (req, res) => {
    try{
      const email = (req.body && String(req.body.email || '').trim()) || '';
      if(!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'invalid email' });
      const subs = loadSubscribers();
      if(subs.includes(email)){
        {
          const sent = await sendEmail(email, 'Subscription confirmed', `<p>You are already subscribed to BoligPortal Monitor.</p>`);
          if(!sent) return res.status(500).json({ error: 'email_failed' });
          return res.json({ ok: true, message: 'already subscribed' });
        }
      }
      subs.push(email);
      saveSubscribers(subs);
      {
        const sent = await sendEmail(email, 'Subscription confirmed', `<p>You are now subscribed to BoligPortal Monitor. You will receive emails when new postings appear.</p>`);
        if(!sent){
          // rollback subscription if confirmation email failed
          const remaining = loadSubscribers().filter(s => s !== email);
          saveSubscribers(remaining);
          return res.status(500).json({ error: 'email_failed' });
        }
        return res.json({ ok: true });
      }
    }catch(e){ console.error('subscribe error', e && e.message); return res.status(500).json({ error: 'server' }); }
  });

  app.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });
    res.flushHeaders && res.flushHeaders();
    res.write('\n');
    clients.add(res);
    // send current baseline immediately so clients that connect after startup get data
    try {
      if (Array.isArray(seen.data) && seen.data.length > 0) {
        const payload = { lastBatch: seen.data.slice(0, INITIAL_COUNT), timestamp: formatCopenhagen(new Date()) };
        res.write(`event: initial\n`);
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      }
    } catch (e) {
      // ignore write errors for new connections
    }
    req.on('close', () => clients.delete(res));
  });

  function broadcastEvent(eventName, payload){
    const data = JSON.stringify(payload);
    for(const res of clients){
      try{
        res.write(`event: ${eventName}\n`);
        res.write(`data: ${data}\n\n`);
      }catch(e){ clients.delete(res); }
    }
  }

  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log('Frontend available at http://localhost:' + port);
  });
  // verify SMTP availability early so we can surface useful errors
  try {
    if (SMTP_USER && SMTP_PASS) {
      await transporter.verify();
      console.log('SMTP transporter verified');
      smtpAvailable = true;
    } else {
      smtpAvailable = false;
      console.warn('SMTP credentials not provided; emails disabled');
    }
  } catch (e) {
    smtpAvailable = false;
    console.warn('SMTP verify failed; emails disabled', e && e.message);
  }
  // --- end express server ---

  // Run immediately, then interval
  // helper to run poll with broadcast
  async function pollAndBroadcast(){
    await poll(seen, broadcastEvent);
  }

  await pollAndBroadcast();
  const interval = setInterval(pollAndBroadcast, POLL_MS);

  function shutdown(code = 0){
    console.log('\nShutting down');
    try{ clearInterval(interval); }catch(e){}
    cleanupSeenFile();
    try{
      server && server.close(() => process.exit(code));
    }catch(e){
      process.exit(code);
    }
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('exit', (code) => {
    cleanupSeenFile();
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err && err.message ? err.message : err);
    shutdown(1);
  });
}

main();
