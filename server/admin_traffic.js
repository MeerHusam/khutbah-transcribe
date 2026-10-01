// admin_traffic.js — the /admin/traffic page: views over time, where viewers are, which
// khutbahs they read, how they got there, their devices, when they come and how long they
// stay. Built from the append-only logs in data/:
//   visits.jsonl  one line per page view (since 11 Sep 2026; khutbah/source/device/place since
//                 the 27 Sep 2026 update, older lines have only ts/new/new_device)
//   geo_views.jsonl  one line per page view with a located IP (city level, from ip-api.com)
//   engage.jsonl  reader-page snapshots: seconds visible, seconds of audio played, furthest
//                 point reached, language (several per view; the largest values count)
// Nothing here stores an IP address or a full user-agent.

const RIYADH_MS = 3 * 3600e3; // Riyadh is UTC+3 all year
const riyadh = iso => new Date(Date.parse(iso) + RIYADH_MS);
const dayOf = iso => riyadh(iso).toISOString().slice(0, 10);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function readJsonl(file, readFileSync) {
  try {
    return readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// Device class, OS, browser and bot flag from a user-agent. Only these labels are stored.
export function classifyUA(ua = '') {
  const bot = /bot\b|bot\/|crawl|spider|slurp|headless|preview|scanner|monitor|python|curl|wget|lighthouse|facebookexternalhit|whatsapp\/|go-http|axios|node-fetch/i.test(ua);
  const os = /iphone|ipad|ipod/i.test(ua) ? 'iOS' : /android/i.test(ua) ? 'Android'
    : /windows/i.test(ua) ? 'Windows' : /cros/i.test(ua) ? 'ChromeOS'
    : /mac os x|macintosh/i.test(ua) ? 'macOS' : /linux/i.test(ua) ? 'Linux' : 'Other';
  const device = /ipad|tablet/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua)) ? 'Tablet'
    : /mobi|iphone|ipod|android/i.test(ua) ? 'Phone' : 'Computer';
  const browser = /instagram/i.test(ua) ? 'Instagram app' : /FBAN|FBAV|FB_IAB/.test(ua) ? 'Facebook app'
    : /snapchat/i.test(ua) ? 'Snapchat app' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Edg(A|iOS)?\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome\//.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : 'Other';
  return { bot, os, device, browser };
}

const count = (arr, key) => {
  const m = new Map();
  for (const x of arr) { const k = key(x); if (k != null && k !== '') m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const median = xs => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
};
const mins = s => (s == null ? '–' : s < 60 ? `${Math.round(s)} s` : `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`);
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const bar = (n, peak, cls = '') => `<span class="bar ${cls}" style="width:${Math.max(2, Math.round((n / Math.max(1, peak)) * 100))}%"></span>`;

function smallTable(title, rows, total) {
  if (!rows.length) return '';
  const peak = rows[0][1];
  return `<div class="card"><h3>${esc(title)}</h3><table>${rows.map(([k, n]) =>
    `<tr><td>${esc(k)}</td><td class="n">${n}</td><td class="pc">${pct(n, total)}</td><td class="b">${bar(n, peak)}</td></tr>`).join('')}</table></div>`;
}

// A view counts as a bot when its user-agent says so or its IP belongs to a hosting provider.
const isBot = v => !!(v.bot || v.geo?.hosting);

export function buildTrafficPage({ visits, geo, engage, totals, khutbahs, now = new Date() }) {
  const nowMs = now.getTime();
  const within = (iso, days) => nowMs - Date.parse(iso) <= days * 86400e3;
  const titleOf = new Map(khutbahs.map(k => [k.slug, k.title]));

  // ── Headline numbers ──
  const last = days => visits.filter(v => v.ts && within(v.ts, days));
  const l1 = last(1), l7 = last(7);
  const newDev = vs => vs.filter(v => v.new_device).length;

  // ── By day (Riyadh), with the top places each day ──
  const byDay = new Map();
  for (const v of visits) {
    if (!v.ts) continue;
    const d = dayOf(v.ts);
    if (!byDay.has(d)) byDay.set(d, { views: 0, newVisitors: 0, newDevices: 0, bots: 0, places: new Map() });
    const e = byDay.get(d);
    e.views++; if (v.new) e.newVisitors++; if (v.new_device) e.newDevices++; if (isBot(v)) e.bots++;
  }
  for (const g of geo) {
    if (!g.ts || !g.city) continue;
    const e = byDay.get(dayOf(g.ts));
    if (e) e.places.set(g.city, (e.places.get(g.city) || 0) + 1);
  }
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const peakDay = Math.max(1, ...days.map(([, d]) => d.views));
  const dayRows = days.map(([day, d]) => {
    const wd = WEEKDAYS[new Date(day + 'T12:00:00Z').getUTCDay()];
    const places = [...d.places.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([c, n]) => `<span class="chip">${esc(c)} ${n}</span>`).join('');
    return `<tr><td>${day} <span class="wd">${wd}</span></td><td class="n">${d.views}${d.bots ? ` <span class="wd" title="bots or data centres">(${d.bots} bot)</span>` : ''}</td>
      <td class="u">${d.newVisitors || ''}</td><td class="u">${d.newDevices || ''}</td>
      <td class="pl">${places}</td><td class="b">${bar(d.views, peakDay)}</td></tr>`;
  }).join('');

  // ── Where viewers are (all located views; data-centre IPs flagged from 27 Sep on) ──
  const people = geo.filter(g => !g.hosting);
  const flaggedDC = geo.filter(g => g.hosting).length;
  const byCountry = new Map();
  for (const g of people) {
    const key = g.country || 'Unknown';
    if (!byCountry.has(key)) byCountry.set(key, { cc: g.countryCode || '', all: 0, week: 0, cities: new Map() });
    const c = byCountry.get(key);
    c.all++; if (within(g.ts, 7)) c.week++;
    const city = g.city || 'Unknown';
    c.cities.set(city, (c.cities.get(city) || 0) + 1);
  }
  const countryRows = [...byCountry.entries()].sort((a, b) => b[1].all - a[1].all).map(([name, c]) =>
    `<tr><td>${esc(c.cc)}</td><td>${esc(name)}</td><td class="n">${c.all}</td><td class="w">${c.week || ''}</td>
     <td>${[...c.cities.entries()].sort((a, b) => b[1] - a[1]).map(([city, n]) => `<span class="chip">${esc(city)} ${n}</span>`).join('')}</td></tr>`).join('');
  const firstSeenCity = new Map();
  for (const g of people) {
    const k = `${g.city || 'Unknown'}, ${g.country || ''}`;
    if (!firstSeenCity.has(k) || g.ts < firstSeenCity.get(k)) firstSeenCity.set(k, g.ts);
  }
  const newPlaces = [...firstSeenCity.entries()].filter(([, ts]) => within(ts, 7))
    .sort((a, b) => b[1].localeCompare(a[1])).map(([k, ts]) => `<span class="chip new">${esc(k)} <em>${dayOf(ts).slice(5)}</em></span>`).join('');

  // ── Everything below needs the fields added on 27 Sep 2026 ──
  const tracked = visits.filter(v => v.id);
  const since = tracked.length ? dayOf(tracked.reduce((a, v) => (v.ts < a ? v.ts : a), tracked[0].ts)) : null;
  const humans = tracked.filter(v => !isBot(v));
  const bots = tracked.length - humans.length;

  // Engagement: several snapshots per view; keep the largest values.
  const eng = new Map();
  for (const e of engage) {
    if (!e.id) continue;
    const cur = eng.get(e.id) || { open_s: 0, played_s: 0, max_pos: 0, dur: null, lang: 'en' };
    cur.open_s = Math.max(cur.open_s, e.open_s || 0);
    cur.played_s = Math.max(cur.played_s, e.played_s || 0);
    cur.max_pos = Math.max(cur.max_pos, e.max_pos || 0);
    if (e.dur) cur.dur = e.dur;
    if (e.lang) cur.lang = e.lang;
    eng.set(e.id, cur);
  }

  const readers = humans.filter(v => v.page === 'reader');
  const khRows = count(readers, v => v.k).map(([slug]) => {
    const vs = readers.filter(v => v.k === slug);
    const es = vs.map(v => eng.get(v.id)).filter(Boolean);
    const played = es.filter(e => e.played_s >= 5);
    const finished = played.filter(e => e.dur && e.max_pos >= 0.9 * e.dur);
    const devs = new Set(vs.map(v => v.dev).filter(Boolean)).size;
    return `<tr><td>${esc(titleOf.get(slug) || slug)}<div class="slug">/${esc(slug)}</div></td><td class="n">${vs.length}</td><td>${devs || '–'}</td>
      <td>${mins(median(es.map(e => e.open_s)))}</td><td>${pct(played.length, es.length)}</td>
      <td>${mins(median(played.map(e => e.played_s)))}</td><td>${pct(finished.length, played.length)}</td></tr>`;
  }).join('');
  const allEng = readers.map(v => eng.get(v.id)).filter(Boolean);
  const langRows = count(allEng, e => (e.lang === 'ur' ? 'اردو (Urdu)' : 'English'));

  const sourceOf = v => (v.src ? `Link tagged “${v.src}”` : v.ref ? `From ${v.ref}` : /app$/.test(v.browser || '') ? `Inside the ${v.browser}` : 'Direct / app link (WhatsApp etc.)');
  const pageRows = count(humans, v => (v.page === 'home' ? 'Home page' : v.page === 'reader' ? 'A khutbah' : null));

  // When (Riyadh time)
  const hours = Array(24).fill(0), wdays = Array(7).fill(0);
  for (const v of visits.filter(v => v.ts && !isBot(v))) { const t = riyadh(v.ts); hours[t.getUTCHours()]++; wdays[t.getUTCDay()]++; }
  const peakH = Math.max(1, ...hours), peakW = Math.max(1, ...wdays);
  const hourCols = hours.map((n, h) => `<div class="hcol" title="${h}:00–${h}:59 · ${n} views"><span style="height:${Math.round((n / peakH) * 100)}%"></span><em>${h % 3 === 0 ? h : ''}</em></div>`).join('');
  const wdRows = wdays.map((n, i) => `<tr><td>${WEEKDAYS[i]}</td><td class="n">${n}</td><td class="b">${bar(n, peakW)}</td></tr>`).join('');

  // Returning: devices seen on two or more Riyadh days.
  const devDays = new Map();
  for (const v of humans) { if (!v.dev) continue; if (!devDays.has(v.dev)) devDays.set(v.dev, new Set()); devDays.get(v.dev).add(dayOf(v.ts)); }
  const returning = [...devDays.values()].filter(s => s.size >= 2).length;
  const returningViews = humans.filter(v => v.dev && devDays.get(v.dev)?.size >= 2).length;

  const note = since ? `since ${since} (when this tracking started)` : 'starts counting on the next page view';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Traffic</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#1a1a1a}
  h1{font-size:20px;margin:0 0 4px}h2{font-size:16px;margin:32px 0 6px}h3{font-size:13px;margin:0 0 8px;color:#374151}
  p.sub{color:#6b7280;font-size:13px;margin:0 0 12px}
  table{border-collapse:collapse;width:100%}
  th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #e5e7eb;font-size:14px;vertical-align:top}
  th{background:#f9fafb;font-weight:600;font-size:13px}
  .n{font-weight:700;color:#059669}.u{font-weight:700;color:#b45309}.w{color:#2563eb;font-weight:600}.pc{color:#6b7280;font-size:12px}
  .wd{color:#9ca3af;font-size:12px}.slug{color:#9ca3af;font-size:12px}
  td.b{width:32%}.bar{display:block;height:10px;background:#34d399;border-radius:3px}
  .chip{display:inline-block;background:#f0fdf4;border:1px solid #d1fae5;border-radius:4px;padding:1px 7px;margin:2px;font-size:12px;color:#065f46}
  .chip.new{background:#eff6ff;border-color:#bfdbfe;color:#1e40af}.chip em{font-style:normal;color:#6b7280}
  td.pl{max-width:340px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:14px 0}
  .stat{border:1px solid #e5e7eb;border-radius:10px;padding:10px 12px}.stat b{display:block;font-size:22px;color:#059669}.stat span{font-size:12px;color:#6b7280}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
  .card{border:1px solid #e5e7eb;border-radius:10px;padding:12px}.card td{padding:5px 6px;font-size:13px}
  .hours{display:flex;align-items:flex-end;gap:3px;height:120px;border-bottom:1px solid #e5e7eb;padding-top:6px}
  .hcol{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center}
  .hcol span{display:block;width:100%;background:#34d399;border-radius:3px 3px 0 0;min-height:1px}
  .hcol em{font-style:normal;font-size:11px;color:#6b7280;height:14px;margin-bottom:-16px}
  .note{font-size:12px;color:#6b7280;margin-top:6px}
  .scroll{overflow-x:auto}
</style>
<h1>Traffic</h1>
<p class="sub">Times and days are Riyadh time (UTC+3). Counts are page views: opening a khutbah, the home page, or switching khutbah each count once.</p>
<div class="stats">
  <div class="stat"><b>${totals.views}</b><span>views, all time</span></div>
  <div class="stat"><b>${totals.visitors}</b><span>unique visitors (by IP)</span></div>
  <div class="stat"><b>${totals.devices}</b><span>unique devices (since 25 Sep)</span></div>
  <div class="stat"><b>${l1.length}</b><span>views in the last 24 h · ${newDev(l1)} new devices</span></div>
  <div class="stat"><b>${l7.length}</b><span>views in the last 7 days · ${newDev(l7)} new devices</span></div>
</div>

<h2>Where viewers are</h2>
<p class="sub">Every located view since tracking began, by country and city (city is approximate, from the IP address). “7 days” is the last week.${flaggedDC ? ` ${flaggedDC} view(s) from data-centre addresses (link scanners, crawlers) are left out.` : ''}</p>
<div class="scroll"><table><thead><tr><th></th><th>Country</th><th>Views</th><th>7 days</th><th>Cities</th></tr></thead>
<tbody>${countryRows || '<tr><td colspan="5">No located views yet.</td></tr>'}</tbody></table></div>
${newPlaces ? `<h3 style="margin-top:14px">New places in the last 7 days</h3><div>${newPlaces}</div>` : ''}
<p class="note">Before 27 Sep, data-centre addresses were not flagged. Towns like Boydton (Virginia), Council Bluffs and Des Moines (Iowa) host Microsoft and Google data centres, so views from there are almost certainly scanners, not people.</p>

<h2>Views by day</h2>
<div class="scroll"><table><thead><tr><th>Day</th><th>Views</th><th>New visitors</th><th>New devices</th><th>Top places</th><th></th></tr></thead>
<tbody>${dayRows || '<tr><td colspan="6">No visits logged yet.</td></tr>'}</tbody></table></div>

<h2>Khutbahs</h2>
<p class="sub">Reader-page views ${note}${bots ? `, not counting ${bots} view(s) from bots or data centres` : ''}. “Time on page” counts only while the page is on screen; it and the listening columns cover views whose page reported back. “Listened” is audio actually played; “finished” means they reached the last 10%.</p>
<div class="scroll"><table><thead><tr><th>Khutbah</th><th>Views</th><th>Devices</th><th>Median time on page</th><th>Pressed play</th><th>Median listened</th><th>Finished</th></tr></thead>
<tbody>${khRows || `<tr><td colspan="7">No khutbah views ${note}.</td></tr>`}</tbody></table></div>

<h2>How they got here, and on what</h2>
<p class="sub">${humans.length ? `${humans.length} view(s) ${note}.` : `No views ${note}.`} WhatsApp opens links without saying where they came from, so shared links show as “direct / app link”.</p>
<div class="grid">
  ${smallTable('Came from', count(humans, sourceOf), humans.length)}
  ${smallTable('Page', pageRows, humans.length)}
  ${smallTable('Device', count(humans, v => v.device), humans.length)}
  ${smallTable('System', count(humans, v => v.os), humans.length)}
  ${smallTable('Browser', count(humans, v => v.browser), humans.length)}
  ${smallTable('Reading in', langRows, allEng.length)}
</div>

<h2>When</h2>
<p class="sub">All views by hour of day and day of week, Riyadh time.</p>
<div class="grid">
  <div class="card"><h3>Hour of day</h3><div class="hours">${hourCols}</div><div style="height:16px"></div></div>
  <div class="card"><h3>Day of week</h3><table>${wdRows}</table></div>
</div>

<h2>Coming back</h2>
<p class="sub">${devDays.size ? `${returning} of ${devDays.size} device(s) came back on another day; ${pct(returningViews, humans.filter(v => v.dev).length)} of views are from them. Counted ${note}.` : `Counts devices seen on two or more days; ${note}.`}</p>
`;
}
