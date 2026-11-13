// ==UserScript==
// @name         Enter Lead (GroupMe → AccuLynx)
// @namespace    amos-exteriors
// @version      5.7.7
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-lead.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-lead.user.js
// @description  Adds an "Enter Lead" button under every lead message in GroupMe. Click it to enter THAT lead into AccuLynx (Needs Confirmed, notes, photo, comments, @Me Mars 1 & 2) and reply "entering" to the lead message, and comment "entered" when finished.
// @match        https://web.groupme.com/*
// @match        https://my.acculynx.com/*
// @match        https://www.google.com/maps/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      groupme.com
// @connect      m.groupme.com
// @connect      i.groupme.com
// @connect      cdn2.groupme.com
// @connect      maps.googleapis.com
// @connect      streetviewpixels-pa.googleapis.com
// @connect      googleusercontent.com
// @connect      server.arcgisonline.com
// @connect      geocoding.geo.census.gov
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ===================== SETTINGS – change these ===================== */
  const CONFIG = {
    // false = fills the AccuLynx form and waits for YOU to click Save. true = clicks Save itself.
    autoSave: true,

    replyEntering: 'entering',
    replyEntered: 'entered',
    signatureComment: 'Claude',
    notifyUsers: [],                                          // no @Me tags any more – a TASK for Mars 1 is created instead
    taskTitle: 'Claude Automated Lead',                       // task created on every entered lead …
    taskAssignee: 'Mars 1 (Resets)',                          // … assigned to Mars 1 only

    assignTo: 'Needs Confirmed',
    workType: 'Retail',
    jobCategory: 'Residential',
    apptHours: 2,
    defaults: { first: 'NA', last: 'NA', phone: '1111111111', email: 'didnotget@gmail.com',
                street: '1 ave', city: 'Indianapolis', state: 'IN', zip: '46226' },

    googleStreetViewKey: '',          // optional – house picture
    imageWindowSeconds: 180,          // rep's photo within 3 minutes belongs to the lead
  };
  /* =================================================================== */

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const KEY_QUEUE = 'amos_lead_queue', KEY_ACTIVE = 'amos_active_lead';
  const norm = s => (s || '').toLowerCase().replace(/[^a-z]/g, '');

  /* ---------- no bot window: messages go to the console; problems pop up ---------- */
  function log(msg, warn) {
    console.log('[EnterLead]', msg);
    if (warn) showNote(msg, true);
  }
  // a small note at the top of the page (used for "click Save" and problems)
  function showNote(msg, warn) {
    let n = document.getElementById('amos-note');
    if (!n) {
      n = document.createElement('div'); n.id = 'amos-note';
      n.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:6px 14px;border-radius:6px;font:600 13px Arial;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer';
      n.title = 'click to close'; n.onclick = () => n.remove();
      document.body.appendChild(n);
    }
    n.style.background = warn ? '#b45309' : '#2563eb';
    n.textContent = msg;
  }
  async function waitFor(fn, timeout = 15000, step = 250) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ }
      await sleep(step);
    }
    return null;
  }

  /* ===================== LEAD PARSING ===================== */
  const titleCase = s => s.split(/(\s+)/).map(w => /^[A-Z][a-z]+[A-Z][a-z]+$/.test(w) ? w : w.toLowerCase().replace(/\b([a-z])/g, c => c.toUpperCase())).join('').replace(/\bAnd\b/g, 'and');   // keeps McDonald / DeWitt
  const PRODUCT_RE = /roof|storm|hail|hardie|hardi\b|vinyl siding|gutter|guard|gaurd|siding|sof+it+|fa[sc]+ia|\btrim\b|window|door|insulation|masonry/i;

  // GroupMe leaves invisible markers in pasted text (\uFFFC from attachments, zero-width and bidi marks).
  // They survive into names and file names, so scrub them before anything else looks at the message.
  const deGhost = t => (t || '').replace(/[\uFFFC\uFEFF\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  // Product Interest = only what the customer WANTS; clauses about what the home already has ("current roof is 20 years old") are dropped
  function interestOnly(t) {
    return String(t || '').split(/(?<=[.!?\n;])\s*/).filter(c => !/\b(current(ly)?|existing|already|has a|have a|had a|years? old|yrs? old|installed|replaced)\b/i.test(c) || /\b(want|wants|interested|needs?|replace|quote|estimate|est)\b/i.test(c)).join(' ');
  }
  function parseLead(text, repName) {
    text = deGhost(text).replace(/\b(\d{1,3}),(\d{3})\b(?!,\d)/g, "$1$2");   // "3,000 Main Street" → 3000
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const phoneRe = /(\(?\d{3}\)?[\s.\-]{0,3}\d{3}[\s.\-]{0,3}\d{4})/;
    const phoneLine = lines.findIndex(l => phoneRe.test(l));
    const streetLine = lines.findIndex(l => /^\d+\s+[a-z0-9]/i.test(l) && !phoneRe.test(l));
    if (phoneLine < 0 && streetLine > 0 && lines.length >= 3 && /\b(indiana|in)\b\.?\s*\d{5}|\b4\d{4}\b/i.test(text))
      return { noPhone: true, sender: repName, raw: text };                       // name + address but NO phone (phone only on the lead sheet)
    if (phoneLine < 0 || streetLine < 0) return parseDictatedLead(text, repName);   // JW Isaac style: one spoken sentence

    const lead = { sender: repName, raw: text, extra: [], products: [] };
    // name = the closest line ABOVE the street that isn't a phone or a product word ("Roof", "Gutters + guards"...)
    let nameLine = '';
    for (let i = streetLine - 1; i >= 0; i--) {
      const l = lines[i];
      const looksLikeDate = /\d{1,2}\/\d{1,2}|@\s*\d|\b\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(l) ||
        new RegExp('\\b(' + MONTHS.map(m => m.slice(0, 3)).join('|') + ')[a-z]*\\.?\\s+\\d', 'i').test(l);
      if (phoneRe.test(l) || looksLikeDate || (PRODUCT_RE.test(l) && l.split(/\s+/).length <= 5)) continue;
      nameLine = l; break;
    }
    let nmRaw = nameLine, nameExtra = '';
    if (/\//.test(nmRaw)) {
      const [left, ...rest] = nmRaw.split('/'); const right = rest.join('/').trim();
      // "Anna/ Tom Reed" = two people sharing the last name → "Anna and Tom Reed"
      if (/^[A-Za-z'.-]+$/.test(left.trim()) && /^[A-Za-z'.-]+(\s+[A-Za-z'.-]+)+$/.test(right) && !/^(mrs?|son|daughter|wife|husband)\b/i.test(right)) nmRaw = left.trim() + ' and ' + right;
      else { nameExtra = right; nmRaw = left; }
    }   // "Susana Bargis / Abraham (son)"
    { const sw = nmRaw.match(/\s+(spoke|spoken|talked|talk|met)\s+(with|to)\b.*$/i);                    // "Pat and Lee Smith spoke with Sam"
      if (sw) { nameExtra = (nameExtra ? nameExtra + ' ' : '') + sw[0].trim().replace(/^./, c => c.toUpperCase()) + '.'; nmRaw = nmRaw.slice(0, sw.index); } }
    nmRaw = nmRaw.replace(/\([^)]*\)/g, ' ');                                                                     // drop "(son)", "(wife)"...
    const nm = nmRaw.replace(/\s+@\s+/g, ' and ').replace(/\s*[,&+]\s*/g, ' and ').replace(/\s+/g, ' ').trim();
    const parts = nm.split(' ');
    lead.first = parts.length > 1 ? titleCase(parts.slice(0, -1).join(' ')) : CONFIG.defaults.first;
    lead.last = nm ? titleCase(parts[parts.length - 1]) : CONFIG.defaults.last;
    // rep re-posted the name as a correction ("Don't Lang" … "DON LANG"): a later name-only line with the same last name wins
    let fixLine = '';
    for (let i = lines.length - 1; i > streetLine; i--) {
      const l = lines[i];
      if (/^[A-Za-z'.-]+(?:\s+[A-Za-z'.-]+){1,2}$/.test(l) && !PRODUCT_RE.test(l) &&
          norm(l.split(/\s+/).pop()) === norm(lead.last) && norm(l) !== norm(nameLine)) { fixLine = l; break; }
    }
    if (fixLine) { const p = fixLine.trim().split(/\s+/); lead.first = titleCase(p.slice(0, -1).join(' ')); lead.last = titleCase(p[p.length - 1]); }
    lead.phone = lines[phoneLine].match(phoneRe)[1].replace(/\D/g, '');
    let addr = lines[streetLine];
    const next = lines[streetLine + 1] || '';
    if (next && !phoneRe.test(next) && (/(indiana|\bin\b|\d{5})/i.test(next) || KNOWN_CITIES.includes(next.toLowerCase().replace(/[.,]/g, '').trim()))) addr += ', ' + next;   // a bare city line ("Logansport")
    const zipLine = (lines[streetLine + 2] || '').trim();                     // the rep put the zip on a line of its own
    if (!/\b\d{5}\b/.test(addr.replace(/^\s*\d+/, '')) && /^\d{5}(-\d{4})?$/.test(zipLine)) addr += ' ' + zipLine;
    addr = addr.replace(/\b(?:cty|co|cnty)\.?\s*r(?:oa)?d\.?(?=\s*\d)/i, 'County Road');   // "123 N Cty Rd 500 E"
    addr = addr.replace(/([A-Za-z])\.(?=\s*,?\s*(?:IN\b\.?\s*)?\d{5}\b)/g, '$1');                  // "Anderson. 46013" → "Anderson 46013"
    lead.address = addr.replace(/\bindiana\b/i, 'IN').replace(/\s+/g, ' ');
    const zipAll = [...lead.address.matchAll(/\b(4\d{4})\b/g)].filter(m => m.index > 0); lead.zip = zipAll.length ? zipAll[zipAll.length - 1][1] : '';
    const email = text.match(/[A-Za-z0-9._%+-]*[A-Za-z][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/); lead.email = email ? email[0] : '';
    lead.appt = parseAppt(text) || parseSpokenAppt(text);
    // who each phone belongs to: "555-123-4567-Donna’s", "555-987-6543 - husband (main number)"
    const phoneLabel = l => l.replace(phoneRe, '').replace(/^[\s\-–:,(]+|[\s)]+$/g, '').replace(/[’']s\b/i, '').trim();
    lead.phoneLabel = phoneLabel(lines[phoneLine]);
    lead.phones2 = [];
    lines.forEach((l, i) => {
      if (i === phoneLine || i === streetLine || l === nameLine || (fixLine && l === fixLine) || (i === streetLine + 1 && addr.replace(/\./g, '').includes(l.replace(/\./g, '')))) return;
      if (/^\d{5}(-\d{4})?$/.test(l)) return;                                      // a bare zip line – already part of the address
      if (/^@?\s*\d{1,2}(:\d{2})?\s*(am?|pm?|a\.m\.|p\.m\.)\.?$/i.test(l)) return;      // a bare time line ("3pm") – already in the appointment
      if (phoneRe.test(l) && l.replace(phoneRe, '').trim().length < 30) {             // second phone number → contact + Mr/Mrs line, not Concerns
        lead.phones2.push({ num: l.match(phoneRe)[1].replace(/\D/g, ''), label: phoneLabel(l) }); return;
      }
      if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(l)) return;                               // email line → Email field only
      if ((/\d{1,2}\/\d{1,2}/.test(l) || /(?<![\d-])\d{1,2}-\d{1,2}(?![\d-])/.test(l) || /(?<![\d-])\d{1,2}-\d{1,2}-\d{2,4}(?!\d)/.test(l)) && l.length < 40) return;
      if (/^[a-z]{1,3}\d{0,2}$/i.test(l)) return;                                   // rep codes like "Zl1"
      if (new RegExp('^(' + MONTHS.map(m => m.slice(0, 3)).join('|') + ')[a-z]*\\.?\\s+\\d', 'i').test(l) && l.length < 40) return;
      if (PRODUCT_RE.test(l) && l.length < 60) {                                    // "130 sofit" → "sofit";  "Soffit/fascia Est" → "Soffit / Fascia"
        const clean = l.replace(/^\d{1,4}(:\d{2})?\s*(am|pm|a|p)?\s+/i, '').replace(/\b(?:est(?:imates?)?|quotes?|inspections?)\b\.?/ig, ' ').replace(/\s+/g, ' ').trim();
        const parts = clean.split(/\s*(?:\/|,|\+|&|\band\b)\s*/i).map(x => x.trim()).filter(Boolean);
        lead.products.push(parts.length > 1 && parts.every(x => x.length < 25) ? parts.map(titleCase).join(' / ') : (clean || l)); return; }
      const em = l.match(/[A-Za-z0-9._%+-]*[A-Za-z][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/);
      if (em) { l = l.replace(em[0], '').replace(/^[\s.,;:\-]+/, '').trim(); if (!l) return; }      // email goes in the Email field only
      lead.extra.push(l);
    });
    // "Pat Lee/Mrs." → the wife is on the lead (Mrs line), not a note in Concerns
    if (/^(mrs?|mr\.? ?& ?mrs)\.?$/i.test(nameExtra.trim())) { lead.spouseTag = /mrs/i.test(nameExtra) ? 'mrs' : 'mr'; nameExtra = ''; }
    if (nameExtra) lead.extra.unshift('Also: ' + nameExtra);
    // product named inside a sentence ("Three windows are busted out") – still pick it up
    if (!lead.products.length) {
      const words = []; const t2 = interestOnly(text);
      if (/roof/i.test(t2)) words.push('Roof');
      if (/gutter|guard|gaurd/i.test(t2)) words.push('Gutters');
      if (/siding|hardie|\bhardi\b/i.test(t2)) words.push('Siding');
      if (/window/i.test(t2)) words.push('Windows');
      if (/\bdoors?\b/i.test(t2)) words.push('Doors');
      if (/sof+it+|fa[sc]+ia|\btrim\b/i.test(t2)) words.push('Soffit/Fascia/Trim');
      if (words.length) lead.products.push(words.join(', '));
    }
    lead.productText = lead.products.join(' / ') || 'NA';
    return lead;
  }

  /* ---- dictated / one-sentence lead (e.g. "Jane Smith 123 North Main Street Springfield Indiana 46000 phone number 555-123-4567 ... Friday October 30th at noon") ---- */
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const SW = 'street|st|road|rd|drive|dr|lane|ln|avenue|ave|court|ct|circle|cir|way|boulevard|blvd|place|pl|trail|trl|parkway|pkwy|highway|hwy|pike|terrace|ter|loop|run|cove|cv|bend|point|pt|path|square|sq';
  function parseDictatedLead(text, repName) {
    text = deGhost(text).replace(/\b(\d{1,3}),(\d{3})\b(?!,\d)/g, "$1$2");   // "3,000 Main Street" → 3000
    // drop any header line GroupMe may leave in ("JI", "James Isaac12:36 PM") before flattening
    const flat = text.split(/\r?\n/).filter(l => l.trim() && !/^[A-Z]{1,3}$/.test(l.trim()) && !/^[a-z]{1,3}\d{1,2}$/i.test(l.trim()) && !/(\d{1,2}:\d{2}\s*[AP]M|Just now|Yesterday)\s*$/i.test(l.trim()))
                     .join(' ').replace(/\s+/g, ' ').trim();
    const phoneRe = /(\(?\d{3}\)?[\s.\-]{0,3}\d{3}[\s.\-]{0,3}\d{4})/;
    const phoneM = flat.match(phoneRe);
    // address = "<number> <words...> <City> Indiana <zip?>"  OR  "<number> <words> <StreetWord>"
    const addrM = flat.match(/\b(\d{2,6})\s+([A-Za-z0-9 .'\-]{3,80}?)\s+(Indiana|\bIN\b)\b\.?\s*(\d{5})?/i) ||
                  flat.match(new RegExp('\\b(\\d{2,6})\\s+([A-Za-z .\'\\-]{3,50}?\\b(?:' + SW + '))\\b', 'i'));
    if (!phoneM || !addrM) return null;
    if (flat.length < 40) return null;

    const lead = { sender: repName, raw: text, extra: [], products: [], dictated: true };
    lead.phone = phoneM[1].replace(/\D/g, '');

    // name = everything before the street number (drop header lines like "JI" / "James Isaac12:36 PM")
    let namePart = flat.slice(0, addrM.index).replace(/\b[A-Z]{2}\b\s*/g, '').replace(/[A-Za-z ]+\d{1,2}:\d{2}\s*[AP]M/gi, '').trim();
    // spelled-out letters ("John Smyth s m i t h") are the CORRECT spelling of the word just before them → use them
    namePart = namePart.replace(/(\S+)\s+([a-z](?: [a-z]){2,})\b/gi, (all, word, letters) => titleCase(letters.replace(/ /g, '')))
                       .replace(/\b[a-z](?: [a-z]){2,}\b/gi, '')                // any leftover spelled letters
                       .replace(/\s*(,|&|\+|\band\b)\s*/gi, ' and ').replace(/\s+/g, ' ').trim();
    namePart = namePart.replace(/\s+(?:they|she|he|we)?\s*(?:live|lives|living|reside|resides)(?:\s+at)?$/i, '').replace(/\s+(?:address\s+is|located\s+at|at)$/i, '').trim();   // "… Smith they live at"
    namePart = namePart.replace(/^(\S+)\s+(\S+)\s+and\s+(\S+)\s+\2$/i, '$1 and $3 $2');       // "Pat Smith and Lee Smith" → "Pat and Lee Smith"
    const parts = namePart.split(' ').filter(Boolean);
    lead.first = parts.length > 1 ? titleCase(parts.slice(0, -1).join(' ')) : (parts[0] ? titleCase(parts[0]) : CONFIG.defaults.first);
    lead.last = parts.length ? titleCase(parts[parts.length - 1]) : CONFIG.defaults.last;

    // address pieces
    let street = (addrM[1] + ' ' + addrM[2]).trim().replace(/^(\d{1,3})\s+(\d{1,3})(?=\s+[A-Za-z])/, '$1$2')   /* spoken "11 12 dellwood" → 1112 */, city = '', zip = addrM[4] || (flat.match(/\b(4\d{4})\b/) || [])[1] || '';
    if (addrM[3]) {
      // split "North Main Street Springfield" → street / city at the last street word
      const sw = street.match(new RegExp('^(.*?\\b(?:' + SW + '))\\b\\.?\\s+(.+)$', 'i'));
      if (sw) { street = sw[1].trim(); city = sw[2].trim(); }
      else { const w = street.split(' '); city = w.pop(); street = w.join(' '); }
    }
    lead.address = titleCase(street) + (city ? ', ' + titleCase(city) : '') + ', IN' + (zip ? ' ' + zip : '');
    lead.zip = zip;
    const email = flat.match(/[A-Za-z0-9._%+-]*[A-Za-z][A-Za-z0-9._%+-]*@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/); lead.email = email ? email[0] : '';

    // everything after the phone number = the write-up
    const after = flat.slice(flat.indexOf(phoneM[1]) + phoneM[1].length).replace(/^\s*(phone number|number|cell)?\s*/i, '').trim();
    lead.appt = parseAppt(after) || parseSpokenAppt(after);
    const afterP = interestOnly(after), prod = [];
    if (/roof/i.test(afterP)) prod.push('Roof');
    if (/gutter/i.test(afterP)) prod.push('Gutters');
    if (/siding|hardie|\bhardi\b/i.test(afterP)) prod.push('Siding');
    if (/window/i.test(afterP)) prod.push('Windows');
    if (/door/i.test(afterP)) prod.push('Doors');
    if (/sof+it+|fa[sc]+ia/i.test(afterP)) prod.push('Soffit/Fascia');
    lead.productText = prod.join(' / ') || 'NA';
    // Concerns: a short line of its own that is only the appointment ("GUTTER EST. WED 11/25/@2PM") is already in the
    // appointment and the products – leave it out; sentences that mention a date stay as written
    const pAt = text.indexOf(phoneM[1]);
    const afterLines = pAt >= 0 ? text.slice(pAt + phoneM[1].length).split(/\r?\n/).map(l => l.trim()).filter(Boolean) : [after];
    if (afterLines.length) afterLines[0] = afterLines[0].replace(/^\s*(phone number|number|cell)?\s*/i, '').trim();
    const apptOnly = l => l.length < 40 && (/\d{1,2}\/\d{1,2}/.test(l) || new RegExp('\\b(' + MONTHS.map(m => m.slice(0, 3)).join('|') + ')[a-z]*\\.?\\s+\\d', 'i').test(l));
    const concern = afterLines.length > 1 ? afterLines.filter(l => !apptOnly(l)).join(' ').replace(/\s+/g, ' ').trim() : after;
    if (concern) lead.extra.push(concern);
    return lead;
  }
  // "Friday October 30th at noon", "October 7th at 4:00 p.m.", "Saturday 10:31 at 10:00 a.m." (10.31 → 10/31)
  function parseSpokenAppt(t) {
    const now = new Date();
    let date = null;
    // "630 tomorrow", "today at 4", "tomorrow 5:30" – relative day + a time written next to it
    const rel = t.match(/\b(today|tonight|tomorrow|tmrw|tmr)\b/i);
    if (rel) {
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (/^t(omorrow|mrw|mr)$/i.test(rel[1]) ? 1 : 0));
      const near = t.match(new RegExp('(?:@\\s*|\\bat\\s+)?\\b(\\d{1,2})(?::(\\d{2})|(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|a|p)?\\s*(?=' + rel[1] + ')', 'i')) ||
                   t.match(new RegExp(rel[1] + '\\s*(?:@|at)?\\s*(\\d{1,2})(?::(\\d{2})|(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?|a|p)?(?![\\d/])', 'i'));
      if (near && +near[1] >= 1 && +near[1] <= 12) {
        let h = +near[1]; const m = +(near[2] || near[3] || 0); const ap = (near[4] || '').toLowerCase();
        if (ap.startsWith('p') && h < 12) h += 12; else if (ap.startsWith('a') && h === 12) h = 0; else if (!ap && h >= 1 && h <= 7) h += 12;
        if (/tonight/i.test(rel[1]) && h < 12) h += 12;
        return { date, hasTime: true, h, m };
      }
      if (/tonight/i.test(rel[1])) return { date, hasTime: false };
      // fall through: maybe "tomorrow at 4" handled below
    }
    if (date) {
      const tm0 = t.match(/(?:\bat\b|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?(?![a-z])/i);
      if (!tm0) return { date, hasTime: false };
    }
    const m1 = t.match(new RegExp('\\b(' + MONTHS.map(m => m.slice(0, 3) + '(?:' + m.slice(3) + ')?').join('|') + ')\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b', 'i'));
    const m2 = t.match(/\b(\d{1,2})[.:](\d{1,2})\b(?=\s+(?:at|@)\s)/i);          // "10:31 at 10:00" → 10/31
    if (date) { /* relative day already set */ }
    else if (m1) { date = new Date(now.getFullYear(), MONTHS.findIndex(m => m.startsWith(m1[1].toLowerCase().slice(0, 3))), +m1[2]); }
    else if (m2 && +m2[1] <= 12 && +m2[2] <= 31) { date = new Date(now.getFullYear(), +m2[1] - 1, +m2[2]); }
    else {
      const wd = t.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
      if (!wd) return null;
      const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
      date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      do { date.setDate(date.getDate() + 1); } while (date.getDay() !== days.indexOf(wd[1].toLowerCase()));
    }
    if (date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) date.setFullYear(date.getFullYear() + 1);
    if (/\bnoon\b/i.test(t)) return { date, hasTime: true, h: 12, m: 0 };
    const tm = t.match(/(?:\bat\b|@)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?|a|p)?(?![a-z])/i) ||
               (m1 && t.slice(t.indexOf(m1[0]) + m1[0].length).match(/^[\s,]*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/i)) ||   // "November 5 3 PM"
               t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.m\.|p\.m\.|am|pm)\b/i);                                                     // "3 PM" anywhere
    if (!tm) return { date, hasTime: false };
    let h = +tm[1], m = tm[2] ? +tm[2] : 0;
    const ap = (tm[3] || '').toLowerCase().replace(/\./g, '');
    if (ap.startsWith('p') && h < 12) h += 12;
    else if (ap.startsWith('a') && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 7) h += 12;
    return { date, hasTime: true, h, m };
  }
  function parseAppt(text) {
    const d = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/) ||
              text.match(/(?<![\d-])(1[0-2]|0?[1-9])-([12]\d|3[01]|0?[1-9])-(\d{2,4})(?!\d)/) ||     // "11-17-26"
              text.match(/(?<![\d-])(1[0-2]|0?[1-9])-([12]\d|3[01]|0?[1-9])(?![\d-])()/);   // "11-7"
    if (!d) return null;
    const now = new Date();
    let yr = d[3] ? (+d[3] < 100 ? 2000 + +d[3] : +d[3]) : 0;
    if (yr && yr < now.getFullYear()) yr = 0;                      // a typo like "11-4-16" is not 2016 – use the next such date
    const year = yr || now.getFullYear();
    const date = new Date(year, +d[1] - 1, +d[2]);
    if (!yr && date < new Date(now.getFullYear(), now.getMonth(), now.getDate())) date.setFullYear(year + 1);
    const t = text.match(/(?:@|\bat\b)\s*(\d{1,4})(?::(\d{2}))?\s*(am|pm|a|p)?/i) ||
              text.match(/\b(\d{1,4})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?![a-z])/i);      // "330 pm" with no @
    if (!t) {
      // bare time just after the date: "11/3  130", "11/3\n1:30", "11-7 230" (no am/pm → 1–7 = PM)
      const after = text.slice(text.indexOf(d[0]) + d[0].length);
      const b = after.match(/^[\s,.]*(?:@\s*)?(\d{1,2}):?(\d{2})?(?!\d)/) || after.match(/^[\s,.]*(\d{1,2})(\d{2})(?!\d)/);
      if (b && +b[1] >= 1 && +b[1] <= 12 && (!b[2] || +b[2] < 60) && (b[2] || /^\s*@/.test(after))) {
        let h = +b[1]; const m = b[2] ? +b[2] : 0; if (h >= 1 && h <= 7) h += 12;
        return { date, hasTime: true, h, m };
      }
      return { date, hasTime: false };
    }
    let h = +t[1], m = t[2] ? +t[2] : 0;
    if (t[1].length > 2) { h = Math.floor(+t[1] / 100); m = +t[1] % 100; }
    const ap = (t[3] || '').toLowerCase();
    if (ap.startsWith('p') && h < 12) h += 12;
    else if (ap.startsWith('a') && h === 12) h = 0;
    else if (!ap && h >= 1 && h <= 7) h += 12;
    return { date, hasTime: true, h, m };
  }
  // "123 Oak Dr, Springfield 46000" / "456 elm drive anytown IN 46001" / "789 Maple Court, Springfield, IN 46002"
  const KNOWN_CITIES = ['indianapolis','indpls','indy','ind','greenwood','avon','carmel','fishers','noblesville','plainfield','brownsburg','mooresville','martinsville','franklin','shelbyville','lafayette','west lafayette','kokomo','anderson','muncie','columbus','bloomington','zionsville','westfield','lawrence','beech grove','speedway','whiteland','new palestine','greenfield','pendleton','danville','lebanon','logansport','richmond','batesville','attica','covington','veedersburg','crawfordsville','tipton','elwood','frankfort','seymour','north vernon','terre haute','evansville','fort wayne','marion','peru','wabash'];
  function splitAddress(addr) {
    let a = (addr || '').replace(/\s+/g, ' ').trim();
    // zip = the LAST 5-digit number that isn't the house number at the start ("12345 Oak Dr., Carmel, IN 46033")
    const zips = [...a.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)].filter(m => m.index > 0);
    const zm = zips.length ? zips[zips.length - 1] : null;
    const zip = zm ? zm[1] : '';
    if (zm) a = a.slice(0, zm.index) + a.slice(zm.index + zm[0].length);
    a = a.replace(/,?\s*\b(Indiana|IN)\b\.?/i, '').replace(/[,\s]+$/, '').trim();
    let street = a, city = '';
    if (a.includes(',')) { const p = a.split(',').map(x => x.trim()).filter(Boolean); street = p[0]; city = p[1] || ''; }
    else {
      const m = a.match(new RegExp('^(.*?\\b(?:' + SW + '))\\b\\.?\\s+(.+)$', 'i'));
      if (m) { street = m[1].trim(); city = m[2].trim(); }
      else {
        // no street word ("5245 southeastern indianapolis") → split off a known city name at the end
        const KNOWN = KNOWN_CITIES;
        const k = KNOWN.filter(c => new RegExp('\\s' + c + '$', 'i').test(a)).sort((x, y) => y.length - x.length)[0];
        if (k) { city = a.slice(a.length - k.length).trim(); street = a.slice(0, a.length - k.length).trim(); }
      }
    }
    const CITY_FIX = { indpls: 'Indianapolis', indy: 'Indianapolis', ind: 'Indianapolis', indpl: 'Indianapolis', indianapolis: 'Indianapolis', 'w lafayette': 'West Lafayette', 'n vernon': 'North Vernon' };
    city = CITY_FIX[city.toLowerCase().replace(/\./g, '').trim()] || city;
    return { street: titleCase(street), city: titleCase(city), zip };
  }
  function tradesFor(lead) {
    const t = lead.productText.toLowerCase(), out = [];
    if (/roof|storm|hail/.test(t) || (/inspection/.test(t) && !/gutter|siding|window|door|soffit|fascia|insulation|masonry/.test(t))) out.push('Roofing');
    if (/gutter|guard|gaurd|\bg\.?\s*s\.?\s*f\b/.test(t)) out.push('Gutters');
    if (/sof+it+|fa[sc]+ia|\btrim\b|\bg\.?\s*s\.?\s*f\b/.test(t)) out.push('Fascia and Soffit');
    if (/siding|hardie|\bhardi\b/.test(t)) out.push('Siding / Soffit / Fascia');
    if (/window|door/.test(t)) out.push('Doors / Windows');
    if (/insulation/.test(t)) out.push('Insulation');
    if (/masonry/.test(t)) out.push('Masonry');
    return out.length ? out : ['Repairs'];
  }
  // Mrs / Mr lines: use the phone labels ("wife", "husband", "Donna’s"); any number we can't place goes on Mr or Mrs as "Name 765-…"
  function mrMrs(lead) {
    const fmt = n => n.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    const all = [{ num: lead.phone, label: lead.phoneLabel || '' }, ...(lead.phones2 || [])].filter(p => p.num && p.label);
    let mrs = '', mr = '';
    for (const p of all) {
      const who = /wife|mrs|\bher\b/i.test(p.label) ? 'mrs' : /husband|\bmr\b|\bhis\b/i.test(p.label) ? 'mr' : '';
      const nm = p.label.replace(/\b(wife|husband|mrs?|main number|main|cell|home|number)\b|[()]/gi, '').trim();
      const txt = (nm ? titleCase(nm) + ' ' : '') + fmt(p.num) + (/main/i.test(p.label) ? ' (main)' : '');
      if (who === 'mrs') mrs = txt; else if (who === 'mr') mr = txt;   // only when the rep said wife/husband – never guess from a first name
    }
    if (lead.spouseTag === 'mrs') { if (!mrs) mrs = 'Mrs. ' + lead.last; if (!mr) mr = lead.first + ' ' + lead.last; }
    if (lead.spouseTag === 'mr')  { if (!mr) mr = 'Mr. ' + lead.last; if (!mrs) mrs = lead.first + ' ' + lead.last; }
    return ['Mrs: ' + mrs, 'Mr: ' + mr].map(l => l.trimEnd());
  }
  // phones labelled only by a first name ("Donna’s") → listed in Concerns so nothing is lost
  function namedPhones(lead) {
    const fmt = n => n.replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    return [{ num: lead.phone, label: lead.phoneLabel || '' }, ...(lead.phones2 || [])]
      .filter(p => p.num && p.label && !/wife|husband|\bmrs?\b|\bher\b|\bhis\b/i.test(p.label))
      .map(p => titleCase(p.label.replace(/[()]/g, '').trim()) + ' ' + fmt(p.num));
  }
  // "Roof (17 years old)" / "roof is 20 yrs" -> Age of Product
  function ageOf(lead) {
    const m = (lead.raw || '').match(/\b(\d{1,3})\s*(?:\+)?\s*(?:years?|yrs?|yr)\b(?:\s*old)?/i);
    return m ? m[1] + ' years old' : '';
  }
  // marketer says "call Monday" / "call tomorrow at 3" → that day at 6 AM (the time they ask for is ignored, only noted)
  function callRequest(lead) {
    const m = (lead.raw || '').match(/\bcall\b[^.\n]{0,30}?\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tmrw|today)\b[^.\n]*/i);
    return m ? m[0].replace(/\s+/g, ' ').trim() : '';
  }
  function callDate(lead) {
    const m = (lead.raw || '').match(/\bcall\b[^.\n]{0,30}?\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|tmrw|today)\b/i);
    if (!m) return null;
    const now = new Date(), d = new Date(now.getFullYear(), now.getMonth(), now.getDate()), w = m[1].toLowerCase();
    if (w === 'today') return d;
    if (/^t(omorrow|mrw)$/.test(w)) { d.setDate(d.getDate() + 1); return d; }
    const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    do { d.setDate(d.getDate() + 1); } while (d.getDay() !== days.indexOf(w));
    return d;
  }
  // CTS (call to schedule) default: 6 AM the next day, never Sunday
  function nextWorkDay() {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0);
    return d;
  }
  // blank when unknown – never "NA" (Andrew's rule)
  function notesFor(lead) {
    const v = x => (x && !/^na$/i.test(String(x).trim())) ? String(x).trim() : '';
    const concerns = callRequest(lead);                          // Concerns is never filled – only a marketer's "call <day>" request goes in the notes
    return [
      'Lead Source: ' + (lead.leadSource || 'Field Marketing: ' + lead.sender),
      'Product Interest: ' + v(lead.productText),
      'Current Product Material: ',
      'Current Issues/Concerns: ' + v(concerns),
      'Age of Product: ' + v(ageOf(lead)), 'Year of Home Built: ', 'Year Home was Purchased: ', 'Style of Home: ',
      'Email: ' + v(lead.email), 'Work Schedules', ...mrMrs(lead),
    ].map(l => l.trimEnd()).join('\n');
  }

  /* ===================== GROUPME: "Enter Lead" button on lead messages ===================== */
  // Chat list rows: <div data-chat-id data-unread="true|false"> … <button data-chat-open-button title="Chat Name">
  const chatRows = () => [...document.querySelectorAll('div[data-chat-id][data-unread]')];
  const rowName = r => { const b = r.querySelector('[data-chat-open-button]'); return b ? (b.getAttribute('title') || b.innerText || '').trim() : ''; };
  const currentChatId = () => (location.pathname.match(/\/chats\/(?:group|dm)\/(\d+)/) || [])[1];
  const currentChatName = () => {
    const r = chatRows().find(x => x.getAttribute('data-chat-id') === currentChatId());
    return r ? rowName(r) : (document.title.split('|').pop() || '').trim();
  };

  // messages in the open chat
  const gmMessages = () => [...document.querySelectorAll('[data-message-id]')];
  function gmSender(node) {
    let n = node;
    while (n) {
      const b = n.querySelector && n.querySelector('[data-profile-button]');
      if (b) return (b.getAttribute('aria-label') || b.innerText).replace(/\s*profile\s*$/i, '').trim();
      n = n.previousElementSibling;
    }
    return '';
  }
  // the typed text block of a message (plain message OR caption typed with a photo).
  // Looks for GroupMe's text marker first; if missing, takes the biggest text block that isn't a quote/header.
  function gmTextEl(node) {
    const direct = node.querySelector('[data-text-message-content]') || node.querySelector('[data-large-emoji]');
    if (direct) return direct;
    const blocks = [...node.querySelectorAll('p,div,span')].filter(e =>
      e.children.length <= 12 && e.innerText && e.innerText.trim().split('\n').length >= 3 &&
      !e.closest('[data-reply-quote-content],[data-message-reply],[data-profile-button]') &&
      !e.querySelector('img'));
    blocks.sort((a, b) => b.innerText.length - a.innerText.length);
    return blocks[0] || null;
  }
  function gmText(node) {
    const c = gmTextEl(node);
    if (!c) return '';
    // read the LIVE element (a detached copy loses its line breaks); drop quoted-reply / header text
    const skip = [...c.querySelectorAll('[data-reply-quote-content],[data-message-reply],[data-profile-button]')].map(x => x.innerText.trim()).filter(Boolean);
    let text = c.innerText;
    for (const q of skip) text = text.replace(q, '');
    return text.split('\n').map(l => l.trim()).filter(l => l && !/(\d{1,2}:\d{2}\s*(AM|PM)|Just now|Yesterday)$/i.test(l)).join('\n');
  }
  function gmImage(node) {
    const img = [...node.querySelectorAll('img')].find(i => /m\.groupme\.com\/uploads|i\.groupme\.com\/\d+x\d+/.test(i.src) &&
      !i.closest('[data-profile-button],[data-reply-quote-content],[data-message-reply]'));
    if (!img || !/m\.groupme\.com\/uploads|i\.groupme\.com/.test(img.src)) return '';
    return img.src.replace(/\.preview$/, '');
  }
  async function gmSend(text) {
    // GroupMe's [data-chat-compose-contenteditable] is now a WRAPPER – type into the real editable box inside it
    const wrap = document.querySelector('[data-chat-compose-contenteditable]');
    const box = (wrap && (wrap.matches('[contenteditable="true"]') ? wrap : wrap.querySelector('[contenteditable="true"], textarea'))) ||
                document.querySelector('[role="textbox"][contenteditable="true"]');
    if (!box) { log('Could not find the GroupMe message box', true); return false; }
    const boxText = () => (box.value !== undefined && box.tagName === 'TEXTAREA' ? box.value : box.innerText).trim();
    box.focus();
    document.execCommand('insertText', false, text);
    await sleep(400);
    if (!boxText().includes(text)) {                                   // typing didn't take – never pretend it posted
      log('Could not type "' + text + '" into GroupMe – post it by hand', true); return false;
    }
    // GroupMe ignores a script-made Enter key – click its real "Send message" button
    const send = await waitFor(() => { const b = document.querySelector('button[aria-label="Send message"]'); return b && !b.disabled ? b : null; }, 3000);
    if (send) send.click();
    else box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    const ok = await waitFor(() => !boxText(), 5000);
    if (!ok) log('"' + text + '" may not have posted in GroupMe – check the thread', true);
    await sleep(500);
    return !!ok;
  }
  // "entering" as a REPLY to the lead message, so the team (and the audit) can see which lead is being entered.
  // GroupMe only draws its hover toolbar for a real mouse, but focusing the message's inner box shows the same "Reply to message" button.
  async function gmReplyTo(msgId, text) {
    const node = document.querySelector('[data-message-id="' + msgId + '"]');
    if (node) {
      node.scrollIntoView({ block: 'center' }); await sleep(400);
      const cand = [...node.querySelectorAll('[tabindex]'), node, ...node.querySelectorAll('div')].slice(0, 15);
      let reply = null;
      for (const e of cand) {
        try { e.focus({ preventScroll: true }); } catch (_) {}
        e.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        reply = await waitFor(() => { const b = node.querySelector('button[aria-label="Reply to message"]'); return b && b.offsetParent ? b : null; }, 700);
        if (reply) break;
      }
      if (reply) {
        reply.click();
        // GroupMe shows a "Cancel reply to <name>" chip above the box once the reply is armed – only then type and send
        const armed = await waitFor(() => document.querySelector('button[aria-label^="Cancel reply to"]'), 3000);
        if (armed) { if (await gmSend(text)) return true; }
      }
    }
    log('Could not reply to the lead message – posting "' + text + '" without a reply; reply to it by hand', true);
    return gmSend(text);
  }
  async function openChat(chatId) {
    if (currentChatId() === chatId) return true;
    const row = chatRows().find(r => r.getAttribute('data-chat-id') === chatId);
    const btn = row && row.querySelector('[data-chat-open-button]');
    if (!btn) return false;
    btn.click();
    return !!await waitFor(() => currentChatId() === chatId && gmMessages().length, 10000);
  }


  // When "Enter Lead" is clicked on a message
  async function enterLead(node, btn) {
    // the CHAT TITLE is often a nickname or an autocorrect ("Melon Tea Keller"); the message's own
    // sender name is the rep's real name, so use that first and keep the title as a fallback.
    const chatName = currentChatName();
    const repName = gmSender(node) || chatName;
    let text = gmText(node);
    {   // add the same rep's follow-up text messages (e.g. "11/9" then "330 pm") until someone else posts
      const all = gmMessages(), i0 = all.indexOf(node), who = gmSender(node);
      for (let j = i0 + 1; j < Math.min(all.length, i0 + 4); j++) {
        if (gmSender(all[j]) !== who) break;
        const t2 = gmText(all[j]);
        if (!t2) continue;                                  // the photo
        if (parseLead(t2, 'x')) break;                       // that's the next lead, not a follow-up
        if (t2.length < 600) text += '\n' + t2;          // short fixes AND longer notes ("This is an inspection for Brenton's roof...")
      }
    }
    let lead = text ? parseLead(text, repName) : null;
    if (lead) lead.chatName = chatName;
    if (!lead && gmImage(node)) {                      // lead sheet photo with no typed lead
      lead = { sender: repName, chatName: chatName, raw: '(lead sheet photo – no typed lead)', extra: [], products: [], productText: 'NA',
               first: 'NA', last: 'NA', phone: '', email: '', address: '', zip: '', appt: null, photoOnly: true };
    }
    if (!lead) { log('That message does not look like a lead.', true); return; }
    if (lead.noPhone) { log('No phone number in the post – read it from the lead sheet photo and enter this lead by hand (or ask the rep to post the phone).', true); return; }
    {   // a second click while THIS lead is still being entered would make a duplicate job – ignore it
      const lid = 'L' + node.getAttribute('data-message-id');
      const q0 = GM_getValue(KEY_QUEUE, {}) || {};
      const busy = (q0[lid] && Date.now() - (q0[lid].queuedAt || 0) < 5 * 60e3) || (GM_getValue(KEY_ACTIVE) === lid && Date.now() - GM_getValue('amos_active_t', 0) < 3 * 60e3);
      if (busy || btn.dataset.running === '1') { log('Already entering this lead – wait for it to finish', true); btn.textContent = 'Already entering…'; return; }
      btn.dataset.running = '1'; setTimeout(() => { btn.dataset.running = ''; }, 15000);
    }
    btn.disabled = true; btn.textContent = 'Entering…';
    log('Lead: ' + lead.first + ' ' + lead.last + ' (' + repName + ')');
    await gmReplyTo(node.getAttribute('data-message-id'), CONFIG.replyEntering);
    // lead sheet photo from the same rep, posted just before or after
    const minOf = m => { const x = ((m.innerText || '').match(/(\d{1,2}):(\d{2})\s*([AP])M/i) || []); return x[1] ? ((+x[1] % 12) + (/p/i.test(x[3]) ? 12 : 0)) * 60 + +x[2] : null; };   // message time in minutes
    const msgs = gmMessages(), i = msgs.indexOf(node), sender = gmSender(node);
    lead.imageUrl = gmImage(node);                 // photo in the same message, if any
    // the rep's photo nearest to the lead text: look both ways (other people's replies are skipped),
    // never past the rep's own next/previous text (that photo belongs to another lead). Closer wins; a tie goes to the photo BEFORE.
    if (!lead.imageUrl) {
      let fwd = null, back = null;
      for (let j = i + 1, n = 0; j < Math.min(msgs.length, i + 6); j++) {
        if (gmSender(msgs[j]) !== sender) continue; n++;
        const im = gmImage(msgs[j]); if (im) { fwd = { url: im, d: n, t: minOf(msgs[j]) }; break; }
        if (gmText(msgs[j])) break;
      }
      for (let j = i - 1, n = 0; j >= Math.max(0, i - 6); j--) {
        if (gmSender(msgs[j]) !== sender) continue; n++;
        if (gmText(msgs[j]) && !gmImage(msgs[j])) break;
        const im = gmImage(msgs[j]);
        if (im) {
          // a photo posted right AFTER another lead's text belongs to THAT lead (text, then its sheet) – don't steal it
          let prevIsLead = false;
          for (let k = j - 1; k >= Math.max(0, j - 4); k--) {
            if (gmSender(msgs[k]) !== sender) continue;
            const pt = gmText(msgs[k]);
            if (pt && !gmImage(msgs[k]) && parseLead(pt, 'x')) {
              // …unless that earlier lead already has its own photo just before it (rep posts photo-then-text)
              let hasOwn = false;
              for (let q = k - 1; q >= Math.max(0, k - 4); q--) { if (gmSender(msgs[q]) !== sender) continue; hasOwn = !!gmImage(msgs[q]) && !gmText(msgs[q]); break; }
              prevIsLead = !hasOwn;
            }
            break;
          }
          if (!prevIsLead) back = { url: im, d: n, t: minOf(msgs[j]) };
          break;
        }
      }
      // when both exist, the one posted CLOSER IN TIME wins (a text posted 4:41 and a photo posted 4:41 beat a photo from 4:16)
      const t0 = minOf(node);
      let pick = (fwd && (!back || fwd.d < back.d)) ? fwd : back;
      if (fwd && back && t0 != null && fwd.t != null && back.t != null) pick = Math.abs(fwd.t - t0) < Math.abs(back.t - t0) ? fwd : back;
      lead.imageUrl = pick ? pick.url : '';
    }
    if (!lead.imageUrl) {
      // reps often send the photo a moment AFTER the text – wait for it (up to imageWindowSeconds)
      btn.textContent = 'Waiting for lead sheet photo…';
      const id = node.getAttribute('data-message-id');
      lead.imageUrl = await waitFor(() => {
        const all = gmMessages(), k = all.findIndex(m => m.getAttribute('data-message-id') === id);
        for (let j = k + 1; j < all.length; j++) if (gmSender(all[j]) === sender && gmImage(all[j])) return gmImage(all[j]);
        return '';
      }, CONFIG.imageWindowSeconds * 1000, 2000) || '';
      if (!lead.imageUrl) log('No lead sheet photo arrived – entering without it.', true);
    }
    lead.id = 'L' + node.getAttribute('data-message-id'); lead.chatId = currentChatId();
    // a re-click is a fresh run: forget anything left from the last attempt on this message
    ['amos_filled_', 'amos_step_', 'amos_comments_done_', 'amos_task_done_', 'amos_done_', 'amos_problems_'].forEach(k => GM_deleteValue(k + lead.id));
    if (GM_getValue(KEY_ACTIVE) === lead.id) GM_deleteValue(KEY_ACTIVE);
    if (lead.appt) lead.appt.date = lead.appt.date.toISOString();
    lead.queuedAt = Date.now(); const q = GM_getValue(KEY_QUEUE, {}); q[lead.id] = lead; GM_setValue(KEY_QUEUE, q);
    GM_setValue('amos_clicked_' + lead.id, true);
    // if an older lead is still marked "active" but its tab is long gone, don't let it block this one
    const act = GM_getValue(KEY_ACTIVE);
    if (act && (!q[act] || Date.now() - GM_getValue('amos_active_t', 0) > 3 * 60e3)) GM_deleteValue(KEY_ACTIVE);
    btn.textContent = 'Sent to AccuLynx…';
    log('Sent to AccuLynx' + (lead.imageUrl ? ' with photo' : ''));
    dispatchTick();
  }

  // an "Enter Lead" button under EVERY lead message in whatever chat is open
  /* ---------- per-thread "Leads" switch ---------- */
  const leadsOn = id => (GM_getValue('amos_lead_threads', []) || []).includes(id);
  function paintLeadToggle() {
    const id = currentChatId();
    let t = document.getElementById('amos-lead-toggle');
    if (!id) { if (t) t.remove(); return; }
    if (!t) {
      t = document.createElement('button'); t.id = 'amos-lead-toggle';
      t.style.cssText = 'position:fixed;top:14px;right:110px;z-index:2147483647;padding:4px 10px;border:0;border-radius:12px;font:600 12px Arial;color:#fff;cursor:pointer';
      t.onclick = () => {
        const cur = currentChatId(), list = GM_getValue('amos_lead_threads', []) || [];
        GM_setValue('amos_lead_threads', leadsOn(cur) ? list.filter(x => x !== cur) : [...list, cur]);
        document.querySelectorAll('.amos-enter-btn').forEach(x => x.remove());   // redraw buttons
        t.dataset.chat = '';
        paintLeadToggle(); addButtons();
      };
      document.body.appendChild(t);
    }
    // sit right next to the CONF badge (another script's button by the chat name) and match its size
    const conf = [...document.body.children].find(e => e.tagName === 'BUTTON' && e !== t && /^\s*conf\s*$/i.test(e.textContent || '') && e.offsetParent !== null);
    if (conf) {
      const r = conf.getBoundingClientRect(), cs = getComputedStyle(conf);
      t.style.top = r.top + 'px'; t.style.left = (r.right + 6) + 'px'; t.style.right = 'auto';
      t.style.padding = cs.padding; t.style.font = cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
      t.style.letterSpacing = cs.letterSpacing; t.style.borderRadius = cs.borderRadius; t.style.height = r.height + 'px'; t.style.lineHeight = 'normal';
      t.style.boxSizing = 'border-box';
    } else { t.style.top = '14px'; t.style.right = '110px'; t.style.left = 'auto'; t.style.height = ''; }
    if (t.dataset.chat === id + leadsOn(id)) return;
    t.dataset.chat = id + leadsOn(id);
    t.textContent = leadsOn(id) ? 'Leads: ON' : 'Leads: OFF';
    t.style.background = leadsOn(id) ? '#16a34a' : '#6b7280';
    t.title = 'Turn on to show "Enter Lead" buttons in this thread';
  }

  function addButtons() {
    if (!leadsOn(currentChatId())) return;                     // only in threads you switched ON
    for (const node of gmMessages()) {
      if (node.hasAttribute('data-yourmessage') || node.querySelector('.amos-enter-btn')) continue;
      const text = gmText(node);
      if (!text || !parseLead(text, 'x')) continue;          // typed lead info only – never on the photo
      addBtn(node, 'L', 'Enter Lead', 'Entered ✓', enterLead);
    }
  }
  function addBtn(node, kind, label, doneLabel, action) {
    const key = 'amos_clicked_' + kind + node.getAttribute('data-message-id');
    const btn = document.createElement('button');
    btn.className = 'amos-enter-btn';
    btn.textContent = label;                                     // always just "Enter Lead" – "entered" in the thread is the record
    btn.style.cssText = 'display:inline-block;margin:4px 6px 2px 0;padding:3px 12px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:600 12px Arial;cursor:pointer';
    btn.onclick = async e => {
      e.preventDefault(); e.stopPropagation();
      if (btn.dataset.busy === '1') return;                     // ignore double-clicks while it's starting
      btn.dataset.busy = '1';
      try { await action(node, btn); }
      catch (err) { showNote(label + ' problem: ' + err.message, true); }
      finally { btn.dataset.busy = ''; btn.disabled = false; setTimeout(() => { btn.textContent = label; btn.style.background = '#2563eb'; }, 4000); }
    };
    const t = gmTextEl(node);
    if (t && t.parentElement) t.parentElement.insertBefore(btn, t.nextSibling);   // directly under the typed text
    else node.appendChild(btn);
  }

  // post "entered" back in the rep's chat once AccuLynx is finished
  let gmBusy = false;
  async function postEnteredTick() {
    if (gmBusy) return;
    if (!(GM_getValue('amos_post_entered', []) || []).length) return;
    // only ONE GroupMe tab may post: claim the job with a short lock so two open tabs never both say "entered"
    const me = (window.__amosTabId = window.__amosTabId || Math.random().toString(36).slice(2));
    const lock = GM_getValue('amos_post_lock', null);
    if (lock && lock.tab !== me && Date.now() - lock.t < 60e3) return;
    GM_setValue('amos_post_lock', { tab: me, t: Date.now() });
    await sleep(400);
    if ((GM_getValue('amos_post_lock', {}) || {}).tab !== me) return;          // another tab won the race
    const pending = GM_getValue('amos_post_entered', []) || [];
    GM_setValue('amos_post_entered', []);                                    // take them off the list BEFORE posting
    if (!pending.length) { GM_deleteValue('amos_post_lock'); return; }
    gmBusy = true;
    try {
      const back = currentChatId();
      const posted = (GM_getValue('amos_posted_ids', []) || []).filter(x => x && x.k);
      for (const p of pending) {
        const key = (p.id || p.name) + '|' + (p.text || CONFIG.replyEntered);
        if (posted.some(x => x.k === key && Date.now() - x.t < 120e3)) continue;   // same reply already posted in the last 2 min
        const reply = p.text || CONFIG.replyEntered;
        if (await openChat(p.chatId)) { await gmSend(reply); posted.push({ k: key, t: Date.now() }); log('Posted "' + reply + '" for ' + p.name); }
        else log('Open that rep\'s chat once so I can post "entered" for ' + p.name, true);
      }
      GM_setValue('amos_posted_ids', posted.slice(-200));
      if (back && back !== currentChatId()) await openChat(back);
    } finally { gmBusy = false; GM_deleteValue('amos_post_lock'); }
  }

  // sends queued leads to AccuLynx one at a time
  function dispatchTick() {
    const q = GM_getValue(KEY_QUEUE, {});
    let changed = false;
    for (const [id, l] of Object.entries(q)) if (l && l.queuedAt && Date.now() - l.queuedAt > 30 * 60e3) { delete q[id]; changed = true; log('Dropped stale queued lead ' + (l.first || '') + ' ' + (l.last || '') + ' – click Enter Lead again if it still needs entering', true); }
    if (changed) GM_setValue(KEY_QUEUE, q);
    const active = GM_getValue(KEY_ACTIVE);
    const since = GM_getValue('amos_active_since', 0);
    if (active && q[active] && Date.now() - GM_getValue('amos_active_t', 0) < 3 * 60e3 && Date.now() - since < 10 * 60e3) return;   // give the open one 3 min (max 10)
    if (active && !q[active]) GM_deleteValue(KEY_ACTIVE);
    else if (active && q[active]) {                                    // the active lead's tab went quiet – give up on it so it can't block everyone else
      log('Lead ' + (q[active].first || '') + ' ' + (q[active].last || '') + ' stalled in AccuLynx – removed from the queue. Check AccuLynx and click Enter Lead again if needed.', true);
      delete q[active]; GM_setValue(KEY_QUEUE, q); GM_deleteValue(KEY_ACTIVE);
    }
    const next = Object.keys(q).sort((a, b) => (q[a].queuedAt || 0) - (q[b].queuedAt || 0))[0];
    if (!next) return;
    GM_setValue(KEY_ACTIVE, next); GM_setValue('amos_active_t', Date.now()); GM_setValue('amos_active_since', Date.now());
    const url = 'https://my.acculynx.com/Lead/New#amoslead=' + next;
    const t0 = GM_getValue('amos_active_t', 0);
    GM_openInTab(url, { active: false, insert: true });
    // if no AccuLynx tab picks the lead up (Chrome sometimes blocks background tabs), open it in front instead
    setTimeout(() => {
      if (GM_getValue(KEY_ACTIVE) === next && GM_getValue('amos_active_t', 0) === t0) {
        log('AccuLynx tab did not open in the background – opening it now', true);
        GM_openInTab(url, { active: true, insert: true });
      }
    }, 20000);
  }

  /* ===================== ACCULYNX HELPERS ===================== */
  const visible = el => el && el.offsetParent !== null;
  function fieldByLabel(labelText) {
    const lab = [...document.querySelectorAll('label')].find(l => visible(l) && l.innerText.replace('*', '').trim().toLowerCase() === labelText.toLowerCase());
    if (!lab) return null;
    let c = lab.parentElement;
    for (let k = 0; k < 4 && c; k++) {
      const f = c.querySelector('input:not([type=checkbox]):not([type=radio]),select,textarea,button');
      if (f) return f;
      c = c.parentElement;
    }
    return null;
  }
  function setValue(el, value) {
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function typeInto(el, value) {
    el.focus(); el.click(); setValue(el, '');
    for (const ch of value) { setValue(el, el.value + ch); el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ch })); await sleep(20); }
  }
  function selectByText(sel, text) {
    const opt = [...sel.options].find(o => o.text.trim().toLowerCase() === text.toLowerCase());
    if (!opt) return false;
    setValue(sel, opt.value); return true;
  }
  const clickText = (text, root = document, tags = 'button,a,li,span,div,label') =>
    [...root.querySelectorAll(tags)].find(e => visible(e) && e.innerText && e.innerText.trim() === text);

  function fetchBlob(url, tries = 2) {
    return new Promise((res, rej) => GM_xmlhttpRequest({
      method: 'GET', url, responseType: 'arraybuffer', timeout: 30000,
      onload: r => (r.status === 200 && r.response && r.response.byteLength > 1000)
        ? res(new Blob([r.response], { type: 'image/jpeg' })) : rej(new Error('download HTTP ' + r.status)),
      onerror: r => rej(new Error('download failed (' + ((r && (r.error || r.statusText || r.status)) || 'blocked – in Tampermonkey allow this script to reach ' + (url.match(/^https?:\/\/([^/]+)/) || [])[1]) + ')')),
      ontimeout: () => rej(new Error('download timed out')),
    })).catch(e => tries > 1 ? sleep(1500).then(() => fetchBlob(url, tries - 1)) : Promise.reject(e));
  }
  const b64ToBlob = b64 => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type: 'image/jpeg' }); };
  const blobToB64 = blob => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });

  // House picture: open Google Maps in a background tab; the Maps part of this script grabs the Street View
  // preview (streetviewpixels-pa.googleapis.com) or reports "none" when Google only has the placeholder drawing.
  // Google finds NUMBERED COUNTY ROADS only in the short form:
  //   "1234 West 100 South"        -> no exact match (pin lands on the road)
  //   "1234 100 S"                 -> exact house + Street View
  //   "123 North County Road 500 East" -> "123 N 500 E"
  function shortRoad(street) {
    const bare = street.replace(/\b(?:county\s+road|c(?:o|ty|nty)\.?\s*rd\.?|cr)\s*(?=\d|[NSEW]\b)/ig, ' ').replace(/\s+/g, ' ').trim();
    if (new RegExp('\\b(?:' + SW + ')\\b', 'i').test(bare)) return street;        // a normal named street – leave it alone
    if (!/\d/.test(bare.replace(/^\s*\d+\s*/, ''))) return street;                 // no ROAD number after the house number
    return bare.replace(/\bnorth\b/ig, 'N').replace(/\bsouth\b/ig, 'S')
               .replace(/\beast\b/ig, 'E').replace(/\bwest\b/ig, 'W')
               .replace(/\s+/g, ' ').trim();
  }
  async function getHousePhoto(lead) {
    const ad = splitAddress(lead.address);
    const q = encodeURIComponent([shortRoad(ad.street), ad.city, 'IN', ad.zip].filter(Boolean).join(', '));
    GM_deleteValue('amos_house_result');
    GM_setValue('amos_house_req', { id: lead.id, t: Date.now() });
    const tab = GM_openInTab('https://www.google.com/maps/place/' + q, { active: false, insert: true });
    const r = await waitFor(() => { const v = GM_getValue('amos_house_result'); return v && v.id === lead.id ? v : null; }, 30000, 500);
    try { tab && tab.close && tab.close(); } catch (e) { /* ignore */ }
    GM_deleteValue('amos_house_req');
    if (r && r.lat) lead.mapPoint = { lat: r.lat, lon: r.lon };   // Google's pin = the house itself, not the road
    if (!r) return { none: true, why: 'Google Maps did not answer' };
    if (r.none) return { none: true, why: r.why || 'Google has no Street View photo of this address' };
    return { blob: b64ToBlob(r.b64) };
  }
  // satellite "overview" picture centred on the job's map pin (AccuLynx search gives the lat/lon)
  // satellite "overview" picture: US Census geocoder gives lat/lon for the address, Esri gives the aerial photo
  function getJSON(url) {
    return new Promise((res, rej) => GM_xmlhttpRequest({ method: 'GET', url, timeout: 20000,
      onload: r => { try { res(JSON.parse(r.responseText)); } catch (e) { rej(new Error('bad answer')); } },
      onerror: () => rej(new Error('geocoder blocked – allow geocoding.geo.census.gov in Tampermonkey')), ontimeout: () => rej(new Error('geocoder timed out')) }));
  }
  async function getOverviewPhoto(lead) {
    let lat, lon;
    if (lead.mapPoint) { lat = lead.mapPoint.lat; lon = lead.mapPoint.lon; }          // Google's pin = the house
    else {
      // fallback only: the Census geocoder guesses a spot ALONG THE ROAD, so the picture can be centred on the street
      const ad = splitAddress(lead.address);
      const one = [shortRoad(ad.street), ad.city, 'IN', ad.zip].filter(Boolean).join(', ');
      const d = await getJSON('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address=' + encodeURIComponent(one));
      const m = d && d.result && d.result.addressMatches && d.result.addressMatches[0];
      if (!m) throw new Error('map location not found');
      lon = m.coordinates.x; lat = m.coordinates.y;
    }
    const dLat = 0.0005, dLon = 0.0008;   // ~110 x 135 m around the house
    const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(',');
    try { return await fetchBlob('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=' + bbox + '&bboxSR=4326&imageSR=3857&size=1000,750&format=jpg&f=image', 1); }
    catch (e) { return stitchTiles(lat, lon); }                // export service sometimes answers HTTP 500 – build it from map tiles instead
  }
  async function stitchTiles(lat, lon) {
    const z = 19, n = 2 ** z, fx = (lon + 180) / 360 * n;
    const fy = (1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n;
    const cx = Math.floor(fx), cy = Math.floor(fy);
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 768;
    const ctx = cv.getContext('2d');
    // the house sits part-way inside its own tile – shift everything so it lands dead centre
    const offX = cv.width / 2 - (3 * 256 + Math.round((fx - cx) * 256));
    const offY = cv.height / 2 - (2 * 256 + Math.round((fy - cy) * 256));
    for (let dx = -3; dx < 3; dx++) for (let dy = -2; dy < 3; dy++) {
      try {
        const b = await fetchBlob('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/' + z + '/' + (cy + dy) + '/' + (cx + dx));
        ctx.drawImage(await createImageBitmap(b), offX + (dx + 3) * 256, offY + (dy + 2) * 256);
      } catch (e) { /* one missing square does not spoil the picture */ }
    }
    return new Promise(r => cv.toBlob(r, 'image/jpeg', 0.9));
  }
  const streetRe = (num, word) => new RegExp('\\b' + num + '\\s+(?:(?:north|south|east|west|[nsew])\\.?\\s+)?' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
  async function uploadPhotos(files, retry = 1) {
    if (files.some(f => !f.size || f.size < 2000)) throw new Error('the picture download came back empty');
    const upBtn = () => [...document.querySelectorAll('button')].find(b => visible(b) && b.textContent.trim() === 'Upload');
    // the previous upload window must be CLOSED first – starting while it was still finishing made the 3rd photo fail
    await waitFor(() => !upBtn(), 30000, 500);
    await sleep(800);
    const add = await waitFor(() => clickText('Add Photos', document, 'button'));
    if (!add) throw new Error('Add Photos button not found');
    add.click();
    await sleep(1200);
    const input = await waitFor(() => { const all = document.querySelectorAll('input[type=file]'); return all[all.length - 1]; });   // the NEWEST upload window's input
    if (!input) throw new Error('photo file input not found');
    const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
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
  async function replyInThread(text, notify) {
    const ed = await waitFor(() => [...document.querySelectorAll('[contenteditable="true"]')].find(visible));
    if (!ed) throw new Error('reply box not found');
    ed.focus();
    if (ed.ckeditorInstance) ed.ckeditorInstance.setData(text.split('\n').map(l => '<p>' + (l.replace(/&/g, '&amp;').replace(/</g, '&lt;') || '&nbsp;') + '</p>').join(''));
    else document.execCommand('insertText', false, text);
    await sleep(600);
    if (notify && notify.length) {                                  // tag Mars 1 / Mars 2 on THIS reply
      const mb = document.querySelector('.mentions-popover__button');
      if (mb) {
        mb.click(); await sleep(900);
        for (const who of notify) {
          const lab = [...document.querySelectorAll('label')].find(l => visible(l) && l.innerText.trim() === who);
          const cb = lab && (lab.querySelector('input[type=checkbox]') || document.getElementById(lab.htmlFor) || lab.parentElement.querySelector('input[type=checkbox]'));
          if (lab && !(cb && cb.checked)) lab.click();
          if (!lab) log('Could not find "' + who + '" to tag', true);
          await sleep(250);
        }
        mb.click(); await sleep(500);
      } else log('Recipients button not found – tag Mars 1 & 2 by hand', true);
    }
    const send = await waitFor(() => { const b = document.querySelector('.job-communications-reply-box__send-button'); return b && visible(b) && !b.disabled ? b : null; }, 5000);
    if (!send) throw new Error('Send button not available on the reply box');
    const before = document.body.innerText.length;
    send.click();
    const ok = await waitFor(() => /submitted successfully/i.test(document.body.innerText) || (ed.ckeditorInstance && ed.ckeditorInstance.getData() === '' && document.body.innerText.length > before), 15000);
    if (!ok) throw new Error('reply did not post');
    await sleep(1500);
  }


  /* ---------- Task for Mars 1 (replaces the @Me tag): Overview → Tasks → Create Task ---------- */
  async function createTask(title, assignee) {
    const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
    const openBtn = await waitFor(() => [...document.querySelectorAll('button,a,span,div')].find(e => visible(e) && e.children.length < 3 && /^\+?\s*Create Task$/i.test(txt(e))), 20000);
    if (!openBtn) throw new Error('"Create Task" button not found on the Overview page');
    openBtn.scrollIntoView({ block: 'center' }); openBtn.click(); await sleep(1500);
    // the task window: "Assign To" (person tags box) + "Description" (the task title) + Create button
    const dlg = () => { const ta = [...document.querySelectorAll('textarea')].filter(visible)[0]; if (!ta) return null;
      let d = ta; for (let k = 0; k < 12 && d; k++, d = d.parentElement) if (/Assign To/i.test(txt(d)) && [...d.querySelectorAll('button')].some(b => /^Create$/i.test(txt(b)))) return d; return null; };
    const win = await waitFor(dlg, 15000);
    if (!win) throw new Error('task window did not open');
    // Assign To = Mars 1 ONLY: remove any other chip, then add Mars 1 if it is not there
    const chips = () => [...(win.querySelector('.ti-tags') || win).querySelectorAll('.ti-tag')];   // first tags box = Assign To (the second one is the job)
    for (const c of chips()) if (!txt(c).includes(assignee)) { const x = c.querySelector('.ti-icon-close') || c.querySelector('.ti-actions i:last-child'); if (x) { x.click(); await sleep(400); } }
    if (!chips().some(c => txt(c).includes(assignee))) {
      const inp = win.querySelector('input.ti-new-tag-input');
      if (!inp) throw new Error('"Find a person" box not found');
      inp.focus(); inp.click(); setValue(inp, assignee.split(' ').slice(0, 2).join(' ')); await sleep(1200);
      const opt = await waitFor(() => [...document.querySelectorAll('.ti-autocomplete li,.ti-item,[role=option],li')].find(e => visible(e) && txt(e).includes(assignee) && !e.closest('.ti-tags .ti-tag')), 8000);
      if (!opt) throw new Error('"' + assignee + '" not in the Find-a-person list');
      opt.click(); await sleep(700);
    }
    if (!chips().some(c => txt(c).includes(assignee)) || chips().length !== 1) throw new Error('Assign To is not only ' + assignee);
    // Description = the task title
    const desc = win.querySelector('textarea');
    desc.focus(); setValue(desc, title); desc.dispatchEvent(new Event('blur', { bubbles: true })); await sleep(500);
    if (desc.value.trim() !== title) throw new Error('task Description did not take');
    const save = [...win.querySelectorAll('button')].filter(visible).find(b => /^create$/i.test(txt(b)) && !b.disabled);
    if (!save) throw new Error('task Create button not found');
    save.click();
    const ok = await waitFor(() => !dlg(), 15000);
    if (!ok) throw new Error('task was not confirmed');
    await sleep(1200);
  }

  /* ---------- @Me tag: Messages tab → comment + "Send notification to" Mars 1 & Mars 2 ---------- */
  async function tagMars(text) {
    const box = await waitFor(() => [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(visible));
    if (!box) throw new Error('comment box not found');
    box.focus(); box.click();
    if (box.tagName === 'TEXTAREA') setValue(box, text); else document.execCommand('insertText', false, text);
    await sleep(500);
    // the toolbar under the box: try each icon until the "Send notification to" list opens
    let form = box; for (let k = 0; k < 6 && form && !clickText('Post', form, 'button'); k++) form = form.parentElement;
    const icons = form ? [...form.querySelectorAll('button,a,[role=button],i,svg')].filter(visible) : [];
    for (const ic of icons) {
      if (/Send notification to/i.test(document.body.innerText)) break;
      if (/post|attach/i.test(ic.innerText || '')) continue;
      ic.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(600);
      if (!/Send notification to/i.test(document.body.innerText)) document.body.click();
    }
    if (!/Send notification to/i.test(document.body.innerText)) throw new Error('notification list not found');
    for (const who of CONFIG.notifyUsers) {
      const lab = [...document.querySelectorAll('label')].find(l => visible(l) && l.innerText.trim() === who);
      const cb = lab && (lab.querySelector('input[type=checkbox]') || lab.parentElement.querySelector('input[type=checkbox]'));
      if (lab && !(cb && cb.checked)) lab.click();
      if (!lab) log('Could not find "' + who + '" in notify list', true);
      await sleep(250);
    }
    document.body.click(); await sleep(400);
    const post = form && clickText('Post', form, 'button');
    if (!post || post.disabled) throw new Error('Post button not available');
    post.click();
    if (!await waitFor(() => /submitted successfully/i.test(document.body.innerText), 15000)) throw new Error('comment not confirmed');
  }

  /* ===================== ACCULYNX: CREATE LEAD ===================== */
  async function fillLeadForm(lead) {
    log('Filling Create Lead for ' + lead.first + ' ' + lead.last);
    const cancel = await waitFor(() => /Finish previous lead/i.test(document.body.innerText) && clickText('Cancel', document, 'button,a'), 4000);
    if (cancel) { cancel.click(); log('Dismissed "Finish previous lead"'); await sleep(1500); }

    const f = n => fieldByLabel(n);
    await waitFor(() => f('First Name'));
    if (lead.photoOnly) {
      // photo-only lead: you type name/phone/address/appointment from the lead sheet
      await typeInto(f('Email'), CONFIG.defaults.email);
    } else {
    await typeInto(f('First Name'), lead.first);
    await typeInto(f('Last Name'), lead.last);
    await typeInto(f('Phone'), lead.phone || CONFIG.defaults.phone);
    for (const p of (lead.phones2 || []).slice(0, 2)) {             // extra numbers → "+ Add Another" under Phone
      try {
        const ph = f('Phone');
        const add = [...document.querySelectorAll('button,a')].find(b => visible(b) && /Add Another/i.test(b.innerText) &&
          (ph.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING));
        if (!add) { log('Could not add 2nd phone ' + p.num + ' – add it by hand', true); break; }
        add.click(); await sleep(600);
        const empty = [...document.querySelectorAll('input[name*="phone-number"], input[id*="phone-number"]')]
          .filter(i => visible(i) && !i.value && i !== ph).pop();
        if (empty) await typeInto(empty, p.num); else log('Could not add 2nd phone ' + p.num + ' – add it by hand', true);
      } catch (e) { log('2nd phone: ' + e.message, true); }
    }
    await typeInto(f('Email'), lead.email || CONFIG.defaults.email);

    // address: filled directly from the message (Google's suggestion list doesn't open for scripts)
    const ad = splitAddress(lead.address);
    setValue(f('City'), ad.city || CONFIG.defaults.city);
    selectByText(f('State'), CONFIG.defaults.state);
    setValue(f('Zip'), ad.zip || lead.zip || CONFIG.defaults.zip);
    const street = f('Street');
    await typeInto(street, ad.street || CONFIG.defaults.street);
    // pick AccuLynx/Google's own address suggestion – it fills the real city + zip (posts often leave the zip off)
    if (ad.street) {
      street.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: ' ' }));
      const want = (ad.city || '').toLowerCase();
      const pick = await waitFor(() => {
        const items = [...document.querySelectorAll('li.refinement-controls__search-result, .refinement-controls__search-results li')].filter(visible);
        const num = (ad.street.match(/^\d+/) || [''])[0];
        return items.find(i => i.textContent.trim().startsWith(num) && want && i.textContent.toLowerCase().includes(want) && /,\s*IN,/i.test(i.textContent)) ||
               (!want && items.find(i => i.textContent.trim().startsWith(num) && /,\s*IN,/i.test(i.textContent)));
      }, 5000, 300);
      if (pick) {
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) pick.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        await sleep(1500);
        log('Address picked from Google: ' + pick.textContent.trim());
      } else if (!ad.zip && !lead.zip) log('No zip in the post and no Google match – zip ' + CONFIG.defaults.zip + ' used. Check it.', true);
    }
    street.dispatchEvent(new Event('blur', { bubbles: true })); street.blur(); await sleep(800);
    if (!street.value) { await typeInto(street, ad.street || CONFIG.defaults.street); street.blur(); await sleep(800); }
    if (!street.value) log('Street did not stick – type it by hand', true);
    if (!ad.city) log('No city in the message – used ' + CONFIG.defaults.city + '. Check it.', true);
    }

    selectByText(f('Job Category'), CONFIG.jobCategory);
    selectByText(f('Work Type'), CONFIG.workType);
    // lead source = the option ending in ": <rep name>" (Field Marketing or Events & Retail)
    const ls = f('Lead Source');
    // exact name first; otherwise allow a small spelling difference (Zack ↔ Zach) as long as the last name matches
    const fm = [...ls.options].filter(o => /^Field Marketing/i.test(o.text));
    const lastOf = s => norm((s.split(':').pop() || '').trim().split(/\s+/).pop());
    const dist = (a, b) => { const d = [...Array(b.length + 1).keys()];
      for (let i = 1; i <= a.length; i++) { let p = d[0]; d[0] = i;
        for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1)); p = t; } }
      return d[b.length]; };
    const findSource = who => {
      const w = norm(who);
      if (!w) return null;
      let o = fm.find(x => norm(x.text.split(':').pop()) === w);                       // exact "…: Melanie Keller"
      if (o) return o;
      const near = fm.filter(x => lastOf(x.text) === lastOf(who) && dist(norm(x.text.split(':').pop()), w) <= 2);
      if (near.length === 1) { log('Lead Source matched by close spelling: ' + near[0].text.trim()); return near[0]; }
      const sameLast = fm.filter(x => lastOf(x.text) === lastOf(who));                 // nickname (Rusty ↔ Russell)
      if (sameLast.length === 1) { log('Lead Source matched by last name: ' + sameLast[0].text.trim()); return sameLast[0]; }
      // several share the last name (a plain one and e.g. "Walmart - …"): take the plain rep entry
      const plain = sameLast.filter(x => norm(x.text.split(':').pop()).endsWith(lastOf(who)) && !/-/.test(x.text.split(':').pop()));
      if (plain.length === 1) { log('Lead Source matched by last name: ' + plain[0].text.trim()); return plain[0]; }
      return null;
    };
    // the message sender's name is tried first, then the chat title
    let opt = findSource(lead.sender) || (lead.chatName && lead.chatName !== lead.sender ? findSource(lead.chatName) : null);
    if (!opt) throw new Error('No Lead Source for "' + lead.sender + '" – pick it by hand');
    setValue(ls, opt.value); lead.leadSource = opt.text.trim();

    f('Trade Type').click(); await sleep(500);
    for (const t of tradesFor(lead)) {
      const labs = [...document.querySelectorAll('label')].filter(l => visible(l));
      const lab = labs.find(l => l.innerText.trim() === t) ||
                  labs.find(l => l.innerText.trim().toLowerCase().startsWith(t.split(/[ /]/)[0].toLowerCase()) && !/^service/i.test(l.innerText.trim()));
      if (lab) lab.click(); else log('Trade "' + t + '" not in list', true);
      await sleep(200);
    }
    document.body.click(); await sleep(2500);

    const dupe = lead.photoOnly ? '' : await checkPossibleMatches(lead);
    if (dupe) {
      // SOLD duplicate (Approved / Completed / Invoiced / Closed job) = a NEW sale for an existing customer:
      // keep going, put the IN number in Cross Reference and in the notes (Andrew's rule)
      const sold = await soldJobAt(lead);
      if (!sold) throw new Error('POSSIBLE DUPLICATE (' + dupe + ') – enter by hand using the revive rules.' + await sourceRuleFor(lead));
      lead.crossRef = sold;
      lead.extra.unshift('Existing customer - sold job ' + sold);
      const crLab = [...document.querySelectorAll('label')].find(l => visible(l) && /^cross reference/i.test(l.innerText.trim()));
      let cr = null; for (let p = crLab; p && !cr; p = p.parentElement) cr = p.querySelector('input');
      if (cr) await typeInto(cr, sold + (cr.value ? ' | ' + cr.value : ''));
      else log('Cross Reference box not found – add ' + sold + ' by hand', true);
    }

    const asg = f('Assign to');
    await typeInto(asg, CONFIG.assignTo.slice(0, 10)); await sleep(800);
    const who = await waitFor(() => [...document.querySelectorAll('li,div,span,a')].filter(e => visible(e) && e.innerText && e.innerText.trim() === CONFIG.assignTo)
      .sort((x, y) => x.querySelectorAll('*').length - y.querySelectorAll('*').length)[0], 5000);
    if (who) { for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) who.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true })); await sleep(600); }
    if (!who || asg.value !== CONFIG.assignTo) log('Could not pick "' + CONFIG.assignTo + '" – do it by hand', true);

    setValue(f('Notes'), notesFor(lead));
    if (lead.photoOnly) { lead.apptText = '(see Initial Appt)'; return; }
    let start, end; const cd = callDate(lead); const a = cd ? { date: cd, hasTime: false } : lead.appt;
    if (a && a.hasTime) { start = new Date(a.date); start.setHours(a.h, a.m, 0, 0); end = new Date(start.getTime() + CONFIG.apptHours * 3600e3); }
    else {
      // no time given → 6–7 AM. "call <day>" → that day; no date at all → the next day (never Sunday)
      start = a ? new Date(a.date) : nextWorkDay();
      start.setHours(6, 0, 0, 0); end = new Date(start.getTime() + 3600e3);
      if (!a) log('No appointment – using next day 6–7 AM (CTS)', true);
    }
    await setApptDate(f('Appointment Date'), start);
    await sleep(600);                                              // times unlock once the date is set
    const hhmm = d => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    setValue(f('Start Time'), hhmm(start)); f('Start Time').dispatchEvent(new Event('blur', { bubbles: true })); await sleep(500);
    setValue(f('End Time'), hhmm(end));     f('End Time').dispatchEvent(new Event('blur', { bubbles: true }));   await sleep(500);
    if (f('Start Time').value !== hhmm(start) || f('End Time').value !== hhmm(end)) log('Appointment times did not take – set them by hand', true);
    setValue(f('Notes'), notesFor(lead));
    const tf = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    lead.apptText = start.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ' ' + tf(start) + ' - ' + tf(end);
  }
  // AccuLynx shows "Possible Matches (N)" COLLAPSED – open it first, or the matches can't be read at all
  async function checkPossibleMatches(lead) {
    // there can be SEVERAL boxes: one under the name/address and one under the phone ("Possible Match (1)")
    await waitFor(() => [...document.querySelectorAll('a,button,span,div,h3,h4')].some(e => visible(e) && /^Possible Match(es)? \(\d+\)$/.test((e.innerText || '').trim())), 4000);
    const heads = [...document.querySelectorAll('a,button,span,div,h3,h4')]
      .filter(e => visible(e) && /^Possible Match(es)? \(\d+\)$/.test((e.innerText || '').trim()))
      .filter((e, i, arr) => !arr.some(o => o !== e && e.contains(o)));                 // smallest element per heading
    let txt = '';
    for (const head of heads) {
      let wrap = head; for (let k = 0; k < 6 && wrap.parentElement && wrap.innerText.length < 80; k++) wrap = wrap.parentElement;
      if (wrap.innerText.length < 80) { head.click(); await sleep(1500); wrap = head; for (let k = 0; k < 6 && wrap.parentElement && wrap.innerText.length < 80; k++) wrap = wrap.parentElement; }
      txt += '\n' + wrap.innerText;
    }
    // every match AccuLynx lists is a .contact-match-result-item (contacts AND jobs) – read them all, wherever they sit
    await sleep(800);
    txt += '\n' + [...document.querySelectorAll('[class*="match-result-item"], .result-list--item')].map(e => e.textContent.replace(/\s+/g, ' ')).join('\n');   // textContent: the list may be collapsed
    if (!txt.trim()) return '';
    // a phone match alone isn't enough (old numbers get reused – e.g. a 2013 business contact) –
    // the SAME match must also share the last name or the street number + street name
    const items = [...document.querySelectorAll('[class*="match-result-item"]')].map(e => e.textContent.replace(/\s+/g, ' '));
    const lastN = norm(lead.last || ''); const stNum = (lead.address.match(/^\d+/) || [''])[0];
    const stWord = (lead.address.replace(/^\d+\s+/, '').split(/[\s,]+/).find(w => w.length > 2 && !/^(north|south|east|west|n|s|e|w)\.?$/i.test(w)) || '').toLowerCase();
    for (const it of items) {
      if (!lead.phone || !it.replace(/\D/g, '').includes(lead.phone)) continue;
      const sameName = lastN.length > 2 && norm(it).includes(lastN);
      const sameAddr = stNum && stWord && streetRe(stNum, stWord).test(it);
      if (sameName || sameAddr) return 'same phone number';
    }
    if (items.length) txt = items.join('\n');                       // address check below runs on the match items
    const num = (lead.address.match(/^\d+/) || [''])[0];
    const word = (lead.address.replace(/^\d+\s+/, '').split(/[\s,]+/).find(w => w.length > 2 && !/^(north|south|east|west)$/i.test(w)) || '');
    // the street word must come RIGHT AFTER the number (an optional N/S/E/W between) – "3000 State" once matched
    // "3000 East 131st Street, Fishers, Indiana … UNITED STATES"
    if (num && word && streetRe(num, word).test(txt)) return 'same street address';
    return '';
  }
  // RULE: when the original job's lead is over 1 year old, its Lead Source is replaced by the new one
  // (e.g. Smith: Rep One 1/17/25 -> Rep Two 11/2/26)
  // returns "IN-12345" when the job already at this address is SOLD, else ''
  async function soldJobAt(lead) {
    try {
      const num = (lead.address.match(/^\d+/) || [''])[0];
      const word = (lead.address.replace(/^\d+\s+/, '').split(/[\s,]+/).find(w => w.length > 2) || '');
      if (!num || !word) return '';
      const r = await fetch('/api/Search/GetTypeAheadSearch?noContacts=true&query=' + encodeURIComponent(num + ' ' + word)).then(r => r.json());
      const hit = (r.results || []).find(x => x.Type !== 'Contact' && (x.FullAddress || '').startsWith(num + ' ') &&
                  /^(Approved|Completed|Invoiced|Closed)$/i.test(x.CurrentMilestone || '') && /^IN-\d+/.test(x.Name || ''));
      const live = (r.results || []).some(x => x.Type !== 'Contact' && (x.FullAddress || '').startsWith(num + ' ') && /^(Lead|Prospect)$/i.test(x.CurrentMilestone || ''));
      return hit && !live ? hit.Name.match(/^IN-\d+/)[0] : '';     // an open Lead/Prospect there still means "revive", not new
    } catch (e) { return ''; }
  }
  async function sourceRuleFor(lead) {
    try {
      const num = (lead.address.match(/^\d+/) || [''])[0];
      const word = (lead.address.replace(/^\d+\s+/, '').split(/[\s,]+/).find(w => w.length > 2) || '');
      if (!num || !word) return '';
      const r = await fetch('/api/Search/GetTypeAheadSearch?noContacts=true&query=' + encodeURIComponent(num + ' ' + word)).then(r => r.json());
      const old = (r.results || []).filter(x => x.Type !== 'Contact' && (x.FullAddress || '').startsWith(num + ' ') && x.CurrentMilestone !== 'Dead')
        .sort((a, b) => (a.MilestoneStart || '').localeCompare(b.MilestoneStart || ''))[0];
      if (!old || !old.MilestoneStart) return '';
      const ageDays = (Date.now() - new Date(old.MilestoneStart)) / 864e5;
      const src = 'Field Marketing: ' + (lead.sender || '');
      lead.dupeJobId = old.Id; lead.replaceSource = ageDays > 365;
      return ageDays > 365
        ? ' Original job (' + (old.Name || old.Id) + ') is over 1 year old – CHANGE its Lead Source to "' + src + '".'
        : ' Original job is under 1 year old – keep its Lead Source.';
    } catch (e) { return ''; }
  }
  async function setApptDate(input, date) {
    // AccuLynx uses a flatpickr calendar wrapped around the box; set the date through it directly
    let c = input, fp = null;
    for (let k = 0; k < 6 && c && !fp; k++) { fp = c._flatpickr || null; c = c.parentElement; }
    if (fp) { fp.setDate(date, true); await sleep(500); }
    if (!input.value) log('Appointment date did not take – set it by hand', true);
  }

  /* ===================== ACCULYNX: AFTER SAVE ===================== */
  async function finishJob(lead, jobId) {
    const base = '/jobs/' + jobId;
    const stepKey = 'amos_step_' + lead.id;
    const step = GM_getValue(stepKey, 'photos');
    const go = (path, next) => { GM_setValue(stepKey, next); location.href = base + path; };

    if (step === 'photos') {
      if (!/\/jobphotos/.test(location.pathname)) return go('/jobphotos', 'photos');
      await sleep(2500);
      const problems = [];
      if (lead.imageUrl) {
        try { await uploadPhotos([new File([await fetchBlob(lead.imageUrl)], lead.last + '_lead_sheet.jpg', { type: 'image/jpeg' })]); log('Lead sheet uploaded'); }
        catch (e) { problems.push('Lead sheet photo: ' + e.message); }
      } else problems.push('No lead sheet photo found in the thread');
      let overviewOk = false, houseOk = false;
      if (!lead.photoOnly) {
        // 1. ask Google Maps first: it hands back the Street View picture AND the pin (the house itself)
        let house = null;
        try { house = await getHousePhoto(lead); if (house.none) problems.push('House picture skipped – ' + house.why); }
        catch (e) { problems.push('House picture: ' + e.message); }
        // 2. OVERVIEW next, centred on that pin – uploaded BEFORE the house picture so the house stays the newest photo
        try { const ov = await getOverviewPhoto(lead); await sleep(1500); await uploadPhotos([new File([ov], lead.last + '_overview.jpg', { type: 'image/jpeg' })]); overviewOk = true; log('Overview picture uploaded'); }
        catch (e) { problems.push('Overview picture: ' + e.message); }
        // 3. the house picture last – Location Info picks the newest photo
        if (house && house.blob) {
          try { await sleep(1500); await uploadPhotos([new File([house.blob], lead.last + '_house.jpg', { type: 'image/jpeg' })]); houseOk = true; log('House picture uploaded'); }
          catch (e) { problems.push('House picture: ' + e.message); }
        }
      }
      if (problems.length) { GM_setValue('amos_problems_' + lead.id, problems); log(problems.join(' · '), true); }
      return (houseOk || overviewOk) ? go('', 'location') : go('/communications', 'comments');   // no Street View → the overview becomes the Location picture
    }
    if (step === 'location') {
      const locSection = () => [...document.querySelectorAll('section.editable')].find(x => /Initial Appt/.test(x.innerText));
      const hasImg = () => { const sct = locSection(); return !!(sct && sct.querySelector('img')); };
      let seen = -1;                                     // how many photos the picker listed (for the error message)
      for (let attempt = 1; attempt <= 3 && !hasImg(); attempt++) {
        try {
          const sct = await waitFor(locSection, 15000);
          const pencil = sct && sct.querySelector('span.edit');
          if (!pencil) throw new Error('Location Info pencil not found');
          pencil.scrollIntoView({ block: 'center' }); pencil.click();
          if (!await waitFor(() => /Edit Location Information/i.test(document.body.innerText), 8000)) throw new Error('location editor did not open');
          const addImg = await waitFor(() => clickText('Add Image', document, 'button'), 8000);
          if (!addImg) throw new Error('Add Image button not found');
          addImg.click();
          await waitFor(() => /Select Files/i.test(document.body.innerText), 8000);
          // The picker does NOT list photos newest-first, so pick by FILE NAME – never the lead sheet.
          // Each thumbnail's address ends in ".../<file name>/w_200,h_200/".
          // match the ENDING only – AccuLynx rewrites the name part of the file (odd characters are dropped)
          // ONLY the picker's own tab – the page header also has a "Photos" button, and clicking that one emptied the picker
          const photosTab = [...document.querySelectorAll('button.file-picker-tabs__tab')]
            .find(e => visible(e) && e.textContent.trim() === 'Photos');
          if (photosTab && !photosTab.classList.contains('current')) { photosTab.click(); await sleep(800); }
          const wanted = [/_house\.jpg/i, /_overview\.jpg/i];
          const thumb = await waitFor(() => {
            const items = [...document.querySelectorAll('li.attachment')];
            seen = items.length;
            if (items[0]) items[0].scrollIntoView({ block: 'center' });   // a hidden tab renders the list lazily
            for (const re of wanted) {
              // read the whole item, not just img.src – in a background tab the picture is not loaded yet and
              // src is still a placeholder (the file name sits in data-src / the item's markup)
              const hit = items.find(li => { try { return re.test(decodeURIComponent(li.outerHTML)); } catch (e) { return re.test(li.outerHTML); } });
              if (hit) return hit.querySelector('button') || hit;
            }
            return null;
          }, 20000, 400);
          if (!thumb) throw new Error('house/overview photo not in the picker (' + seen + ' photo(s) listed)');
          thumb.click(); await sleep(600);
          // the PICKER's own Save – the Location editor's Save sits later on the page, and clicking that one
          // closed everything without the picture (this was the long-running "House picture NOT set" failure)
          let pick = document.querySelector('button.file-picker-tabs__tab');
          while (pick && ![...pick.querySelectorAll('button')].some(b => visible(b) && b.innerText.trim() === 'Save')) pick = pick.parentElement;
          const save1 = pick && [...pick.querySelectorAll('button')].filter(x => visible(x) && x.innerText.trim() === 'Save').pop();
          if (!save1) throw new Error('Save button not found in the photo picker');
          save1.click(); await sleep(2000);
          const save2 = [...document.querySelectorAll('button')].filter(x => visible(x) && x.innerText.trim() === 'Save').pop();
          if (save2) save2.click();
          await waitFor(() => /Location information saved/i.test(document.body.innerText) || hasImg(), 10000);
          await sleep(1500);
        } catch (e) {
          log('Location photo attempt ' + attempt + ': ' + e.message, true);
          const cancel = [...document.querySelectorAll('button,a')].filter(x => visible(x) && x.innerText.trim() === 'Cancel').pop();
          if (cancel) { cancel.click(); await sleep(1000); }
        }
      }
      if (hasImg()) log('House picture set on Location Info');
      else { const pr = GM_getValue('amos_problems_' + lead.id, []) || []; pr.push('House picture NOT set on Location Info (picker listed ' + seen + ' photo(s)) – do it by hand'); GM_setValue('amos_problems_' + lead.id, pr); }
      return go('/communications', 'comments');
    }
    if (step === 'comments') {
      if (GM_getValue('amos_comments_done_' + lead.id)) { GM_setValue(stepKey, 'tag'); return finishJob(lead, jobId); }   // never post twice
      // The notes thread's preview shows the ORIGINAL notes at first, but after replies it shows the LATEST reply.
      // So match the thread by any text we know is in it.
      const srcLine = lead.leadSource || ('Field Marketing: ' + lead.sender);
      const marks = ['Lead Source: ' + srcLine, srcLine + ' Initial Appt', srcLine + '\nInitial Appt', CONFIG.signatureComment, lead.raw.slice(0, 40)];
      // pick the SMALLEST visible element that contains one of the marks (the list row), not a big wrapper around it
      const first = await waitFor(() => {
        const c = [...document.querySelectorAll('div,li')].filter(e => visible(e) && e.children.length > 0 &&
          e.innerText.length < 500 && marks.some(m => e.innerText.includes(m)));
        return c.sort((a, b) => a.innerText.length - b.innerText.length)[0] || null;
      }, 30000);
      if (!first) throw new Error('notes message not found in Communications');
      first.click(); await sleep(2500);
      // read only the messages area – the page header shows "Name 123 Street City", which once matched the rep's
      // post ("Name 123 Street City …") and the rep's post was skipped
      const threadText = () => ((document.querySelector('article') || document.body).innerText).replace(/\s+/g, ' ');
      if (!threadText().includes(lead.raw.replace(/\s+/g, ' ').slice(0, 40)))
        await replyInThread(lead.raw);
      if (!threadText().includes((srcLine + ' Initial Appt: ' + lead.apptText).replace(/\s+/g, ' ')))
        await replyInThread(srcLine + '\nInitial Appt: ' + lead.apptText);
      await replyInThread(CONFIG.signatureComment, CONFIG.notifyUsers);   // "Claude" (no @Me tags any more)
      GM_setValue('amos_comments_done_' + lead.id, true);
      log('Replies posted');
      return go('', 'task');                                              // Overview page → create the task for Mars 1
    }
    if (step === 'task') {
      if (GM_getValue('amos_task_done_' + lead.id)) { GM_setValue(stepKey, 'tag'); return finishJob(lead, jobId); }   // never twice
      GM_setValue('amos_task_done_' + lead.id, true);                     // ONE attempt only – a half-finished try must not create a second task
      await sleep(2500);
      try { await createTask(CONFIG.taskTitle, CONFIG.taskAssignee); log('Task "' + CONFIG.taskTitle + '" created for ' + CONFIG.taskAssignee); }
      catch (e) {
        const pr = GM_getValue('amos_problems_' + lead.id, []); pr.push('Task NOT created (' + e.message + ') – create "' + CONFIG.taskTitle + '" for ' + CONFIG.taskAssignee + ' by hand'); GM_setValue('amos_problems_' + lead.id, pr);
        log('Task: ' + e.message, true);
      }
      GM_setValue(stepKey, 'tag');
      return finishJob(lead, jobId);
    }
    if (step === 'tag') {
      GM_setValue('amos_post_entered', [...GM_getValue('amos_post_entered', []), { id: lead.id, chatId: lead.chatId, name: lead.first + ' ' + lead.last }]);
      GM_setValue('amos_done_' + lead.id, true);
      const q = GM_getValue(KEY_QUEUE, {}); delete q[lead.id]; GM_setValue(KEY_QUEUE, q);
      GM_deleteValue(KEY_ACTIVE); GM_deleteValue(stepKey); GM_deleteValue('amos_comments_done_' + lead.id); GM_deleteValue('amos_task_done_' + lead.id);
      const probs = GM_getValue('amos_problems_' + lead.id, []); GM_deleteValue('amos_problems_' + lead.id);
      showNote('Done – ' + lead.first + ' ' + lead.last + ' entered.' + (probs.length ? ' NOTE: ' + probs.join(' · ') : ' You can close this tab.'), probs.length > 0);
    }
  }


  let busy = false;
  async function accuLynxMain() {
    if (busy) return;
    busy = true;
    try { await accuLynxRun(); }
    catch (e) {
      log('STOPPED on this lead: ' + e.message, true);
      // move on to the next lead; this one stays in the panel log for you to finish by hand
      const a = GM_getValue(KEY_ACTIVE); const q = GM_getValue(KEY_QUEUE, {});
      if (a && q[a]) { delete q[a]; GM_setValue(KEY_QUEUE, q); }
      GM_deleteValue(KEY_ACTIVE);                      // never leave a crashed lead blocking the queue
    }
    finally { busy = false; }
  }
  async function accuLynxRun() {
    const q = GM_getValue(KEY_QUEUE, {});
    const hashId = (location.hash.match(/amoslead=(L\d+)/) || [])[1];
    // heartbeat ONLY from the tab that is working the active lead – ordinary AccuLynx browsing must never keep a dead lead "busy"
    if (hashId && hashId === GM_getValue(KEY_ACTIVE)) GM_setValue('amos_active_t', Date.now());
    if (hashId && /\/lead\/new/i.test(location.pathname)) {
      const lead = q[hashId]; if (!lead) return;
      if (GM_getValue('amos_filled_' + hashId)) return;          // don't refill on re-check
      await fillLeadForm(lead);
      GM_setValue('amos_filled_' + hashId, true);
      q[hashId] = lead; GM_setValue(KEY_QUEUE, q);
      GM_setValue('amos_step_' + hashId, 'photos');
      if (CONFIG.autoSave) {
        const save = clickText('Save', document, 'button');
        if (!save || save.disabled) throw new Error('Save is greyed out – a required field is missing');
        save.click(); log('Saved');
      } else {
        showNote(lead.photoOnly ? 'Photo-only lead: type the name, phone, address and appointment from the lead sheet, then click SAVE.' : 'Lead filled in. Check it and click SAVE – the rest finishes on its own.');
        // while this form waits for you, keep telling the queue it's still in use (so the next lead waits its turn)
        const hb = setInterval(() => { if (/\/lead\/new/i.test(location.pathname)) GM_setValue('amos_active_t', Date.now()); else clearInterval(hb); }, 30000);
      }
      return;
    }
    const active = GM_getValue(KEY_ACTIVE);
    const job = location.pathname.match(/\/jobs\/([0-9a-f-]{36})/i);
    if (active && job && q[active] && GM_getValue('amos_filled_' + active)) {
      GM_setValue('amos_active_t', Date.now());                     // this tab is finishing the active lead
      await sleep(2500);
      const lead = q[active];
      if (!document.body.innerText.toLowerCase().includes(lead.last.toLowerCase())) return;
      await finishJob(lead, job[1]);
    }
  }

  /* ===================== GOOGLE MAPS: hand back the Street View picture ===================== */
  async function mapsRun() {
    const req = GM_getValue('amos_house_req');
    if (!req || Date.now() - req.t > 60000) return;                 // only for a tab the script opened just now
    const img = await waitFor(() => [...document.querySelectorAll('img')].find(i => i.getBoundingClientRect().width > 200 && i.src), 20000, 500);
    // Google's own pin for the place – the ROOFTOP point, unlike a street-range geocoder.
    // It only appears in the address bar once Google has resolved the place, which is AFTER the
    // first picture shows – so wait for it, or we fall back to a geocoder that aims at the road.
    await waitFor(() => /!3d-?\d+\.\d+!4d-?\d+\.\d+/.test(location.href), 12000, 300);
    const pin = location.href.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || location.href.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    const where = pin ? { lat: +pin[1], lon: +pin[2] } : {};
    const done = v => GM_setValue('amos_house_result', Object.assign({ id: req.id, t: Date.now() }, where, v));
    if (!img) return done({ none: true, why: 'no preview picture on the Google Maps page' });
    if (!/streetviewpixels-pa\.googleapis\.com|googleusercontent\.com/.test(img.src))
      return done({ none: true, why: 'Google has no Street View photo of this address' });
    try {
      const big = img.src.replace(/([?&])w=\d+/, '$1w=1600').replace(/([?&])h=\d+/, '$1h=940').replace(/=w\d+-h\d+/, '=w1600-h940');
      done({ b64: await blobToB64(await fetchBlob(big)) });
    } catch (e) { done({ none: true, why: 'could not download the Street View photo' }); }
  }

  /* ===================== START ===================== */
  if (location.host === 'web.groupme.com') {
    setInterval(() => { paintLeadToggle(); addButtons(); }, 1500);
    setInterval(dispatchTick, 3000);
    setInterval(postEnteredTick, 3000);
  }
  if (location.host === 'www.google.com' && /^\/maps/.test(location.pathname)) mapsRun();
  if (location.host === 'my.acculynx.com') {
    accuLynxMain();
    let last = location.href;
    setInterval(() => { if (location.href !== last) { last = location.href; accuLynxMain(); } }, 1500);
  }
})();
