// ==UserScript==
// @name         Mars Lead Form (GroupMe → AccuLynx + Lead Table)
// @namespace    amos-exteriors
// @version      1.9.2
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/mars-lead-form.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/mars-lead-form.user.js
// @description  In-house lead form for the Mars team. A green "+ LEAD" button sits next to CONF in GroupMe and right of "for Amos Exteriors" in the title of AccuLynx's Create New Lead page. Check for Duplicate searches AccuLynx, opens Street View and the Predictive Sales AI storm map, and checks the Amos Service Area. Complete enters the lead in AccuLynx (or revives the old lead) and puts it in the Lead Table's Lead Pool.
// @author       Andrew Thomas (Mars 2) with Claude
// @match        https://web.groupme.com/*
// @match        https://app.groupme.com/*
// @match        https://my.acculynx.com/*
// @match        https://www.google.com/maps/*
// @match        https://docs.google.com/spreadsheets/d/170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      my.acculynx.com
// @connect      docs.google.com
// @connect      www.google.com
// @connect      geocoding.geo.census.gov
// @connect      nominatim.openstreetmap.org
// @connect      router.project-osrm.org
// @connect      maps.googleapis.com
// @connect      streetviewpixels-pa.googleapis.com
// @connect      googleusercontent.com
// @connect      i.groupme.com
// @connect      groupme.com
// @connect      server.arcgisonline.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
  HOW THE MARS TEAM USES IT
  1. In GroupMe click the green "+ LEAD" button (next to CONF). The lead form opens.
  2. Type First Name, Last Name, Phone, Email and Address, then press the big CHECK FOR DUPLICATE button.
     It does four things at once:
       - searches AccuLynx for the same name, phone, address and email,
       - opens Google Street View of the house in a new tab,
       - opens Predictive Sales AI (storm map) for the address in a new tab,
       - checks the address against the Amos Service Area map (the map linked on the Lead Table's
         SERVICE AREA tab): OK / ROOF ONLY / OUT OF AREA.
  3. Fill in the rest and press COMPLETE. The form clears for the next lead and the work runs by itself:
       NEW LEAD   -> AccuLynx Create Lead (notes template, trades, appointment, assigned to Mars 1 /
                     Needs Confirmed / Mars 2), Save, house + overview pictures, house picture on Location
                     Info, "Lead Source / Initial Appt" and "Claude" replies.
       DUPLICATE  -> every AccuLynx record found has a link (opens in a background tab, the form stays open) and a
                     DUPLICATE box. Tick the box on the matching record (the likely one says "suggested"):
                     Lead / Prospect / Dead job -> that job is used: re-opened if dead, new initial appointment,
                     assigned, the filled-out lead report posted in its comments, Lead Table.
                     SOLD job (Approved / Completed / Invoiced / Closed) -> a NEW lead with the IN number in
                     Cross Reference. No box ticked = NEW lead (Complete asks first if a likely duplicate was found).
       ROOF ONLY  -> when the address is in a roof-only zone, every product other than Roof (ticked or typed in
                     the "other" box) is flagged OOA in red, Complete asks first, and the notes get an OOA line.
       LEAD TABLE -> the lead is written into that day's Lead Pool row (Morning / Afternoon / Evening), linked
                     to the job: "1000 Carmel Roof" (retail, leftmost free cell) or "1000 Carmel Smith"
                     (insurance, rightmost free cell). A TAKEN cell is used first, then an empty cell, then
                     DO NOT FILL. White fill, black letters, Arial 9. CTS leads (no time) are not put on the table.
     The Lead Table opens in its own tab for a few seconds to do the typing (Chrome will not type in a
     background tab) and closes itself.
  SCREEN 2 (optional): press "Screen 2" at the top of the form once. A "SCREEN 2" tab opens (Lead Table, read-only);
     drag that tab onto your other screen and leave it open. From then on Check for Duplicate opens its tabs in THAT
     window: Street View of the house in front, the storm map behind it, and AccuLynx records you click go behind
     too. The next lead's Check for Duplicate closes the last lead's tabs there. No Screen 2 tab open = tabs open here.
  4. The "Recent" list at the bottom of the form shows how each lead is going and anything left to do by hand.
*/

(function () {
  'use strict';

  /* ===================== SETTINGS ===================== */
  const CONFIG = {
    LEAD_TABLE_ID: '170b4L23-iIy2D8LH_d2DvcQhulscqtMo6cs7p6byMDY',      // Lead Table 2026
    SERVICE_TAB: /service area/i,                                    // tab that links the service area map
    ASSIGN_OPTIONS: ['Mars 1', 'Needs Confirmed', 'Mars 2'],
    TASK_TITLE: 'Claude Automated Lead',
    TASK_ASSIGNEE: 'Mars 1 (Resets)',
    SIGNATURE: 'Claude',
    RETAIL_HOURS: 2,
    INSURANCE_HOURS: 1,
    DEFAULT_EMAIL: 'didnotget@gmail.com',
    REP_COLS: 'CDEFGHIJKLMNOPQRSTUVW'.split(''),
    PATRICK_BLUE: '#0000ff',
    PRODUCTS: [                                                       // form box -> AccuLynx Trade Type
      ['Roof', 'Roofing'], ['Gutters', 'Gutters'], ['Siding', 'Siding / Soffit / Fascia'],
      ['Soffit/Fascia', 'Fascia and Soffit'], ['Windows', 'Doors / Windows'], ['Doors', 'Doors / Windows'],
      ['Insulation', 'Insulation'], ['Masonry', 'Masonry'], ['Repairs', 'Repairs'],
    ],
    STYLES: ['Ranch', '1.5 Story', '2 Story', 'Bi-Level', 'Tri-Level', 'Split Level', 'Cape Cod', 'Mobile Home', 'Condo / Townhouse'],
  };
  /* ==================================================== */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pad2 = n => String(n).padStart(2, '0');
  const clean = s => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');
  const visible = e => e && e.offsetParent !== null;
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  async function waitFor(fn, timeout = 15000, step = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ }
      await sleep(step);
    }
    return null;
  }
  function gm(opts) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest(Object.assign({
      timeout: 30000, onload: resolve,
      onerror: () => reject(new Error('could not reach ' + ((opts.url.match(/^https?:\/\/([^/]+)/) || [])[1] || 'the site'))),
      ontimeout: () => reject(new Error('timed out')),
    }, opts)));
  }
  const fmtLead = min => { const h = (Math.floor(min / 60) % 12) || 12; return `${h}${pad2(min % 60)}`; };
  const clock = min => { const h = (Math.floor(min / 60) % 12) || 12; return `${h}:${pad2(min % 60)} ${min >= 720 ? 'PM' : 'AM'}`; };

  /* ===================== ADDRESS ===================== */
  const SW = 'street|st|road|rd|drive|dr|lane|ln|avenue|ave|court|ct|circle|cir|way|boulevard|blvd|place|pl|trail|trl|parkway|pkwy|highway|hwy|pike|terrace|ter|loop|run|cove|cv|bend|point|pt|path|square|sq';
  const titleCase = s => s.split(/(\s+)/).map(w => /^[A-Z][a-z]+[A-Z][a-z]+$/.test(w) ? w : w.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())).join('');
  function splitAddress(addr) {
    let a = (addr || '').replace(/\s+/g, ' ').trim();
    const zips = [...a.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].filter(m => m.index > 0);
    const zm = zips.length ? zips[zips.length - 1] : null;
    const zip = zm ? zm[1] : '';
    if (zm) a = a.slice(0, zm.index) + a.slice(zm.index + zm[0].length);
    a = a.replace(/,?\s*\b(Indiana|IN)\b\.?/i, '').replace(/[,\s]+$/, '').trim();
    let street = a, city = '';
    if (a.includes(',')) { const p = a.split(',').map(x => x.trim()).filter(Boolean); street = p[0]; city = p[1] || ''; }
    else { const m = a.match(new RegExp('^(.*?\\b(?:' + SW + '))\\b\\.?\\s+(.+)$', 'i')); if (m) { street = m[1].trim(); city = m[2].trim(); } }
    const FIX = { indpls: 'Indianapolis', indy: 'Indianapolis', ind: 'Indianapolis', indianapolis: 'Indianapolis' };
    city = FIX[city.toLowerCase().replace(/\./g, '').trim()] || city;
    return { street: titleCase(street), city: titleCase(city), zip };
  }
  // Google finds numbered county roads only in the short form ("1234 W 100 S")
  function shortRoad(street) {
    const bare = street.replace(/\b(?:county\s+road|c(?:o|ty|nty)\.?\s*rd\.?|cr)\s*(?=\d|[NSEW]\b)/ig, ' ').replace(/\s+/g, ' ').trim();
    if (new RegExp('\\b(?:' + SW + ')\\b', 'i').test(bare)) return street;
    if (!/\d/.test(bare.replace(/^\s*\d+\s*/, ''))) return street;
    return bare.replace(/\bnorth\b/ig, 'N').replace(/\bsouth\b/ig, 'S').replace(/\beast\b/ig, 'E').replace(/\bwest\b/ig, 'W').replace(/\s+/g, ' ').trim();
  }
  // products asked for that are NOT roofing (ticked boxes + words typed in the "other" box)
  const NON_ROOF = [['Gutters', /gutter|guard/i], ['Siding', /siding|hardie|vinyl/i], ['Soffit/Fascia', /sof+it|fa[sc]+ia|\btrim\b/i], ['Windows', /window/i], ['Doors', /\bdoors?\b/i],
    ['Insulation', /insulation/i], ['Masonry', /masonry|brick|chimney/i], ['Paint', /paint/i], ['Deck/Porch', /deck|porch/i], ['Skylights', /skylight/i]];
  function ooaProducts(products, otherText) {
    const out = new Set((products || []).filter(p => !/^(roof|repairs)$/i.test(p)));
    NON_ROOF.forEach(([name, re]) => { if (re.test(otherText || '')) out.add(name); });
    return [...out];
  }
  const oneLine = ad => [shortRoad(ad.street), ad.city, 'IN', ad.zip].filter(Boolean).join(', ');
  // address -> { lat, lon, city, zip, matched }  (US Census first, OpenStreetMap as backup)
  async function geocode(address) {
    const ad = splitAddress(address);
    try {
      const r = await gm({ method: 'GET', url: 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(oneLine(ad)) });
      const m = JSON.parse(r.responseText).result.addressMatches[0];
      if (m) {
        const c = m.addressComponents || {};
        return { lat: m.coordinates.y, lon: m.coordinates.x, city: titleCase(c.city || ad.city || ''), zip: c.zip || ad.zip, matched: m.matchedAddress, exact: true };
      }
    } catch (e) { /* try the backup */ }
    const q = new URLSearchParams({ format: 'json', addressdetails: '1', limit: '1', countrycodes: 'us' });
    if (ad.street) q.set('street', ad.street); if (ad.city) q.set('city', ad.city); if (ad.zip) q.set('postalcode', ad.zip); q.set('state', 'Indiana');
    const r = await gm({ method: 'GET', url: 'https://nominatim.openstreetmap.org/search?' + q });
    const h = JSON.parse(r.responseText)[0];
    if (!h) throw new Error('address not found on the map - check the spelling, city and zip');
    const a = h.address || {};
    return { lat: +h.lat, lon: +h.lon, city: titleCase(a.city || a.town || a.village || ad.city || ''), zip: a.postcode || ad.zip, matched: h.display_name, exact: !!a.house_number };
  }

  /* ===================== SERVICE AREA (map linked on the Lead Table) ===================== */
  function parseKml(kml) {
    const shapes = [];
    const coords = s => s.trim().split(/\s+/).map(c => c.split(',').map(Number)).filter(p => p.length >= 2 && !isNaN(p[0])).map(p => [+p[0].toFixed(4), +p[1].toFixed(4)]);
    for (const m of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
      const p = m[1];
      const name = clean((p.match(/<name>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/name>/) || [])[1]);
      // the 45-minute drive shapes are only a guide and are huge – not needed for the verdict
      if (!/outside|service area|srvc|shingle|work this area|storm/i.test(name)) continue;
      const polys = [];
      for (const pg of p.matchAll(/<Polygon>([\s\S]*?)<\/Polygon>/g)) {
        const outer = (pg[1].match(/<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/) || [])[1];
        if (!outer) continue;
        const inner = [...pg[1].matchAll(/<innerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)].map(x => coords(x[1]));
        polys.push({ outer: coords(outer), inner });
      }
      for (const ls of p.matchAll(/<LineString>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/g)) polys.push({ outer: coords(ls[1]), inner: [] });
      if (polys.length) shapes.push({ name, polys });
    }
    return shapes;
  }
  const inRing = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c; } return c; };
  const inShape = (pt, s) => s.polys.some(p => inRing(pt, p.outer) && !p.inner.some(r => inRing(pt, r)));
  async function serviceAreaShapes() {
    const cached = GM_getValue('mlf_area', null);
    if (cached && cached.shapes && Date.now() - cached.t < 24 * 3600e3) return cached.shapes;
    // 1) the SERVICE AREA tab on the Lead Table holds the link to the map
    const base = `https://docs.google.com/spreadsheets/d/${CONFIG.LEAD_TABLE_ID}`;
    const list = await gm({ method: 'GET', url: `${base}/htmlview?_=${Date.now()}` });
    const tabs = [...(list.responseText || '').matchAll(/items\.push\(\{name: "([^"]+)"[^}]*?gid: "?(\d+)/g)].map(m => ({ name: m[1], gid: m[2] }));
    const tab = tabs.find(t => CONFIG.SERVICE_TAB.test(t.name));
    if (!tab) throw new Error('No SERVICE AREA tab found on the Lead Table (are you signed in to Google in this Chrome?)');
    const sheet = await gm({ method: 'GET', url: `${base}/htmlview/sheet?headers=true&gid=${tab.gid}&_=${Date.now()}` });
    const html = (sheet.responseText || '').replace(/&amp;/g, '&');
    let mid = null;
    for (const h of html.matchAll(/href="([^"]+)"/g)) { const u = decodeURIComponent(h[1]); const m = u.match(/maps\/d\/[^"]*?[?&]mid=([\w-]+)/); if (m) { mid = m[1]; break; } }
    if (!mid) throw new Error('The SERVICE AREA tab has no map link');
    // 2) the map's shapes (KML export)
    const k = await gm({ method: 'GET', url: `https://www.google.com/maps/d/kml?mid=${mid}&forcekml=1`, timeout: 60000 });
    if (k.status >= 400 || !/<kml/i.test(k.responseText || '')) throw new Error('Could not open the service area map (HTTP ' + k.status + ')');
    const shapes = parseKml(k.responseText);
    if (!shapes.length) throw new Error('The service area map has no shapes I recognize');
    GM_setValue('mlf_area', { t: Date.now(), shapes });
    return shapes;
  }
  // Order matters: shingle-roof-only zones, then the "Outside" zones, then the service areas. Anything else is out.
  async function serviceAreaVerdict(geo) {
    const shapes = await serviceAreaShapes();
    const pt = [geo.lon, geo.lat];
    const hits = shapes.filter(s => inShape(pt, s)).map(s => s.name);
    const has = re => hits.some(n => re.test(n));
    const notes = [];
    if (has(/laf/i)) notes.push('Lafayette branch area');
    if (has(/murphy/i)) notes.push("Patrick Murphy's area");
    if (has(/work this area|storm/i)) notes.push('inside a storm area on the map');
    let verdict, color;
    if (has(/shingle/i)) { verdict = 'ROOF ONLY (shingle roofing)'; color = '#1565c0'; }
    else if (has(/outside/i)) { verdict = 'OUT OF AREA'; color = '#b42318'; }
    else if (has(/indy service area|ok for all|laf branch srvc|murphy srvc/i)) { verdict = 'IN SERVICE AREA - all products'; color = '#1b7f3a'; }
    else { verdict = 'OUT OF AREA (not inside any service area)'; color = '#b42318'; }
    return { verdict, color, notes, hits, roofOnly: /^ROOF ONLY/.test(verdict) };
  }

  /* ===================== ACCULYNX SEARCH (duplicates) ===================== */
  // direct call with the browser's AccuLynx sign-in; if that is refused, an open AccuLynx tab does it for us
  async function axSearch(query, noContacts) {
    const path = `/api/Search/GetTypeAheadSearch?noContacts=${noContacts ? 'true' : 'false'}&query=${encodeURIComponent(query)}`;
    try {
      const r = await gm({ method: 'GET', url: 'https://my.acculynx.com' + path, headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      if (r.status === 200 && /^\s*\{/.test(r.responseText || '')) return JSON.parse(r.responseText).results || [];
    } catch (e) { /* use the relay */ }
    const ask = () => new Promise((resolve, reject) => {
      const id = Date.now() + '-' + Math.random().toString(36).slice(2); let lid = null;
      const timer = setTimeout(() => { if (lid !== null) GM_removeValueChangeListener(lid); reject(new Error('timeout')); }, 9000);
      lid = GM_addValueChangeListener('mlf_ax_res', (n, o, v) => { if (!v || v.id !== id) return; clearTimeout(timer); GM_removeValueChangeListener(lid); v.ok ? resolve(v.data) : reject(new Error(v.error)); });
      GM_setValue('mlf_ax_req', { id, path, ts: Date.now() });
    });
    try { return JSON.parse(await ask()).results || []; }
    catch (e) {
      // no AccuLynx tab open: open ONE in the background (shared by the 4 searches) and ask again
      if (!axTab) axTab = (async () => { const t = GM_openInTab('https://my.acculynx.com/dashboard', { active: false, insert: true }); await sleep(9000); return t; })();
      const tab = await axTab;
      try { return JSON.parse(await ask()).results || []; }
      catch (e2) { throw new Error('AccuLynx did not answer - sign in to AccuLynx in this Chrome'); }
      finally { setTimeout(() => { try { tab.close(); } catch (_) { /* ignore */ } axTab = null; }, 15000); }
    }
  }
  let axTab = null;
  const SOLD = /^(Approved|Completed|Invoiced|Closed)$/i;
  const OPEN = /^(Lead|Prospect)$/i;
  const DEAD = /^(Dead|Canceled|Cancelled)$/i;
  // jobs "Submitted for approval" count as SOLD until they are closed (Andrew's rule): returns Map(jobId lower -> {rep, date})
  async function axSubmitted() {
    const m = new Map();
    try {
      const r = await gm({ method: 'GET', url: 'https://my.acculynx.com/api/v3/job-workflows/track/milestones/3', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } });
      if (r.status !== 200) return m;
      const j = JSON.parse(r.responseText || 'null');
      const arr = Array.isArray(j) ? j : (j && (j.items || j.data || j.results || j.jobs)) || [];
      for (const x of arr) { const id = String(x.JobId || x.jobId || x.Id || '').toLowerCase(); if (id) m.set(id, { rep: x.CompanyRepresentative || x.companyRepresentative || '', date: x.SubmittedDate || '' }); }
    } catch (e) { /* no AccuLynx sign-in here, or the list is unavailable - the normal sold check still works */ }
    return m;
  }
  const isSold = x => SOLD.test(x.CurrentMilestone || '') || !!x.Submitted;
  async function findDuplicates(f) {
    const ad = splitAddress(f.address);
    const num = (ad.street.match(/^\d+/) || [''])[0];
    const word = (ad.street.replace(/^\d+\s+/, '').split(/[\s,]+/).find(w => w.length > 2 && !/^(north|south|east|west)$/i.test(w)) || '');
    const streetRe = num && word ? new RegExp('^\\s*' + num + '\\s+(?:(?:north|south|east|west|[nsew])\\.?\\s+)?' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i') : null;
    const searches = [
      ['name', `${f.first} ${f.last}`.trim()],
      ['phone', f.phone],
      ['address', num && word ? `${num} ${word}` : ''],
      ['email', f.email && f.email.toLowerCase() !== CONFIG.DEFAULT_EMAIL ? f.email : ''],
    ].filter(s => s[1]);
    const all = new Map();
    const errors = [];
    await Promise.all(searches.map(async ([kind, q]) => {
      try {
        const res = await axSearch(q, false);
        for (const x of res) {
          const blob = JSON.stringify(x).toLowerCase();
          let ok = false;
          if (kind === 'name') ok = !!f.last && blob.includes(f.last.toLowerCase()) && (!f.first || blob.includes(f.first.toLowerCase()));
          if (kind === 'phone') ok = blob.replace(/\D/g, '').includes(f.phone);
          if (kind === 'address') ok = !!streetRe && streetRe.test(x.FullAddress || '');
          if (kind === 'email') ok = blob.includes(f.email.toLowerCase());
          if (!ok) continue;
          const key = x.Id || x.Name;
          const cur = all.get(key) || Object.assign({ why: new Set() }, x);
          cur.why.add(kind); all.set(key, cur);
        }
      } catch (e) { errors.push(kind + ': ' + e.message); }
    }));
    const matches = [...all.values()].map(x => Object.assign(x, { why: [...x.why] }))
      .sort((a, b) => b.why.length - a.why.length);
    // a phone or email match alone is not enough (numbers get reused) – it must also share the name or the address
    const strong = x => x.why.includes('address') || (x.why.includes('name') && (x.why.includes('phone') || x.why.includes('email')));
    const jobs = matches.filter(x => x.Type !== 'Contact' && x.Id && strong(x));
    const subm = await axSubmitted();
    jobs.forEach(x => { const sb = subm.get(String(x.Id).toLowerCase()); if (sb && !SOLD.test(x.CurrentMilestone || '')) { x.Submitted = true; x.SalesPerson = x.SalesPerson || sb.rep; x.SubmittedRep = sb.rep; } });
    const sold = jobs.filter(x => isSold(x)).sort((a, b) => (b.MilestoneStart || '').localeCompare(a.MilestoneStart || ''))[0];
    const open = jobs.filter(x => OPEN.test(x.CurrentMilestone || '') && !x.Submitted).sort((a, b) => (b.MilestoneStart || '').localeCompare(a.MilestoneStart || ''))[0];
    const dead = jobs.filter(x => DEAD.test(x.CurrentMilestone || '') && !x.Submitted).sort((a, b) => (b.MilestoneStart || '').localeCompare(a.MilestoneStart || ''))[0];
    let plan;
    // Andrew's rules: an OPEN lead (Lead / Prospect) at the house is used; otherwise a SOLD job means a new lead with the
    // IN number in Cross Reference; only when the house has nothing but dead jobs is the newest dead job revived
    if (open || (dead && !sold)) {
      const j = open || dead;
      const oldest = jobs.filter(x => !DEAD.test(x.CurrentMilestone || '') || x === j).sort((a, b) => (a.MilestoneStart || '').localeCompare(b.MilestoneStart || ''))[0] || j;
      const overYear = oldest.MilestoneStart && (Date.now() - new Date(oldest.MilestoneStart)) / 864e5 > 365;
      plan = { kind: 'revive', jobId: j.Id, name: j.Name, milestone: j.CurrentMilestone, dead: DEAD.test(j.CurrentMilestone || ''), address: j.FullAddress, overYear };
    } else if (sold) {
      plan = planForPick(sold, 'prev');
    } else plan = { kind: 'new' };
    return { matches, plan, errors };
  }
  // what Complete does with the record the rep checked as the duplicate
  // what Complete does with the record the rep picked. mode: 'dup' = add to that job, 'dupkeep' = add to it but keep its appointment,
  // 'prev' = Previous Customer (new lead, IN number in Cross Reference), 'new' = ignore it. No mode = the sensible default for that job.
  function planForPick(j, mode) {
    if (!j || mode === 'new') return { kind: 'new' };
    const sold = isSold(j);
    if (!mode) mode = sold ? 'prev' : 'dup';
    if (mode === 'prev') return { kind: 'sold', crossRef: ((j.Name || '').match(/^IN-\d+/) || [''])[0], name: j.Name, milestone: j.Submitted ? 'Submitted for approval' : j.CurrentMilestone, sellingRep: clean(j.SalesPerson || j.SubmittedRep || '') };
    const overYear = !!j.MilestoneStart && (Date.now() - new Date(j.MilestoneStart)) / 864e5 > 365;
    return { kind: 'revive', jobId: j.Id, name: j.Name, milestone: j.CurrentMilestone, dead: DEAD.test(j.CurrentMilestone || ''), address: j.FullAddress, overYear, keepAppt: mode === 'dupkeep' };
  }

  /* ======================================================================================
     LEAD FIT FINDER (same logic as the Lead Fit Finder script): best open slots for an address.
     Reads the Lead Table, measures the drives, and ranks the open slots for the next 4 days.
     ====================================================================================== */
  const FIT = (function () {
    const FC = {
      REP_COLS: 'CDEFGHIJKLMNOPQRSTUVW'.split(''),
      SLOTS: ['Morning', 'Afternoon', 'Evening'],
      WINDOWS: [[600, 705], [720, 915], [930, 1110]],   // lead start window per slot row (minutes after midnight)
      LEAD_MIN: 120, STATE: 'IN', TOP: 5, MAX_MILES: 70, LOCAL_MIN: 10, LOCAL_MI: 4, CLUSTER_MIN: 20, FAR_MILES: 45, MAX_ROW: 100,
    };
    const ssid = CONFIG.LEAD_TABLE_ID;
    const colLetter = (i) => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const decode = (s) => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

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
        if (!rn || rn > FC.MAX_ROW) continue;
        let pos = 0; const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi; let t;
        while ((t = re.exec(tr))) {
          if (/freezebar/i.test(t[1])) continue;
          while (occ[`${rn}:${pos}`]) pos += 1;
          const cs = +((t[1].match(/colspan="?(\d+)/i) || [])[1] || 1), rs = +((t[1].match(/rowspan="?(\d+)/i) || [])[1] || 1);
          for (let r = 0; r < rs; r += 1) for (let c = 0; c < cs; c += 1) occ[`${rn + r}:${pos + c}`] = 1;
          cells[`${letterAt(pos)}${rn}`] = clean(decode(t[2]));
          const job = (t[2].match(/jobs\/([0-9a-f]{8}-[0-9a-f-]{27})/i) || [])[1];
          if (job) cells[`#${letterAt(pos)}${rn}`] = job.toLowerCase();
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
    function findBlocks(cells) {
      const blocks = [];
      for (let r = 3; r <= FC.MAX_ROW; r += 1) {
        const n = FC.REP_COLS.filter((c) => /^\*?\s*[A-Z][a-z]+\s+[A-Z][A-Za-z'-]+/.test(cells[`${c}${r}`] || '')).length;
        if (n >= 15) { blocks.push({ names: r, slots: [r + 1, r + 2, r + 3], pool: [r - 5, r - 4, r - 3] }); r += 6; }
      }
      return blocks.slice(0, 7);
    }
    function repsOf(cells, namesRow) {
      return FC.REP_COLS.map((c) => {
        const raw = cells[`${c}${namesRow}`] || '';
        const manager = raw.includes('*');
        const words = raw.replace(/\*/g, '').trim().split(' ');
        return { col: c, name: words.slice(0, 2).join(' '), home: words.slice(2).join(' '), manager };
      }).filter((r) => r.name);
    }
    function placeFromCell(text) {
      const src = clean(String(text || '').replace(/[*!()]/g, ' '));
      if (/\b(MGT|MGMT|MTG|MEETING|OFF|1:1|SALES|UNAVAILABLE|AWAY|KIDS|SELF\s*GEN)\b/i.test(src)) return '';
      const t = src.replace(/^(\d{1,4}(?:-\d{1,4})?)(?:\s*[<>]\s*\d{3,4})?\s+/, '');
      if (t === src) return '';
      const zip = t.match(/^(4[67]\d{3})\b/); if (zip) return zip[1];
      const words = t.split(' ');
      const stop = /^(roof|siding|sid|gutters?|gut|windows?|win|doors?|front|soffit|sof|fascia|hardie|insulation|chimney|skylights?|masonry|su|adj|beback|walk|problem|contract|save|self|gen|rh|so|pc|\d.*)$/i;
      const out = [];
      for (const w of words) { if (stop.test(w) || /[\/,]/.test(w)) break; out.push(w); if (out.length === 2) break; }
      return out.join(' ');
    }

    async function geocode(q) {
      const key = 'fit:geo:' + q.toLowerCase();
      const hit = GM_getValue(key, null);
      if (hit) return hit;
      const last = GM_getValue('fit:geo:last', 0); const wait = 1100 - (Date.now() - last);
      if (wait > 0) await sleep(wait);                          // OpenStreetMap allows 1 lookup per second
      GM_setValue('fit:geo:last', Date.now());
      const r = await gm({ method: 'GET', url: `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(q)}` });
      const arr = JSON.parse(r.responseText || '[]');
      if (!arr.length) return null;
      const p = { lat: +arr[0].lat, lon: +arr[0].lon, label: arr[0].display_name };
      GM_setValue(key, p);
      return p;
    }
    const TOWN_FIX = { 'mccrdsvlle': 'McCordsville', 'mrtinsville': 'Martinsville', 'princes lakes': 'Princes Lakes', 'floyd knobs': 'Floyds Knobs' };
    const fixTown = (p) => TOWN_FIX[clean(p).toLowerCase()] || p;
    const withState = (place) => (/\b(IN|Indiana)\b/i.test(place) ? place : `${place}, ${FC.STATE}`);
    const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const MI = 1609.34;
    async function osrmFrom(origin, pts) {
      const coords = [origin, ...pts].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
      const r = await gm({ method: 'GET', url: `https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance` });
      const j = JSON.parse(r.responseText || '{}');
      if (!j.durations) throw new Error('Drive-time service did not answer. Try again in a minute.');
      return pts.map((p, k) => ({ min: j.durations[0][k + 1] == null ? null : Math.round(j.durations[0][k + 1] / 60), mi: j.distances[0][k + 1] == null ? null : Math.round(j.distances[0][k + 1] / MI) }));
    }
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

    async function find(address, slotPick, log) {
      tabList = null;
      const today = new Date(); today.setHours(12, 0, 0, 0);
      const days = [];
      for (let k = 0; k < 4; k += 1) { const d = new Date(today); d.setDate(d.getDate() + k); if (d.getDay() !== 0) days.push(d); }
      const tabCells = {};
      const candidates = [];
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
        const dayPool = [];
        {
          const pj = new Set(); block.slots.concat([block.slots[2] + 1]).forEach((rr) => FC.REP_COLS.forEach((c) => { const j = cells[`#${c}${rr}`]; if (j) pj.add(j); }));
          block.pool.forEach((pr, pi) => FC.REP_COLS.forEach((c) => {
            const t = cells[`${c}${pr}`] || ''; const j = cells[`#${c}${pr}`];
            if (!t || /^(DO NOT FILL|SALES MTG|NO LEADS|CANCELS?|PGT.*)$/i.test(t) || (j && pj.has(j))) return;
            const pl = placeFromCell(t); if (pl) dayPool.push({ place: fixTown(pl), slotIdx: pi, text: t });
          }));
        }
        block.slots.forEach((row, i) => {
          const placedJobs = new Set(); block.slots.concat([block.slots[2] + 1]).forEach((rr) => FC.REP_COLS.forEach((c) => { const j = cells[`#${c}${rr}`]; if (j) placedJobs.add(j); }));
          const waiting = FC.REP_COLS.filter((c) => {
            const t = cells[`${c}${block.pool[i]}`] || '';
            if (!t || /^(DO NOT FILL|SALES MTG|NO LEADS|CANCELS?|PGT.*)$/i.test(t)) return false;
            const j = cells[`#${c}${block.pool[i]}`];
            return !(j && placedJobs.has(j));
          }).length;
          const need = parseInt(cells[`B${row}`], 10) - waiting;
          if (!(need > 0)) return;
          if (slotPick !== 'any' && FC.SLOTS[i] !== slotPick) return;
          reps.forEach((r, ri) => {
            if (cells[`${r.col}${row}`]) return;
            let from = r.home, fromWhy = 'home', prevEnd = null;
            for (let j = i - 1; j >= 0; j -= 1) if (places[ri][j]) { from = places[ri][j]; fromWhy = `${FC.SLOTS[j].toLowerCase()} appt`; const t = times[ri][j]; if (t) prevEnd = t.end || t.start + FC.LEAD_MIN; break; }
            let next = r.home, nextWhy = 'home', nextStart = null;
            for (let j = i + 1; j < 3; j += 1) if (places[ri][j]) { next = places[ri][j]; nextWhy = `${FC.SLOTS[j].toLowerCase()} appt`; const t = times[ri][j]; if (t) nextStart = t.start; break; }
            const sameDay = places[ri].filter(Boolean);
            candidates.push({ d, label: `${DOW[d.getDay()]} ${d.getMonth() + 1}/${d.getDate()}`, slot: FC.SLOTS[i], slotIdx: i, rep: r, from: fixTown(from), fromWhy, next: fixTown(next), nextWhy, need, prevEnd, nextStart, sameDay: sameDay.map(fixTown), dayPool });
          });
        });
      }
      if (!candidates.length) throw new Error('No open slot with leads needed in the next 4 days.');

      log('Finding the address...');
      const q = /\bIN\b|Indiana|\b4[67]\d{3}\b/.test(address) ? address : `${address}, ${FC.STATE}`;
      let cust = await geocode(q);
      const zipTyped = (address.match(/\b(4[67]\d{3})\b/) || [])[1];
      if (cust && zipTyped && !String(cust.label).includes(zipTyped)) {
        GM_setValue('fit:geo:' + q.toLowerCase(), null);
        cust = await geocode(q) || null;
        if (!cust || !String(cust.label).includes(zipTyped)) cust = await geocode(`${zipTyped}, ${FC.STATE}`) || cust;
      }
      if (!cust) throw new Error(`Address not found: "${address}". Try street + city, or the zip.`);

      log('Measuring drives...');
      const names = [...new Set(candidates.flatMap((c) => [c.from, c.next, ...c.sameDay, ...c.dayPool.map((p) => p.place)]))].filter(Boolean);
      const pts = {}; let done = 0;
      for (const nm of names) {
        try { pts[nm] = await geocode(withState(nm)); } catch (e) { await sleep(2500); try { pts[nm] = await geocode(withState(nm)); } catch (e2) { pts[nm] = null; } }
        done += 1; log(`Measuring drives... (${done}/${names.length} places)`);
      }
      const known = names.filter((nm) => pts[nm]);
      const custKey = `${cust.lat.toFixed(3)},${cust.lon.toFixed(3)}`;
      const legs = {}; const missing = [];
      known.forEach((nm) => { const hit = GM_getValue(`fit:leg:${custKey}|${nm.toLowerCase()}`, null); if (hit) legs[nm] = hit; else missing.push(nm); });
      for (let k = 0; k < missing.length; k += 90) {
        const part = missing.slice(k, k + 90);
        (await osrmFrom(cust, part.map((nm) => pts[nm]))).forEach((v, n) => { legs[part[n]] = v; if (v.min != null) GM_setValue(`fit:leg:${custKey}|${part[n].toLowerCase()}`, v); });
      }
      Object.values(legs).forEach((v) => { if (v && v.min != null && v.min < FC.LOCAL_MIN) { v.local = true; v.min = FC.LOCAL_MIN; v.mi = Math.max(v.mi || 0, FC.LOCAL_MI); } });

      const scored = [];
      candidates.forEach((c) => {
        const inn = legs[c.from], out = legs[c.next];
        if (!inn || inn.min == null) return;
        if (inn.mi > FC.MAX_MILES) return;
        const back = out && out.min != null ? out.min : inn.min;
        const nearest = Math.min(...[c.from, c.next, ...c.sameDay].map((nm) => (legs[nm] && legs[nm].min != null ? legs[nm].min : 999)));
        const near = c.dayPool.filter((p) => p.slotIdx !== c.slotIdx).map((p) => ({ p, m: legs[p.place] && legs[p.place].min != null ? legs[p.place].min : 999 })).filter((x) => x.m <= FC.CLUSTER_MIN).sort((a, b) => a.m - b.m);
        const pairable = near.find((x) => Math.abs(x.p.slotIdx - c.slotIdx) === 1) || null;
        const score = inn.min + 0.5 * back - (c.sameDay.length && nearest <= 25 ? 10 : 0) - (pairable ? 12 : near.length ? 5 : 0) + (c.rep.manager ? 15 : 0);
        const [w0, w1] = FC.WINDOWS[c.slotIdx];
        let earliest = w0;
        const now = new Date();
        if (c.d.toDateString() === now.toDateString()) earliest = Math.max(earliest, now.getHours() * 60 + now.getMinutes() + 60);
        if (c.prevEnd != null) earliest = Math.max(earliest, c.prevEnd + inn.min);
        earliest = Math.ceil(earliest / 15) * 15;
        let latest = w1;
        if (c.nextStart != null) latest = Math.min(latest, Math.floor((c.nextStart - FC.LEAD_MIN - back) / 15) * 15);
        if (earliest > latest) return;
        scored.push(Object.assign(c, { local: !!inn.local, min: inn.min, mi: inn.mi, back, nearest, score, startAt: earliest, latestAt: latest, pair: pairable || null }));
      });
      if (!scored.length) throw new Error('Every open rep is more than 70 miles away in the next 4 days.');
      scored.sort((a, b) => a.score - b.score);
      const top = []; const usedSlot = new Set();
      for (const c of scored) { const k = `${c.label}|${c.slot}|${c.startAt}`; if (usedSlot.has(k)) continue; usedSlot.add(k); top.push(c); if (top.length === FC.TOP) break; }
      const far = top[0].mi >= FC.FAR_MILES;
      return { cust, top, far, considered: scored.length };
    }
    return { find, FC };
  })();

  /* ======================================================================================
     GROUPME: the form
     ====================================================================================== */
  function mountLeadForm(onAccuLynx) {
    const NAVY = '#1f3a5f', GREEN = '#1b7f3a', RED = '#b42318', LINE = '#d9dee6', MUTED = '#5f6b7a';
    const el = (tag, style, text, attrs) => { const e = document.createElement(tag); if (style) e.style.cssText = style; if (text != null) e.textContent = text; Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v)); return e; };
    const inputCss = `width:100%;box-sizing:border-box;border:1px solid ${LINE};border-radius:6px;padding:6px 8px;font:13px Arial,sans-serif;color:#1d2430;background:#fff`;

    const btn = el('button', `position:fixed;top:12px;right:20px;z-index:2147483000;background:${GREEN};color:#fff;border:0;border-radius:12px;padding:3px 10px;font:700 11px Arial,sans-serif;letter-spacing:.04em;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer`, '+ LEAD', { title: 'Mars lead form' });
    const panel = el('div', `position:fixed;z-index:2147483001;width:460px;max-width:calc(100vw - 16px);background:#fff;border:1px solid ${LINE};border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.25);font:13px Arial,sans-serif;color:#1d2430;display:none;overflow:auto`);
    const head = el('div', `position:sticky;top:0;z-index:1;padding:10px 14px;background:${GREEN};color:#fff;display:flex;align-items:center;border-radius:10px 10px 0 0`);
    head.appendChild(el('div', 'flex:1;font-weight:700;font-size:14px', 'Mars Lead Form'));
    // Screen 2: a tab the team drags onto the other monitor; Check for Duplicate's tabs open in that window
    const s2Alive = () => Date.now() - GM_getValue('mlf_s2_hb', 0) < 15000;
    const s2Btn = el('button', 'border:1px solid rgba(255,255,255,.6);background:none;color:#fff;border-radius:6px;padding:3px 8px;font:600 11px Arial,sans-serif;cursor:pointer;margin-right:10px', '', { title: 'Open the Screen 2 tab, then drag it onto your other screen' });
    const paintS2 = () => { s2Btn.textContent = (s2Alive() ? '● ' : '○ ') + 'Screen 2'; s2Btn.style.background = s2Alive() ? 'rgba(255,255,255,.25)' : 'none'; };
    paintS2(); setInterval(paintS2, 3000);
    s2Btn.onclick = () => {
      if (s2Alive()) { status('Screen 2 is already open - its tabs open in that window. To move it, drag the SCREEN 2 tab to the other screen.'); return; }
      GM_openInTab(`https://docs.google.com/spreadsheets/d/${CONFIG.LEAD_TABLE_ID}/htmlview#mlfscreen2`, { active: true, insert: true });
      status('A "SCREEN 2" tab just opened. Drag that tab out of this window and drop it on your other screen, then make it full screen. Leave it open.');
    };
    head.appendChild(s2Btn);
    // list = [{ url, front }]; newLead = the tabs of the previous lead on Screen 2 are closed first
    function openOnScreen(list, newLead) {
      if (s2Alive()) { GM_setValue('mlf_s2_open', { id: Date.now() + '-' + Math.random().toString(36).slice(2), list, newLead }); return; }
      list.forEach(x => GM_openInTab(x.url, { active: false, insert: true }));
    }
    const xBtn = el('button', 'border:0;background:none;color:#fff;font-size:20px;cursor:pointer;line-height:1', '×');
    head.appendChild(xBtn);
    const body = el('div', 'padding:12px 14px 14px');
    panel.appendChild(head); panel.appendChild(body);
    document.body.appendChild(panel); document.body.appendChild(btn);
    ['keydown', 'keypress', 'keyup', 'paste'].forEach(ev => panel.addEventListener(ev, e => e.stopPropagation()));

    // sits right next to the CONF button: GroupMe = the Lead Slots CONF (top bar), AccuLynx = the CONF above Notes on Create New Lead
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };      // (a fixed-position button has no offsetParent, so "visible()" cannot be used)
    const findConf = () => [...document.querySelectorAll('button')].find(b => b !== btn && b.textContent.trim() === 'CONF' && (onAccuLynx || /confirmable/i.test(b.title || '')));
    const dock = () => {
      const conf = findConf();
      if (onAccuLynx) {
        const hd = document.querySelector('h1.ax-page-header__heading .location-text');      // "for Amos Exteriors" in the page title
        if (hd && shown(hd)) {
          if (btn.previousElementSibling !== hd) {
            btn.style.cssText = `position:static;display:inline-block;vertical-align:middle;margin:0 0 0 18px;background:${GREEN};color:#fff;border:0;border-radius:8px;padding:9px 20px;font:700 15px/1 Arial,sans-serif;letter-spacing:.04em;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer`;
            hd.insertAdjacentElement('afterend', btn);
          }
        } else if (btn.parentElement !== document.body) {            // title not found: a button in the lower left
          btn.style.cssText = `position:fixed;left:170px;bottom:22px;z-index:2147483000;background:${GREEN};color:#fff;border:0;border-radius:8px;padding:9px 20px;font:700 15px Arial,sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.25);cursor:pointer`;
          document.body.appendChild(btn);
        }
      } else if (conf && shown(conf)) {
        const r = conf.getBoundingClientRect();
        btn.style.right = 'auto'; btn.style.left = Math.min(innerWidth - btn.offsetWidth - 8, r.right + 6) + 'px';
        btn.style.top = (r.top + r.height / 2 - btn.offsetHeight / 2) + 'px';
      } else { btn.style.left = 'auto'; btn.style.right = '20px'; btn.style.top = '12px'; }
      place();
    };
    const place = () => {
      if (panel.style.display === 'none') return;
      const r = btn.getBoundingClientRect(), M = 8, pw = Math.min(460, innerWidth - 2 * M);
      // opens under the button, its left edge on the button, so there is room on the LEFT for the slots / fit box
      panel.style.left = Math.max(M, Math.min(r.left, innerWidth - pw - M)) + 'px';
      panel.style.top = Math.min(r.bottom + M, innerHeight - 200) + 'px';
      panel.style.maxHeight = (innerHeight - parseFloat(panel.style.top) - M) + 'px';
      placeBox();
    };
    setInterval(dock, 800); addEventListener('resize', dock); setTimeout(dock, 300);

    /* ---------- the box to the LEFT of the form: Confirmable Lead Slots + Lead Fit Finder (filled by CHECK FOR DUPLICATE) ---------- */
    const box = el('div', `position:fixed;z-index:2147483001;width:480px;max-width:calc(100vw - 16px);background:#fff;border:1px solid ${LINE};border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.25);font:13px Arial,sans-serif;color:#1d2430;display:none;overflow:auto`);
    const boxHead = el('div', `position:sticky;top:0;z-index:1;padding:10px 14px;background:${NAVY};color:#fff;display:flex;align-items:center;border-radius:10px 10px 0 0`);
    boxHead.appendChild(el('div', 'flex:1;font-weight:700;font-size:14px', 'Availability'));
    const boxX = el('button', 'border:0;background:none;color:#fff;font-size:20px;cursor:pointer;line-height:1', '×'); boxX.onclick = () => { box.style.display = 'none'; };
    boxHead.appendChild(boxX); box.appendChild(boxHead);
    const slotsHead = el('div', `padding:8px 14px 0;font-size:11px;font-weight:700;color:${MUTED};text-transform:uppercase;letter-spacing:.04em`, 'Confirmable Lead Slots');
    const slotsOut = el('div', 'padding:4px 14px 10px');
    const fitHead = el('div', `padding:8px 14px 0;border-top:1px solid ${LINE};font-size:11px;font-weight:700;color:${MUTED};text-transform:uppercase;letter-spacing:.04em`, 'Lead Fit Finder');
    const fitStatus = el('div', `padding:2px 14px;color:${MUTED};font-size:12px`);
    const fitOut = el('div', 'padding:0 14px 12px');
    [slotsHead, slotsOut, fitHead, fitStatus, fitOut].forEach(x => box.appendChild(x));
    document.body.appendChild(box);
    ['keydown', 'keypress', 'keyup', 'paste'].forEach(ev => box.addEventListener(ev, e => e.stopPropagation()));
    function placeBox() {
      if (box.style.display === 'none' || panel.style.display === 'none') return;
      const M = 8, pl = parseFloat(panel.style.left) || M;
      const bw = Math.max(280, Math.min(480, pl - M - M));
      box.style.width = bw + 'px';
      box.style.left = Math.max(M, pl - M - bw) + 'px';
      box.style.top = panel.style.top;
      box.style.maxHeight = panel.style.maxHeight;
    }

    // --- Confirmable Lead Slots: copied from the CONF panel (GroupMe). On AccuLynx the GroupMe tab is asked to do it.
    const findSlotsPanel = () => {
      const t = [...document.querySelectorAll('div')].find(d => d.children.length === 0 && d.textContent.trim() === 'Confirmable Lead Slots');
      for (let p = t; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).position === 'fixed') return p;
      return null;
    };
    async function readSlotsHere() {
      const conf = findConf();
      if (!conf) throw new Error('no CONF button on this page');
      let p = findSlotsPanel();
      const wasOpen = !!p && p.style.display !== 'none';
      if (wasOpen) { const rb = [...p.querySelectorAll('button')].find(b => b.textContent.trim() === 'Refresh'); if (rb) rb.click(); }
      else { conf.click(); p = await waitFor(findSlotsPanel, 5000); }
      if (!p) throw new Error('the CONF panel did not open');
      const prevVis = p.style.visibility; p.style.visibility = 'hidden';                 // read it without flashing it on screen
      try {
        await sleep(500);
        const ok = await waitFor(() => { const t = p.innerText || ''; return t.length > 40 && !/Loading/i.test(t); }, 40000, 400);
        if (!ok) throw new Error('the CONF panel did not finish loading');
        const copy = p.cloneNode(true);
        copy.style.cssText = 'display:block;border:0;box-shadow:none;max-height:none;width:auto';
        if (copy.firstElementChild) copy.removeChild(copy.firstElementChild);               // its own blue header
        copy.querySelectorAll('button').forEach(b => { b.style.pointerEvents = 'none'; b.style.cursor = 'default'; });
        return copy.outerHTML;
      } finally {
        p.style.visibility = prevVis;
        if (!wasOpen) { const x = [...p.querySelectorAll('button')].find(b => b.textContent.trim() === '×'); if (x) x.click(); else p.style.display = 'none'; }
      }
    }
    if (!onAccuLynx) {
      // an AccuLynx tab asks; the GroupMe tab with the CONF button answers
      GM_addValueChangeListener('mlf_slots_req', async (n, o, req) => {
        if (!req || !req.id || Date.now() - req.ts > 60000 || !findConf()) return;
        try { GM_setValue('mlf_slots_res', { id: req.id, ok: true, html: await readSlotsHere() }); }
        catch (e) { GM_setValue('mlf_slots_res', { id: req.id, ok: false, error: e.message }); }
      });
    }
    async function slotsHtml() {
      if (!onAccuLynx) return readSlotsHere().catch(e => { throw new Error(e.message === 'no CONF button on this page' ? 'The CONF (Confirmable Lead Slots) button is not on this page - install / enable the Lead Slots script.' : e.message); });
      const id = Date.now() + '-' + Math.random().toString(36).slice(2);
      GM_setValue('mlf_slots_req', { id, ts: Date.now() });
      const res = await waitFor(() => { const v = GM_getValue('mlf_slots_res', null); return v && v.id === id ? v : null; }, 60000, 500);
      if (!res) throw new Error('No answer - keep a GroupMe tab open (with the CONF button) and press CHECK FOR DUPLICATE again.');
      if (!res.ok) throw new Error(res.error || 'could not read the slots');
      return res.html;
    }

    // --- Lead Fit Finder results
    function renderFit(res) {
      fitOut.textContent = '';
      const cellCss = `padding:7px 6px;border-bottom:1px solid ${LINE};vertical-align:top`;
      if (res.far) fitOut.appendChild(el('div', 'margin:6px 0 10px;padding:8px 10px;background:#fff4e5;border:1px solid #f5c58a;border-radius:6px;color:#7a4a00;font-size:12px', `Distant lead (${res.top[0].mi} mi for the best fit). Book this rep's slot with another lead in the same area or on the way back.`));
      const table = el('table', 'width:100%;border-collapse:collapse;font-size:12.5px');
      const hr = el('tr');
      ['#', 'Day / best time', 'Drive', 'From → then'].forEach(h => hr.appendChild(el('th', `text-align:left;padding:6px;color:${MUTED};font-weight:600;border-bottom:2px solid ${LINE};font-size:11px;text-transform:uppercase;letter-spacing:.04em`, h)));
      table.appendChild(hr);
      res.top.forEach((c, k) => {
        const tr = el('tr', k === 0 ? 'background:#f2f7fc' : '');
        tr.appendChild(el('td', `${cellCss};font-weight:700;color:${NAVY}`, String(k + 1)));
        const ds = el('td', cellCss); ds.appendChild(el('div', 'font-weight:600', c.label)); ds.appendChild(el('div', `font-weight:700;color:${NAVY}`, clock(c.startAt)));
        ds.appendChild(el('div', `color:${MUTED};font-size:11.5px`, `${c.slot}${c.latestAt > c.startAt ? ` · ok until ${clock(c.latestAt)}` : ''} · ${c.need} needed`)); tr.appendChild(ds);
        const dc = el('td', cellCss); const col = c.min <= 30 ? GREEN : c.min <= 60 ? '#b26a00' : RED;
        dc.appendChild(el('div', `font-weight:700;color:${col}`, c.local ? `~${c.min} min` : `${c.min} min`)); dc.appendChild(el('div', `color:${MUTED};font-size:11.5px`, c.local ? 'same area' : `${c.mi} mi`)); tr.appendChild(dc);
        const fc = el('td', `${cellCss};color:${MUTED};font-size:11.5px`);
        fc.appendChild(el('div', '', `${c.from} (${c.fromWhy})`)); fc.appendChild(el('div', '', `→ ${c.next} (${c.nextWhy}, ${c.back} min)`));
        if (c.pair) fc.appendChild(el('div', `color:${GREEN};font-weight:600`, `Pair with pool lead ${c.pair.p.text.split(' ').slice(0, 3).join(' ')} (${FIT.FC.SLOTS[c.pair.p.slotIdx].toLowerCase()}, ${c.pair.m} min apart)`));
        tr.appendChild(fc); table.appendChild(tr);
      });
      fitOut.appendChild(table);
      fitOut.appendChild(el('div', `margin-top:8px;color:${MUTED};font-size:11px`, 'Ranked by the drive there, the drive to the next stop or home, and nearby Lead Pool leads that can be paired. Full rows and drives over 70 miles are left out.'));
    }
    let boardSeq = 0;
    function runBoard(address) {
      const my = ++boardSeq;
      box.style.display = 'block'; placeBox(); place();
      slotsOut.textContent = ''; slotsOut.appendChild(el('div', `color:${MUTED};font-size:12px`, 'Loading the open slots…'));
      fitOut.textContent = ''; fitStatus.style.color = MUTED; fitStatus.textContent = 'Starting…';
      slotsHtml().then(h => { if (my !== boardSeq) return; slotsOut.innerHTML = h; })
        .catch(e => { if (my !== boardSeq) return; slotsOut.textContent = ''; slotsOut.appendChild(el('div', `color:${RED};font-size:12px`, 'Slots: ' + e.message)); });
      FIT.find(address, 'any', m => { if (my === boardSeq) fitStatus.textContent = m; })
        .then(res => { if (my !== boardSeq) return; fitStatus.textContent = `For: ${address}  -  found ${res.cust.label.split(',').slice(0, 3).join(',')}  -  ${res.considered} open slots compared`; renderFit(res); })
        .catch(e => { if (my !== boardSeq) return; fitStatus.style.color = RED; fitStatus.textContent = 'Lead Fit Finder: ' + e.message; });
    }

    /* ---------- form fields ---------- */
    const F = {};
    // every row goes into `into` (the form body, or one half of a two-column pair)
    let into = body;
    const row = (label, input, note) => {
      const w = el('div', 'margin-bottom:8px');
      w.appendChild(el('div', `font-size:11px;font-weight:700;color:${MUTED};margin-bottom:2px;text-transform:uppercase;letter-spacing:.03em`, label));
      w.appendChild(input);
      if (note) w.appendChild(el('div', `font-size:11px;color:${MUTED};margin-top:2px`, note));
      into.appendChild(w); return input;
    };
    const text = (key, label, ph, type) => (F[key] = row(label, el('input', inputCss, null, { type: type || 'text', placeholder: ph || '' })));
    const select = (key, label, options, first) => {
      const s = el('select', inputCss);
      if (first !== undefined) s.appendChild(el('option', '', first, { value: '' }));
      options.forEach(o => s.appendChild(el('option', '', o, { value: o })));
      return (F[key] = row(label, s));
    };
    const twoCols = (left, right) => {
      const w = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:0 10px'); body.appendChild(w);
      for (const fn of [left, right]) { into = el('div'); w.appendChild(into); fn(); }
      into = body;
    };

    twoCols(() => text('first', 'First Name', ''), () => text('last', 'Last Name', ''));
    twoCols(() => text('phone', 'Phone Number', '317-555-1234', 'tel'), () => text('email', 'Email', 'blank = ' + CONFIG.DEFAULT_EMAIL, 'email'));
    text('address', 'Address', '123 Main St, Carmel, IN 46032');

    const checkBtn = el('button', `width:100%;margin:4px 0 8px;padding:12px;border:0;border-radius:8px;background:${NAVY};color:#fff;font:700 15px Arial,sans-serif;letter-spacing:.04em;cursor:pointer`, 'CHECK FOR DUPLICATE');
    body.appendChild(checkBtn);
    const checkOut = el('div', 'margin-bottom:10px;font-size:12px');
    body.appendChild(checkOut);

    // Lead Source: the full list from AccuLynx's Create Lead page
    const srcWrap = el('div', 'display:flex;gap:6px');
    const srcSel = el('select', inputCss + ';flex:1');
    const srcReload = el('button', `border:1px solid ${LINE};background:#fff;border-radius:6px;padding:0 8px;cursor:pointer;font:12px Arial`, '↻', { title: 'Reload the Lead Source list from AccuLynx' });
    srcWrap.appendChild(srcSel); srcWrap.appendChild(srcReload);
    F.leadSource = srcSel; row('Lead Source', srcWrap);
    function fillSources() {
      const keep = srcSel.value;
      const list = (GM_getValue('mlf_sources', null) || {}).list || [];
      srcSel.textContent = '';
      srcSel.appendChild(el('option', '', list.length ? '- pick -' : '(press ↻ to load from AccuLynx)', { value: '' }));
      list.forEach(o => srcSel.appendChild(el('option', '', o.text, { value: o.value })));
      srcSel.value = keep;
    }
    fillSources();
    GM_addValueChangeListener('mlf_sources', () => fillSources());
    srcReload.onclick = async () => {
      srcReload.textContent = '…';
      const t0 = ((GM_getValue('mlf_sources', null) || {}).t) || 0;
      const tab = GM_openInTab('https://my.acculynx.com/Lead/New#mlfsources', { active: false, insert: true });
      const ok = await waitFor(() => (((GM_getValue('mlf_sources', null) || {}).t) || 0) > t0, 40000, 500);
      try { tab.close(); } catch (e) { /* closed itself */ }
      srcReload.textContent = '↻';
      if (!ok) status('Could not load the Lead Source list - open AccuLynx (Create Lead) once and press ↻ again.', true);
    };
    if (!((GM_getValue('mlf_sources', null) || {}).list || []).length) setTimeout(() => srcReload.onclick(), 1500);

    // Product Interest: tick boxes (only what the customer wants)
    const prodBox = el('div', 'display:flex;flex-wrap:wrap;gap:4px 10px');
    F.products = [];
    CONFIG.PRODUCTS.forEach(([name]) => {
      const l = el('label', 'display:flex;align-items:center;gap:3px;cursor:pointer;font-size:12px');
      const c = el('input', '', null, { type: 'checkbox', value: name }); l.appendChild(c); l.appendChild(document.createTextNode(name));
      F.products.push(c); prodBox.appendChild(l);
    });
    const prodOther = el('input', inputCss + ';margin-top:4px', null, { placeholder: 'other / details (optional)' });
    // ROOF ONLY zone: everything but Roof is OOA - shown in red under the service area line, kept up to date
    const ooaLine = el('div', `margin:2px 0;color:${RED};font-weight:700`);
    function paintOoa() {
      const roofOnly = lastCheck && lastCheck.area && lastCheck.area.roofOnly;
      const list = roofOnly ? ooaProducts(F.products.filter(c => c.checked).map(c => c.value), prodOther.value) : [];
      ooaLine.textContent = list.length ? 'OOA (roof-only area) for: ' + list.join(', ') : '';
    }
    F.products.forEach(c => c.addEventListener('change', paintOoa));
    prodOther.addEventListener('input', paintOoa);
    F.productOther = prodOther;
    const prodWrap = el('div'); prodWrap.appendChild(prodBox); prodWrap.appendChild(prodOther);
    row('Product Interest', prodWrap);

    text('material', 'Current Product Material', 'e.g. wood windows, vinyl siding');
    text('concerns', 'Current Issues/Concerns', '');
    twoCols(() => text('age', 'Age of Product', 'years'), () => text('built', 'Year of Home Built', ''));
    twoCols(() => text('purchased', 'Year Home was Purchased', ''), () => { text('style', 'Style of Home', 'pick or type'); F.style.setAttribute('list', 'mlf-styles'); });
    const dl = el('datalist', '', null, { id: 'mlf-styles' }); CONFIG.STYLES.forEach(s => dl.appendChild(el('option', '', null, { value: s }))); body.appendChild(dl);
    twoCols(() => text('mrs', 'Work Schedule - Mrs', ''), () => text('mr', 'Work Schedule - Mr', ''));
    F.notes = row('Notes', el('textarea', inputCss + ';height:60px;resize:vertical'));
    select('workType', 'Retail or Insurance', ['Retail', 'Insurance']);

    // appointment: date + time, or CTS
    const apWrap = el('div', 'display:flex;gap:6px;align-items:center');
    F.apptDate = el('input', inputCss + ';flex:1', null, { type: 'date' });
    F.apptTime = el('select', inputCss + ';flex:1');
    F.apptTime.appendChild(el('option', '', '- time -', { value: '' }));
    for (let m = 6 * 60; m <= 20 * 60; m += 15) F.apptTime.appendChild(el('option', '', clock(m), { value: String(m) }));
    const ctsL = el('label', 'display:flex;align-items:center;gap:3px;font-size:12px;font-weight:700;white-space:nowrap;cursor:pointer');
    F.cts = el('input', '', null, { type: 'checkbox' }); ctsL.appendChild(F.cts); ctsL.appendChild(document.createTextNode('CTS'));
    apWrap.appendChild(F.apptDate); apWrap.appendChild(F.apptTime); apWrap.appendChild(ctsL);
    row('Appointment date and time', apWrap, 'CTS = call to schedule: 6-7 AM the next work day, not put on the Lead Table.');
    F.cts.onchange = () => { F.apptDate.disabled = F.apptTime.disabled = F.cts.checked; };
    select('assign', 'Who is the rep assigned to?', CONFIG.ASSIGN_OPTIONS, '- pick -');

    // two small optional drop boxes: a picture dropped here is used instead of the automatic one
    const PHOTO = { ov: '', ls: '' };
    const photoRow = el('div', 'display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:4px');
    const photoBoxes = {};
    function photoBox(key, title) {
      const b = el('div', `border:1px dashed ${MUTED};border-radius:6px;padding:4px 6px;min-height:34px;display:flex;align-items:center;gap:6px;font-size:11px;color:${MUTED};cursor:pointer;background:#fafbfc`, '', { title: 'Drag a picture here (or click to choose one). Optional.' });
      const img = el('img', 'width:30px;height:30px;object-fit:cover;border-radius:4px;display:none');
      const t = el('div', 'flex:1;line-height:1.2'); const tt = el('b', `color:#1d2430;display:block`, title); const hint = el('span', '', 'drop here (optional)'); t.appendChild(tt); t.appendChild(hint);
      const x = el('span', `color:${RED};font-weight:700;display:none;padding:0 3px`, '×', { title: 'remove' });
      const file = el('input', 'display:none', null, { type: 'file', accept: 'image/*' });
      b.appendChild(img); b.appendChild(t); b.appendChild(x); b.appendChild(file);
      const set = (data) => { PHOTO[key] = data || ''; img.style.display = data ? 'block' : 'none'; if (data) img.src = data; x.style.display = data ? 'inline' : 'none'; hint.textContent = data ? 'picture added' : 'drop here (optional)'; b.style.borderColor = data ? GREEN : MUTED; };
      const shrink = (src) => new Promise((res, rej) => { const im = new Image(); im.onload = () => { const k = Math.min(1, 1600 / Math.max(im.width, im.height)); const c = document.createElement('canvas'); c.width = Math.round(im.width * k); c.height = Math.round(im.height * k); c.getContext('2d').drawImage(im, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.85)); }; im.onerror = () => rej(new Error('not a picture')); im.src = src; });
      const fromFile = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('could not read the file')); r.readAsDataURL(f); });
      const take = async (dt) => {
        try {
          let src = '';
          const f = [...(dt.files || [])].find(x => /^image\//.test(x.type));
          if (f) src = await fromFile(f);
          else {                                                       // a picture dragged out of a web page / GroupMe: it arrives as a link
            const url = (dt.getData('text/uri-list') || dt.getData('text/plain') || '').split('\n')[0].trim();
            if (!/^https?:/i.test(url)) throw new Error('drop a picture file or a picture from a page');
            src = await blobToDataUrl(await fetchBlob(url, 2));
          }
          set(await shrink(src)); status(title + ' added.');
        } catch (e) { status(title + ': ' + e.message, true); }
      };
      b.addEventListener('dragover', e => { e.preventDefault(); b.style.background = '#eaf5ee'; });
      b.addEventListener('dragleave', () => { b.style.background = '#fafbfc'; });
      b.addEventListener('drop', e => { e.preventDefault(); b.style.background = '#fafbfc'; take(e.dataTransfer); });
      b.addEventListener('click', e => { if (e.target === x) { set(''); return; } if (e.target !== file) file.click(); });
      file.addEventListener('change', () => { if (file.files[0]) take({ files: file.files, getData: () => '' }); file.value = ''; });
      photoBoxes[key] = { set };
      photoRow.appendChild(b);
    }
    const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(new Error('could not read the picture')); r.readAsDataURL(blob); });
    photoBox('ov', 'Overview Photo'); photoBox('ls', 'Lead Sheet Photo');
    body.appendChild(photoRow);

    const doneBtn = el('button', `width:100%;margin-top:6px;padding:12px;border:0;border-radius:8px;background:${GREEN};color:#fff;font:700 15px Arial,sans-serif;letter-spacing:.04em;cursor:pointer`, 'COMPLETE');
    body.appendChild(doneBtn);
    const statusEl = el('div', 'margin-top:8px;font-size:12px;min-height:16px');
    body.appendChild(statusEl);
    body.appendChild(el('div', `margin-top:10px;font-size:11px;font-weight:700;color:${MUTED};text-transform:uppercase`, 'Recent'));
    const recentEl = el('div', 'font-size:12px');
    body.appendChild(recentEl);
    function status(msg, bad) { statusEl.style.color = bad ? RED : GREEN; statusEl.textContent = msg; }

    function readForm() {
      const v = k => clean(F[k].value);
      return {
        first: titleCase(v('first')), last: titleCase(v('last')), phone: v('phone').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''),
        email: v('email'), address: v('address'),
        leadSourceValue: F.leadSource.value, leadSource: F.leadSource.value ? clean(F.leadSource.selectedOptions[0].textContent) : '',
        products: F.products.filter(c => c.checked).map(c => c.value), productOther: v('productOther'),
        material: v('material'), concerns: v('concerns'), age: v('age'), built: v('built'), purchased: v('purchased'),
        style: v('style'), mrs: v('mrs'), mr: v('mr'), notes: F.notes.value.trim(), workType: F.workType.value,
        apptDate: F.apptDate.value, apptMin: F.apptTime.value === '' ? null : +F.apptTime.value, cts: F.cts.checked, assign: F.assign.value,
      };
    }
    const checkKey = f => [f.first, f.last, f.phone, f.email, f.address].join('|').toLowerCase();

    /* ---------- CHECK FOR DUPLICATE ---------- */
    let lastCheck = null;
    async function runCheck(openTabs) {
      const f = readForm();
      if (!f.address) { status('Type the address first.', true); return null; }
      checkBtn.disabled = true; checkBtn.textContent = 'CHECKING…'; checkOut.textContent = '';
      const line = (label, style) => { const d = el('div', 'margin:2px 0;' + (style || ''), label); checkOut.appendChild(d); return d; };
      const geoLine = line('Map: finding the address…');
      const areaLine = line('Service area: …');
      const dupLine = line('AccuLynx: searching name, phone, address, email…');
      checkOut.appendChild(ooaLine);
      const result = { key: checkKey(f), geo: null, area: null, dup: null };
      runBoard(f.address);                       // Confirmable Lead Slots + Lead Fit Finder, in the box to the left
      const geoP = geocode(f.address).then(g => {
        result.geo = g;
        geoLine.textContent = 'Map: ' + g.matched + (g.exact ? '' : '  (approximate - check the house number)');
        if (openTabs) {
          // 2. Street View of the house   3. Predictive Sales AI storm map
          // Google looks up the exact house; the Maps part of this script then clicks Google's Street View picture of it
          // (the map lookup above aims at the street, so a Street View from it can face the house across the road)
          GM_setValue('mlf_sv_req', { t: Date.now() });
          const ad = splitAddress(f.address);
          openOnScreen([
            { url: 'https://www.google.com/maps/place/' + encodeURIComponent(oneLine({ street: ad.street, city: ad.city || g.city, zip: ad.zip || g.zip })), front: true },
            { url: 'https://apps.predictivesalesai.com/admin/weather/map?' + new URLSearchParams({ lat: g.lat, long: g.lon, zoom: '13', exactcoords: 'true', displayaddress: f.address + ' USA' }) },
          ], true);
        }
        return g;
      }).catch(e => { geoLine.textContent = 'Map: ' + e.message; geoLine.style.color = RED; return null; });
      if (openTabs) geoP.then(g => { if (!g) openOnScreen([{ url: 'https://www.google.com/maps/search/' + encodeURIComponent(f.address), front: true }], true); });
      const areaP = geoP.then(async g => {
        if (!g) { areaLine.textContent = 'Service area: needs the map location'; return; }
        try { result.area = await serviceAreaVerdict(g); setTimeout(paintOoa, 0); areaLine.textContent = ''; areaLine.appendChild(el('b', `color:${result.area.color}`, 'Service area: ' + result.area.verdict)); if (result.area.notes.length) areaLine.appendChild(document.createTextNode('  (' + result.area.notes.join(', ') + ')')); }
        catch (e) { areaLine.textContent = 'Service area: ' + e.message; areaLine.style.color = RED; }
      });
      const dupP = findDuplicates(f).then(d => {
        result.dup = d; dupLine.textContent = '';
        if (!d.matches.length) dupLine.appendChild(el('b', `color:${GREEN}`, 'AccuLynx: no duplicate found - a NEW lead will be created.'));
        else {
          const sugId = d.plan.kind === 'revive' ? d.plan.jobId : d.plan.kind === 'sold' ? (d.matches.find(x => x.Name === d.plan.name) || {}).Id : null;
          dupLine.appendChild(el('b', `color:${sugId ? RED : NAVY}`, sugId ? 'AccuLynx: POSSIBLE DUPLICATE - open the record to look, then choose what to do beside it.' : 'AccuLynx: similar records found (none at the same house). Choose an action only if one is the same customer.'));
          const planLine = el('div', 'margin:4px 0;font-weight:700');
          const showPlan = () => {
            const pl = planForPick(result.pick, result.mode);
            planLine.style.color = pl.kind === 'new' ? GREEN : RED;
            planLine.textContent = 'Complete will: ' + (pl.kind === 'new' ? 'create a NEW lead.'
              : pl.kind === 'sold' ? `create a NEW lead (Previous Customer) with ${pl.crossRef || 'the IN number'} in Cross Reference` + (pl.sellingRep ? `, "${pl.sellingRep}" (sold the last job) in the notes under Lead Source` : '') + '. QuickMeasure / Hover / EagleView go on the new job (listed as a to-do).'
              : `use ${pl.name || 'that job'} (${pl.milestone})${pl.dead ? ', re-open it' : ''}, ` + (pl.keepAppt ? 'KEEP its appointment as it is (the new request goes in the comment)' : 'set the new appointment') + ', put the lead report in its comments and finish the lead entry there.' +
                (pl.overYear ? ' It is over 1 year old - its Lead Source must change to the new source (listed as a to-do).' : ''));
          };
          const ul = el('div', `margin:4px 0 0 8px;border-left:3px solid ${LINE};padding-left:6px`);
          const sels = [];
          d.matches.slice(0, 10).forEach(x => {
            const r = el('div', 'margin:5px 0');
            const isJob = x.Type !== 'Contact' && x.Id;
            if (isJob) {
              const url = 'https://my.acculynx.com/jobs/' + x.Id;
              const a = el('a', 'color:#1155cc;font-weight:700;cursor:pointer', x.Name || '(job)', { href: url, title: 'opens in a new tab - this form stays open' });
              a.onclick = e => { e.preventDefault(); openOnScreen([{ url }], false); a.style.color = '#6b3fa0'; };
              r.appendChild(a);
            } else r.appendChild(el('b', '', (x.Name || '(contact)') + ' [contact]'));
            r.appendChild(document.createTextNode(` - ${x.Submitted ? 'Submitted for approval' : (x.CurrentMilestone || '')} ${x.MilestoneStart ? '(' + String(x.MilestoneStart).slice(0, 10) + ')' : ''} · ${x.FullAddress || ''} · same ${x.why.join(', ')}`));
            if (isJob) {
              const sold = isSold(x);
              const sel = el('select', `display:block;margin-top:2px;max-width:100%;padding:2px 4px;border:1px solid ${RED};border-radius:6px;color:${RED};font:700 11px Arial,sans-serif`);
              const opts = sold ? [['', '- what to do with this job? -'], ['prev', 'Previous Customer: new lead + prior info'], ['new', 'Enter as a new lead anyway']]
                : [['', '- what to do with this job? -'], ['dup', 'Duplicate: add the new info to THIS job'], ['dupkeep', 'Duplicate: add info, KEEP its appointment'], ['new', 'Enter as a new lead anyway']];
              opts.forEach(([v, t]) => sel.appendChild(el('option', '', t + (v && x.Id === sugId && ((sold && v === 'prev') || (!sold && v === 'dup')) ? ' (suggested)' : ''), { value: v })));
              sel.onchange = () => { sels.forEach(o => { if (o !== sel) o.value = ''; }); result.pick = sel.value && sel.value !== 'new' ? x : null; result.mode = sel.value; showPlan(); };
              sels.push(sel); r.appendChild(sel);
            }
            ul.appendChild(r);
          });
          dupLine.appendChild(ul); dupLine.appendChild(planLine);
          // pre-choose the suggested action, as before
          if (sugId) { const sel = sels[d.matches.slice(0, 10).filter(x => x.Type !== 'Contact' && x.Id).findIndex(x => x.Id === sugId)]; if (sel && sel.options.length > 1) { sel.selectedIndex = 1; sel.onchange(); } }
          else showPlan();
        }
        if (d.errors.length) dupLine.appendChild(el('div', `color:${RED}`, 'Search problems: ' + d.errors.join('; ')));
      }).catch(e => { dupLine.textContent = 'AccuLynx: ' + e.message; dupLine.style.color = RED; });
      await Promise.all([geoP, areaP, dupP]);
      checkBtn.disabled = false; checkBtn.textContent = 'CHECK FOR DUPLICATE';
      lastCheck = result; paintOoa();
      return result;
    }
    checkBtn.onclick = () => runCheck(true);

    /* ---------- COMPLETE ---------- */
    function nextWorkDay() { const d = new Date(); d.setHours(0, 0, 0, 0); do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0); return d; }
    function notesFor(L) {
      const prod = [L.products.join(', '), L.productOther].filter(Boolean).join(' - ');
      return [
        'Lead Source: ' + L.leadSource,
        ...(L.plan && L.plan.kind === 'sold' && L.plan.sellingRep ? ['Previous sale (' + (L.crossRef || 'sold job') + ') by: ' + L.plan.sellingRep] : []),
        'Product Interest: ' + prod,
        'Current Product Material: ' + L.material,
        'Current Issues/Concerns: ' + L.concerns,
        'Age of Product: ' + L.age,
        'Year of Home Built: ' + L.built,
        'Year Home was Purchased: ' + L.purchased,
        'Style of Home: ' + L.style,
        'Email: ' + (L.email || ''),
        'Work Schedules',
        'Mrs: ' + L.mrs,
        'Mr: ' + L.mr,
      ].concat(L.notes ? ['', 'Notes: ' + L.notes] : []).concat(L.ooa && L.ooa.length ? ['', 'OOA (roof-only area) for: ' + L.ooa.join(', ')] : []).concat(L.crossRef ? ['', 'Existing customer - sold job ' + L.crossRef] : []).map(s => s.trimEnd()).join('\n');
    }
    let curPrefill = null;
    doneBtn.onclick = async () => {
      let f = readForm();
      const miss = [];
      if (!f.first) miss.push('First Name'); if (!f.last) miss.push('Last Name');
      if (f.phone.length !== 10) miss.push('Phone (10 digits)');
      if (!f.address) miss.push('Address'); if (!f.leadSourceValue) miss.push('Lead Source');
      if (!f.products.length && !f.productOther) miss.push('Product Interest');
      if (!f.cts && (!f.apptDate || f.apptMin === null)) miss.push('Appointment date and time (or CTS)');
      if (!f.assign) miss.push('Assigned rep');
      if (miss.length) { status('Missing: ' + miss.join(', '), true); return; }
      let start;
      if (f.cts) { start = nextWorkDay(); start.setHours(6, 0, 0, 0); }
      else {
        const [y, mo, d] = f.apptDate.split('-').map(Number);
        start = new Date(y, mo - 1, d, Math.floor(f.apptMin / 60), f.apptMin % 60);
        if (start.getDay() === 0) { status('Sunday is not a work day - pick another date.', true); return; }
        if (start < new Date(Date.now() - 3600e3)) { status('That appointment is in the past.', true); return; }
      }
      // the duplicate check must match what is in the form now
      let chk = lastCheck;
      if (!chk || chk.key !== checkKey(f) || !chk.dup) { status('Running the duplicate check first…'); chk = await runCheck(false); f = readForm(); }
      if (!chk || !chk.dup) { status('The duplicate check did not finish - press CHECK FOR DUPLICATE and try again.', true); return; }
      if (chk.area && /OUT OF AREA/.test(chk.area.verdict) && !confirm('This address is OUT OF the service area. Enter the lead anyway?')) return;
      const ooa = chk.area && chk.area.roofOnly ? ooaProducts(f.products, f.productOther) : [];
      if (ooa.length && !confirm('This address is in a ROOF ONLY area.\nOOA for: ' + ooa.join(', ') + '\n\nEnter the lead anyway? (the OOA line goes in the notes)')) return;
      const plan = planForPick(chk.pick, chk.mode);
      if (!chk.pick && chk.mode !== 'new' && chk.dup.plan.kind !== 'new' && !confirm(`AccuLynx found a likely duplicate (${chk.dup.plan.name || 'same house'}), but no DUPLICATE box is ticked.\n\nOK = enter it as a NEW lead anyway\nCancel = go back and tick the matching record`)) return;
      const mins = f.workType === 'Insurance' ? CONFIG.INSURANCE_HOURS * 60 : CONFIG.RETAIL_HOURS * 60;
      const end = new Date(start.getTime() + (f.cts || start.getHours() === 6 ? 60 : mins) * 60e3);   // CTS / a 6 AM call slot is 1 hour
      const tf = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const L = Object.assign({}, f, {
        id: 'M' + Date.now(), queuedAt: Date.now(),
        start: start.toISOString(), end: end.toISOString(),
        startMin: start.getHours() * 60 + start.getMinutes(), endMin: end.getHours() * 60 + end.getMinutes(),
        apptText: start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ' ' + tf(start) + ' - ' + tf(end),
        geo: chk.geo, plan, ooa, crossRef: plan.kind === 'sold' ? plan.crossRef : '',
        trades: [...new Set(f.products.map(p => (CONFIG.PRODUCTS.find(x => x[0] === p) || [])[1]).filter(Boolean))],
      });
      if (!L.trades.length) L.trades = ['Repairs'];
      if (chk.geo) { const ad = splitAddress(f.address); L.city = ad.city || chk.geo.city; L.zip = ad.zip || chk.geo.zip; }
      L.notesText = notesFor(L);
      if (PHOTO.ov) L.ovData = PHOTO.ov;
      if (PHOTO.ls) L.lsData = PHOTO.ls;
      if (curPrefill) {      // came from GroupMe's Enter Lead: carry the lead sheet photo + the rep's post, and remember who to tell "entered"
        L.imageUrl = curPrefill.imageUrl || ''; L.rawPost = curPrefill.raw || '';
        const pm = GM_getValue('mlf_prefill_map', {}); pm[L.id] = { id: curPrefill.id, chatId: curPrefill.chatId, name: `${L.first} ${L.last}` }; GM_setValue('mlf_prefill_map', pm);
        curPrefill = null;
      }
      const q = GM_getValue('mlf_queue', {}); q[L.id] = L; GM_setValue('mlf_queue', q);
      setRecent(L.id, { name: `${L.first} ${L.last}`, msg: 'waiting for AccuLynx…', t: Date.now() });
      // clear the form for the next lead
      ['first', 'last', 'phone', 'email', 'address', 'productOther', 'material', 'concerns', 'age', 'built', 'purchased', 'style', 'mrs', 'mr'].forEach(k => { F[k].value = ''; });
      F.notes.value = ''; F.leadSource.value = ''; F.workType.value = 'Retail'; F.apptDate.value = ''; F.apptTime.value = ''; F.assign.value = '';
      F.cts.checked = false; F.cts.onchange(); F.products.forEach(c => { c.checked = false; }); photoBoxes.ov.set(''); photoBoxes.ls.set('');
      checkOut.textContent = ''; lastCheck = null;
      status(`${L.first} ${L.last} sent - ${plan.kind === 'revive' ? 'updating the existing job' : 'creating the lead'} in AccuLynx. You can type the next lead.`);
      dispatchTick();
    };

    /* ---------- recent list / progress from the AccuLynx tab ---------- */
    function setRecent(id, v) { const r = GM_getValue('mlf_recent', {}); r[id] = Object.assign(r[id] || {}, v); const keep = Object.entries(r).sort((a, b) => b[1].t - a[1].t).slice(0, 8); GM_setValue('mlf_recent', Object.fromEntries(keep)); }
    function paintRecent() {
      const r = Object.entries(GM_getValue('mlf_recent', {})).sort((a, b) => b[1].t - a[1].t);
      recentEl.textContent = '';
      if (!r.length) { recentEl.appendChild(el('div', `color:${MUTED}`, 'nothing yet')); return; }
      r.forEach(([, v]) => {
        const d = el('div', `padding:4px 0;border-bottom:1px solid ${LINE}`);
        d.appendChild(el('b', '', v.name + ': '));
        d.appendChild(el('span', `color:${v.bad ? RED : v.done ? GREEN : '#1d2430'}`, v.msg));
        if (v.jobId) { d.appendChild(document.createTextNode(' ')); d.appendChild(el('a', 'color:#1155cc', 'open job', { href: 'https://my.acculynx.com/jobs/' + v.jobId, target: '_blank' })); }
        recentEl.appendChild(d);
      });
    }
    paintRecent(); GM_addValueChangeListener('mlf_recent', paintRecent);

    /* ---------- one lead at a time goes to AccuLynx ---------- */
    function dispatchTick() {
      const q = GM_getValue('mlf_queue', {});
      const active = GM_getValue('mlf_active', null);
      const hb = GM_getValue('mlf_hb', 0);
      if (active && q[active] && Date.now() - hb < 4 * 60e3) return;          // still working
      if (active && q[active]) {                                               // the AccuLynx tab went quiet
        setRecent(active, { msg: 'STOPPED in AccuLynx (tab closed or stuck) - check the job and finish by hand.', bad: true, t: Date.now() });
        delete q[active]; GM_setValue('mlf_queue', q);
      }
      GM_deleteValue('mlf_active');
      const next = Object.keys(q).sort((a, b) => q[a].queuedAt - q[b].queuedAt)[0];
      if (!next) return;
      // tab "election": only one GroupMe tab dispatches
      const me = (window.__mlfTab = window.__mlfTab || Math.random().toString(36).slice(2));
      const lock = GM_getValue('mlf_dispatch_lock', null);
      if (lock && lock.tab !== me && Date.now() - lock.t < 15000) return;
      GM_setValue('mlf_dispatch_lock', { tab: me, t: Date.now() });
      const L = q[next];
      GM_setValue('mlf_active', next); GM_setValue('mlf_hb', Date.now());
      const url = L.plan.kind === 'revive'
        ? `https://my.acculynx.com/jobs/${L.plan.jobId}${L.plan.dead ? '/settings' : ''}#mlf=${next}`
        : `https://my.acculynx.com/Lead/New#mlf=${next}`;
      GM_openInTab(url, { active: false, insert: true });
      const t0 = GM_getValue('mlf_hb', 0);
      setTimeout(() => {                                                       // Chrome sometimes blocks background tabs
        if (GM_getValue('mlf_active') === next && GM_getValue('mlf_hb', 0) === t0) GM_openInTab(url, { active: true, insert: true });
      }, 20000);
    }
    setInterval(dispatchTick, 4000);

    /* ---------- Enter Lead (the other GroupMe script) hands a parsed lead to this form ---------- */
    const de = document.documentElement;
    de.dataset.amosFormReady = '1';
    const PROD_RE = [['Roof', /roof/i], ['Gutters', /gutter|guard|gaurd/i], ['Siding', /siding|hardie|hardi\b/i], ['Soffit/Fascia', /soffit|sofit|fascia|\btrim\b/i],
      ['Windows', /window/i], ['Doors', /\bdoors?\b/i], ['Insulation', /insul/i], ['Masonry', /mason|brick|chimney/i], ['Repairs', /repair|leak/i]];
    const OTHER_RE = [/shutter/i, /\bdecks?\b/i, /fence/i];
    function pickSource(rep) {
      const n = x => String(x || '').toLowerCase().replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
      const want = n(rep), opts = [...srcSel.options].filter(o => o.value);
      let o = opts.find(o => n(o.textContent).endsWith(want)) ||
              opts.find(o => /field marketing/i.test(o.textContent) && want && want.split(' ').every(t => n(o.textContent).includes(t)));
      // the rep's GroupMe name can be spelled differently from AccuLynx ("Zack" / "Zach"): fall back to the LAST name inside "Field Marketing: ..."
      if (!o && want) {
        const last = want.split(' ').pop(), first = want.split(' ')[0];
        const cands = opts.filter(x => /^field marketing: /i.test(x.textContent) && n(x.textContent).split(' ').pop() === last);
        o = cands.find(x => n(x.textContent).includes(first.slice(0, 2))) || (cands.length === 1 ? cands[0] : null);
      }
      return o ? o.value : '';
    }
    function setForm(v) {
      const set = (k, x) => { F[k].value = x == null ? '' : x; };
      ['first', 'last', 'phone', 'email', 'address', 'productOther', 'material', 'concerns', 'age', 'built', 'purchased', 'style', 'mrs', 'mr'].forEach(k => set(k, v[k]));
      F.notes.value = v.notes || ''; F.workType.value = v.workType || 'Retail'; F.assign.value = v.assign || '';
      F.products.forEach(c => { c.checked = (v.products || []).includes(c.value); });
      F.cts.checked = !!v.cts; F.cts.onchange(); photoBoxes.ov.set(''); photoBoxes.ls.set('');
      F.apptDate.value = v.cts ? '' : (v.apptDate || ''); F.apptTime.value = v.apptMin == null || v.cts ? '' : String(v.apptMin);
      if (v.leadSourceValue) F.leadSource.value = v.leadSourceValue;
      checkOut.textContent = ''; lastCheck = null; paintOoa();
    }
    document.addEventListener('amos-prefill', async () => {
      let p = null; try { p = JSON.parse(de.dataset.amosPrefill || 'null'); } catch (e) { /* ignore */ }
      if (!p || !p.id) return;
      curPrefill = p;
      const prods = PROD_RE.filter(([, re]) => re.test(p.productText || '')).map(x => x[0]);
      setForm({ first: p.first, last: p.last, phone: p.phone, email: p.email, address: p.address, products: prods, productOther: [...(prods.length ? [] : [p.productText || '']), ...OTHER_RE.filter(re => re.test(p.raw || '')).map(re => ((p.raw.match(re) || [''])[0]).replace(/^./, c => c.toUpperCase()))].filter(Boolean).join(', '),
        concerns: p.concerns, age: p.age, mrs: p.mrs, mr: p.mr, notes: p.notes || '', workType: 'Retail', assign: 'Needs Confirmed',
        apptDate: p.apptDate, apptMin: p.apptMin, cts: !!p.cts });
      panel.style.display = 'block'; place();
      de.dataset.amosPrefillAck = p.id; document.dispatchEvent(new Event('amos-prefill-ack'));      // tells Enter Lead the form took the lead
      status('Lead filled in from GroupMe (' + p.sender + ') - review it, pick what to do with any duplicate, then press COMPLETE.');
      if (!srcSel.options.length || srcSel.options.length < 2) await waitFor(() => srcSel.options.length > 1, 15000, 400);
      const sv = pickSource(p.sender);
      if (sv) F.leadSource.value = sv; else status('Lead Source: no "Field Marketing: ' + p.sender + '" in the list - pick it by hand.', true);
      runCheck(true);
    });
    // tell Enter Lead when the AccuLynx tab has finished a lead that came from GroupMe, so it posts "entered"
    GM_addValueChangeListener('mlf_recent', (n, o, v) => {
      const pm = GM_getValue('mlf_prefill_map', {}); let ch = false;
      for (const [id, info] of Object.entries(pm)) if (v && v[id] && v[id].fin) {
        de.dataset.amosDone = JSON.stringify({ id: info.id, chatId: info.chatId, name: info.name }); document.dispatchEvent(new Event('amos-lead-done'));
        delete pm[id]; ch = true;
      }
      if (ch) GM_setValue('mlf_prefill_map', pm);
    });

    /* ---------- extra actions: Reply only / Save for later ---------- */
    const moreBox = el('div', `margin-top:8px;padding:8px;border:1px dashed ${LINE};border-radius:8px`);
    moreBox.appendChild(el('div', `font-size:11px;font-weight:700;color:${MUTED};text-transform:uppercase;margin-bottom:4px`, 'Other options'));
    const saveBtn = el('button', `width:100%;border:1px solid ${NAVY};border-radius:6px;background:#fff;color:${NAVY};padding:6px;font:700 12px Arial;cursor:pointer`, 'SAVE FOR LATER');
    moreBox.appendChild(saveBtn);
    body.insertBefore(moreBox, statusEl);
    const savedEl = el('div', 'font-size:12px;margin-top:4px');
    moreBox.appendChild(savedEl);
    function paintSaved() {
      const list = GM_getValue('mlf_saved', []) || []; savedEl.textContent = '';
      list.forEach((it, i) => {
        const d = el('div', `padding:3px 0;border-top:1px solid ${LINE}`);
        d.appendChild(el('b', '', `${it.f.first} ${it.f.last}`.trim() + ' '));
        const o = el('a', 'color:#1155cc;cursor:pointer;margin-right:8px', 'open'); o.onclick = () => { curPrefill = it.p; setForm(it.f); if (it.f.leadSourceValue) F.leadSource.value = it.f.leadSourceValue; const l2 = GM_getValue('mlf_saved', []); l2.splice(i, 1); GM_setValue('mlf_saved', l2); status('Saved lead opened - review it, then COMPLETE.'); runCheck(false); };
        const x = el('a', `color:${RED};cursor:pointer`, 'delete'); x.onclick = () => { const l2 = GM_getValue('mlf_saved', []); l2.splice(i, 1); GM_setValue('mlf_saved', l2); };
        d.appendChild(o); d.appendChild(x); savedEl.appendChild(d);
      });
    }
    paintSaved(); GM_addValueChangeListener('mlf_saved', paintSaved);
    saveBtn.onclick = () => {
      const f = readForm(); if (!f.first && !f.last && !f.address) { status('Nothing to save.', true); return; }
      const list = GM_getValue('mlf_saved', []) || []; list.unshift({ p: curPrefill, f }); GM_setValue('mlf_saved', list.slice(0, 15));
      curPrefill = null; setForm({}); status('Saved for later (listed under Other options).');
    };

    btn.onclick = () => { if (panel.style.display === 'none') { panel.style.display = 'block'; place(); } else { panel.style.display = 'none'; box.style.display = 'none'; } };
    xBtn.onclick = () => { panel.style.display = 'none'; box.style.display = 'none'; };
  }
  if (/groupme\.com$/.test(location.host)) { mountLeadForm(false); return; }

  /* ======================================================================================
     GOOGLE MAPS (only for a tab this script opened):
       - Check for Duplicate: open Street View of the house by clicking Google's own Street View picture
       - AccuLynx photos: hand back the Street View picture of the house
     ====================================================================================== */
  // Street View tab (opened by the house-photo step): find the street picture panorama nearest the house and aim it AT the house
  if (location.host === 'www.google.com' && /^\/maps\/@/.test(location.pathname) && /map_action=pano|3a,/.test(location.href)) {
    (async () => {
      const req = GM_getValue('mlf_pano_req');
      if (!req || Date.now() - req.t > 90000) return;
      const fin = v => GM_setValue('mlf_pano_res', Object.assign({ id: req.id, t: Date.now() }, v));
      try {
        const ok = await waitFor(() => /!1s[A-Za-z0-9_-]{20,24}!/.test(location.href) && /@-?\d+\.\d+,-?\d+\.\d+,/.test(location.href), 25000, 400);
        if (!ok) return fin({ none: true, why: 'no street picture within reach' });
        const pid = location.href.match(/!1s([A-Za-z0-9_-]{20,24})!/)[1];
        const at = location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+),/);
        const la1 = +at[1], lo1 = +at[2], rad = x => x * Math.PI / 180;
        const dy = rad(req.lat - la1), dx = rad(req.lon - lo1) * Math.cos(rad(la1));
        const dist = Math.sqrt(dx * dx + dy * dy) * 6371000;
        if (dist > 150) return fin({ none: true, why: 'nearest street picture is ' + Math.round(dist) + ' m from the house' });
        const yaw = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;       // compass bearing from the camera to the house
        const url = 'https://streetviewpixels-pa.googleapis.com/v1/thumbnail?panoid=' + pid + '&cb_client=maps_sv.tactile&w=1600&h=940&yaw=' + yaw.toFixed(1) + '&pitch=0&thumbfov=80';
        fin({ b64: await blobToB64(await fetchBlob(url)) });
      } catch (e) { fin({ none: true, why: 'street picture failed: ' + e.message }); }
    })();
    return;
  }
  if (location.host === 'www.google.com' && /^\/maps\/place\//.test(location.pathname)) {
    (async () => {
      const sv = GM_getValue('mlf_sv_req', null);
      if (sv && Date.now() - sv.t < 60000) {
        GM_deleteValue('mlf_sv_req');
        const thumb = await waitFor(() => {
          const i = [...document.querySelectorAll('img')].find(x => /streetviewpixels-pa\.googleapis\.com/.test(x.src) && x.getBoundingClientRect().width > 80);
          return i ? (i.closest('button,a,[role="button"]') || i) : null;
        }, 20000, 500);
        if (thumb) thumb.click();      // no picture = Google has no Street View here; the house pin stays on screen
        return;
      }
      const req = GM_getValue('mlf_house_req');
      if (!req || Date.now() - req.t > 60000) return;
      const img = await waitFor(() => [...document.querySelectorAll('img')].find(i => i.getBoundingClientRect().width > 200 && i.src), 20000, 500);
      await waitFor(() => /!3d-?\d+\.\d+!4d-?\d+\.\d+/.test(location.href), 12000, 300);
      const pin = location.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      const done = v => GM_setValue('mlf_house_res', Object.assign({ id: req.id, t: Date.now() }, pin ? { lat: +pin[1], lon: +pin[2] } : {}, v));
      // FIRST CHOICE: the real street-level picture aimed at the house (Andrew: always use Street View when Google has it)
      if (pin) {
        GM_deleteValue('mlf_pano_res'); GM_setValue('mlf_pano_req', { id: req.id, lat: +pin[1], lon: +pin[2], t: Date.now() });
        const ptab = GM_openInTab('https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=' + pin[1] + ',' + pin[2], { active: false, insert: true });
        const pr = await waitFor(() => { const v = GM_getValue('mlf_pano_res'); return v && v.id === req.id ? v : null; }, 40000, 500);
        try { ptab.close(); } catch (e) { /* ignore */ }
        GM_deleteValue('mlf_pano_req');
        if (pr && pr.b64) return done({ b64: pr.b64 });
      }
      if (!img || !/streetviewpixels-pa\.googleapis\.com|googleusercontent\.com/.test(img.src)) return done({ none: true, why: 'Google has no Street View photo of this address' });
      try {
        const big = img.src.replace(/([?&])w=\d+/, '$1w=1600').replace(/([?&])h=\d+/, '$1h=940').replace(/=w\d+-h\d+/, '=w1600-h940');
        done({ b64: await blobToB64(await fetchBlob(big)) });
      } catch (e) { done({ none: true, why: 'could not download the Street View photo' }); }
    })();
    return;
  }

  function dataUrlToBlob(d) {
    const m = String(d || '').match(/^data:([^;,]+)?(;base64)?,(.*)$/s); if (!m) throw new Error('bad picture');
    const bin = atob(m[3]); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: m[1] || 'image/jpeg' });
  }
  function fetchBlob(url, tries = 2) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
      onload: r => (r.status === 200 && r.response && r.response.byteLength > 1000) ? res(new Blob([r.response], { type: 'image/jpeg' })) : rej(new Error('download HTTP ' + r.status)),
      onerror: () => rej(new Error('download failed')), ontimeout: () => rej(new Error('download timed out')),
    })).catch(e => tries > 1 ? sleep(1500).then(() => fetchBlob(url, tries - 1)) : Promise.reject(e));
  }
  function blobToB64(blob) { return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); }); }
  const b64ToBlob = b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/jpeg' }); };

  /* ======================================================================================
     LEAD TABLE: write the lead into the Lead Pool (runs in its own visible tab)
     ====================================================================================== */
  if (location.host === 'docs.google.com') {
    let screen2 = false;
    try { if (/mlfscreen2/.test(location.hash)) sessionStorage.setItem('mlfScreen2', '1'); screen2 = sessionStorage.getItem('mlfScreen2') === '1'; } catch (e) { /* ignore */ }
    if (screen2) {
      // SCREEN 2: opens Check for Duplicate's tabs in THIS window (the one on the other monitor)
      const me = Math.random().toString(36).slice(2);
      GM_setValue('mlf_s2_owner', me);                                    // the newest Screen 2 tab is the one used
      const beat = () => { if (GM_getValue('mlf_s2_owner') === me) GM_setValue('mlf_s2_hb', Date.now()); };
      beat(); setInterval(beat, 5000);
      document.title = 'SCREEN 2 - Mars Lead Form';
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#1b7f3a;color:#fff;font:700 14px Arial,sans-serif;padding:8px 14px;text-align:center';
      bar.textContent = 'SCREEN 2 - keep this tab open on your other screen. Check for Duplicate opens Street View here, with the storm map and AccuLynx records behind it.';
      document.body.appendChild(bar);
      let last = [];
      GM_addValueChangeListener('mlf_s2_open', (n, o, v) => {
        if (!v || GM_getValue('mlf_s2_owner') !== me) return;
        if (v.newLead) { last.forEach(t => { try { t.close(); } catch (e) { /* already closed */ } }); last = []; }
        const back = v.list.filter(x => !x.front), front = v.list.filter(x => x.front);
        // right after this tab: Street View (in front), then the storm map; records clicked later go at the end, behind
        back.slice().reverse().forEach(x => last.push(GM_openInTab(x.url, { active: false, insert: v.newLead })));
        front.forEach(x => last.push(GM_openInTab(x.url, { active: true, insert: true })));
      });
      return;
    }
    const job = GM_getValue('mlf_sheet_job', null);
    if (!job || job.claimed || Date.now() - job.ts > 180000) return;
    GM_setValue('mlf_sheet_job', Object.assign({}, job, { claimed: true }));
    const reply = x => GM_setValue('mlf_sheet_res', Object.assign({ id: job.id, t: Date.now() }, x));

    const UI = {
      nameBox: () => document.querySelector('#t-name-box'),
      editor: () => document.getElementById('waffle-rich-text-editor'),
      grid: () => document.querySelector('.grid-scrollable-wrapper') || document.querySelector('.grid-container'),
    };
    const mouseSeq = (e, x, y) => { const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 }; e.dispatchEvent(new MouseEvent('mousedown', o)); e.dispatchEvent(new MouseEvent('mouseup', Object.assign({}, o, { buttons: 0 }))); e.dispatchEvent(new MouseEvent('click', Object.assign({}, o, { buttons: 0 }))); };
    const clickEl = e => { const r = e.getBoundingClientRect(); mouseSeq(e, r.x + r.width / 2, r.y + r.height / 2); };
    const tabEls = () => [...document.querySelectorAll('.docs-sheet-tab')];
    const tabName = e => { const n = e.querySelector('.docs-sheet-tab-name'); return clean(n ? n.textContent : e.textContent); };
    const activeTab = () => { const a = document.querySelector('.docs-sheet-active-tab'); return a ? tabName(a) : ''; };
    async function switchToTab(name) {
      if (activeTab().includes(name)) return;
      const t = tabEls().find(e => tabName(e).includes(name));
      if (!t) throw new Error(`there is no week tab ${name} on the Lead Table yet`);
      clickEl(t.querySelector('.docs-sheet-tab-name') || t); await sleep(1800);
      if (!activeTab().includes(name)) throw new Error(`could not open tab ${name}`);
    }
    async function goTo(addr) {
      const nb = UI.nameBox(); nb.focus(); nb.value = addr; nb.dispatchEvent(new Event('input', { bubbles: true }));
      const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
      nb.dispatchEvent(new KeyboardEvent('keydown', k)); nb.dispatchEvent(new KeyboardEvent('keyup', k));
      await sleep(650);
      if (!addr.includes(':') && nb.value.toUpperCase() !== addr) throw new Error(`could not select cell ${addr}`);
    }
    function commitClick() {
      const g = UI.grid(); const r = g.getBoundingClientRect(); const ed = UI.editor().getBoundingClientRect();
      for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.7], [0.7, 0.35], [0.25, 0.4], [0.6, 0.6]]) {
        const x = r.x + r.width * fx, y = r.y + r.height * fy;
        if (x >= ed.left - 6 && x <= ed.right + 6 && y >= ed.top - 6 && y <= ed.bottom + 6) continue;
        const e = document.elementFromPoint(x, y); if (!e) continue;
        mouseSeq(e, x, y); return;
      }
      mouseSeq(g, r.x + r.width / 2, r.y + r.height / 2);
    }
    async function writeText(addr, value) {
      await goTo(addr);
      const ed = UI.editor(); ed.focus();
      const kd = { key: 'a', code: 'KeyA', keyCode: 65, which: 65, bubbles: true, cancelable: true };
      ed.dispatchEvent(new KeyboardEvent('keydown', kd)); ed.dispatchEvent(new KeyboardEvent('keypress', Object.assign({}, kd, { charCode: 97 })));
      document.execCommand('selectAll', false, null); document.execCommand('insertText', false, value);
      ed.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); ed.dispatchEvent(new KeyboardEvent('keyup', kd));
      await sleep(400);
      const inEdit = ed.getBoundingClientRect().y > -5000;
      commitClick(); await sleep(650);
      if (!inEdit) throw new Error(`could not type into ${addr}`);
    }
    function paletteCell(name) {
      const cells = [...document.querySelectorAll('.docs-material-colorpalette')].filter(e => e.offsetParent !== null).flatMap(p => [...p.querySelectorAll('.docs-material-colorpalette-cell')]);
      return cells.find(c => (c.getAttribute('title') || c.getAttribute('aria-label') || '').toLowerCase() === name) || null;
    }
    async function setColor(addr, which, name) {
      await goTo(addr);
      const b = document.getElementById(which === 'fill' ? 't-cell-color' : 't-text-color');
      if (!b) throw new Error('color button not found');
      clickEl(b); await sleep(500);
      let c = paletteCell(name); if (!c) { await sleep(600); c = paletteCell(name); }
      if (!c) { clickEl(b); throw new Error(`color ${name} not found`); }
      clickEl(c); await sleep(450);
    }
    function visibleMenuItems() {
      const pops = [...document.querySelectorAll('.goog-menu, [role="menu"], [role="listbox"], .docs-toolbar-popup, .goog-popup')].filter(e => e.offsetParent !== null && e.getBoundingClientRect().top > 40);
      return pops.flatMap(p => [...p.querySelectorAll('.goog-menuitem, [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="button"]')]).filter(m => m.offsetParent !== null);
    }
    function menuItemByLabel(labels) {
      const want = labels.map(l => l.toLowerCase()); const items = visibleMenuItems();
      const hit = items.find(m => { const a = (m.getAttribute('aria-label') || '').toLowerCase().trim(); return want.some(w => a === w || a.startsWith(w + ' ') || a.startsWith(w + ',')); }) || items.find(m => want.includes(clean(m.textContent).toLowerCase()));
      if (hit) return hit;
      const icon = [...document.querySelectorAll('.docs-common-icon[aria-label]')].find(e => e.offsetParent !== null && e.getBoundingClientRect().top > 95 && want.includes(e.getAttribute('aria-label').toLowerCase().trim()));
      return icon ? (icon.closest('[role="button"], .goog-toolbar-button, .goog-flat-button, .goog-inline-block') || icon.parentElement || icon) : null;
    }
    async function pickFromToolbar(id, labels) {
      const b = document.getElementById(id); if (!b) throw new Error('toolbar ' + id);
      clickEl(b); await sleep(600);
      let it = menuItemByLabel(labels); if (!it) { await sleep(600); it = menuItemByLabel(labels); }
      if (!it) { clickEl(b); await sleep(200); throw new Error('menu ' + labels[0]); }
      clickEl(it); await sleep(450);
    }
    async function baseFormat(addr) {
      const failed = [];
      for (const [n, fn] of [
        ['font', () => pickFromToolbar('docs-font-family', ['Arial'])],
        ['size', async () => { const i = document.querySelector('#fontSizeSelect input'); if (!i) throw new Error('size'); i.focus(); i.value = '9'; i.dispatchEvent(new Event('input', { bubbles: true })); const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }; i.dispatchEvent(new KeyboardEvent('keydown', k)); i.dispatchEvent(new KeyboardEvent('keyup', k)); i.dispatchEvent(new Event('change', { bubbles: true })); await sleep(400); }],
        ['wrap', () => pickFromToolbar('t-textwrap', ['Wrap'])],
        ['center', () => pickFromToolbar('t-align', ['Center'])],
        ['middle', () => pickFromToolbar('t-valign', ['Middle'])],
      ]) { try { await goTo(addr); await fn(); } catch (e) { failed.push(n); } }
      return failed;
    }
    const decode = s => String(s || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const normHex = c => { c = String(c || '').trim().toLowerCase(); const m = c.match(/^#([0-9a-f]{3})$/); return m ? '#' + m[1].split('').map(x => x + x).join('') : c; };
    const colLetter = i => { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    async function readCells(gid) {
      const html = await (await fetch(`/spreadsheets/d/${CONFIG.LEAD_TABLE_ID}/htmlview/sheet?headers=true&gid=${gid}&_=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' })).text();
      const styles = {}; html.replace(/\.(s\d+)\s*\{([^}]*)\}/g, (m, cls, b) => { styles[cls] = normHex((b.match(/background-color:\s*([^;]+)/i) || [])[1]); return m; });
      const vis = []; const he = html.indexOf('</thead>');
      (he > 0 ? html.slice(0, he) : '').replace(/<th\b[^>]*id="[^"]*C(\d+)"[^>]*>/gi, (m, n) => { vis.push(+n); return m; });
      const L = pos => colLetter(vis[pos] !== undefined ? vis[pos] : pos);
      const cells = {}; const occ = {};
      for (const tr of html.split(/<tr\b/i).slice(1)) {
        const th = tr.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i); if (!th) continue;
        const rn = parseInt(decode(th[1]).trim(), 10); if (!rn || rn > 100) continue;
        let pos = 0; const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi; let t;
        while ((t = re.exec(tr))) {
          if (/freezebar/i.test(t[1])) continue;
          while (occ[`${rn}:${pos}`]) pos += 1;
          const cs = +((t[1].match(/colspan="?(\d+)/i) || [])[1] || 1), rs = +((t[1].match(/rowspan="?(\d+)/i) || [])[1] || 1);
          for (let r = 0; r < rs; r += 1) for (let c = 0; c < cs; c += 1) occ[`${rn + r}:${pos + c}`] = 1;
          const cls = ((t[1].match(/class="([^"]*)"/i) || [])[1] || '').match(/\bs\d+\b/);
          const jid = (t[2].match(/jobs\/([0-9a-f]{8}-[0-9a-f-]{27})/i) || [])[1];
          cells[`${L(pos)}${rn}`] = { t: clean(decode(t[2])), bg: cls ? styles[cls[0]] || '' : '', job: jid ? jid.toLowerCase() : '' };
          pos += cs;
        }
      }
      return cells;
    }
    function findBlocks(cells) {
      const blocks = [];
      for (let r = 3; r <= 100; r += 1) {
        const n = CONFIG.REP_COLS.filter(c => /^\*?\s*[A-Z][a-z]+\s+[A-Z][A-Za-z'-]+/.test((cells[`${c}${r}`] || {}).t || '')).length;
        if (n >= 15) { blocks.push({ names: r, slots: [r + 1, r + 2, r + 3, r + 4], pool: [r - 5, r - 4, r - 3] }); r += 6; }
      }
      return blocks.slice(0, 7);
    }

    (async () => {
      try {
        if (!(await waitFor(() => UI.nameBox() && document.querySelector('.docs-sheet-tab') && UI.editor(), 30000, 500))) throw new Error('the Lead Table did not finish loading');
        await sleep(1500);
        await switchToTab(job.tab);
        const gid = (location.hash.match(/gid=(\d+)/) || [])[1];
        if (!gid) throw new Error('could not read the tab id');
        const cells = await readCells(gid);
        const block = findBlocks(cells)[job.dayIndex];
        if (!block) throw new Error(`could not find the ${job.dayLabel} block on ${job.tab}`);
        const cell = a => cells[a] || { t: '', bg: '', job: '' };
        // already on the table (a re-run)? then leave it
        const rows = [...block.pool, ...block.slots];
        const there = rows.flatMap(r => CONFIG.REP_COLS.map(c => `${c}${r}`)).find(a => cell(a).job && cell(a).job === job.jobId.toLowerCase());
        if (there) { reply({ ok: true, cell: there, already: true }); return; }
        const poolRow = block.pool[job.slot];
        let cols = CONFIG.REP_COLS.filter(c => cell(`${c}${poolRow}`).bg !== CONFIG.PATRICK_BLUE);
        if (job.insurance) cols = cols.slice().reverse();                   // insurance fills from the far right
        const free = re => cols.map(c => `${c}${poolRow}`).find(a => re.test(cell(a).t));
        const target = free(/^TAKEN$/i) || free(/^$/) || free(/^DO NOT FILL$/i);
        if (!target) throw new Error(`no free Lead Pool cell in the ${job.slotName} row on ${job.dayLabel}`);
        const before = cell(target).t;
        await writeText(target, `=HYPERLINK("${job.link}","${job.text.replace(/"/g, "'")}")`);
        const problems = [];
        try { await setColor(target, 'fill', 'white'); } catch (e) { problems.push('fill color'); }
        try { await setColor(target, 'text', 'black'); } catch (e) { problems.push('text color'); }
        problems.push(...await baseFormat(target));
        await sleep(2500);
        const after = (await readCells(gid))[target] || {};
        if (clean(after.t) !== clean(job.text)) throw new Error(`wrote ${target} but it reads "${after.t || ''}" - please check it`);
        reply({ ok: true, cell: target, replaced: before, problems });
      } catch (e) { reply({ ok: false, error: e.message }); }
    })();
    return;
  }

  /* ======================================================================================
     ACCULYNX
     ====================================================================================== */
  if (location.host !== 'my.acculynx.com') return;

  // relay: GroupMe asks, this tab searches with its own sign-in
  GM_addValueChangeListener('mlf_ax_req', async (n, o, req) => {
    if (!req || !req.id || Date.now() - req.ts > 20000) return;
    try { const r = await fetch(req.path, { credentials: 'same-origin', headers: { Accept: 'application/json' } }); GM_setValue('mlf_ax_res', { id: req.id, ok: r.ok, data: await r.text(), error: r.ok ? '' : 'HTTP ' + r.status }); }
    catch (e) { GM_setValue('mlf_ax_res', { id: req.id, ok: false, error: String(e) }); }
  });

  function fieldByLabel(labelText) {
    const lab = [...document.querySelectorAll('label')].find(l => visible(l) && l.innerText.replace('*', '').trim().toLowerCase() === labelText.toLowerCase());
    if (!lab) return null;
    let c = lab.parentElement;
    for (let k = 0; k < 4 && c; k++) { const f = c.querySelector('input:not([type=checkbox]):not([type=radio]),select,textarea,button'); if (f) return f; c = c.parentElement; }
    return null;
  }

  // Lead Source list: saved from every Create Lead page (and fetched on request with #mlfsources)
  if (/^\/lead\/new/i.test(location.pathname)) {
    (async () => {
      const ls = await waitFor(() => { const s = fieldByLabel('Lead Source'); return s && s.options && s.options.length > 3 ? s : null; }, 30000, 500);
      if (ls) GM_setValue('mlf_sources', { t: Date.now(), list: [...ls.options].filter(o => o.value && clean(o.text)).map(o => ({ value: o.value, text: clean(o.text) })) });
      if (/mlfsources/.test(location.hash)) { await sleep(500); window.close(); }
    })();
  }

  function setValue(e, value) {
    const proto = e.tagName === 'SELECT' ? HTMLSelectElement.prototype : e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function typeInto(e, value) { e.focus(); e.click(); setValue(e, ''); for (const ch of value) { setValue(e, e.value + ch); e.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch })); await sleep(20); } }
  function selectByText(sel, t) { const o = sel && [...sel.options].find(x => x.text.trim().toLowerCase() === t.toLowerCase()); if (!o) return false; setValue(sel, o.value); return true; }
  const clickText = (t, root = document, tags = 'button,a,li,span,div,label') => [...root.querySelectorAll(tags)].find(e => visible(e) && e.innerText && e.innerText.trim() === t);
  const fire = e => { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) e.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); };
  function showNote(msg, warn) {
    let n = document.getElementById('mlf-note');
    if (!n) { n = document.createElement('div'); n.id = 'mlf-note'; n.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 14px;border-radius:6px;font:600 13px Arial;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer;max-width:80vw'; n.title = 'click to close'; n.onclick = () => n.remove(); document.body.appendChild(n); }
    n.style.background = warn ? '#b45309' : '#1b7f3a'; n.textContent = 'Mars Lead Form: ' + msg;
  }

  /* ---------- the lead this tab is working on ---------- */
  const hashId = (location.hash.match(/mlf=(M\d+)/) || [])[1];
  if (hashId) { try { sessionStorage.setItem('mlfWorker', hashId); } catch (e) { /* ignore */ } }
  const myLead = () => { let id = null; try { id = sessionStorage.getItem('mlfWorker'); } catch (e) { /* ignore */ } return id && id === GM_getValue('mlf_active') ? id : null; };
  const stKey = id => 'mlf_state_' + id;
  // a Create New Lead page that is NOT a lead being entered by this script: put the + LEAD button next to its CONF button
  { let w = null; try { w = sessionStorage.getItem('mlfWorker'); } catch (e) { /* ignore */ } if (/^\/lead\/new/i.test(location.pathname) && !hashId && !w) mountLeadForm(true); }
  const getL = id => (GM_getValue('mlf_queue', {}) || {})[id];
  const saveL = L => { const q = GM_getValue('mlf_queue', {}); q[L.id] = L; GM_setValue('mlf_queue', q); };
  function progress(L, msg, extra) {
    const r = GM_getValue('mlf_recent', {}); r[L.id] = Object.assign(r[L.id] || { name: L.first + ' ' + L.last }, { msg, t: Date.now(), jobId: L.jobId || (r[L.id] || {}).jobId }, extra || {});
    GM_setValue('mlf_recent', r); GM_setValue('mlf_hb', Date.now());
    console.log('[MarsLeadForm]', L.first, L.last, msg);
  }
  const problem = (L, p) => { L.problems = (L.problems || []).concat(p); saveL(L); };
  const go = (L, step, path) => { L.step = step; saveL(L); GM_setValue('mlf_hb', Date.now()); location.href = '/jobs/' + L.jobId + (path || ''); };

  /* ---------- NEW LEAD: Create Lead form ---------- */
  async function fillCreateLead(L) {
    const cancel = await waitFor(() => /Finish previous lead/i.test(document.body.innerText) && clickText('Cancel', document, 'button,a'), 4000);
    if (cancel) { cancel.click(); await sleep(1500); }
    const f = fieldByLabel;
    if (!(await waitFor(() => f('First Name'), 30000))) throw new Error('Create Lead page did not load');
    await typeInto(f('First Name'), L.first);
    await typeInto(f('Last Name'), L.last);
    await typeInto(f('Phone'), L.phone);
    await typeInto(f('Email'), L.email || CONFIG.DEFAULT_EMAIL);
    const ad = splitAddress(L.address);
    setValue(f('City'), ad.city || L.city || 'Indianapolis');
    selectByText(f('State'), 'IN');
    setValue(f('Zip'), ad.zip || L.zip || '');
    const street = f('Street');
    await typeInto(street, ad.street);
    street.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
    const want = (ad.city || L.city || '').toLowerCase(), num = (ad.street.match(/^\d+/) || [''])[0];
    const pick = await waitFor(() => {
      const items = [...document.querySelectorAll('li.refinement-controls__search-result, .refinement-controls__search-results li')].filter(visible);
      return items.find(i => i.textContent.trim().startsWith(num) && want && i.textContent.toLowerCase().includes(want) && /,\s*IN,/i.test(i.textContent)) ||
             (!want && items.find(i => i.textContent.trim().startsWith(num) && /,\s*IN,/i.test(i.textContent)));
    }, 5000, 300);
    if (pick) { fire(pick); await sleep(1500); }
    street.dispatchEvent(new Event('blur', { bubbles: true })); street.blur(); await sleep(800);
    if (!street.value) { await typeInto(street, ad.street); street.blur(); await sleep(800); }
    if (!f('Zip').value && L.zip) setValue(f('Zip'), L.zip);
    if (!street.value) throw new Error('the street did not stick in the Create Lead form');

    selectByText(f('Job Category'), 'Residential');
    if (!selectByText(f('Work Type'), L.workType)) problem(L, 'Work Type "' + L.workType + '" not picked - set it by hand');
    const ls = f('Lead Source');
    const opt = [...ls.options].find(o => o.value === L.leadSourceValue) || [...ls.options].find(o => clean(o.text) === L.leadSource);
    if (!opt) throw new Error('Lead Source "' + L.leadSource + '" is not in AccuLynx\'s list');
    setValue(ls, opt.value);

    f('Trade Type').click(); await sleep(500);
    for (const t of L.trades) {
      const labs = [...document.querySelectorAll('label')].filter(visible);
      const lab = labs.find(l => l.innerText.trim() === t) || labs.find(l => l.innerText.trim().toLowerCase().startsWith(t.split(/[ /]/)[0].toLowerCase()) && !/^service/i.test(l.innerText.trim()));
      if (lab) lab.click(); else problem(L, 'Trade "' + t + '" not found - tick it by hand');
      await sleep(200);
    }
    document.body.click(); await sleep(2500);

    if (L.crossRef) {
      const crLab = [...document.querySelectorAll('label')].find(l => visible(l) && /^cross reference/i.test(l.innerText.trim()));
      let cr = null; for (let p = crLab; p && !cr; p = p.parentElement) cr = p.querySelector('input');
      if (cr) await typeInto(cr, L.crossRef + (cr.value ? ' | ' + cr.value : '')); else problem(L, 'Cross Reference box not found - add ' + L.crossRef + ' by hand');
    }

    const asg = f('Assign to');
    await typeInto(asg, L.assign.slice(0, 10)); await sleep(900);
    const isWho = t => t === L.assign || t.startsWith(L.assign + ' ') || t.startsWith(L.assign + '(');
    const who = await waitFor(() => [...document.querySelectorAll('li,div,span,a')].filter(e => visible(e) && e.innerText && isWho(e.innerText.trim()))
      .sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length)[0], 6000);
    if (who) { fire(who); await sleep(700); }
    if (!who || !isWho(clean(asg.value))) problem(L, 'Could not pick "' + L.assign + '" in Assign to - check it');

    setValue(f('Notes'), L.notesText);
    const start = new Date(L.start), end = new Date(L.end);
    let c = f('Appointment Date'), fp = null;
    for (let k = 0; k < 6 && c && !fp; k++) { fp = c._flatpickr || null; c = c.parentElement; }
    if (fp) { fp.setDate(start, true); await sleep(800); }
    if (!f('Appointment Date').value) throw new Error('the appointment date did not take');
    const hhmm = d => pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    setValue(f('Start Time'), hhmm(start)); f('Start Time').dispatchEvent(new Event('blur', { bubbles: true })); await sleep(500);
    setValue(f('End Time'), hhmm(end)); f('End Time').dispatchEvent(new Event('blur', { bubbles: true })); await sleep(500);
    if (f('Start Time').value !== hhmm(start) || f('End Time').value !== hhmm(end)) problem(L, 'Appointment times did not take - check them');
    setValue(f('Notes'), L.notesText);
  }

  /* ---------- photos (same as Enter Lead): house + overview, house on Location Info ---------- */
  async function getHousePhoto(L) {
    const ad = splitAddress(L.address);
    GM_deleteValue('mlf_house_res'); GM_setValue('mlf_house_req', { id: L.id, t: Date.now() });
    const tab = GM_openInTab('https://www.google.com/maps/place/' + encodeURIComponent(oneLine({ street: ad.street, city: ad.city || L.city, zip: ad.zip || L.zip })), { active: false, insert: true });
    const r = await waitFor(() => { const v = GM_getValue('mlf_house_res'); return v && v.id === L.id ? v : null; }, 30000, 500);
    try { tab.close(); } catch (e) { /* ignore */ }
    GM_deleteValue('mlf_house_req');
    if (r && r.lat) L.pin = { lat: r.lat, lon: r.lon };
    if (!r) return { none: true, why: 'Google Maps did not answer' };
    if (r.none) return { none: true, why: r.why };
    return { blob: b64ToBlob(r.b64) };
  }
  async function getOverviewPhoto(L) {
    const p = L.pin || (L.geo ? { lat: L.geo.lat, lon: L.geo.lon } : null);
    if (!p) throw new Error('no map location');
    const bbox = [p.lon - 0.0008, p.lat - 0.0005, p.lon + 0.0008, p.lat + 0.0005].join(',');
    return fetchBlob('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=' + bbox + '&bboxSR=4326&imageSR=3857&size=1000,750&format=jpg&f=image', 2);
  }
  async function uploadPhotos(files, retry = 1) {
    const upBtn = () => [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Upload');
    await waitFor(() => !upBtn(), 30000, 500); await sleep(800);
    const add = await waitFor(() => clickText('Add Photos', document, 'button'));
    if (!add) throw new Error('Add Photos button not found');
    add.click(); await sleep(1200);
    const input = await waitFor(() => { const all = document.querySelectorAll('input[type=file]'); return all[all.length - 1]; });
    if (!input) throw new Error('photo file input not found');
    const dt = new DataTransfer(); files.forEach(fl => dt.items.add(fl));
    input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(2500);
    const up = await waitFor(() => { const b = upBtn(); return b && !b.disabled ? b : null; }, 15000);
    if (!up) {
      const cancel = [...document.querySelectorAll('button,a')].filter(b => visible(b) && b.textContent.trim() === 'Cancel').pop();
      if (cancel) { cancel.click(); await sleep(1500); }
      if (retry > 0) return uploadPhotos(files, retry - 1);
      throw new Error('Upload button not found');
    }
    up.click();
    if (!await waitFor(() => /successfully uploaded/i.test(document.body.innerText) || !upBtn(), 60000)) throw new Error('upload did not confirm');
    await waitFor(() => !upBtn(), 30000, 500);
  }
  async function setLocationPhoto() {
    const sec = () => [...document.querySelectorAll('section.editable')].find(x => /Initial Appt/.test(x.innerText));
    const hasImg = () => { const s = sec(); return !!(s && s.querySelector('img')); };
    for (let attempt = 1; attempt <= 3 && !hasImg(); attempt++) {
      try {
        const s = await waitFor(sec, 15000);
        const pencil = s && s.querySelector('span.edit');
        if (!pencil) throw new Error('Location Info pencil not found');
        pencil.scrollIntoView({ block: 'center' }); pencil.click();
        if (!await waitFor(() => /Edit Location Information/i.test(document.body.innerText), 8000)) throw new Error('location editor did not open');
        const addImg = await waitFor(() => clickText('Add Image', document, 'button'), 8000);
        if (!addImg) throw new Error('Add Image button not found');
        addImg.click();
        await waitFor(() => /Select Files/i.test(document.body.innerText), 8000);
        const photosTab = [...document.querySelectorAll('button.file-picker-tabs__tab')].find(e => visible(e) && e.textContent.trim() === 'Photos');
        if (photosTab && !photosTab.classList.contains('current')) { photosTab.click(); await sleep(800); }
        const thumb = await waitFor(() => {
          const items = [...document.querySelectorAll('li.attachment')];
          if (items[0]) items[0].scrollIntoView({ block: 'center' });
          for (const re of [/_house\.jpg/i, /_overview\.jpg/i]) {
            const hit = items.find(li => { try { return re.test(decodeURIComponent(li.outerHTML)); } catch (e) { return re.test(li.outerHTML); } });
            if (hit) return hit.querySelector('button') || hit;
          }
          return null;
        }, 20000, 400);
        if (!thumb) throw new Error('house photo not in the picker');
        thumb.click(); await sleep(600);
        let pk = document.querySelector('button.file-picker-tabs__tab');
        while (pk && ![...pk.querySelectorAll('button')].some(b => visible(b) && b.innerText.trim() === 'Save')) pk = pk.parentElement;
        const save1 = pk && [...pk.querySelectorAll('button')].filter(x => visible(x) && x.innerText.trim() === 'Save').pop();
        if (!save1) throw new Error('picker Save not found');
        save1.click(); await sleep(2000);
        const save2 = [...document.querySelectorAll('button')].filter(x => visible(x) && x.innerText.trim() === 'Save').pop();
        if (save2) save2.click();
        await waitFor(() => /Location information saved/i.test(document.body.innerText) || hasImg(), 10000);
        await sleep(1500);
      } catch (e) {
        const cancel = [...document.querySelectorAll('button,a')].filter(x => visible(x) && x.innerText.trim() === 'Cancel').pop();
        if (cancel) { cancel.click(); await sleep(1000); }
        if (attempt === 3) throw e;
      }
    }
    if (!hasImg()) throw new Error('house picture not set on Location Info');
  }

  /* ---------- comments / task ---------- */
  async function replyInThread(text) {
    const ed = await waitFor(() => [...document.querySelectorAll('[contenteditable="true"]')].find(visible));
    if (!ed) throw new Error('reply box not found');
    ed.focus();
    if (ed.ckeditorInstance) ed.ckeditorInstance.setData(text.split('\n').map(l => '<p>' + (l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;') + '</p>').join(''));
    else document.execCommand('insertText', false, text);
    await sleep(600);
    const send = await waitFor(() => { const b = document.querySelector('.job-communications-reply-box__send-button'); return b && visible(b) && !b.disabled ? b : null; }, 5000);
    if (!send) throw new Error('Send button not available on the reply box');
    const before = document.body.innerText.length;
    send.click();
    const ok = await waitFor(() => /submitted successfully/i.test(document.body.innerText) || (ed.ckeditorInstance && ed.ckeditorInstance.getData() === '' && document.body.innerText.length > before), 15000);
    if (!ok) throw new Error('reply did not post');
    await sleep(1500);
  }
  // open the notes thread: the one whose preview shows one of the marks, else the oldest (last) thread in the list
  async function openNotesThread(marks, fallbackOldest) {
    const row = await waitFor(() => {
      const c = [...document.querySelectorAll('div,li')].filter(e => visible(e) && e.children.length > 0 && e.innerText.length < 500 && marks.some(m => e.innerText.includes(m)));
      return c.sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
    }, fallbackOldest ? 12000 : 30000);
    if (row) { row.click(); await sleep(2500); return true; }
    if (!fallbackOldest) return false;
    const rows = [...document.querySelectorAll('[class*="communication"] li, [class*="message-list"] li, [class*="thread"] li')].filter(e => visible(e) && e.innerText.length > 10 && e.innerText.length < 500);
    const oldest = rows[rows.length - 1];
    if (!oldest) return false;
    oldest.click(); await sleep(2500); return true;
  }
  async function createTask(title, assignee) {
    const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
    const openBtn = await waitFor(() => [...document.querySelectorAll('button,a,span,div')].find(e => visible(e) && e.children.length < 3 && /^\+?\s*Create Task$/i.test(txt(e))), 20000);
    if (!openBtn) throw new Error('"Create Task" button not found on the Overview page');
    openBtn.scrollIntoView({ block: 'center' }); openBtn.click(); await sleep(1500);
    const dlg = () => { const ta = [...document.querySelectorAll('textarea')].filter(visible)[0]; if (!ta) return null; let d = ta; for (let k = 0; k < 12 && d; k++, d = d.parentElement) if (/Assign To/i.test(txt(d)) && [...d.querySelectorAll('button')].some(b => /^Create$/i.test(txt(b)))) return d; return null; };
    const win = await waitFor(dlg, 15000);
    if (!win) throw new Error('task window did not open');
    const chips = () => [...(win.querySelector('.ti-tags') || win).querySelectorAll('.ti-tag')];
    for (const ch of chips()) if (!txt(ch).includes(assignee)) { const x = ch.querySelector('.ti-icon-close') || ch.querySelector('.ti-actions i:last-child'); if (x) { x.click(); await sleep(400); } }
    if (!chips().some(ch => txt(ch).includes(assignee))) {
      const inp = win.querySelector('input.ti-new-tag-input');
      if (!inp) throw new Error('"Find a person" box not found');
      // a tab opened in the background never gets real focus, so the list stays shut: fire the focus events ourselves and type the way a keyboard does
      const findOpt = () => [...win.querySelectorAll('.ti-autocomplete li.ti-item')].find(e => visible(e) && txt(e).includes(assignee));
      let opt = null;
      for (let tryN = 0; tryN < 3 && !opt; tryN++) {
        inp.focus(); inp.click(); inp.dispatchEvent(new FocusEvent('focus')); inp.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await typeInto(inp, assignee.split(' ').slice(0, 2).join(' ')); await sleep(1500);
        opt = await waitFor(findOpt, 5000);
        if (!opt) { setValue(inp, ''); await sleep(500); }
      }
      if (!opt) throw new Error('"' + assignee + '" not in the Find-a-person list');
      for (const t of ['mouseenter', 'mouseover', 'mousedown', 'mouseup']) { try { opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); } catch (_) { /* ignore */ } }
      opt.click(); await sleep(700);
      if (!chips().some(ch => txt(ch).includes(assignee))) { inp.focus(); inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); await sleep(700); }
    }
    if (!chips().some(ch => txt(ch).includes(assignee)) || chips().length !== 1) throw new Error('Assign To is not only ' + assignee);
    const desc = win.querySelector('textarea');
    desc.focus(); setValue(desc, title); desc.dispatchEvent(new Event('blur', { bubbles: true })); await sleep(500);
    const save = [...win.querySelectorAll('button')].filter(visible).find(b => /^create$/i.test(txt(b)) && !b.disabled);
    if (!save) throw new Error('task Create button not found');
    save.click();
    if (!await waitFor(() => !dlg(), 15000)) { await sleep(3000); if (!(await waitFor(() => [...document.querySelectorAll('a,span,div')].some(e => visible(e) && e.children.length === 0 && txt(e) === title), 8000))) throw new Error('task was not confirmed'); }
    await sleep(1200);
  }

  /* ---------- DUPLICATE: re-open, appointment, rep (same steps as the Dead Lead Reviver) ---------- */
  const bodyText = () => document.body.innerText || '';
  async function reopenJob() {
    const link = await waitFor(() => [...document.querySelectorAll('a.nav-link')].find(a => /Re-?\s?Open Job/i.test(a.textContent)), 20000);
    if (!link) throw new Error('Re-Open Job link not found on Settings');
    link.click();
    const b = await waitFor(() => document.querySelector('button[data-test="reopen-job__reopen"]'), 10000);
    if (!b) throw new Error('Re-Open Job button not found');
    await sleep(500); b.click();
    await waitFor(() => /re-?opened successfully/i.test(bodyText()), 25000);
    await sleep(3000);
  }
  async function setInitialAppt(L) {
    const ready = await waitFor(() => [...document.querySelectorAll('dt')].find(e => e.textContent.trim() === 'Initial Appt:') && /Milestones/.test(bodyText()), 25000);
    if (!ready) throw new Error('Overview did not load');
    await sleep(3000);
    const start = new Date(L.start);
    const label = MONTHS[start.getMonth()] + ' ' + start.getDate() + ', ' + start.getFullYear();
    const sec = document.querySelector('#location-view') && document.querySelector('#location-view').closest('section.editable');
    const pencil = sec && sec.querySelector('span.edit');
    if (!pencil) throw new Error('Location Info edit pencil not found');
    pencil.click();
    const dsel = '.edit-location-modal__section--appointment-date-selector';
    const wrap = await waitFor(() => document.querySelector(dsel), 15000);
    if (!wrap) throw new Error('Edit Location panel did not open');
    await sleep(800);
    const dateInput = wrap.querySelector('input');
    try {
      const clr = wrap.querySelector('button.form-v3-select__clear');
      if (dateInput.value && clr) { clr.click(); await sleep(700); }
      for (const cal of [...document.querySelectorAll('.flatpickr-calendar')]) {
        const yrEl = cal.querySelector('.cur-year'), moEl = cal.querySelector('select.flatpickr-monthDropdown-months');
        if (!yrEl || !moEl) continue;
        const diff = (parseInt(yrEl.value, 10) * 12 + parseInt(moEl.value, 10)) - (start.getFullYear() * 12 + start.getMonth());
        const nav = cal.querySelector(diff > 0 ? '.flatpickr-prev-month' : '.flatpickr-next-month');
        for (let i = 0; i < Math.abs(diff); i++) nav.click();
        await sleep(400);
        const dayEl = [...cal.querySelectorAll('.flatpickr-day')].find(x => x.getAttribute('aria-label') === label);
        if (!dayEl) continue;
        ['mousedown', 'mouseup', 'click'].forEach(t => dayEl.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })));
        await sleep(800);
        if (dateInput.value) break;
      }
      if (!dateInput.value) throw new Error('the appointment date did not take');
      const sels = await waitFor(() => { const s = [...document.querySelectorAll('.appointment-times-selector select')]; return s.length === 2 && !s[0].disabled ? s : null; }, 8000);
      if (!sels) throw new Error('Start/End time boxes did not unlock');
      const setSel = (sel, min) => { if (![...sel.options].some(o => o.value === String(min))) throw new Error('time ' + clock(min) + ' not offered'); setValue(sel, String(min)); };
      setSel(sels[0], L.startMin); await sleep(400);
      setSel(sels[1], L.endMin); await sleep(400);
      const saveBtn = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Save');
      if (!saveBtn) throw new Error('Save button not found');
      saveBtn.click();
      await waitFor(() => !document.querySelector(dsel), 15000);
      await sleep(5000);
    } catch (e) {
      const cancel = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Cancel' && /text-blue/.test(b.className));
      if (cancel) cancel.click();
      throw e;
    }
  }
  async function assignRep(want) {
    const label = () => { const e = document.querySelector('.job-rep-wrapper .rep-name'); return e ? clean(e.textContent) : ''; };
    const isWho = t => t === want || t.startsWith(want + ' ') || t.startsWith(want + '(');
    if (isWho(label())) return;
    const wrap = document.querySelector('.job-rep-wrapper');
    const toggle = wrap && wrap.querySelector('button.no-focus-outline');
    if (!toggle) throw new Error('assigned-rep box not found');
    toggle.click();
    const box = await waitFor(() => document.querySelector('.primary-rep-details'), 6000);
    if (!box) throw new Error('rep details did not open');
    let top = box, pencil = null;
    for (let i = 0; i < 5 && top && !pencil; i++) { pencil = top.querySelector('span.edit'); top = top.parentElement; }
    if (!pencil) throw new Error('rep edit pencil not found');
    pencil.click();
    const sel = await waitFor(() => { const lab = [...document.querySelectorAll('label')].find(l => /Company Representative/.test(l.textContent)); let c = lab; for (let i = 0; i < 4 && c && !c.querySelector('select'); i++) c = c.parentElement; return c && c.querySelector('select'); }, 10000);
    if (!sel) throw new Error('Company Representative box did not open');
    const opt = [...sel.options].find(o => isWho(clean(o.text)));
    if (!opt) throw new Error('"' + want + '" is not in the representative list');
    setValue(sel, opt.value); await sleep(600);
    const saveBtn = [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Save');
    if (!saveBtn) throw new Error('Save button not found for the representative');
    saveBtn.click();
    if (!(await waitFor(() => isWho(label()), 12000))) throw new Error('rep still shows "' + label() + '"');
  }

  /* ---------- Lead Table hand-off ---------- */
  function sheetJobFor(L) {
    if (L.cts) return { skip: 'CTS lead - not put on the Lead Table' };
    const s = new Date(L.start);
    if (s.getDay() === 0) return { skip: 'Sunday - not on the Lead Table' };
    const mon = new Date(s.getFullYear(), s.getMonth(), s.getDate() - ((s.getDay() + 6) % 7));
    const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
    const f = x => `${x.getMonth() + 1}.${x.getDate()}.${String(x.getFullYear()).slice(-2)}`;
    const slot = L.startMin < 720 ? 0 : (L.startMin < 930 ? 1 : 2);
    const city = L.city || splitAddress(L.address).city || '';
    const place = /indianapolis/i.test(city) && L.zip ? L.zip : (city || L.zip || '');
    const ins = L.workType === 'Insurance';
    const prod = L.products.length ? L.products.join(' & ') : (L.productOther || 'Repairs');
    return {
      id: L.id, ts: Date.now(), tab: `${f(mon)}-${f(sun)}`, dayIndex: Math.round((new Date(s.getFullYear(), s.getMonth(), s.getDate()) - mon) / 864e5),
      dayLabel: s.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' }), slot, slotName: ['Morning', 'Afternoon', 'Evening'][slot],
      insurance: ins, jobId: L.jobId, link: 'https://my.acculynx.com/jobs/' + L.jobId,
      text: `${fmtLead(L.startMin)} ${place} ${ins ? L.last : prod}`.replace(/\s+/g, ' ').trim(),
    };
  }
  // the Lead Table opens in its own VISIBLE tab (Chrome will not type into a background tab), types, reports back, closes
  async function toLeadTable(job) {
    GM_deleteValue('mlf_sheet_res');
    GM_setValue('mlf_sheet_job', job);
    const tab = GM_openInTab(`https://docs.google.com/spreadsheets/d/${CONFIG.LEAD_TABLE_ID}/edit`, { active: true, insert: true, setParent: true });
    const hb = setInterval(() => GM_setValue('mlf_hb', Date.now()), 20000);
    const res = await waitFor(() => { const v = GM_getValue('mlf_sheet_res', null); return v && v.id === job.id ? v : null; }, 180000, 1000);
    clearInterval(hb);
    await sleep(1500);
    try { tab.close(); } catch (e) { /* already closed */ }
    return res || { ok: false, error: 'the Lead Table tab did not finish' };
  }

  /* ---------- the step machine ---------- */
  let busy = false;
  async function run() {
    if (busy) return;
    const id = myLead(); if (!id) return;
    const L = getL(id); if (!L) return;
    busy = true;
    try {
      GM_setValue('mlf_hb', Date.now());
      if (!L.step) L.step = L.plan.kind === 'revive' ? (L.plan.dead ? 'reopen' : 'appt') : 'form';
      if (L.plan.kind === 'revive' && !L.jobId) { L.jobId = L.plan.jobId; saveL(L); }
      const onJob = () => { const m = location.pathname.match(/^\/jobs\/([0-9a-f-]{36})/i); return m && L.jobId && m[1].toLowerCase() === L.jobId.toLowerCase(); };
      const overview = () => /^\/jobs\/[0-9a-f-]{36}\/?$/i.test(location.pathname);

      if (L.step === 'form') {
        if (!/^\/lead\/new/i.test(location.pathname)) return;
        progress(L, 'filling Create Lead…');
        await fillCreateLead(L);
        L.step = 'saved'; L.savedAt = Date.now(); saveL(L);
        const save = clickText('Save', document, 'button');
        if (!save || save.disabled) throw new Error('Save is greyed out - a required field is missing on Create Lead');
        save.click();
        progress(L, 'saved, waiting for the job page…');
        return;
      }
      if (L.step === 'saved') {
        const m = location.pathname.match(/^\/jobs\/([0-9a-f-]{36})/i);
        if (!m) return;
        await sleep(2500);
        if (!bodyText().toLowerCase().includes(L.last.toLowerCase())) return;
        L.jobId = m[1]; saveL(L);
        progress(L, 'lead created - adding pictures…');
        return go(L, 'photos', '/jobphotos');
      }
      if (!onJob()) return;

      if (L.step === 'photos') {
        if (!/\/jobphotos/.test(location.pathname)) return go(L, 'photos', '/jobphotos');
        await sleep(2500);
        let house = null, okAny = false;
        try { house = await getHousePhoto(L); if (house.none) problem(L, 'House picture skipped - ' + house.why); } catch (e) { problem(L, 'House picture: ' + e.message); }
        if (L.lsData || L.imageUrl) { try { const ls = L.lsData ? dataUrlToBlob(L.lsData) : await fetchBlob(L.imageUrl, 2); await uploadPhotos([new File([ls], L.last + '_leadsheet.jpg', { type: 'image/jpeg' })]); okAny = true; } catch (e) { problem(L, 'Lead sheet picture: ' + e.message + ' - add it by hand'); } }
        try { const ov = L.ovData ? dataUrlToBlob(L.ovData) : await getOverviewPhoto(L); await uploadPhotos([new File([ov], L.last + '_overview.jpg', { type: 'image/jpeg' })]); okAny = true; } catch (e) { problem(L, 'Overview picture: ' + e.message); }
        if (house && house.blob) { try { await sleep(1500); await uploadPhotos([new File([house.blob], L.last + '_house.jpg', { type: 'image/jpeg' })]); okAny = true; } catch (e) { problem(L, 'House picture: ' + e.message); } }
        saveL(L);
        return okAny ? go(L, 'location', '') : go(L, 'comments', '/communications');
      }
      if (L.step === 'location') {
        if (!overview()) return go(L, 'location', '');
        progress(L, 'setting the house picture…');
        try { await setLocationPhoto(); } catch (e) { problem(L, e.message + ' - set the Location Info picture by hand'); }
        return go(L, 'comments', '/communications');
      }
      if (L.step === 'reopen') {
        if (!/\/settings/.test(location.pathname)) return go(L, 'reopen', '/settings');
        progress(L, 're-opening the old job…');
        await reopenJob();
        return go(L, 'appt', '');
      }
      if (L.step === 'appt') {
        if (!overview()) return go(L, 'appt', '');
        if (/Dead Milestone/.test(bodyText()) || /has been .Canceled./.test(bodyText())) {
          L.deadTries = (L.deadTries || 0) + 1; saveL(L);
          if (L.deadTries > 4) throw new Error('the old job still shows dead after Re-Open');
          await sleep(8000); location.reload(); return;
        }
        if (L.plan.keepAppt) { progress(L, 'keeping the existing appointment…'); return go(L, 'rep', ''); }
        progress(L, 'setting the new initial appointment…');
        await setInitialAppt(L);
        return go(L, 'rep', '');
      }
      if (L.step === 'rep') {
        if (!overview()) return go(L, 'rep', '');
        await sleep(2500);
        progress(L, 'assigning ' + L.assign + '…');
        try { await assignRep(L.assign); } catch (e) { problem(L, 'Assign to ' + L.assign + ': ' + e.message + ' - do it by hand'); }
        // existing (revived / duplicate) jobs also get the Street View + overview pictures, same as a new lead
        if (L.plan.kind === 'revive' && !L.photosDone) { L.photosDone = true; saveL(L); return go(L, 'photos', '/jobphotos'); }
        return go(L, 'comments', '/communications');
      }
      if (L.step === 'comments') {
        if (!/\/communications/.test(location.pathname)) return go(L, 'comments', '/communications');
        if (L.commentsDone) return go(L, 'task', '');
        progress(L, 'posting the notes…');
        await sleep(2500);
        const src = 'Lead Source: ' + L.leadSource;
        try {
          if (L.plan.kind === 'revive') {
            if (!(await openNotesThread(['Lead Source:', 'Initial Appt'], true))) throw new Error('no message thread found to post the notes in');
            await replyInThread('NEW LEAD INFO (' + new Date().toLocaleDateString('en-US') + ')\n' + L.notesText + '\n\n' + (L.plan.keepAppt ? 'Requested Appt (existing appointment NOT changed): ' : 'Initial Appt: ') + L.apptText);
          } else {
            if (!(await openNotesThread([src, L.notesText.split('\n')[1] || src], false))) throw new Error('notes message not found in Communications');
            if (L.rawPost) await replyInThread(L.rawPost);
            await replyInThread(src + '\nInitial Appt: ' + L.apptText);
          }
          await replyInThread(CONFIG.SIGNATURE);
        } catch (e) { problem(L, 'Comments: ' + e.message + ' - post the notes / "Claude" by hand'); }
        L.commentsDone = true; saveL(L);
        return go(L, 'task', '');
      }
      if (L.step === 'task') {
        if (!overview()) return go(L, 'task', '');
        // no task for Mars 1 any more (removed on request)
        L.step = 'sheet'; saveL(L);
      }
      if (L.step === 'sheet') {
        const job = L.assign !== 'Mars 2' ? { skip: 'not assigned to Mars 2 - not put on the Lead Table' } : L.plan.keepAppt ? { skip: 'existing appointment kept - Lead Table not changed' } : sheetJobFor(L);
        if (job.skip) L.sheetNote = job.skip;
        else {
          progress(L, 'writing the Lead Table (' + job.dayLabel + ' ' + job.slotName + ')…');
          const r = await toLeadTable(job);
          if (r.ok) L.sheetNote = r.already ? 'already on the Lead Table (' + r.cell + ')' : `Lead Table ${job.dayLabel} ${job.slotName} cell ${r.cell}` + (r.replaced ? ` (was "${r.replaced}")` : '') + (r.problems && r.problems.length ? ' - formatting not set: ' + r.problems.join(', ') : '');
          else problem(L, 'Lead Table: ' + r.error + ` - add "${job.text}" to ${job.dayLabel} ${job.slotName} Lead Pool by hand`);
        }
        L.step = 'done'; saveL(L);
      }
      if (L.step === 'done') {
        if (L.plan.kind === 'sold') problem(L, 'Previous customer ' + (L.crossRef || '') + ': add the QuickMeasure / Hover / EagleView reports to the new job by hand' + (L.plan.sellingRep ? ' (last sold by ' + L.plan.sellingRep + ', already in the notes)' : ''));
        if (L.plan.kind === 'revive' && L.plan.overYear) problem(L, 'Original job is over 1 year old - change its Lead Source to "' + L.leadSource + '"');
        const probs = L.problems || [];
        const what = L.plan.kind === 'revive' ? 'existing job updated' : 'entered';
        progress(L, `${what}. ${L.sheetNote || ''}${probs.length ? ' | TO DO: ' + probs.join(' · ') : ''}`, { done: !probs.length, bad: probs.length > 0, jobId: L.jobId, fin: true });
        const q = GM_getValue('mlf_queue', {}); delete q[L.id]; GM_setValue('mlf_queue', q);
        GM_deleteValue('mlf_active');
        showNote(`${L.first} ${L.last} ${what}.` + (probs.length ? ' TO DO: ' + probs.join(' · ') : ' You can close this tab.'), probs.length > 0);
      }
    } catch (e) {
      progress(L, 'STOPPED: ' + e.message + ' - finish this lead by hand.', { bad: true });
      showNote('STOPPED: ' + e.message, true);
      const q = GM_getValue('mlf_queue', {}); delete q[L.id]; GM_setValue('mlf_queue', q);
      GM_deleteValue('mlf_active');
    } finally { busy = false; }
  }
  run();
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; run(); } }, 1500);
})();
