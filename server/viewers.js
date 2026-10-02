// Viewer counts over the page's WebSocket. Live = concurrent open connections. Total =
// cumulative page loads, persisted to disk so it survives restarts/redeploys; unique visitors
// by hashed IP and by a browser ID. Each visit is also logged (with its place) for
// /admin/traffic.
import { readFileSync, writeFileSync, appendFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';
import { VIEWS_FILE, GEO_FILE, VISITS_FILE } from './config.js';
import { catalog } from './khutbahs.js';
import { classifyUA } from './admin/traffic.js';

async function lookupGeo(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return null;
  try {
    // hosting: the IP belongs to a data centre (link scanners, crawlers), not a person's connection.
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,countryCode,status,hosting,mobile`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status !== 'success') return null;
    return { city: data.city, region: data.regionName, country: data.country, countryCode: data.countryCode, hosting: !!data.hosting, mobile: !!data.mobile };
  } catch { return null; }
}

// ip-api.com's free tier allows 45 lookups a minute and blocks an address that keeps going over;
// a thousand people opening a shared link within minutes would. Each address is looked up once
// (a masjid's Wi-Fi is one address) and at most 40 a minute; past that a visit is logged without
// its place. `lookup` is replaceable for the test.
// ponytail: the cache only empties at 5000 addresses or a restart; places rarely change.
const geoCache = new Map(); // ip -> Promise<place | null>
let geoMinute = 0, geoCount = 0;
export function placeOf(ip, lookup = lookupGeo) {
  if (geoCache.has(ip)) return geoCache.get(ip);
  const minute = Math.floor(Date.now() / 60_000);
  if (minute !== geoMinute) { geoMinute = minute; geoCount = 0; }
  if (++geoCount > 40) return Promise.resolve(null);
  if (geoCache.size > 5000) geoCache.clear();
  const place = lookup(ip);
  geoCache.set(ip, place);
  place.then(g => { if (!g) geoCache.delete(ip); }); // a failed lookup is tried again next visit
  return place;
}

let totalViews = 0;
let uniqueIps = new Set();
// Hashed IP -> ISO timestamp of that visitor's first ever visit. Hashes recorded before
// this map existed have no entry; /admin/traffic reports those as "before tracking".
let firstSeen = {};
// Distinct browsers, by a random ID each browser keeps in localStorage. Unique IPs undercount:
// a whole household (or a masjid) on one Wi-Fi is one IP. Counted from 25 Sep 2026 on.
let uniqueDevices = new Set();
try {
  const saved = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'));
  totalViews = saved.total || 0;
  uniqueIps = new Set(saved.unique_ips || []);
  firstSeen = saved.first_seen || {};
  uniqueDevices = new Set(saved.unique_devices || []);
} catch { totalViews = 0; }

// Written at most every 5 s: it holds every hashed address, and a write per visit adds up when
// many arrive at once. A crash loses at most those 5 s of counts.
let persistTimer = null;
function persistViews() {
  persistTimer ??= setTimeout(() => {
    persistTimer = null;
    try { writeFileSync(VIEWS_FILE, JSON.stringify({ total: totalViews, unique_ips: [...uniqueIps], first_seen: firstSeen, unique_devices: [...uniqueDevices] })); } catch {}
  }, 5000);
}

function hashIp(ip) {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// The running totals, for /admin/traffic.
export const viewerTotals = () => ({ views: totalViews, visitors: uniqueIps.size, devices: uniqueDevices.size });

const liveClients = new Set();

function viewerCounts() {
  return { type: 'viewers', live: liveClients.size, total: totalViews, unique: uniqueIps.size, devices: uniqueDevices.size };
}

// Every join and leave used to send the count to every open page, n² messages when a shared
// link brings many people at once; now one round at most every 2 s.
let broadcastTimer = null;
function broadcastViewers() {
  broadcastTimer ??= setTimeout(() => {
    broadcastTimer = null;
    const payload = JSON.stringify(viewerCounts());
    for (const ws of liveClients) if (ws.readyState === 1) ws.send(payload);
  }, 2000);
}

// One page view: a viewer socket opened by home.html or a reader page.
export function handleViewer(ws, req) {
  liveClients.add(ws);
  ws.on('close', () => { liveClients.delete(ws); broadcastViewers(); });
  ws.on('error', () => liveClients.delete(ws));
  const params = new URL(req.url || '/', 'http://x').searchParams;
  // A page reconnecting (?re=1: the phone woke up, or the site redeployed) is back in the live
  // count but is not a new view: the page keeps the view ID it was given.
  if (params.get('re') === '1') {
    if (ws.readyState === 1) ws.send(JSON.stringify(viewerCounts()));
    broadcastViewers();
    return;
  }
  totalViews += 1;
  const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const visitTs = new Date().toISOString();
  let isNewVisitor = false;
  if (rawIp) {
    const h = hashIp(rawIp);
    isNewVisitor = !uniqueIps.has(h);
    uniqueIps.add(h);
    if (isNewVisitor) firstSeen[h] = visitTs;
  }
  // The page sends its browser ID as ?d=; stored hashed, like IPs.
  let isNewDevice = false, deviceHash = null;
  const device = params.get('d') || '';
  if (/^[A-Za-z0-9-]{8,64}$/.test(device)) {
    deviceHash = hashIp('device:' + device);
    isNewDevice = !uniqueDevices.has(deviceHash);
    uniqueDevices.add(deviceHash);
  }
  persistViews();
  // Per-visit log for /admin/traffic (views.json only holds running totals). The page says
  // which page and khutbah it is (p, k), the link's ?s= tag and the referring site (s, r);
  // the user-agent is kept only as device/OS/browser labels. Written once the IP's city is
  // known (at most 3 s), so each line carries its place.
  const page = ['home', 'reader'].includes(params.get('p')) ? params.get('p') : null;
  const k = params.get('k') || '';
  const { slugToFolder, folderToSlug, featured } = catalog();
  const visit = {
    ts: visitTs, new: isNewVisitor, new_device: isNewDevice,
    id: randomBytes(6).toString('hex'),
    dev: deviceHash, page,
    k: page === 'reader' ? (slugToFolder.has(k) ? k : folderToSlug.get(k) || folderToSlug.get(featured) || null) : null,
    src: (params.get('s') || '').replace(/[^\w-]/g, '').slice(0, 24) || null,
    ref: /^[a-z0-9.-]{3,80}$/i.test(params.get('r') || '') && params.get('r') !== req.headers.host ? params.get('r').toLowerCase() : null,
    ...classifyUA(req.headers['user-agent'] || ''),
  };
  // Send the new client its view ID and current numbers immediately, then tell everyone.
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'hello', id: visit.id }));
    ws.send(JSON.stringify(viewerCounts()));
  }
  broadcastViewers();
  placeOf(rawIp).then(geo => {
    if (geo) {
      visit.geo = { city: geo.city, country: geo.country, countryCode: geo.countryCode, hosting: geo.hosting };
      try { appendFileSync(GEO_FILE, JSON.stringify({ ts: new Date().toISOString(), ...geo }) + '\n'); } catch {}
    }
    try { appendFileSync(VISITS_FILE, JSON.stringify(visit) + '\n'); } catch {}
  });
}
