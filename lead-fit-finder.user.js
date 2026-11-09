// ==UserScript==
// @name         Amos Lead Fit Finder
// @namespace    amos-exteriors-lead-table
// @version      2.7.2
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/lead-fit-finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/lead-fit-finder.user.js
// @description  Type a customer address on the Lead Table and get the 5 best open slots over the next 3 work days, ranked by location, open slots and drive time.
// @author       Andrew Thomas (Mars 2) with Claude
// @match        https://my.acculynx.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      docs.google.com
// @connect      nominatim.openstreetmap.org
// @connect      router.project-osrm.org
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  HOW TO USE
  1. On any AccuLynx page a navy "Availability" button sits bottom-right (drag it anywhere; it remembers the
     spot; double-click it to send it back to the corner). It reads the Lead Table in the background
     (you must be signed in to Google in the same Chrome). Rep names are never shown.
  2. Type the customer's address (street, city or zip) and press Find.
  3. It checks the next 3 WORK days (Monday-Saturday; Sunday is never a work day), every Morning / Afternoon /
     Evening row that still needs leads (column B > 0), and every rep whose slot is empty.
     Tuesday Morning and Saturday Evening never have lead slots, so they are always skipped.
     It shows the 5 best spots, one per rep:
       - drive time and miles from where he will be (his earlier appointment that day, otherwise home),
       - where he goes next (later appointment or home) and how long that drive is.
     Ranking = drive there + half the drive to his next stop, with a bonus when he already has another
     appointment near the customer that day. Reps over 70 miles away are never suggested; a best fit over
     45 miles shows a reminder to book him another lead in the area or on the way back.
  Nothing on the sheet is changed. Addresses and towns are looked up on OpenStreetMap (free) and remembered,
  so repeat lookups are fast. Drive times come from the public OSRM router.

  CHANGES IN 2.7.2
  - Address fallback uses structured zip / town lookups (bare "47949, IN" found nothing).
  - Also skips the pool lead at this job's own Initial Appt day + time (when the pool cell has no job link).

  CHANGES IN 2.7.1
  - A street address OpenStreetMap cannot find falls back to the zip, then the town (was an error).
  - The job you are on is never offered as its own "Pair with pool lead".

  CHANGES IN 2.7.0
  - Results are cards: day/time/drive on the left, "Best fit" (the rep's whole day, leg by leg) on the right.

  CHANGES IN 2.6.0
  - "Next 4 days" (calendar days) -> "next 3 work days" (Mon-Sat, Sunday skipped and not counted).
  - Today is not counted as one of the 3 days (set INCLUDE_TODAY: true to count it).
  - Tuesday Morning and Saturday Evening are never offered (CLOSED_SLOTS).
*/

(function () {
  'use strict';

  const CONFIG = {
    LEAD_TABLE_ID: '170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY',   // Lead Table 2026
    SPREADSHEETS: {
      '170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY': 'Lead Table 2026',
      '10Ca7c5tpct4dQ67S5_NPfwkVleX8mM-q5LH9i59icAI': 'Lead Table (training copy)'
    },
    REP_COLS: 'CDEFGHIJKLMNOPQRSTUVW'.split(''),
    SLOTS: ['Morning', 'Afternoon', 'Evening'],
    // lead start window per slot row (minutes after midnight): Morning 10:00-11:45, Afternoon 12:00-3:15, Evening 3:30-6:30
    WINDOWS: [[600, 705], [720, 915], [930, 1110]],
    LEAD_MIN: 120,     // a lead takes about 2 hours
    STATE: 'IN',
    TOP: 5,
    WORK_DAYS: 3,          // how many work days to look ahead
    WORK_DOW: [1, 2, 3, 4, 5, 6],   // Monday-Saturday are work days (0 = Sunday)
    INCLUDE_TODAY: false,  // false = start counting tomorrow; true = today counts as one of the work days
    // slots that never have leads: day of week (0=Sun ... 6=Sat) -> slot names
    CLOSED_SLOTS: { 2: ['Morning'], 6: ['Evening'] },   // Tuesday morning, Saturday evening
    MAX_MILES: 70,     // never suggest a drive longer than this for one lead
    LOCAL_MIN: 10,     // same town / same zip: count it as about a 10-minute, 4-mile drive (not 0)
    LOCAL_MI: 4,
    CLUSTER_MIN: 20,   // a waiting Lead Pool lead this many minutes from the customer is "in the same area"
    FAR_MILES: 45,     // past this, remind Mars to pair the lead with another nearby / on the way home
    MAX_ROW: 100,
    // Cells that mean "this rep cannot take a lead in this slot" are anything non-empty.
    // Managers (* in front of the name) are listed only when their slot is truly empty.
  };

  const ssid = CONFIG.LEAD_TABLE_ID;   // the Lead Table this button reads (change in CONFIG to use the training copy)

  // ---------- small helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const pad2 = (n) => String(n).padStart(2, '0');
  const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const decode = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

  function gm(opts) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest(Object.assign({
      timeout: 20000, onload: resolve, onerror: () => reject(new Error('network error')), ontimeout: () => reject(new Error('timeout'))
    }, opts)));
  }

  // ---------- which days to search ----------
  // the next N work days (Mon-Sat). Sunday is skipped and does not count toward N.
  function workDays() {
    const days = [];
    const d = new Date(); d.setHours(12, 0, 0, 0);
    if (!CONFIG.INCLUDE_TODAY) d.setDate(d.getDate() + 1);
    while (days.length < CONFIG.WORK_DAYS) {
      if (CONFIG.WORK_DOW.includes(d.getDay())) days.push(new Date(d));
      d.setDate(d.getDate() + 1);
    }
    return days;
  }
  const slotClosed = (d, slotName) => (CONFIG.CLOSED_SLOTS[d.getDay()] || []).includes(slotName);

  // ---------- read the week tab ----------
  function parseSheet(html) {
    const vis = [];
    const headEnd = html.indexOf('</thead>');
    (headEnd > 0 ? html.slice(0, headEnd) : '').replace(/<th\b[^>]*id="[^"]*C(\d+)"[^>]*>/gi, (m, n) => { vis.push(+n); return m; });
    const letterAt = (pos) => colLetter(vis[pos] !== undefined ? vis[pos] : pos);
    const cells = {}; const occ = {};
    for (const tr of html.split(/<tr\b/i).slice(1)) {
      const th = tr.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i);
      if (!th) continue;
      const rn = parseInt(decode(th[1]).trim(), 10);
      if (!rn || rn > CONFIG.MAX_ROW) continue;
      let pos = 0; const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi; let t;
      while ((t = re.exec(tr))) {
        if (/freezebar/i.test(t[1])) continue;
        while (occ[`${rn}:${pos}`]) pos += 1;
        const cs = +((t[1].match(/colspan="?(\d+)/i) || [])[1] || 1), rs = +((t[1].match(/rowspan="?(\d+)/i) || [])[1] || 1);
        for (let r = 0; r < rs; r += 1) for (let c = 0; c < cs; c += 1) occ[`${rn + r}:${pos + c}`] = 1;
        cells[`${letterAt(pos)}${rn}`] = clean(decode(t[2]));
        const job = (t[2].match(/jobs\/([0-9a-f]{8}-[0-9a-f-]{27})/i) || [])[1];
        if (job) cells[`#${letterAt(pos)}${rn}`] = job.toLowerCase();   // AccuLynx job linked in that cell
        pos += cs;
      }
    }
    return cells;
  }
  async function getText(url) {
    const r = await gm({ method: 'GET', url, headers: { 'Cache-Control': 'no-cache' } });
    if (r.status && r.status >= 400) throw new Error(`Lead Table answered ${r.status}. Make sure you are signed in to Google in this Chrome.`);
    return r.responseText || '';
  }
  let tabList = null;
  async function gidFor(name) {
    if (!tabList) {
      const h = await getText(`https://docs.google.com/spreadsheets/d/${ssid}/htmlview?_=${Date.now()}`);
      tabList = [...h.matchAll(/items\.push\(\{name: "([^"]+)"[^}]*?gid: "?(\d+)/g)].map((m) => ({ name: m[1], gid: m[2] }));
      if (!tabList.length) throw new Error('Could not open the Lead Table. Make sure you are signed in to Google in this Chrome.');
    }
    const t = tabList.find((x) => x.name.includes(name));
    return t ? t.gid : null;
  }
  async function readTab(gid) {
    const html = await getText(`https://docs.google.com/spreadsheets/d/${ssid}/htmlview/sheet?headers=true&gid=${gid}&_=${Date.now()}`);
    if (!/<table/i.test(html)) throw new Error('Could not read the Lead Table. Make sure you are signed in to Google in this Chrome.');
    return parseSheet(html);
  }
  function tabNameFor(d) {
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const f = (x) => `${x.getMonth() + 1}.${x.getDate()}.${String(x.getFullYear()).slice(-2)}`;
    return { mon, name: `${f(mon)}-${f(sun)}` };
  }

  // Day blocks: the names row is the one with 8+ "First Last Town" cells; slots are the 3 rows under it
  function findBlocks(cells) {
    const blocks = [];
    for (let r = 3; r <= CONFIG.MAX_ROW; r += 1) {
      const n = CONFIG.REP_COLS.filter((c) => /^\*?\s*[A-Z][a-z]+\s+[A-Z][A-Za-z'-]+/.test(cells[`${c}${r}`] || '')).length;
      if (n >= 15) { blocks.push({ names: r, slots: [r + 1, r + 2, r + 3], pool: [r - 5, r - 4, r - 3] }); r += 6; }
    }
    return blocks.slice(0, 7);
  }
  function repsOf(cells, namesRow) {
    return CONFIG.REP_COLS.map((c) => {
      const raw = cells[`${c}${namesRow}`] || '';
      const manager = raw.includes('*');
      const words = raw.replace(/\*/g, '').trim().split(' ');
      return { col: c, name: words.slice(0, 2).join(' '), home: words.slice(2).join(' '), manager };
    }).filter((r) => r.name);
  }
  // Where a lead cell is: "1000 Lafayette siding 2L" -> "Lafayette", "200 46237 Bohanon" -> "46237"
  function placeFromCell(text) {
    const src = clean(String(text || '').replace(/[*!()]/g, ' '));
    if (/\b(MGT|MGMT|MTG|MEETING|OFF|1:1|SALES|UNAVAILABLE|AWAY|KIDS|SELF\s*GEN)\b/i.test(src)) return '';
    const t = src.replace(/^(\d{1,4}(?:-\d{1,4})?)(?:\s*[<>]\s*\d{3,4})?\s+/, '');
    if (t === src) return '';                               // no leading time = not an appointment
    const zip = t.match(/^(4[67]\d{3})\b/); if (zip) return zip[1];
    const words = t.split(' ');
    const stop = /^(roof|siding|sid|gutters?|gut|windows?|win|doors?|front|soffit|sof|fascia|hardie|insulation|chimney|skylights?|masonry|su|adj|beback|walk|problem|contract|save|self|gen|rh|so|pc|\d.*)$/i;
    const out = [];
    for (const w of words) { if (stop.test(w) || /[\/,]/.test(w)) break; out.push(w); if (out.length === 2) break; }
    return out.join(' ');
  }

  // ---------- maps ----------
  async function geocode(q, structured) {
    const key = 'geo:' + q.toLowerCase();
    const hit = GM_getValue(key, null);
    if (hit) return hit;
    const last = GM_getValue('geo:last', 0); const wait = 1100 - (Date.now() - last);
    if (wait > 0) await sleep(wait);                          // OpenStreetMap allows 1 lookup per second
    GM_setValue('geo:last', Date.now());
    const r = await gm({ method: 'GET', url: `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&${structured ? q : 'q=' + encodeURIComponent(q)}` });
    const arr = JSON.parse(r.responseText || '[]');
    if (!arr.length) return null;
    const p = { lat: +arr[0].lat, lon: +arr[0].lon, label: arr[0].display_name };
    GM_setValue(key, p);
    return p;
  }
  const TOWN_FIX = { 'mccrdsvlle': 'McCordsville', 'mrtinsville': 'Martinsville', 'princes lakes': 'Princes Lakes', 'floyd knobs': 'Floyds Knobs' };
  const fixTown = (p) => TOWN_FIX[clean(p).toLowerCase()] || p;
  const withState = (place) => (/\b(IN|Indiana)\b/i.test(place) ? place : `${place}, ${CONFIG.STATE}`);

  // ---------- the search: next 3 work days, every open slot, best fit by location + drive ----------
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MI = 1609.34;
  async function osrmFrom(origin, pts) {
    const coords = [origin, ...pts].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const r = await gm({ method: 'GET', url: `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance` });
    const j = JSON.parse(r.responseText || '{}');
    if (!j.durations) throw new Error('Drive-time service did not answer. Try again in a minute.');
    return pts.map((p, k) => ({ min: j.durations[0][k + 1] == null ? null : Math.round(j.durations[0][k + 1] / 60), mi: j.distances[0][k + 1] == null ? null : Math.round(j.distances[0][k + 1] / MI) }));
  }

  // start time written at the front of a cell: "1000 ..." -> 600, "200 ..." -> 840, "10-1130 ..." -> 600
  function timeFromCell(text) {
    const m = clean(text).match(/^(\d{1,4})(?:-(\d{1,4}))?(?:\s*[<>]\s*(\d{3,4}))?\s/);
    if (!m) return null;
    const tok = m[3] || m[1];
    let h, mm; if (tok.length <= 2) { h = +tok; mm = 0; } else { h = +tok.slice(0, -2); mm = +tok.slice(-2); }
    if (h < 1 || h > 12 || mm > 59) return null;
    if (h <= 7) h += 12;
    let end = null;
    if (m[2] && !m[3]) { const e = m[2]; let eh, em; if (e.length <= 2) { eh = +e; em = 0; } else { eh = +e.slice(0, -2); em = +e.slice(-2); } if (eh <= 8) eh += 12; end = eh * 60 + em; }
    return { start: h * 60 + mm, end };
  }
  const clock = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${(h % 12) || 12}:${pad2(mm)} ${h >= 12 ? 'PM' : 'AM'}`; };

  async function find(address, slotPick, log) {
    tabList = null;
    const days = workDays();   // next 3 work days, Mon-Sat
    // the AccuLynx job you are on (if any) - it may already sit in the Lead Pool; don't pair it with itself
    const thisJob = ((location.pathname.match(/jobs\/([0-9a-f]{8}-[0-9a-f-]{27})/i) || [])[1] || '').toLowerCase();
    // ...and its Initial Appt (e.g. "November 10, 2026 2:00 PM"): a pool lead at that same day + time is this job
    let thisAppt = null;
    if (thisJob) {
      const m = (document.body.innerText || '').match(/Initial Appt:\s*([A-Za-z]+ \d{1,2}, \d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);
      if (m) { let h = +m[2] % 12; if (/pm/i.test(m[4])) h += 12; thisAppt = { day: new Date(m[1]).toDateString(), start: h * 60 + +m[3] }; }
    }
    const tabCells = {};
    const candidates = [];   // { day, slotIdx, rep, from, fromWhy, next, nextWhy, need }
    for (const d of days) {
      const { mon, name } = tabNameFor(d);
      if (!tabCells[name]) {
        log(`Reading ${name}...`);
        const gid = await gidFor(name);
        if (!gid) { log(`No tab ${name} yet - skipped.`); tabCells[name] = null; continue; }
        tabCells[name] = await readTab(gid);
      }
      const cells = tabCells[name];
      if (!cells) continue;
      const idx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - mon) / 86400000);
      const block = findBlocks(cells)[idx];
      if (!block) continue;
      const reps = repsOf(cells, block.names);
      const places = reps.map((r) => block.slots.map((row) => placeFromCell(cells[`${r.col}${row}`])));
      const times = reps.map((r) => block.slots.map((row) => (placeFromCell(cells[`${r.col}${row}`]) ? timeFromCell(cells[`${r.col}${row}`]) : null)));
      // every lead waiting in this day's Lead Pool, with its place and time row - used to cluster new leads near them
      const dayPool = [];
      {
        const pj = new Set(); block.slots.concat([block.slots[2] + 1]).forEach((rr) => CONFIG.REP_COLS.forEach((c) => { const j = cells[`#${c}${rr}`]; if (j) pj.add(j); }));
        block.pool.forEach((pr, pi) => CONFIG.REP_COLS.forEach((c) => {
          const t = cells[`${c}${pr}`] || ''; const j = cells[`#${c}${pr}`];
          if (!t || /^(DO NOT FILL|SALES MTG|NO LEADS|CANCELS?|PGT.*)$/i.test(t) || (j && pj.has(j))) return;
          if (j && j === thisJob) return;                       // never suggest pairing the lead with itself
          if (thisAppt && thisAppt.day === d.toDateString()) { const tt = timeFromCell(t); if (tt && tt.start === thisAppt.start) return; }
          const pl = placeFromCell(t); if (pl) dayPool.push({ place: fixTown(pl), slotIdx: pi, text: t });
        }));
      }
      block.slots.forEach((row, i) => {
        if (slotClosed(d, CONFIG.SLOTS[i])) return;            // Tuesday morning / Saturday evening: never any lead slots
        // open slots in this row (column B) minus leads already waiting in the Lead Pool for this row.
        // A pool lead that is already placed under a rep (same AccuLynx link below) counts once, not twice.
        const placedJobs = new Set(); block.slots.concat([block.slots[2] + 1]).forEach((rr) => CONFIG.REP_COLS.forEach((c) => { const j = cells[`#${c}${rr}`]; if (j) placedJobs.add(j); }));
        const waiting = CONFIG.REP_COLS.filter((c) => {
          const t = cells[`${c}${block.pool[i]}`] || '';
          if (!t || /^(DO NOT FILL|SALES MTG|NO LEADS|CANCELS?|PGT.*)$/i.test(t)) return false;
          const j = cells[`#${c}${block.pool[i]}`];
          return !(j && placedJobs.has(j));
        }).length;
        const need = parseInt(cells[`B${row}`], 10) - waiting;
        if (!(need > 0)) return;                              // row is full - booking here would overbook
        if (slotPick !== 'any' && CONFIG.SLOTS[i] !== slotPick) return;
        reps.forEach((r, ri) => {
          if (cells[`${r.col}${row}`]) return;                 // slot taken
          let from = r.home, fromWhy = 'home', prevEnd = null;
          for (let j = i - 1; j >= 0; j -= 1) if (places[ri][j]) { from = places[ri][j]; fromWhy = `${CONFIG.SLOTS[j].toLowerCase()} appt`; const t = times[ri][j]; if (t) prevEnd = t.end || t.start + CONFIG.LEAD_MIN; break; }
          let next = r.home, nextWhy = 'home', nextStart = null;
          for (let j = i + 1; j < 3; j += 1) if (places[ri][j]) { next = places[ri][j]; nextWhy = `${CONFIG.SLOTS[j].toLowerCase()} appt`; const t = times[ri][j]; if (t) nextStart = t.start; break; }
          const sameDay = places[ri].filter(Boolean);
          // the rep's whole day (for the "Best fit" breakdown): place + start time of each slot
          const plan = block.slots.map((rr, j) => ({ place: places[ri][j] ? fixTown(places[ri][j]) : '', start: times[ri][j] ? times[ri][j].start : null, taken: !!cells[`${r.col}${rr}`] }));
          candidates.push({ d, label: `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`, slot: CONFIG.SLOTS[i], slotIdx: i, rep: r, from: fixTown(from), fromWhy, next: fixTown(next), nextWhy, need, prevEnd, nextStart, sameDay: sameDay.map(fixTown), dayPool, plan });
        });
      });
    }
    if (!candidates.length) throw new Error(`No open slot with leads needed in the next ${CONFIG.WORK_DAYS} work days.`);

    log('Finding the address...');
    const q = /\bIN\b|Indiana|\b4[67]\d{3}\b/.test(address) ? address : `${address}, ${CONFIG.STATE}`;
    let cust = await geocode(q);
    const zipTyped = (address.match(/\b(4[67]\d{3})\b/) || [])[1];
    if (cust && zipTyped && !String(cust.label).includes(zipTyped)) {
      // the saved lookup does not match the zip that was typed - look it up again, by zip if needed
      GM_setValue('geo:' + q.toLowerCase(), null);
      cust = await geocode(q) || null;
      if (!cust || !String(cust.label).includes(zipTyped)) cust = await geocode(`${zipTyped}, ${CONFIG.STATE}`) || cust;
    }
    // OpenStreetMap often misses rural / highway addresses ("1971 US Highway 136"): fall back to the zip, then the town
    // (structured lookups: a bare "47949, IN" free-text search often finds nothing)
    const parts = address.split(',').map(clean).filter(Boolean);
    const town = parts.length > 1 ? parts[1].replace(/\b(IN|Indiana)\b|\b4[67]\d{3}\b/gi, '').trim() : '';
    if (!cust && town && zipTyped) cust = await geocode(`${town}, ${CONFIG.STATE} ${zipTyped}`);
    if (!cust && zipTyped) cust = await geocode(`postalcode=${zipTyped}&state=Indiana`, true);
    if (!cust && town) cust = await geocode(`city=${encodeURIComponent(town)}&state=Indiana`, true);
    if (!cust && town) cust = await geocode(`${town}, Indiana`);
    if (!cust) throw new Error(`Address not found: "${address}". Try street + city, or the zip.`);

    log('Measuring drives...');
    const names = [...new Set(candidates.flatMap((c) => [c.from, c.next, ...c.sameDay, ...c.dayPool.map((p) => p.place)]))].filter(Boolean);
    const pts = {}; let done = 0;
    for (const nm of names) {
      // one failed lookup must not stop the search: retry once, then skip that place
      try { pts[nm] = await geocode(withState(nm)); } catch (e) { await sleep(2500); try { pts[nm] = await geocode(withState(nm)); } catch (e2) { pts[nm] = null; } }
      done += 1; log(`Measuring drives... (${done}/${names.length} places)`);
    }
    const known = names.filter((nm) => pts[nm]);
    // drive times are remembered: same customer spot + same place = no new calculation next time
    const custKey = `${cust.lat.toFixed(3)},${cust.lon.toFixed(3)}`;
    const legs = {}; const missing = [];
    known.forEach((nm) => { const hit = GM_getValue(`leg:${custKey}|${nm.toLowerCase()}`, null); if (hit) legs[nm] = hit; else missing.push(nm); });
    for (let k = 0; k < missing.length; k += 90) {                 // the router takes up to ~100 points per call
      const part = missing.slice(k, k + 90);
      (await osrmFrom(cust, part.map((nm) => pts[nm]))).forEach((v, n) => { legs[part[n]] = v; if (v.min != null) GM_setValue(`leg:${custKey}|${part[n].toLowerCase()}`, v); });
    }
    // a town or zip is measured from its center, so the same town/zip comes back as 0 min / 0 mi.
    // Inside a town a real drive is still several minutes - use a floor so these do not look like "0 min".
    Object.values(legs).forEach((v) => { if (v && v.min != null && v.min < CONFIG.LOCAL_MIN) { v.local = true; v.min = CONFIG.LOCAL_MIN; v.mi = Math.max(v.mi || 0, CONFIG.LOCAL_MI); } });
    log(missing.length ? `Measured ${missing.length} new drive${missing.length === 1 ? '' : 's'} (${known.length - missing.length} remembered).` : 'All drives remembered from earlier searches.');

    const scored = [];
    candidates.forEach((c) => {
      const inn = legs[c.from], out = legs[c.next];
      if (!inn || inn.min == null) return;
      if (inn.mi > CONFIG.MAX_MILES) return;                  // nobody drives more than 70 miles for one lead
      const back = out && out.min != null ? out.min : inn.min;
      const nearest = Math.min(...[c.from, c.next, ...c.sameDay].map((nm) => (legs[nm] && legs[nm].min != null ? legs[nm].min : 999)));
      // score: drive there + half the drive to where he goes next (on the way home / to the next appt)
      //        + a bonus when he already has another appointment near this address that day
      // leads waiting in the pool that day near this customer: book them as a pair (same rep, next/previous slot)
      // (a pool lead in the SAME time row is competition for the slot, not a partner - only other rows count)
      const near = c.dayPool.filter((p) => p.slotIdx !== c.slotIdx).map((p) => ({ p, m: legs[p.place] && legs[p.place].min != null ? legs[p.place].min : 999 })).filter((x) => x.m <= CONFIG.CLUSTER_MIN).sort((a, b) => a.m - b.m);
      const pairable = near.find((x) => Math.abs(x.p.slotIdx - c.slotIdx) === 1) || null;
      const score = inn.min + 0.5 * back - (c.sameDay.length && nearest <= 25 ? 10 : 0) - (pairable ? 12 : near.length ? 5 : 0) + (c.rep.manager ? 15 : 0);
      // best exact start: as early as the slot allows, but after he can get there from his previous appt,
      // and early enough that he still makes his next appt after a 2-hour lead + the drive
      const [w0, w1] = CONFIG.WINDOWS[c.slotIdx];
      let earliest = w0;
      const now = new Date();
      if (c.d.toDateString() === now.toDateString()) earliest = Math.max(earliest, now.getHours() * 60 + now.getMinutes() + 60); // today: at least an hour from now
      if (c.prevEnd != null) earliest = Math.max(earliest, c.prevEnd + inn.min);
      earliest = Math.ceil(earliest / 15) * 15;
      let latest = w1;
      if (c.nextStart != null) latest = Math.min(latest, Math.floor((c.nextStart - CONFIG.LEAD_MIN - back) / 15) * 15);
      if (earliest > latest) return;                          // he could not make it in or out in time
      const outMi = out && out.mi != null ? out.mi : inn.mi, outLocal = out ? !!out.local : !!inn.local;
      scored.push(Object.assign(c, { local: !!inn.local, min: inn.min, mi: inn.mi, back, outMi, outLocal, nearest, score, startAt: earliest, latestAt: latest, pair: pairable || null }));
    });
    if (!scored.length) throw new Error(`Every open rep is more than ${CONFIG.MAX_MILES} miles away in the next ${CONFIG.WORK_DAYS} work days.`);
    scored.sort((a, b) => a.score - b.score);
    // best 5 SLOTS: one line per day + time row + start time (the best rep for it), never the same slot twice
    const top = []; const usedSlot = new Set();
    for (const c of scored) { const k = `${c.label}|${c.slot}|${c.startAt}`; if (usedSlot.has(k)) continue; usedSlot.add(k); top.push(c); if (top.length === CONFIG.TOP) break; }
    const far = top[0].mi >= CONFIG.FAR_MILES;
    return { cust, top, far, considered: scored.length, days };
  }

  // ---------- panel ----------
  function el(tag, style, text, attrs) {
    const e = document.createElement(tag);
    if (style) e.style.cssText = style;
    if (text != null) e.textContent = text;
    Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
    return e;
  }
  function buildUI() {
    const NAVY = '#1f3a5f', LINE = '#d9dee6', MUTED = '#5f6b7a';
    const btn = el('button', `position:fixed;right:18px;bottom:18px;z-index:2147483000;background:${NAVY};color:#fff;border:0;border-radius:20px;padding:10px 16px;font:600 13px Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:grab;user-select:none;touch-action:none`, 'Availability');
    btn.title = 'Click to open. Drag to move.';
    const panel = el('div', `position:fixed;right:18px;bottom:66px;width:560px;max-width:calc(100vw - 36px);max-height:76vh;overflow:auto;z-index:2147483001;background:#fff;border:1px solid ${LINE};border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.25);font:13px Arial,sans-serif;color:#1d2430;display:none`);
    const head = el('div', `padding:12px 16px;background:${NAVY};color:#fff;display:flex;align-items:center;border-radius:10px 10px 0 0`);
    const ht = el('div', 'flex:1');
    ht.appendChild(el('div', 'font-weight:700;font-size:14px', 'Lead Fit Finder'));
    const sub = el('div', 'font-size:11px;opacity:.8;margin-top:2px', `Best open slot for a new lead - next ${CONFIG.WORK_DAYS} work days`);
    ht.appendChild(sub);
    head.appendChild(ht);
    const x = el('button', 'border:0;background:none;color:#fff;font-size:20px;cursor:pointer;line-height:1', '×'); head.appendChild(x);
    const form = el('div', `padding:12px 16px;display:flex;gap:8px;border-bottom:1px solid ${LINE}`);
    const addr = el('input', `flex:1;padding:8px 10px;border:1px solid ${LINE};border-radius:6px;font:13px Arial,sans-serif`, null, { placeholder: 'Customer address, city or zip' });
    const go = el('button', `background:${NAVY};color:#fff;border:0;border-radius:6px;padding:8px 18px;font:600 13px Arial,sans-serif;cursor:pointer`, 'Find');
    const pick = el('select', `padding:8px 6px;border:1px solid ${LINE};border-radius:6px;font:13px Arial,sans-serif;background:#fff`);
    [['any', 'Any time'], ['Morning', 'Morning'], ['Afternoon', 'Afternoon'], ['Evening', 'Evening']].forEach(([v, t]) => { const o = el('option', '', t); o.value = v; pick.appendChild(o); });
    form.appendChild(addr); form.appendChild(pick); form.appendChild(go);
    const status = el('div', `padding:8px 16px;color:${MUTED};font-size:12px`, 'Enter an address and press Find.');
    const out = el('div', 'padding:0 16px 14px');
    panel.appendChild(head); panel.appendChild(form); panel.appendChild(status); panel.appendChild(out);
    document.body.appendChild(panel); document.body.appendChild(btn);
    // ---- drag to move; the spot is remembered ----
    // keep the whole panel on screen wherever the button sits: open on the side with more room,
    // and shrink the panel (it scrolls inside) so it never runs off the top or bottom
    const placePanel = () => {
      if (panel.style.display === 'none') return;
      const r = btn.getBoundingClientRect(); const M = 8;
      const pw = Math.min(560, window.innerWidth - 2 * M);
      panel.style.width = pw + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = Math.max(M, Math.min(r.left + r.width - pw, window.innerWidth - pw - M)) + 'px';
      const above = r.top - 2 * M, below = window.innerHeight - r.bottom - 2 * M;
      const room = Math.max(above, below);
      panel.style.maxHeight = Math.max(220, room) + 'px';
      const ph = Math.min(panel.scrollHeight, Math.max(220, room));
      const top = below >= above ? r.bottom + M : r.top - M - ph;
      panel.style.top = Math.max(M, Math.min(top, window.innerHeight - ph - M)) + 'px';
    };
    new MutationObserver(() => placePanel()).observe(out, { childList: true, subtree: true });
    window.addEventListener('resize', placePanel);
    const setPos = (x, y) => {
      x = Math.max(4, Math.min(x, window.innerWidth - btn.offsetWidth - 4)); y = Math.max(4, Math.min(y, window.innerHeight - btn.offsetHeight - 4));
      btn.style.left = x + 'px'; btn.style.top = y + 'px'; btn.style.right = 'auto'; btn.style.bottom = 'auto';
    };
    const saved = GM_getValue('btnPos', null);
    if (saved) setPos(saved.x, saved.y);
    let drag = null, moved = false;
    btn.addEventListener('pointerdown', (e) => { const r = btn.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY }; moved = false; btn.setPointerCapture(e.pointerId); btn.style.cursor = 'grabbing'; });
    btn.addEventListener('pointermove', (e) => { if (!drag) return; if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) > 4) moved = true; if (moved) { setPos(e.clientX - drag.dx, e.clientY - drag.dy); if (panel.style.display === 'block') placePanel(); } });
    btn.addEventListener('pointerup', () => { if (!drag) return; drag = null; btn.style.cursor = 'grab'; if (moved) { const r = btn.getBoundingClientRect(); GM_setValue('btnPos', { x: r.left, y: r.top }); } });
    window.addEventListener('resize', () => { const p = GM_getValue('btnPos', null); if (p) setPos(p.x, p.y); });
    btn.onclick = () => { if (moved) { moved = false; return; } panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; if (panel.style.display === 'block') { placePanel(); addr.focus(); } };
    btn.addEventListener('dblclick', (e) => { e.preventDefault(); GM_setValue('btnPos', null); btn.style.left = btn.style.top = ''; btn.style.right = '18px'; btn.style.bottom = '18px'; });
    x.onclick = () => { panel.style.display = 'none'; };
    const cellCss = `padding:7px 6px;border-bottom:1px solid ${LINE};vertical-align:top`;
    let busy = false;
    const run = async () => {
      if (busy || !clean(addr.value)) return;
      busy = true; out.textContent = ''; go.disabled = true; go.style.opacity = '.6'; status.style.color = MUTED;
      try {
        const typed = clean(addr.value);
        const res = await find(typed, pick.value, (m) => { status.textContent = m; });
        const dayList = res.days.map((d) => `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`).join(', ');
        sub.textContent = `Best open slot for a new lead - ${dayList}`;
        status.textContent = `Results for: ${typed} (${pick.options[pick.selectedIndex].text})  -  found ${res.cust.label.split(',').slice(0, 3).join(',')}  -  ${res.considered} open slots compared`;
        if (res.far) {
          out.appendChild(el('div', 'margin:6px 0 10px;padding:8px 10px;background:#fff4e5;border:1px solid #f5c58a;border-radius:6px;color:#7a4a00;font-size:12px',
            `Distant lead (${res.top[0].mi} mi for the best fit). Book this rep's slot with another lead in the same area or on the way back.`));
        }
        // one card per result: left = day, time, drive; right = "Best fit" - the rep's whole day, slot by slot
        const custName = typed.split(',')[0];
        const leg = (mi, min, local) => (local ? `same area / ~${min} min` : `${mi} mi / ${min} min`);
        res.top.forEach((c, k) => {
          const card = el('div', `display:flex;gap:12px;margin-top:10px;padding:10px;border:1px solid ${k === 0 ? '#9fc0e3' : LINE};border-radius:8px;background:${k === 0 ? '#f2f7fc' : '#fff'}`);
          const left = el('div', 'flex:0 0 118px');
          const col = c.min <= 30 ? '#1b7f3a' : c.min <= 60 ? '#b26a00' : '#b42318';
          left.appendChild(el('div', `font-weight:700;color:${NAVY};font-size:11px`, `#${k + 1}${k === 0 ? '  BEST' : ''}`));
          left.appendChild(el('div', 'font-weight:700;font-size:14px;margin-top:2px', c.label));
          left.appendChild(el('div', `font-weight:700;font-size:16px;color:${NAVY}`, clock(c.startAt)));
          left.appendChild(el('div', `color:${MUTED};font-size:11.5px`, c.slot));
          if (c.latestAt > c.startAt) left.appendChild(el('div', `color:${MUTED};font-size:11.5px`, `ok until ${clock(c.latestAt)}`));
          left.appendChild(el('div', `color:${MUTED};font-size:11.5px`, `${c.need} needed`));
          left.appendChild(el('div', `margin-top:4px;font-weight:700;color:${col}`, c.local ? `~${c.min} min drive` : `${c.min} min · ${c.mi} mi`));
          card.appendChild(left);

          const right = el('div', `flex:1;border-left:1px solid ${LINE};padding-left:12px;font-size:12px;line-height:1.55`);
          right.appendChild(el('div', `font-weight:700;color:${NAVY};margin-bottom:2px`, 'Best fit:'));
          const nextIdx = c.plan.findIndex((p, j) => j > c.slotIdx && p.place);
          const fromLabel = c.fromWhy === 'home' ? `${c.from} (home)` : c.from;
          c.plan.forEach((p, j) => {
            const name = CONFIG.SLOTS[j];
            let text, style = '';
            if (j === c.slotIdx) {
              text = `${name}: ${fromLabel} to ${custName} ${clock(c.startAt)} = ${leg(c.mi, c.min, c.local)}`;
              style = 'font-weight:700;color:#1b7f3a';                     // the new lead
            } else if (j === nextIdx) {
              text = `${name}: ${custName} to ${p.place}${p.start != null ? ' ' + clock(p.start) : ''} = ${leg(c.outMi, c.back, c.outLocal)}`;
            } else if (p.place) {
              text = `${name}: ${p.place}${p.start != null ? ' ' + clock(p.start) : ''} (booked)`;
            } else if (p.taken || slotClosed(c.d, name)) {
              text = `${name}: not available`; style = `color:${MUTED}`;
            } else {
              text = `${name}: open`; style = `color:${MUTED}`;
            }
            const line = el('div', style); line.appendChild(el('span', 'font-weight:700', name + ':')); line.appendChild(document.createTextNode(text.slice(name.length + 1)));
            right.appendChild(line);
          });
          if (c.nextWhy === 'home') {
            const line = el('div', ''); line.appendChild(el('span', 'font-weight:700', 'Home:'));
            line.appendChild(document.createTextNode(` ${custName} to ${c.next} = ${leg(c.outMi, c.back, c.outLocal)}`));
            right.appendChild(line);
          }
          if (c.pair) right.appendChild(el('div', 'margin-top:4px;color:#1b7f3a;font-weight:600', `Pair with pool lead ${c.pair.p.text.split(' ').slice(0, 3).join(' ')} (${CONFIG.SLOTS[c.pair.p.slotIdx].toLowerCase()}, ${c.pair.m} min apart)`));
          card.appendChild(right);
          out.appendChild(card);
        });
        out.appendChild(el('div', `margin-top:8px;color:${MUTED};font-size:11px`, `Ranked by the drive there, the drive to the next stop or home, and nearby Lead Pool leads that can be paired. Full rows, Tuesday mornings, Saturday evenings and drives over ${CONFIG.MAX_MILES} miles are left out.`));
      } catch (e) { status.textContent = e.message; status.style.color = '#b42318'; }
      busy = false; go.disabled = false; go.style.opacity = '1';
    };
    go.onclick = run;
    // changing the address or the time of day clears the old results so they are never mistaken for the new search
    const stale = () => { if (busy) return; if (out.childNodes.length) { out.textContent = ''; status.style.color = MUTED; status.textContent = 'Press Find to search.'; } };
    addr.addEventListener('input', stale); pick.addEventListener('change', stale);
    addr.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    ['keydown', 'keypress', 'keyup', 'input'].forEach((ev) => panel.addEventListener(ev, (e) => e.stopPropagation()));
  }

  let n = 0;
  const wait = setInterval(() => {
    n += 1;
    if (document.body) { clearInterval(wait); buildUI(); } else if (n > 60) clearInterval(wait);
  }, 1000);
})();
