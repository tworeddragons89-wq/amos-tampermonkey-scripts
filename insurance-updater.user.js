// ==UserScript==
// @name         Amos Insurance Updater (AccuLynx)
// @namespace    amos-exteriors
// @version      1.3.3
// @description  Fills blank Insurance and Adjuster fields on Inspection/Insurance leads from the carrier's scope, and lists everything it can't decide for a person to review.
// @match        https://my.acculynx.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_notification
// @connect      my.acculynx.com
// @connect      files.acculynx.com
// @connect      script.google.com
// @connect      script.googleusercontent.com
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/insurance-updater.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/insurance-updater.user.js
// @run-at       document-idle
// @noframes
// ==/UserScript==
/* Small PDF text extractor (no outside libraries). Handles Flate streams, object streams,
   ToUnicode CMaps, simple encodings and form XObjects. Returns plain text, one line per text row. */
const PdfText = (() => {
  const latin1 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 8192) s += String.fromCharCode.apply(null, u8.subarray(i, i + 8192)); return s; };
  const toBytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
  async function inflate(u8) {
    const ds = new DecompressionStream('deflate');
    const w = ds.writable.getWriter(); w.write(u8).catch(() => {}); w.close().catch(() => {});
    const r = ds.readable.getReader(); const parts = []; let n = 0;
    try { for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); n += value.length; } } catch (e) { /* keep what we got */ }
    const out = new Uint8Array(n); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
  }
  async function decode(dict, raw) {
    if (/\/FlateDecode|\/Fl\b/.test(dict)) return inflate(raw);
    if (/\/Filter/.test(dict)) return null; // images (DCT etc) - not needed
    return raw;
  }
  async function loadObjects(buf) {
    const s = latin1(buf); const objs = new Map();
    const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
    while ((m = re.exec(s))) {
      const num = +m[1]; const start = re.lastIndex;
      const end = s.indexOf('endobj', start); if (end < 0) break;
      let body = s.slice(start, end); const si = body.search(/\bstream\r?\n/);
      const o = { dict: body, raw: null };
      if (si >= 0) {
        o.dict = body.slice(0, si);
        const ds = start + si + body.slice(si).match(/^stream\r?\n/)[0].length;
        let de = s.indexOf('endstream', ds); if (de < 0 || de > end) de = end;
        let e2 = de; while (e2 > ds && (s[e2 - 1] === '\n' || s[e2 - 1] === '\r')) e2--;
        o.raw = buf.subarray(ds, de > e2 + 2 ? de : de); o.rawTrim = buf.subarray(ds, e2);
      }
      objs.set(num, o); re.lastIndex = end + 6;
    }
    for (const [, o] of [...objs]) {
      if (o.raw && /\/Type\s*\/ObjStm/.test(o.dict)) {
        const d = await decode(o.dict, o.rawTrim); if (!d) continue;
        const t = latin1(d); const N = +(o.dict.match(/\/N\s+(\d+)/) || [])[1]; const F = +(o.dict.match(/\/First\s+(\d+)/) || [])[1];
        const hdr = t.slice(0, F).trim().split(/\s+/).map(Number);
        for (let i = 0; i < N; i++) {
          const on = hdr[2 * i], off = hdr[2 * i + 1], nx = i + 1 < N ? hdr[2 * i + 3] : t.length - F;
          if (!objs.has(on)) objs.set(on, { dict: t.slice(F + off, F + nx), raw: null });
        }
      }
    }
    return objs;
  }
  const ref = (str) => { const m = str && str.match(/^\s*(\d+)\s+\d+\s+R/); return m ? +m[1] : null; };
  // pull the value after /Key in a dict string (handles nested << >> and [ ])
  function getVal(dict, key) {
    const re = new RegExp('/' + key + '(?![A-Za-z0-9])\\s*'); const m = re.exec(dict); if (!m) return null;
    let i = m.index + m[0].length; const c = dict[i];
    if (c === '<' && dict[i + 1] === '<') { let d = 0, j = i; for (; j < dict.length; j++) { if (dict[j] === '<' && dict[j + 1] === '<') { d++; j++; } else if (dict[j] === '>' && dict[j + 1] === '>') { d--; j++; if (!d) break; } } return dict.slice(i, j + 1); }
    if (c === '[') { let d = 0, j = i; for (; j < dict.length; j++) { if (dict[j] === '[') d++; else if (dict[j] === ']') { d--; if (!d) break; } } return dict.slice(i, j + 1); }
    const r = dict.slice(i).match(/^(\d+\s+\d+\s+R|\/[^\s/<>\[\]()]+|[^\s/<>\[\]()]+)/); return r ? r[1] : null;
  }
  function resolveDict(objs, v) { const r = ref(v); return r != null ? (objs.get(r) || {}).dict || '' : (v || ''); }
  function parseCMap(t) {
    const map = new Map(); let bytes = 1;
    const cs = t.match(/begincodespacerange\s*<([0-9A-Fa-f]+)>/); if (cs) bytes = cs[1].length / 2;
    const hex2str = (h) => { let o = ''; for (let i = 0; i + 3 < h.length + 1; i += 4) o += String.fromCharCode(parseInt(h.substr(i, 4), 16)); return o; };
    for (const blk of t.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g)) map.set(parseInt(m[1], 16), hex2str(m[2].padEnd(4, '0')));
    for (const blk of t.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
      for (const m of blk.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
        const a = parseInt(m[1], 16), b = parseInt(m[2], 16);
        if (m[3][0] === '<') { const base = m[3].slice(1, -1); let v = parseInt(base.slice(-4), 16); const pre = base.length > 4 ? hex2str(base.slice(0, -4)) : ''; for (let c = a; c <= b && c - a < 65536; c++) map.set(c, pre + String.fromCharCode(v++)); }
        else { const arr = [...m[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map(x => hex2str(x[1])); for (let c = a; c <= b; c++) map.set(c, arr[c - a] || ''); }
      }
    }
    return { map, bytes };
  }
  async function fontInfo(objs, fdict, cache) {
    const tu = ref(getVal(fdict, 'ToUnicode')); let cmap = null;
    if (tu != null) { if (cache.has(tu)) cmap = cache.get(tu); else { const o = objs.get(tu); if (o && o.rawTrim) { const d = await decode(o.dict, o.rawTrim); if (d) cmap = parseCMap(latin1(d)); } cache.set(tu, cmap); } }
    const two = /Identity-H|Type0/.test(fdict);
    return { cmap, bytes: cmap ? cmap.bytes : (two ? 2 : 1) };
  }
  function tokenize(t) {
    const toks = []; let i = 0; const n = t.length;
    while (i < n) {
      const c = t[i];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '%') { while (i < n && t[i] !== '\n' && t[i] !== '\r') i++; continue; }
      if (c === '(') { let d = 1, o = ''; i++; while (i < n && d) { const ch = t[i]; if (ch === '\\') { const nx = t[i + 1]; const esc = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }; if (nx in esc) { o += esc[nx]; i += 2; } else if (/[0-7]/.test(nx)) { const oc = t.substr(i + 1, 3).match(/^[0-7]{1,3}/)[0]; o += String.fromCharCode(parseInt(oc, 8)); i += 1 + oc.length; } else { i += 2; } continue; } if (ch === '(') d++; if (ch === ')') { d--; if (!d) { i++; break; } } o += ch; i++; } toks.push({ s: o }); continue; }
      if (c === '<' && t[i + 1] === '<') { toks.push({ op: '<<' }); i += 2; continue; }
      if (c === '>' && t[i + 1] === '>') { toks.push({ op: '>>' }); i += 2; continue; }
      if (c === '<') { const j = t.indexOf('>', i); const h = t.slice(i + 1, j).replace(/\s/g, ''); let o = ''; for (let k = 0; k < h.length; k += 2) o += String.fromCharCode(parseInt((h.substr(k, 2) + '0').slice(0, 2), 16)); toks.push({ s: o }); i = j + 1; continue; }
      if (c === '[' || c === ']') { toks.push({ op: c }); i++; continue; }
      if (c === '/') { let j = i + 1; while (j < n && !/[\s\/\[\]()<>{}%]/.test(t[j])) j++; toks.push({ name: t.slice(i + 1, j) }); i = j; continue; }
      let j = i; while (j < n && !/[\s\/\[\]()<>{}%]/.test(t[j])) j++; if (j === i) j++;
      const w = t.slice(i, j); i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) toks.push({ num: +w }); else toks.push({ op: w });
      if (w === 'ID') { const e = t.indexOf('EI', i); i = e < 0 ? n : e + 2; }
    }
    return toks;
  }
  async function pageText(objs, contentBytes, resDict, out, depth, cache) {
    const fontsDict = resolveDict(objs, getVal(resDict, 'Font'));
    const fonts = {};
    for (const m of fontsDict.matchAll(/\/([^\s\/<>\[\]()]+)\s+(\d+)\s+\d+\s+R/g)) fonts[m[1]] = await fontInfo(objs, (objs.get(+m[2]) || {}).dict || '', cache);
    const xo = resolveDict(objs, getVal(resDict, 'XObject'));
    const toks = tokenize(latin1(contentBytes)); const st = [];
    let font = null, lastY = null, line = '';
    const flush = () => { if (line.trim()) out.push(line.replace(/\s+/g, ' ').trim()); line = ''; };
    const dec = (s) => { if (!font) return s; if (font.cmap) { let o = ''; for (let i = 0; i < s.length; i += font.bytes) { let c = 0; for (let k = 0; k < font.bytes; k++) c = c * 256 + (s.charCodeAt(i + k) || 0); o += font.cmap.map.has(c) ? font.cmap.map.get(c) : (font.bytes === 1 ? String.fromCharCode(c) : ''); } return o; } return font.bytes === 2 ? '' : s; };
    const moveTo = (y) => { if (lastY !== null && Math.abs(y - lastY) > 1) flush(); else if (line && !/\s$/.test(line)) line += ' '; lastY = y; };
    let ty = 0, lead = 0;
    for (const tk of toks) {
      if (!tk.op) { st.push(tk); continue; }
      const op = tk.op;
      if (op === '[' || op === '<<') { st.push(tk); continue; }
      if (op === ']') { const arr = []; while (st.length && st[st.length - 1].op !== '[') arr.unshift(st.pop()); st.pop(); st.push({ arr }); continue; }
      if (op === '>>') { while (st.length && st[st.length - 1].op !== '<<') st.pop(); st.pop(); continue; }
      const a = st.splice(0);
      switch (op) {
        case 'BT': ty = 0; break;
        case 'Tf': font = fonts[(a[0] || {}).name] || null; break;
        case 'TL': lead = (a[0] || {}).num || 0; break;
        case 'Td': ty += (a[1] || {}).num || 0; moveTo(ty); break;
        case 'TD': ty += (a[1] || {}).num || 0; lead = -((a[1] || {}).num || 0); moveTo(ty); break;
        case 'Tm': ty = (a[5] || {}).num || 0; moveTo(ty); break;
        case 'T*': ty -= lead; moveTo(ty); break;
        case 'Tj': line += dec((a[0] || {}).s || ''); break;
        case "'": ty -= lead; moveTo(ty); line += dec((a[0] || {}).s || ''); break;
        case '"': ty -= lead; moveTo(ty); line += dec((a[2] || {}).s || ''); break;
        case 'TJ': for (const e of ((a[0] || {}).arr || [])) { if (e.s != null) line += dec(e.s); else if (e.num < -180) line += ' '; } break;
        case 'ET': break;
        case 'Do': {
          if (depth > 2) break; const nm = (a[0] || {}).name; const r = ref(getVal(xo, nm)); const o = r != null && objs.get(r);
          if (o && o.rawTrim && /\/Subtype\s*\/Form/.test(o.dict)) { const d = await decode(o.dict, o.rawTrim); if (d) { flush(); lastY = null; await pageText(objs, d, getVal(o.dict, 'Resources') ? resolveDict(objs, getVal(o.dict, 'Resources')) : resDict, out, depth + 1, cache); } }
          break; }
      }
    }
    flush();
  }
  async function extract(arrayBuffer, maxPages = 40) {
    const buf = new Uint8Array(arrayBuffer); const objs = await loadObjects(buf);
    // page order: walk the page tree from the Catalog; fall back to object order
    const pages = []; const seen = new Set();
    const walk = (num) => { if (seen.has(num) || pages.length >= maxPages) return; seen.add(num); const o = objs.get(num); if (!o) return; if (/\/Type\s*\/Pages\b/.test(o.dict)) { for (const k of (getVal(o.dict, 'Kids') || '').matchAll(/(\d+)\s+\d+\s+R/g)) walk(+k[1]); } else if (/\/Type\s*\/Page\b/.test(o.dict)) pages.push(num); };
    for (const [n, o] of objs) if (/\/Type\s*\/Catalog/.test(o.dict)) { const p = ref(getVal(o.dict, 'Pages')); if (p != null) walk(p); }
    if (!pages.length) for (const [n, o] of objs) if (/\/Type\s*\/Page\b/.test(o.dict) && pages.length < maxPages) pages.push(n);
    const cache = new Map(); const outPages = [];
    for (const pn of pages) {
      const pd = objs.get(pn).dict; let res = getVal(pd, 'Resources'); let p = pd; let guard = 0;
      while (!res && guard++ < 10) { const par = ref(getVal(p, 'Parent')); if (par == null) break; p = (objs.get(par) || {}).dict || ''; res = getVal(p, 'Resources'); }
      const resDict = resolveDict(objs, res || '');
      const cv = getVal(pd, 'Contents') || ''; const refs = [...cv.matchAll(/(\d+)\s+\d+\s+R/g)].map(m => +m[1]);
      let all = []; for (const r of refs) { let o = objs.get(r); if (o && !o.rawTrim && /^\s*\[/.test(o.dict)) { for (const k of o.dict.matchAll(/(\d+)\s+\d+\s+R/g)) { const oo = objs.get(+k[1]); if (oo && oo.rawTrim) { const d = await decode(oo.dict, oo.rawTrim); if (d) all.push(d); } } continue; } if (o && o.rawTrim) { const d = await decode(o.dict, o.rawTrim); if (d) all.push(d); } }
      const merged = new Uint8Array(all.reduce((a, b) => a + b.length + 1, 0)); let off = 0; for (const d of all) { merged.set(d, off); off += d.length; merged[off++] = 10; }
      const out = []; await pageText(objs, merged, resDict, out, 0, cache); outPages.push(out.join('\n'));
    }
    return { pages: outPages.length, text: outPages.join('\n\f\n'), chars: outPages.join('').replace(/\s/g, '').length };
  }
  return { extract };
})();
/* ---------- Core: reads a lead, decides what to fill, saves. No Tampermonkey calls in here. ---------- */
const AIU_CORE = (env) => {
  const ALLOWED = ['lead', 'assigned', 'prospect', 'dead', 'canceled', 'cancelled'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  class SessionError extends Error {}
  class StopError extends Error {}

  /* ---- talking to AccuLynx ---- */
  async function api(path, opts = {}) {
    const waits = [5000, 20000, 60000];
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(path, { credentials: 'same-origin', ...opts, headers: { Accept: 'application/json', ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
      } catch (e) { r = null; }
      if (r) {
        const ct = r.headers.get('content-type') || '';
        if (r.status === 401 || r.status === 403 || (r.redirected && !/\/api\//.test(r.url)) || (r.ok && /text\/html/.test(ct))) throw new SessionError('AccuLynx is signed out');
        if (r.ok) { const t = await r.text(); try { return t ? JSON.parse(t) : null; } catch (e) { throw new SessionError('AccuLynx answered with a page instead of data (probably signed out)'); } }
        if (r.status !== 429 && r.status < 500) throw new Error('AccuLynx said ' + r.status + ' for ' + path.split('?')[0]);
      }
      if (attempt >= waits.length) throw new Error('AccuLynx did not answer after 4 tries: ' + path.split('?')[0]);
      await sleep(waits[attempt]);
    }
  }
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });

  const LIST_URL = (page) => '/api/joblist?filters=currentMilestoneList%3DAssigned&filters=currentMilestoneList%3DProspect&filters=currentMilestoneList%3DDead&filters=workTypes%3DInspection&filters=workTypes%3DInsurance&loadAll=false&onlyBalanceDue=false&onlyWatchList=false&query=&sort=lastTouched%7Cdesc&type=2&page=' + page;
  async function listPage(page) {
    const j = await api(LIST_URL(page));
    return { total: j.TotalRecords, pages: j.TotalPages || Math.ceil((j.TotalRecords || 0) / Math.max(1, (j.results || []).length || 20)) /* v1.3.2: the API reports 0 pages, so work it out from the total */, rows: (j.results || []).map((r) => ({ id: r.Id, name: r.JobNameWithJobNumber || r.Name, milestone: r.CurrentMilestone, touched: r.LastTouchedUTC || r.LastTouched, workTypes: r.WorkTypes })) };
  }
  async function milestone(id) { const b = await api(`/api/jobs/${id}/GetJobBootstrap`); return String((b && b.Job && b.Job.CurrentMilestone) || '').toLowerCase(); }
  let carrierList = null, carrierListAt = 0;
  async function carriers() { if (!carrierList || Date.now() - carrierListAt > 6 * 3600000) { const j = await api('/api/v3/insurance'); carrierList = Array.isArray(j) ? j : []; carrierListAt = Date.now(); } return carrierList; }
  async function readInfo(id) { const j = await api(`/api/jobOverview/${id}/GetLocationInformationWithInsurance`); return { d: j.job.JobDetail, companies: await carriers() }; }
  async function docs(id) { const f = await api(`/api/v4/job-documents/${id}/job-document-folders`); const arr = Array.isArray(f) ? f : (f.Folders || f.Items || Object.values(f).find(Array.isArray) || []); const out = []; for (const fo of arr) for (const fi of fo.Files || []) out.push({ folder: fo.Name, name: fi.Name || '', ext: String(fi.Extension || '').toLowerCase().replace(/^\./, '') || (/pdf/i.test(fi.MIMEType || '') ? 'pdf' : (String(fi.MIMEType || '').match(/^image\/(\w+)/i) || [])[1] || ''), created: fi.CreatedDate, href: fi.Href || fi.Url, by: fi.CreatedByDisplayName }); return out; }
  const strip = (h) => String(h || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  async function messages(id) {
    const j = await post(`/api/v4/jobs/${id}/communications/previews`, { PageSize: 100 });
    const out = []; let reads = 0;
    for (const p of (j && j.Previews) || []) {
      const d = p.Data || {}; const base = { type: (p.Type || {}).Name, when: p.Timestamp, subject: d.Subject || '' };
      const prev = d.BodyPreview || '';
      if ((p.MessageCount > 1 || prev.length >= 90) && reads < 25 && p.ThreadId && /Job Message|Email|Text/i.test(base.type || '')) {
        reads++;
        try { const t = await post(`/api/v4/jobs/${id}/communications/thread/${p.ThreadId}`, {}); for (const m of (t && t.Messages) || []) out.push({ ...base, when: m.CreatedDate, by: (m.Creator || {}).Name || '', text: strip(m.Content || m.ContentPreview) }); continue; } catch (e) { if (e instanceof SessionError) throw e; }
      }
      out.push({ ...base, by: '', text: strip(prev) });
    }
    return out;
  }

  /* ---- carriers ---- */
  const CARRIERS = [
    ['STATE FARM', /state\s*farm/i], ['ALLSTATE', /\ballstate\b/i], ['American Family', /american\s+family|\bamfam\b/i], ['Indiana Farm Bureau Insurance', /indiana\s+farm\s+bureau|farm\s+bureau\s+(?:insurance|mutual)|infarmbureau/i],
    ['ERIE', /\berie\s+(?:insurance|indemnity|family|exchange)/i], ['Liberty Mutual', /liberty\s+mutual/i], ['Travelers', /travelers\s+(?:insurance|casualty|home|indemnity|property|personal|commercial)|\bthe\s+travelers\b/i], ['FARMERS', /farmers\s+(?:insurance|group|exchange)/i],
    ['Assurant', /assurant|standard\s+guaranty|american\s+bankers/i], ['USAA', /\busaa\b/i], ['Nationwide', /nationwide\s+(?:insurance|mutual|property|general)/i], ['Progressive', /progressive\s+(?:insurance|casualty|home|direct|specialty|advanced)|asi\s+progressive/i], ['Geico', /geico/i],
    ['Auto-Owners', /auto[\s-]?owners/i], ['Cincinnati', /cincinnati\s+(?:insurance|financial)/i], ['Grange', /grange\s+(?:insurance|mutual)/i], ['Safeco', /safeco/i], ['Westfield', /westfield\s+(?:insurance|group)/i],
    ['Encova', /\bencova\b/i],
    ['Meridian', /meridian\s+security/i], ['Encompass', /encompass\s+(?:insurance|indemnity)/i], ['Homesite', /homesite/i], ['Pekin', /pekin\s+(?:insurance|life)/i], ['Hanover', /\bhanover\s+(?:insurance|fire)/i],
    ['Shelter', /shelter\s+(?:insurance|mutual)/i], ['Country Financial', /country\s+financial/i], ['Chubb', /\bchubb\b/i], ['Foremost', /foremost\s+(?:insurance|signature|property)/i], ['American Strategic', /american\s+strategic/i],
    ['Universal Property', /universal\s+property/i], ['Kemper', /\bkemper\b/i], ['MetLife', /met\s?life/i], ['The Hartford', /the\s+hartford|hartford\s+(?:fire|insurance)/i], ['American National', /american\s+national/i],
    ['Germantown Mutual', /germantown\s+mutual/i], ['Church Mutual', /church\s+mutual/i], ['Frankenmuth', /frankenmuth/i], ['Celina', /celina\s+(?:insurance|mutual)/i], ['Hastings Mutual', /hastings\s+mutual/i], ['Orion180', /orion\s?180/i], ['Openly', /\bopenly\b/i], ['Branch', /branch\s+insurance/i], ['Lemonade', /lemonade\s+insurance/i], ['Hippo', /hippo\s+insurance/i], ['Kin Insurance', /\bkin\s+insurance/i], ['American Modern', /american\s+modern/i], ['Selective', /selective\s+insurance/i], ['Amica', /\bamica\b/i], ['Allied', /\ballied\s+insurance/i], ['Indiana Insurance', /indiana\s+insurance\s+company/i], ['Brotherhood Mutual', /brotherhood\s+mutual/i], ['Midwest Family', /midwest\s+family/i], ['Goodville Mutual', /goodville/i], ['SageSure', /sagesure/i], ['Bristol West', /bristol\s+west/i], ['Spinnaker', /spinnaker\s+insurance/i], ['Philadelphia Insurance', /philadelphia\s+(?:insurance|indemnity)/i], ['Century', /\bcentury\s+(?:insurance|national)/i], ['Omni', /\bomni\s+insurance/i], ['AAA', /\bAAA\b|auto\s+club/],
  ];
  const norm = (s) => String(s || '').toLowerCase().replace(/insurance|ins\.|company|\bco\b|group|mutual|exchange|[^a-z0-9]/g, '');
  function carrierHits(text) { const hits = {}; for (const [name, re] of CARRIERS) { const g = new RegExp(re.source, 'gi'); const n = (String(text).match(g) || []).length; if (n) hits[name] = n; } return hits; }
  function pickCarrier(hits, top) { const e = Object.entries(hits).sort((a, b) => b[1] - a[1]); if (!e.length) return null; if (e.length > 1 && e[1][1] === e[0][1]) { if (top) { const th = Object.keys(carrierHits(top)); const tied = e.filter((x) => x[1] === e[0][1]).map((x) => x[0]).filter((n) => th.includes(n)); if (tied.length === 1) return { name: tied[0] }; } return { tie: e.map((x) => x[0]) }; } return { name: e[0][0] }; }
  function carrierToList(name, companies) {
    const k = norm(name); const plain = companies.filter((c) => c.Status !== false && !/ - |-\s*\w+$/.test(c.Name || '') && !/^insurance agent$/i.test(c.Name || '')); const m = plain.filter((c) => norm(c.Name) === k);
    if (m.length === 1) return { id: m[0].InsuranceCompanyID, label: m[0].Name, other: '' };
    if (m.length > 1) return { ambiguous: m.map((c) => c.Name) };
    const oth = plain.find((c) => /^\s*other\s*$/i.test(c.Name || ''));
    if (oth) return { id: oth.InsuranceCompanyID, label: 'Other', other: name, isOther: true };
    return null;
  }

  /* ---- reading a scope's text ---- */
  const fmtPhone = (s) => { let d = String(s || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '1') d = d.slice(1); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : ''; };
  const titleCase = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()));
  const CONSUMER = /@(gmail|yahoo|hotmail|aol|outlook|icloud|live|msn|comcast|att|sbcglobal|bellsouth|ymail|me|protonmail)\./i;
  const emails = (s) => [...String(s).matchAll(/(?:^|[\s:;,<(])([A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,})(?=$|[\s>),;])/gi)].map((x) => x[1].toLowerCase()).filter((x) => !/amos/i.test(x) && !CONSUMER.test(x));
  // v1.1.0: a phone number must have separators ("(317) 555-1212", "866-787-8676"); a bare 10-digit run is usually a policy or claim number
  const PHONE = '(?<![\\d-])(?:1[\\s.-]?)?(?:\\([2-9]\\d{2}\\)\\s*|[2-9]\\d{2}[\\s.-])[2-9]\\d{2}[\\s.-]\\d{4}(?![\\d-])';
  // v1.1.0: a person's name from a "Claim Rep.: Paul Gund FL#W833204 Billing: ..." style header
  const NAME_STOP = /^(?:business|phone|cell|cellular|home|e-?mail|company|office|license|licence|position|billing|fax|claim|estimate|insured|property|adjuster|estimator|date|policy|type|contact)$/i;
  const TEAMISH = /\b(?:team|department|dept|claims?|estimating|estimate|center|centre|services?|insurance|group|unit|desk|office|line|catastrophe|processing)\b/i;
  function cleanName(raw) {
    const toks = String(raw).replace(/#.*$/, '').split(/[ ,]+/).filter(Boolean); const keep = [];
    for (const t of toks) { if (NAME_STOP.test(t)) break; if (keep.length >= 2 && /^[A-Z]{2}$/.test(t)) break; keep.push(t); }
    return keep.join(' ').trim();
  }
  function parseScope(text) {
    const t = String(text || ''); const lines = t.split('\n').map((l) => l.trim());
    const r = { readable: t.replace(/\s/g, '').length >= 300, flags: [] };
    let m = null; for (const c of t.matchAll(/Claim\s*(?:Number|No\.?|#)\s*:?\s*([A-Z0-9][A-Z0-9-]{4,24})\b/gi)) { if (/^(policy|date|type)/i.test(c[1]) || /^[0X-]+$/i.test(c[1]) || !/\d/.test(c[1])) continue; /* v1.3.1: a claim number has a digit; "INSURED" is a column label */ r.claim = c[1].toUpperCase(); break; }
    m = t.match(/Date\s+of\s+Loss\s*:?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i) || t.match(/Loss\s+Date\s*:?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i);
    if (m) { let y = +m[3]; if (y < 100) y += 2000; r.dol = { y, m: +m[1], d: +m[2] }; }
    m = t.match(/Type\s+of\s+Loss\s*:?\s*([A-Za-z][A-Za-z\/& -]{1,30}?)(?:\s{2,}|\n|$|\s+(?:Deductible|Date|Policy|Claim))/i); if (m) r.lossType = m[1].trim();
    // adjuster: labelled form (Xactimate header). v1.1.0: try every label, skip team names, strip license numbers.
    const labelRe = /(?:^|\n)\s*(?:Estimator|Adjuster|Claim\s*Rep(?:\.|resentative)?|Claims?\s+Professional|Field\s+Adjuster|Desk\s+Adjuster|Independent\s+Adjuster)\s*:\s*([A-Z][A-Za-z.'#0-9-]+(?:[ ,]+[A-Z][A-Za-z.'#0-9-]*){1,3})/g;
    for (const lm of t.matchAll(labelRe)) {
      const nm = cleanName(lm[1]);
      if (nm.split(' ').length < 2 || TEAMISH.test(nm)) continue;
      r.adjName = titleCase(nm);
      let near = t.slice(lm.index, lm.index + 400); const stopAt = near.slice(5).search(/\b(?:Claim\s*(?:Number|No)|Policy\s*Number|Type\s*of\s*Loss|Date\s+of)\b/i); if (stopAt >= 0) near = near.slice(0, stopAt + 5);
      const p = near.match(new RegExp('(' + PHONE + ')(?:\\s*(?:x|ext\\.?|extension)\\s*(\\d{1,8})(?!\\d))?', 'i')); if (p) { r.adjPhone = fmtPhone(p[1]); if (p[2]) r.adjExt = p[2]; }
      const e = emails(near)[0]; if (e) r.adjEmail = e;
      break;
    }
    // adjuster: State Farm form ("Last, First" then "866-787-8676 x 9785")
    if (!r.adjName) for (let i = 0; i < lines.length - 1; i++) {
      const a = lines[i].match(/^([A-Z][A-Za-z'-]+),\s*([A-Z][A-Za-z'-]+(?:\s+[A-Z]\.?)?)$/); const b = lines[i + 1].match(new RegExp('^(' + PHONE + ')(?:\\s*(?:x|ext\\.?)\\s*(\\d{1,8}))?$', 'i'));
      if (a && b && !/^(INDIANAPOLIS|MARION|IN)$/i.test(a[1])) { r.adjName = titleCase(a[2] + ' ' + a[1]); r.adjPhone = fmtPhone(b[1]); if (b[2]) r.adjExt = b[2]; break; }
    }
    // adjuster: e-mail signature ("Name" then "Claim Specialist")
    if (!r.adjName) for (let i = 1; i < Math.min(lines.length, 80); i++) {
      if (/^(claims?\s+(specialist|adjuster|representative|rep\.?|professional|associate)|(field|desk|independent|staff)\s+adjuster)\b/i.test(lines[i]) && /^[A-Z][a-z'-]+(?:\s+[A-Z][a-z.'-]*){1,3}$/.test(lines[i - 1])) { r.adjName = lines[i - 1]; break; }
    }
    // claim office (letterhead on the first page)
    const head = t.slice(0, 1500); const headTop = head.split(/\n[^\n]*(?:Insured|Policyholder|Owner|Customer)\s*:/i)[0];
    m = head.match(new RegExp('Fax(?:\\s*(?:Number|No\\.?|#))?\\s*:?\\s*(' + PHONE + ')', 'i')); if (m) r.fax = fmtPhone(m[1]);
    m = head.match(new RegExp('(?:Phone|Tel(?:ephone)?|Office|Claims?)\\s*:?\\s*(' + PHONE + ')', 'i')); if (m) r.officePhone = fmtPhone(m[1]);
    const em = emails(headTop.split('\n').filter((l) => !/^\s*(from|to|cc|bcc|sent|subject)\s*:/i.test(l)).join('\n')).filter((x) => !/@internal\./i.test(x)); if (em.length) r.officeEmail = em[0];
    r.carrier = pickCarrier(carrierHits(t.slice(0, 8000)), lines.slice(0, 15).join('\n'));
    r.letterhead = (lines.slice(0, 10).find((l) => /\b(insurance|mutual|indemnity|casualty|underwriters|assurance|group|company|claims|exchange|inc|llc)\b/i.test(l) && !/insured|policyholder|^(date|page|p\.?o\.?\s*box)\b/i.test(l) && !/\d{3}.*\d{4}/.test(l)) || '').slice(0, 60);
    if (/amos\s+exteriors/i.test(t.slice(0, 1200))) r.flags.push('looks like an Amos document, not the carrier\'s');
    m = t.match(/Net\s+(?:Actual\s+Cash\s+Value\s+)?(?:Claim|Payment)[^\n$]*?\$\s*\(?([\d,]+\.\d\d)\)?/i);
    if (m) { r.net = +m[1].replace(/,/g, ''); if (r.net === 0) r.flags.push('scope pays $0 (under the deductible?)'); }
    if (/below\s+(?:the\s+|your\s+)?deductible|does\s+not\s+exceed\s+(?:the\s+|your\s+)?deductible|less\s+than\s+(?:the\s+|your\s+)?deductible/i.test(t)) r.flags.push('scope says the damage is under the deductible');
    r.looksLikeScope = r.readable && !!r.claim && (!!r.dol || /Insured\s*:/i.test(t)) && !r.flags.some((f) => /Amos document/.test(f));
    return r;
  }

  /* ---- reading the messages ---- */
  function scanMessages(msgs) {
    const all = msgs.map((m) => (m.subject ? m.subject + ' ' : '') + m.text).join('\n');
    const f = { notes: [] };
    if (/\b(?:claim\s+(?:was\s+|got\s+|has\s+been\s+)?denied|denied\s+(?:the\s+)?(?:claim|roof|by\s+(?:the\s+)?insurance)|insurance\s+denied|denial\s+letter|claim\s+denial)\b/i.test(all)) { f.denied = true; f.notes.push('messages mention a denied claim'); }
    if (/full(?:y)?\s+approv/i.test(all)) { f.fullApproval = true; f.notes.push('messages mention a full approval (check Claim Approved)'); }
    if (/\bmet\s+(?:with\s+)?(?:the\s+)?adjuster|adjuster\s+(?:meeting|appointment)\s+(?:went|was|is\s+done)|had\s+(?:an?\s+)?adjuster\s+meeting/i.test(all)) { f.metAdjuster = true; f.notes.push('messages mention meeting the adjuster (check Met Adjuster)'); }
    if (/\bpartial(?:ly)?\s+(?:approv|pay)|approved\s+(?:only\s+)?(?:the\s+)?(?:gutters|siding|windows|front|back)/i.test(all)) f.notes.push('messages mention a partial approval');
    if (/\bretail\b/i.test(all)) f.retail = true;
    const cm = all.match(/claim\s*(?:#|number|no\.?)\s*(?:is\s*)?:?\s*([A-Z0-9][A-Z0-9-]{5,20})\b/i); if (cm && /\d/.test(cm[1])) { f.claimInMsg = cm[1].toUpperCase(); }
    const lab = [...all.matchAll(/insurance(?:\s+(?:company|carrier|provider|co\.?))?\s*(?:is|:|-|=)\s*([A-Za-z][A-Za-z .&'-]{2,40})/gi)].map((x) => x[1]);
    const named = new Set(); for (const s of lab) { const p = pickCarrier(carrierHits(s)); if (p && p.name) named.add(p.name); }
    if (named.size === 1) f.carrierInMsg = [...named][0]; else if (named.size > 1) f.notes.push('messages name more than one carrier: ' + [...named].join(', '));
    if (/\b(?:filed|file[ds]?)\s+(?:a\s+)?claim|claim\s+(?:was\s+|has\s+been\s+)?filed/i.test(all)) f.claimFiledMsg = true;
    // v1.1.0: an adjuster phone number written in a message is shown to a person, never filled automatically
    const ap = all.match(new RegExp('(?:adjuster|adj\\.?)[^\\n]{0,60}?(' + PHONE + ')', 'i')); if (ap && fmtPhone(ap[1])) { f.adjPhoneMsg = fmtPhone(ap[1]); f.notes.push('a message gives an adjuster phone ' + f.adjPhoneMsg + ' (not filled automatically)'); }
    return f;
  }

  /* ---- deciding ---- */
  const isoDate = (o) => `${o.y}-${String(o.m).padStart(2, '0')}-${String(o.d).padStart(2, '0')}T00:00:00.000Z`;
  // v1.1.0: take the calendar day exactly as AccuLynx wrote it, so time zones can't shift it by a day
  const dayOf = (s) => { if (!s) return ''; const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/); if (m) return m[1]; const d = new Date(s); if (isNaN(d)) return ''; return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const cmpClaim = (a, b) => String(a || '').toUpperCase().replace(/[^A-Z0-9]/g, '') === String(b || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

  async function analyze(row) {
    const res = { id: row.id, name: row.name, link: 'https://my.acculynx.com/jobs/' + row.id, set: [], flags: [], ins: null, adj: null, scope: null };
    const ms = await milestone(row.id); res.milestone = ms;
    if (!ALLOWED.includes(ms)) { res.result = 'skipped'; res.reason = 'protected milestone (' + (ms || 'unknown') + ')'; return res; }
    const { d, companies } = await readInfo(row.id); res.before = d;
    const files = await docs(row.id);
    const pdfs = files.filter((f) => f.ext === 'pdf' && f.href);
    const scopeCands = pdfs.filter((f) => !/invoice|timesheet|time\s*sheet|contract|permit|check|certificate|w-?9|lien|warranty/i.test(f.name) && (/scope|loss/i.test(f.folder) || /scope|\bsol\b|statement\s+of\s+loss|xactimate|loss\s+estimate|claim\s+estimate|estimate\s+summary/i.test(f.name)))
      .sort((a, b) => (/scope|loss/i.test(b.folder) - /scope|loss/i.test(a.folder)) || String(b.created).localeCompare(String(a.created))).slice(0, 4);
    const contingency = files.some((f) => /contingen/i.test(f.name) || /contingen/i.test(f.folder));
    let scope = null; const unreadable = [];
    for (const f of scopeCands) {
      let p; try { p = await env.readScope(f.href, f); } catch (e) { if (e instanceof SessionError) throw e; p = null; res.flags.push('could not open ' + f.name + ' (' + e.message + ')'); continue; }
      if (!p) continue;
      if (!p.readable) { unreadable.push(f.name); continue; }
      if (p.looksLikeScope) { scope = { ...p, file: f.name, folder: f.folder, created: f.created }; break; }
    }
    if (unreadable.length) res.flags.push('scope is a scan or picture the script can\'t read: ' + unreadable.join(', '));
    const picScopes = files.filter((f) => f.ext !== 'pdf' && /^(jpe?g|png|heic|heif|gif|tiff?|bmp|webp)$/.test(f.ext) && (/scope|loss/i.test(f.folder) || /scope|statement\s+of\s+loss/i.test(f.name)));
    if (!scope && picScopes.length) res.flags.push('scope is a photo the script can\'t read: ' + picScopes.map((f) => f.name).join(', '));
    // v1.1.0: PDFs in the Scope of Loss folder that did not look like a scope are said out loud, not silently ignored
    const notScopes = scopeCands.filter((f) => !unreadable.includes(f.name) && !(scope && f.name === scope.file));
    if (!scope && notScopes.length && !unreadable.length) res.flags.push('read but did not recognize as a carrier scope: ' + notScopes.map((f) => f.name).join(', '));
    const msgs = await messages(row.id); const mf = scanMessages(msgs); res.msgFlags = mf;
    res.flags.push(...mf.notes);
    res.scope = scope;

    // what the lead says
    const want = {}; const wantAdj = {}; const src = {};
    if (scope) {
      const ctx = 'scope "' + scope.file + '"';
      if (scope.carrier && scope.carrier.name) { const c = carrierToList(scope.carrier.name, companies); if (c && c.id) { want.carrier = c; src.carrier = ctx; } else if (c && c.ambiguous) res.flags.push('carrier ' + scope.carrier.name + ' matches more than one list entry'); else res.flags.push('carrier ' + scope.carrier.name + ' could not be matched to the carrier list'); }
      else if (scope.carrier && scope.carrier.tie) res.flags.push('scope names more than one carrier: ' + scope.carrier.tie.join(', '));
      else if (!d.InsuranceCompanyID) res.flags.push('carrier not recognized in the scope' + (scope.letterhead ? ' (the letterhead reads "' + scope.letterhead + '")' : ''));
      if (mf.denied) res.flags.push('Damage Location left blank because messages mention a denial');
      else { want.DamageLocation = 'True'; src.DamageLocation = ctx; }
      if (scope.dol) { want.DateOfLoss = scope.dol; src.DateOfLoss = ctx; }
      want.ClaimField = true; src.ClaimField = ctx; if (scope.claim) { want.ClaimNumber = scope.claim; src.ClaimNumber = ctx; }
      want.HavePaperwork = true; src.HavePaperwork = ctx;
      if (scope.adjName) { wantAdj.AdjusterName = scope.adjName; }
      const phone = scope.adjPhone; /* v1.3.3: never use the letterhead/office phone as the adjuster phone (it can be the customer's own number) */ if (phone) { wantAdj.AdjusterPhone = phone; if (scope.adjPhone && scope.adjExt) wantAdj.AdjusterExt = scope.adjExt; }
      if (scope.fax) wantAdj.AdjusterFax = scope.fax;
      const em = scope.adjEmail || scope.officeEmail; if (em) wantAdj.AdjusterEmail = em;
      res.flags.push(...scope.flags);
    } else {
      if (mf.carrierInMsg) { const c = carrierToList(mf.carrierInMsg, companies); if (c && c.id && !c.isOther) { want.carrier = c; src.carrier = 'a message naming the insurance company'; } }
      if (mf.claimInMsg && blank(d.ClaimNumber)) res.flags.push('a message mentions claim number ' + mf.claimInMsg + ' but there is no readable scope; check it');
      if (contingency && blank(d.ClaimNumber)) res.flags.push('contingency on file (often handwritten); check it for carrier and claim number');
      if (mf.claimFiledMsg && !d.ClaimField) res.flags.push('messages say a claim was filed; ' + (unreadable.length || picScopes.length ? 'the scope needs a person to read it' : 'no scope on file'));
    }

    // fill blanks only
    const ins = { InsuranceCompanyID: d.InsuranceCompanyID || null, DamageLocation: d.DamageLocation || '', DateOfLoss: d.DateOfLoss || null, ClaimField: !!d.ClaimField, ClaimFiledDate: d.ClaimFiledDate || null, ClaimNumber: d.ClaimNumber || '', HavePaperwork: !!d.HavePaperwork, InsuranceCompanyOtherName: d.InsuranceCompanyOtherName || '' };
    let insChanged = false;
    if (want.carrier) {
      if (blank(ins.InsuranceCompanyID)) { ins.InsuranceCompanyID = want.carrier.id; ins.InsuranceCompanyOtherName = want.carrier.other || ''; insChanged = true; res.set.push('Insurance Company ' + (want.carrier.isOther ? 'Other: ' + want.carrier.other : want.carrier.label) + ' (' + src.carrier + ')'); if (want.carrier.isOther) res.flags.push(want.carrier.other + ' is not in the carrier list, entered as Other'); }
      else if (String(ins.InsuranceCompanyID).toLowerCase() !== String(want.carrier.id).toLowerCase()) res.flags.push('conflict: Insurance Company on file differs from ' + src.carrier + ' (' + want.carrier.label + (want.carrier.other ? ': ' + want.carrier.other : '') + ')');
    }
    if (want.DamageLocation) { if (blank(ins.DamageLocation)) { ins.DamageLocation = 'True'; insChanged = true; res.set.push('Damage Location True (' + src.DamageLocation + ')'); } }
    if (want.DateOfLoss) { const w = isoDate(want.DateOfLoss); if (blank(ins.DateOfLoss)) { ins.DateOfLoss = w; insChanged = true; res.set.push(`Date of Loss ${want.DateOfLoss.m}/${want.DateOfLoss.d}/${want.DateOfLoss.y}`); } else if (dayOf(ins.DateOfLoss) !== w.slice(0, 10)) res.flags.push(`conflict: Date of Loss on file is ${dayOf(ins.DateOfLoss)}, scope says ${want.DateOfLoss.m}/${want.DateOfLoss.d}/${want.DateOfLoss.y}`); }
    if (want.ClaimField && !ins.ClaimField) { ins.ClaimField = true; insChanged = true; res.set.push('Claim Filed'); }
    if (want.ClaimNumber) { if (blank(ins.ClaimNumber)) { ins.ClaimNumber = want.ClaimNumber; insChanged = true; res.set.push('Claim Number ' + want.ClaimNumber); } else if (!cmpClaim(ins.ClaimNumber, want.ClaimNumber)) res.flags.push('conflict: Claim Number on file is ' + ins.ClaimNumber + ', scope says ' + want.ClaimNumber); }
    if (want.HavePaperwork && !ins.HavePaperwork) { ins.HavePaperwork = true; insChanged = true; res.set.push('Has Paperwork'); }

    const adj = { AdjusterName: d.AdjusterName || '', AdjusterPhone: d.AdjusterPhone || '', AdjusterExt: d.AdjusterExt || '', AdjusterPhoneType: d.AdjusterPhoneType || '', AdjusterFax: d.AdjusterFax || '', AdjusterEmail: d.AdjusterEmail || '', MetWithAdjuster: !!d.MetWithAdjuster, MetWithAdjusterDate: d.MetWithAdjusterDate || null, ClaimApproved: !!d.ClaimApproved, ClaimApprovedDate: d.ClaimApprovedDate || null };
    let adjChanged = false;
    const label = { AdjusterName: 'Adjuster Name', AdjusterPhone: 'Adjuster Phone', AdjusterExt: 'Ext', AdjusterFax: 'Adjuster Fax', AdjusterEmail: 'Adjuster Email' };
    const phoneBlankBefore = blank(adj.AdjusterPhone);
    for (const k of Object.keys(wantAdj)) {
      if (k === 'AdjusterExt' && !phoneBlankBefore) continue; // ext belongs with the phone we write
      if (blank(adj[k])) { adj[k] = wantAdj[k]; adjChanged = true; res.set.push(label[k] + ' ' + wantAdj[k]); }
      else if (k === 'AdjusterName' && norm(adj[k]) !== norm(wantAdj[k])) res.flags.push('conflict: Adjuster Name on file is ' + adj[k] + ', scope says ' + wantAdj[k]);
      else if (/Phone|Fax/.test(k) && adj[k].replace(/\D/g, '').slice(-10) !== wantAdj[k].replace(/\D/g, '').slice(-10)) res.flags.push('note: ' + label[k] + ' on file differs from the scope; left as is');
    }
    if (insChanged) res.ins = ins; if (adjChanged) res.adj = adj;
    res.result = (insChanged || adjChanged) ? 'updated' : 'nochange';
    if (!scope && res.result === 'nochange') res.reason = files.length ? 'no carrier scope on file' : 'no documents on file';
    if (scope && res.result === 'nochange') res.reason = 'everything from the scope is already filled';
    res.review = res.flags.length > 0;
    return res;
  }

  async function save(res) {
    const ms = await milestone(res.id);
    if (!ALLOWED.includes(ms)) { res.result = 'skipped'; res.reason = 'milestone changed to ' + ms + ' before saving'; return res; }
    if (res.ins) await post('/api/jobs/SaveInsuranceInfo', { JobDetail: res.ins, jobId: res.id });
    if (res.adj) await post(`/api/jobs/${res.id}/SaveAdjusterInfo`, { JobDetail: res.adj, jobId: res.id });
    const { d } = await readInfo(res.id); const bad = [];
    if (res.ins) for (const k of ['InsuranceCompanyID', 'DamageLocation', 'ClaimField', 'ClaimNumber', 'HavePaperwork', 'InsuranceCompanyOtherName']) if (String(d[k] ?? '').toLowerCase() !== String(res.ins[k] ?? '').toLowerCase()) bad.push(k);
    if (res.ins && res.ins.DateOfLoss && dayOf(d.DateOfLoss) !== dayOf(res.ins.DateOfLoss)) bad.push('DateOfLoss');
    if (res.adj) for (const k of ['AdjusterName', 'AdjusterPhone', 'AdjusterExt', 'AdjusterFax', 'AdjusterEmail']) if (String(d[k] ?? '') !== String(res.adj[k] ?? '')) bad.push(k);
    // nothing we did not mean to touch may change
    for (const k of ['MetWithAdjuster', 'ClaimApproved']) if (!!d[k] !== !!res.before[k]) bad.push(k + ' changed unexpectedly');
    if (bad.length) { res.flags.push('read-back did not match for: ' + bad.join(', ')); res.review = true; res.verify = 'mismatch'; } else res.verify = 'ok';
    return res;
  }

  return { api, listPage, milestone, readInfo, docs, messages, parseScope, scanMessages, analyze, save, carrierToList, SessionError, StopError, sleep, ALLOWED };
};
/* ---------- Tampermonkey side: storage, PDF download, the run loop and the control panel ---------- */
(function () {
  'use strict';
  if (window.top !== window.self) return;
  const VERSION = '1.3.3';
  // v1.1.0: maxLeadsThisRun stops a run after that many leads (0 = no limit)
  const DEFAULTS = { secondsBetweenLeads: 12, maxLeadsPerHour: 120, restMinutesAfterFullPass: 30, webhookUrl: '', maxLeadsThisRun: 25 };
  const S = {
    get: (k, d) => { try { const v = GM_getValue(k); return v === undefined ? d : v; } catch (e) { return d; } },
    set: (k, v) => GM_setValue(k, v),
  };
  // v1.2.0: there is no dry run any more; the script always saves. (Leads only seen in an old dry run get checked again.)
  const settings = () => ({ ...DEFAULTS, ...S.get('aiu_settings', {}) });

  function fetchPdf(href) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({ method: 'GET', url: href, responseType: 'arraybuffer', timeout: 60000,
        onload: (r) => { if (r.status === 200 && r.response && r.response.byteLength > 100) resolve(r.response); else if (r.status === 401 || r.status === 403) reject(new Error('file link refused (' + r.status + ')')); else reject(new Error('file download failed (' + r.status + ')')); },
        onerror: () => reject(new Error('file download failed')), ontimeout: () => reject(new Error('file download timed out')) });
    });
  }
  const pdfCache = new Map();
  const core = AIU_CORE({
    readScope: async (href) => {
      if (pdfCache.has(href)) return pdfCache.get(href);
      const ab = await fetchPdf(href);
      if (ab.byteLength > 25 * 1024 * 1024) return { readable: false, flags: ['file too big to read'] };
      const head = new Uint8Array(ab, 0, 5); if (String.fromCharCode(...head) !== '%PDF-') throw new Error('not a PDF');
      const t = await PdfText.extract(ab, 40); const p = core.parseScope(t.text);
      if (pdfCache.size > 50) pdfCache.clear(); pdfCache.set(href, p); return p;
    },
  });

  /* ---- logs ---- */
  const cap = (arr, n) => (arr.length > n ? arr.slice(arr.length - n) : arr);
  function record(res) {
    const done = S.get('aiu_done', {}); done[res.id] = { t: res.touched || '', r: res.result, rv: !!res.review, at: Date.now(), dry: false }; S.set('aiu_done', done);
    const log = S.get('aiu_log', []);
    log.push([new Date().toLocaleString(), res.name, res.link, res.milestone || '', res.result, res.set.join('; '), res.reason || '', res.flags.join('; '), res.verify || '']);
    S.set('aiu_log', cap(log, 20000));
    if (res.scope) {
      const sc = res.scope; const rows = S.get('aiu_scopes', []);
      const carrier = sc.carrier && sc.carrier.name ? sc.carrier.name : '';
      const row = [res.name, res.link, res.milestone, carrier, sc.claim || '', sc.dol ? `${sc.dol.m}/${sc.dol.d}/${sc.dol.y}` : '', sc.file, sc.lossType || '', sc.adjName || '', sc.adjPhone ? sc.adjPhone + (sc.adjExt ? ' x' + sc.adjExt : '') : '', res.flags.join('; ')];
      if (!rows.some((r) => r[1] === res.link && r[6] === sc.file)) { rows.push(row); S.set('aiu_scopes', cap(rows, 20000)); sendSheet('Scope Log', row); }
    }
    if (res.review) {
      const rows = S.get('aiu_review', []); const row = [new Date().toLocaleDateString(), res.name, res.link, res.milestone || '', res.flags.join('; '), res.set.join('; ')];
      rows.push(row); S.set('aiu_review', cap(rows, 20000)); sendSheet('Needs Review', row);
    }
    const c = S.get('aiu_counts', { updated: 0, nochange: 0, skipped: 0, review: 0, error: 0 }); c[res.result] = (c[res.result] || 0) + 1; if (res.review) c.review++; S.set('aiu_counts', c);
    // v1.3.0: keep the last results where they can be audited (also written onto the panel as data-aiu)
    try {
      const sc = res.scope; const last = S.get('aiu_last', []);
      last.push({ at: new Date().toLocaleTimeString(), n: res.name, l: res.link, r: res.result, set: res.set, fl: res.flags, v: res.verify || '', why: res.reason || '', sc: sc ? { f: sc.file, car: sc.carrier && (sc.carrier.name || (sc.carrier.tie || []).join('|')), claim: sc.claim, dol: sc.dol ? `${sc.dol.m}/${sc.dol.d}/${sc.dol.y}` : '', adj: sc.adjName, ph: sc.adjPhone, ext: sc.adjExt, op: sc.officePhone, fax: sc.fax, em: sc.adjEmail || sc.officeEmail } : null });
      S.set('aiu_last', cap(last, 40)); if (host) host.setAttribute('data-aiu', JSON.stringify(cap(last, 40)));
    } catch (e) { /* never let logging stop a run */ }
  }
  function sendSheet(tab, row) {
    const url = settings().webhookUrl; if (!url || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(url)) return;
    GM_xmlhttpRequest({ method: 'POST', url, data: JSON.stringify({ tab, row }), headers: { 'Content-Type': 'text/plain' }, onerror: () => {} });
  }
  function csv(rows, header) { const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"'; return [header, ...rows].map((r) => r.map(q).join(',')).join('\r\n'); }
  function download(name, text) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000); }

  /* ---- one tab at a time ---- */
  const TAB = Math.random().toString(36).slice(2);
  const lockFree = () => { const l = S.get('aiu_lock', null); return !l || l.tab === TAB || Date.now() - l.ts > 45000; };
  const holdLock = () => S.set('aiu_lock', { tab: TAB, ts: Date.now() });

  /* ---- the loop ---- */
  let running = false, stopAsked = false, status = 'Stopped';
  const say = (s) => { status = s; render(); };
  const wait = async (ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (stopAsked) throw new core.StopError(); holdLock(); await core.sleep(Math.min(5000, end - Date.now())); } };
  function hourOk() { const h = S.get('aiu_hour', { start: Date.now(), n: 0 }); if (Date.now() - h.start > 3600000) { S.set('aiu_hour', { start: Date.now(), n: 0 }); return 0; } return h.n >= settings().maxLeadsPerHour ? h.start + 3600000 - Date.now() : 0; }
  function countHour() { const h = S.get('aiu_hour', { start: Date.now(), n: 0 }); h.n++; S.set('aiu_hour', h); }
  function needsWork(row) { const d = S.get('aiu_done', {})[row.id]; if (!d) return true; if (d.dry) return true; if (d.r === 'error') return Date.now() - d.at > 6 * 3600000; return d.t !== (row.touched || '') && d.r !== 'skipped' ? true : false; }

  async function run() {
    if (running) return; if (!lockFree()) { alert('The insurance updater is already running in another AccuLynx tab. Use that tab, or close it and wait a minute.'); return; }
    running = true; stopAsked = false; holdLock(); let errorsInRow = 0, ranThisRun = 0, pauseNote = '';
    try {
      for (;;) {
        let page = 1, pages = 1, worked = 0;
        while (page <= pages) {
          say('Reading the lead list, page ' + page);
          const lp = await core.listPage(page); pages = Math.min(lp.pages || 1, 2000); S.set('aiu_total', lp.total); if (!lp.rows.length) break;
          for (const row of lp.rows) {
            if (!needsWork(row)) continue;
            const w = hourOk(); if (w) { say('Hourly limit reached, resting ' + Math.ceil(w / 60000) + ' min'); await wait(w); }
            say('Working on ' + row.name);
            let res;
            try {
              res = await core.analyze(row); res.touched = row.touched;
              if (res.result === 'updated') await core.save(res);
              errorsInRow = 0;
            } catch (e) {
              if (e instanceof core.SessionError || e instanceof core.StopError) throw e;
              errorsInRow++; res = { id: row.id, name: row.name, link: 'https://my.acculynx.com/jobs/' + row.id, set: [], flags: ['error: ' + e.message], result: 'error', review: false, touched: row.touched };
              if (errorsInRow >= 5) { say('5 errors in a row, resting 15 min'); await wait(15 * 60000); errorsInRow = 0; }
            }
            record(res); countHour(); worked++; ranThisRun++; render();
            // v1.1.0 guard 1: after the very first live save, stop so a person can check that lead in AccuLynx
            if (res.result === 'updated' && res.verify && !S.get('aiu_firstOk_110', false)) { S.set('aiu_firstOk_110', true); pauseNote = 'PAUSED after the first live save. Open ' + res.link + ' and check it (dates, adjuster, text opt-in), then press Start.'; throw new core.StopError(); }
            // v1.1.0 guard 2: stop after the number of leads set in the panel
            const limit = +settings().maxLeadsThisRun || 0; if (limit && ranThisRun >= limit) { pauseNote = 'Finished the ' + limit + '-lead run. Press Start for another batch.'; throw new core.StopError(); }
            await wait(settings().secondsBetweenLeads * 1000);
          }
          page++; await wait(1500);
        }
        say('Finished a full pass (' + worked + ' leads). Resting ' + settings().restMinutesAfterFullPass + ' min, then checking for new leads');
        await wait(settings().restMinutesAfterFullPass * 60000);
      }
    } catch (e) {
      if (e instanceof core.SessionError) {
        say('PAUSED: AccuLynx signed out. Sign in again, then press Start.');
        try { GM_notification({ title: 'Amos insurance updater paused', text: 'AccuLynx signed out. Sign in again, then press Start.', timeout: 0 }); } catch (x) {}
      } else if (e instanceof core.StopError) say(pauseNote || 'Stopped');
      else say('Stopped by an error: ' + e.message);
    } finally { running = false; S.set('aiu_lock', null); render(); }
  }

  /* ---- panel ---- */
  let host, root;
  function render() {
    if (!root) return; const st = settings(); const c = S.get('aiu_counts', {}); const n = Object.keys(S.get('aiu_done', {})).length;
    root.querySelector('#st').textContent = status;
    root.querySelector('#ct').textContent = `Checked ${n} of ${S.get('aiu_total', '?')} leads · updated ${c.updated || 0} · no changes ${c.nochange || 0} · skipped ${c.skipped || 0} · needs review ${c.review || 0} · errors ${c.error || 0}`;
    root.querySelector('#go').textContent = running ? 'Stop' : 'Start';
    root.querySelector('#mode').textContent = 'LIVE: saving to AccuLynx';
    root.querySelector('#mode').style.color = '#b00020';
  }
  function panel() {
    host = document.createElement('div'); host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483646;';
    const clamp = (x, y) => [Math.min(Math.max(0, x), Math.max(0, window.innerWidth - 60)), Math.min(Math.max(0, y), Math.max(0, window.innerHeight - 40))];
    const place = (x, y) => { const c = clamp(x, y); host.style.left = c[0] + 'px'; host.style.top = c[1] + 'px'; return c; };
    const pos = S.get('aiu_pos', null); if (pos && isFinite(pos.x) && isFinite(pos.y)) place(pos.x, pos.y); else place(window.innerWidth - 340, 110);
    window.addEventListener('resize', () => place(host.offsetLeft, host.offsetTop));
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>.b{font:13px system-ui,sans-serif;background:#fff;color:#222;border:1px solid #999;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.25);padding:10px;width:320px}
      .h{font-weight:600;display:flex;justify-content:space-between;cursor:pointer}.x{display:none;margin-top:8px}.open .x{display:block}button{margin:3px 3px 0 0;padding:4px 8px;font:12px system-ui}
      #st{margin:6px 0;font-weight:600}#ct{color:#444;font-size:12px}label{display:block;margin-top:6px;font-size:12px}input[type=number]{width:60px}input[type=text]{width:100%}</style>
      <div class="b" id="b"><div class="h" id="hd"><span>Insurance updater v${VERSION}</span><span id="mode"></span></div>
      <div class="x"><div id="st"></div><div id="ct"></div>
      <button id="go">Start</button><button id="ex">Export CSVs</button><button id="cl">Clear logs</button>
      <label>Seconds between leads <input type="number" id="sec" min="5" max="600"></label>
      <label>Most leads per hour <input type="number" id="hr" min="1" max="600"></label>
      <label>Stop after this many leads (0 = no limit) <input type="number" id="mx" min="0" max="5000"></label>
      <label>Google Sheet web app link (optional)<input type="text" id="wh" placeholder="https://script.google.com/macros/s/.../exec"></label>
      <button id="sv">Save settings</button></div></div>`;
    document.documentElement.appendChild(host);
    try { host.setAttribute('data-aiu', JSON.stringify(S.get('aiu_last', []))); } catch (e) { /* ignore */ }
    const st = settings(); root.querySelector('#sec').value = st.secondsBetweenLeads; root.querySelector('#hr').value = st.maxLeadsPerHour; root.querySelector('#mx').value = st.maxLeadsThisRun; root.querySelector('#wh').value = st.webhookUrl;
    const b = root.querySelector('#b'); if (S.get('aiu_open', false)) b.classList.add('open');
    // v1.2.0: drag the title bar to move the box; a plain click on it still opens/closes it
    const hd = root.querySelector('#hd'); let drag = null;
    hd.style.cursor = 'move'; hd.style.userSelect = 'none'; hd.title = 'Drag to move. Click to open or close.';
    hd.addEventListener('pointerdown', (e) => { if (e.button !== 0) return; drag = { sx: e.clientX, sy: e.clientY, ox: host.offsetLeft, oy: host.offsetTop, moved: false }; try { hd.setPointerCapture(e.pointerId); } catch (x) {} });
    hd.addEventListener('pointermove', (e) => { if (!drag) return; const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy; if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return; drag.moved = true; place(drag.ox + dx, drag.oy + dy); });
    hd.addEventListener('pointerup', () => { if (!drag) return; const d = drag; drag = null; if (d.moved) S.set('aiu_pos', { x: host.offsetLeft, y: host.offsetTop }); else { b.classList.toggle('open'); S.set('aiu_open', b.classList.contains('open')); } });
    hd.addEventListener('pointercancel', () => { drag = null; });
    root.querySelector('#go').onclick = () => {
      if (running) { stopAsked = true; say('Stopping...'); return; }
      run();
    };
    root.querySelector('#sv').onclick = () => { const sec = Math.max(5, +root.querySelector('#sec').value || 12), hr = Math.max(1, +root.querySelector('#hr').value || 120), mx = Math.max(0, +root.querySelector('#mx').value || 0), wh = root.querySelector('#wh').value.trim(); if (wh && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(wh)) { alert('That link does not look like a Google Apps Script web app link (it should start with https://script.google.com/macros/s/ and end with /exec).'); return; } S.set('aiu_settings', { ...settings(), secondsBetweenLeads: sec, maxLeadsPerHour: hr, maxLeadsThisRun: mx, webhookUrl: wh }); say('Settings saved'); };
    root.querySelector('#ex').onclick = () => {
      const day = new Date().toISOString().slice(0, 10);
      download(`insurance-updater-log-${day}.csv`, csv(S.get('aiu_log', []), ['When', 'Lead', 'Link', 'Milestone', 'Result', 'Fields set', 'Reason', 'Flags', 'Read-back']));
      setTimeout(() => download(`insurance-scope-log-${day}.csv`, csv(S.get('aiu_scopes', []), ['Lead', 'Link', 'Milestone', 'Carrier', 'Claim number', 'Date of loss', 'Scope file', 'Type of loss', 'Adjuster', 'Adjuster phone', 'Notes'])), 800);
      setTimeout(() => download(`insurance-needs-review-${day}.csv`, csv(S.get('aiu_review', []), ['Date', 'Lead', 'Link', 'Milestone', 'Why it needs a person', 'What the script filled'])), 1600);
    };
    root.querySelector('#cl').onclick = () => { if (confirm('Clear the logs and counts? (Leads already checked stay checked.)')) { S.set('aiu_log', []); S.set('aiu_scopes', []); S.set('aiu_review', []); S.set('aiu_counts', {}); render(); } };
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', panel); else panel();
})();
