// ==UserScript==
// @name         Amos - Enter Dispo
// @namespace    amos-exteriors
// @version      2.7
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-dispo.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/enter-dispo.user.js
// @description  Adds an "Enter Dispo" button to a rep's GroupMe dispos. Click it to post the dispo as a comment on the lead's AccuLynx job, then reply "current" in the rep's thread.
// @match        https://web.groupme.com/*
// @match        https://my.acculynx.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const KEY_JOB = 'amosDispoJob';     // dispo waiting to be entered in AccuLynx
  const KEY_DONE = 'amosDispoDone';   // AccuLynx tells GroupMe it finished
  const ACCULYNX_URL = 'https://my.acculynx.com/dashboard';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout = 20000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(300);
    }
    return null;
  }
  function toast(msg, color = '#2b7') {
    const d = document.createElement('div');
    d.textContent = msg;
    Object.assign(d.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: 999999,
      background: color, color: '#fff', padding: '10px 14px', borderRadius: '6px',
      font: '14px sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '360px'
    });
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 9000);
  }
  // Type into an input/textarea/contenteditable so the web app "sees" it
  function typeInto(el, text) {
    el.focus();
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function pressEnter(el) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    }
  }
  // A small badge that stays on screen and says which step the script is on, so a stall is never silent
  function status(msg, color = '#0a6cff') {
    let d = document.getElementById('amosDispoStatus');
    if (!d) {
      d = document.createElement('div');
      d.id = 'amosDispoStatus';
      Object.assign(d.style, {
        position: 'fixed', bottom: '70px', right: '20px', zIndex: 999999, color: '#fff', padding: '8px 12px',
        borderRadius: '6px', font: '13px sans-serif', boxShadow: '0 2px 8px rgba(0,0,0,.3)', maxWidth: '360px'
      });
      document.body.appendChild(d);
    }
    d.style.background = color;
    d.textContent = 'Enter Dispo: ' + msg;
  }
  const visible = (el) => el && el.offsetParent !== null;
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

  // <parse>
  // Find an AccuLynx job number ("IN-4521") in the dispo. Careful: a state + ZIP such as
  // "Anytown, IN 46000" looks like a job number but is not one, and neither is "in 2027".
  function findJobNum(text) {
    for (const m of text.matchAll(/(^|[^A-Za-z0-9])(in)([-\s]?)(\d{3,6})\b/gi)) {
      const before = text.slice(0, m.index + m[1].length);
      if (/,\s*$/.test(before)) continue;                          // ", IN 46000" = state + ZIP
      if (m[3] !== '-' && m[2] !== 'IN') continue;                 // plain word "in 500" is not a job #
      if (m[3] !== '-' && /^4[67]\d{3}$/.test(m[4])) continue;     // Indiana ZIP code
      return 'IN-' + m[4];
    }
    return '';
  }
  // Work out how to find the lead in AccuLynx. AccuLynx search takes a Job #,
  // customer name or address (NOT a phone number), so: job # first, then name.
  function parseLead(text) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const jobNum = findJobNum(text);
    const addrLine = lines.find((l) => /^\d{1,6}\s+[A-Za-z]/.test(l) && !/^\d{3}[\s.)-]+\d{3}/.test(l));
    const addr = addrLine ? norm(addrLine).split(' ').slice(0, 2).join(' ') : '';

    const isCityLine = (l) => /^[A-Za-z .'-]+,\s*([A-Z]{2}\b|Indiana|Ohio|Kentucky|Illinois|Michigan)/.test(l);
    const lastFirst = /^[A-Za-z'’.\-]+(\s[A-Za-z'’.\-]+)?\s*,\s*[A-Za-z]/;   // "Doe, Jane and John" / "Smith , Anna"
    const headerLine = lines.slice(0, 3).find((l) => /^IN[-\s]?\d{3,6}\s*[:\-]?\s*[A-Za-z]/.test(l));   // "IN-4521 Jane Doe"
    let nameLine = headerLine || lines.slice(0, 6).find((l) => lastFirst.test(l) && !isCityLine(l) && !/^\w+:/.test(l));
    if (!nameLine) {
      nameLine = lines.find((l) => !/^\d/.test(l) && !/:\s*$/.test(l) && !/^(customer|job|lead|product|demo|price|payment)/i.test(l));
    }
    let tokens = [], search = '';
    if (nameLine && lastFirst.test(nameLine) && !isCityLine(nameLine)) {   // "Doe, Jane and John"
      const [last, rest] = nameLine.split(',');
      tokens = [...norm(last).split(' '), norm(rest).split(' ')[0]].filter(Boolean);
      search = last.trim();
    } else if (nameLine) {                                     // "Jane Doe"
      // Only the name part: before the first comma / dash (drops "Monday, Nov 2 · 4–6 PM" etc.)
      const nameOnly = nameLine.replace(/^IN[-\s]?\d+\s*[:\-]?\s*/i, '').split(/[,·–—]| - /)[0];
      const words = norm(nameOnly).split(' ').filter((w) => w && w !== 'and');
      tokens = words;
      search = words.length > 2 ? words[words.length - 1] : words.join(' ');
    }
    // Best thing to search: job # → street address (very unique) → customer name
    // AccuLynx abbreviates ("Cir", "Dr", "St"), so drop the street-type word from the search
    // (and keep only the street part: "123 Main Station, Zionsville, IN" → "123 Main Station")
    const addrFull = addrLine ? addrLine.split(',')[0].replace(/[,\s]+$/, '')
      .replace(/\s+(street|st|avenue|ave|road|rd|drive|dr|lane|ln|court|ct|circle|cir|boulevard|blvd|way|place|pl|parkway|pkwy|trail|trl|terrace|ter)\.?$/i, '') : '';
    const nameSearch = search;
    if (addrFull) search = addrFull;
    if (jobNum) search = jobNum;
    // Backups, tried in this order if the first search finds nothing. The IN number in a dispo is
    // not always searchable in AccuLynx (a lead can carry it only inside its emails), so the
    // address and then the name must be able to find the job.
    const alts = [addrFull, nameSearch].filter((s, i, a) => s && s !== search && a.indexOf(s) === i);
    return { jobNum, search, alts, tokens, addr };
  }
  // A line of the dispo that is distinctive enough to tell if it is already on the job.
  // Only the LAST lines count: that is where the rep writes the result. Everything above
  // (name, address, lead-sheet fields) is already on the job from when the lead was entered.
  function dupKey(text) {
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean).slice(1);   // skip line 1 (name / header)
    const cands = lines.slice(-3).filter((l) =>
      l.length >= 20 && !/^[A-Za-z][A-Za-z \/]*:/.test(l) && !/^\d/.test(l) &&
      !/\d{3}[\s.)-]+\d{3}/.test(l) && !/,\s*[A-Z]{2}\b/.test(l) && !/@/.test(l));
    return cands.sort((a, b) => b.length - a.length)[0] || '';
  }
  // </parse>

  // =====================================================================
  //  GROUPME SIDE
  // =====================================================================
  if (location.host === 'web.groupme.com') {

    // Each GroupMe tab gets an id so only the tab that clicked reacts when AccuLynx finishes
    let TAB_ID = sessionStorage.getItem('amosTabId');
    if (!TAB_ID) { TAB_ID = String(Math.random()).slice(2); sessionStorage.setItem('amosTabId', TAB_ID); }

    // ---------- Per-thread ON/OFF toggle ----------
    const KEY_THREADS = 'amosDispoThreads';
    const threadId = () => (location.pathname.match(/\/chats\/[^/]+\/([^/?#]+)/) || [])[1] || '';
    const isOn = () => !!GM_getValue(KEY_THREADS, {})[threadId()];
    function setOn(on) {
      const all = GM_getValue(KEY_THREADS, {});
      if (on) all[threadId()] = document.title.replace(/^GroupMe \|\s*/, '');
      else delete all[threadId()];
      GM_setValue(KEY_THREADS, all);
    }
    function drawToggle() {
      let t = document.getElementById('amosDispoToggle');
      if (!threadId()) { if (t) t.remove(); return; }
      if (!t) {
        t = document.createElement('button');
        t.id = 'amosDispoToggle';
        Object.assign(t.style, {
          position: 'fixed', top: '14px', right: '16px', zIndex: 999999, padding: '4px 10px',
          border: 'none', borderRadius: '12px', cursor: 'pointer', font: '600 12px Arial', color: '#fff'
        });
        t.addEventListener('click', () => { setOn(!isOn()); refresh(); });
        document.body.appendChild(t);
      }
      const on = isOn();
      t.textContent = on ? 'Dispos: ON' : 'Dispos: OFF';
      t.style.background = on ? '#2b7' : '#6b7280';
      // Sit immediately to the right of the Leads toggle, same size and top edge.
      const leads = document.getElementById('amos-lead-toggle');
      if (leads) {
        const lr = leads.getBoundingClientRect();
        if (lr.width) {
          t.style.top = lr.top + 'px';
          t.style.right = Math.max(4, window.innerWidth - lr.right - 6 - t.getBoundingClientRect().width) + 'px';
        }
      }
    }
    function removeButtons() {
      document.querySelectorAll('.amosDispoBtn').forEach((b) => b.remove());
    }
    function refresh() {
      drawToggle();
      if (isOn()) addButtons(); else removeButtons();
    }

    // ---------- Reading GroupMe messages ----------
    // GroupMe marks each message with data-message. Plain text posts are labeled
    // "Name: text"; photo posts "Message. Received from Name".
    const allMsgs = () => [...document.querySelectorAll('[data-message]')];
    function senderOf(m) {
      const g = m.querySelector('[role="group"][aria-label]');
      const label = g ? g.getAttribute('aria-label') : '';
      const pm = label.match(/^Message\.\s*(?:Received from|Sent by)\s+(.*?)(?:\.\s*Pinned)?$/i);
      if (pm) return pm[1].trim();
      const i = label.indexOf(': ');
      return i > 0 ? label.slice(0, i).trim() : '';
    }
    // The thread is named after the rep, but GroupMe may show their posts as "Freddy",
    // "Duke Antonijevic 2" or "Karandos,David" — so ignore word order and extras:
    // every word of the shorter name must appear in the longer one.
    function isOwner(sender, owner) {
      const s = norm(sender).split(' ').filter(Boolean), o = norm(owner).split(' ').filter(Boolean);
      if (!s.length || !o.length) return false;
      const [small, big] = s.length <= o.length ? [s, o] : [o, s];
      return small.every((w) => big.includes(w));
    }
    // The text part of the message (never the photo)
    const textBlock = (msg) => {
      let t = msg.querySelector('[data-text-message-content]');
      if (!t) {                                   // photo + text posts
        const ps = [...msg.querySelectorAll('p')].filter((p) => p.innerText.trim());
        const p = ps[ps.length - 1];
        t = p ? (p.closest('[data-yourmessage]') || p.parentElement) : null;
      }
      return t && t.innerText.trim().length >= 8 ? t : null;
    };
    function dispoText(anchor) {
      const paras = [...anchor.querySelectorAll('p')].map((p) => p.innerText.trim()).filter(Boolean);
      let text = paras.join('\n');
      if (!text) {
        const clone = anchor.cloneNode(true);
        clone.querySelectorAll('button').forEach((b) => b.remove());
        text = clone.innerText.replace(/^.*\d{1,2}:\d{2}\s*(AM|PM)\s*\n+/i, '').trim();
      }
      // GroupMe can leave invisible placeholder characters in a name ("Smith<obj>, John"); they break name matching.
      // Written as escapes (object-replacement char, zero-width chars, BOM) so copy/paste can never corrupt the range.
      return text.replace(/[￼​-‍⁠﻿]/g, '');
    }

    // Time of a post. GroupMe shows the time only on the first of several back-to-back
    // posts by the same person, so walk back up that run until a time is found.
    function postTime(msg) {
      const list = allMsgs(), who = senderOf(msg);
      for (let i = list.indexOf(msg); i >= 0; i--) {
        if (senderOf(list[i]) !== who) break;
        const te = list[i].querySelector('[data-message-time]');
        if (te && /\d{1,2}:\d{2}/.test(te.textContent)) return te.textContent.trim();
      }
      return '';
    }

    function addButtons() {
      if (!isOn()) return;
      const owner = document.title.replace(/^GroupMe \|\s*/i, '').trim();
      if (!owner) return;
      allMsgs().forEach((msg) => {
        if (msg.querySelector('.amosDispoBtn')) return;           // already has one
        if (!isOwner(senderOf(msg), owner)) return;               // dispos come from the thread's owner
        const anchor = textBlock(msg);                            // text only, never photos
        if (!anchor) return;
        const btn = document.createElement('button');
        btn.className = 'amosDispoBtn';
        btn.textContent = 'Enter Dispo';
        Object.assign(btn.style, {
          display: 'block', margin: '4px 0 0 0', padding: '3px 10px', background: '#0a6cff', color: '#fff',
          border: 'none', borderRadius: '4px', cursor: 'pointer', font: '12px sans-serif'
        });
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = dispoText(anchor);
          let time = postTime(msg);
          if (!time) time = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
          let rep = senderOf(msg).replace(/\s+\d+$/, '');              // "Duke Antonijevic 2" → "Duke Antonijevic"
          const cm = rep.match(/^([^,]+),\s*(.+)$/);                   // "Karandos,David" → "David Karandos"
          if (cm) rep = cm[2] + ' ' + cm[1];
          const lead = parseLead(text);
          // No confirmation box: the search term comes straight from the dispo.
          // Only ask if nothing at all could be read from it.
          let typed = lead.search;
          if (!typed) {
            typed = prompt('Could not read a job #, address or name from this dispo. Type what to search AccuLynx for:', '');
            if (!typed) return;
          }
          if (typed.trim() !== lead.search) {                      // user typed one in
            const jm = typed.match(/IN[-\s]?(\d{3,6})/i);
            lead.jobNum = jm ? 'IN-' + jm[1] : '';
            lead.search = typed.trim();
            lead.alts = [];
            lead.tokens = norm(typed).split(' ').filter(Boolean);
            lead.addr = '';
          }
          const created = Date.now();
          GM_deleteValue(KEY_DONE);
          GM_setValue(KEY_JOB, Object.assign({}, lead, {
            rep, time, text,
            comment: `Dispo from ${rep} (${time}):\n${text}`,
            threadUrl: location.href,
            originTab: TAB_ID,
            created
          }));
          btn.textContent = 'Entering...';
          btn.disabled = true;
          // If AccuLynx has not reported back in 90 seconds, say so and free the button instead of hanging
          setTimeout(() => {
            if (btn.textContent === 'Entering...') {
              btn.textContent = 'Enter Dispo';
              btn.disabled = false;
              toast('The AccuLynx tab did not finish. Check its tab (the blue/red "Enter Dispo" badge says where it stopped), then click Enter Dispo again.', '#e80');
            }
          }, 90 * 1000);
          try {
            GM_openInTab(ACCULYNX_URL + '?amosDispo=' + created, { active: true });
          } catch (err) {
            toast('Could not open AccuLynx: ' + (err && err.message ? err.message : err), '#c33');
            btn.textContent = 'Enter Dispo';
            btn.disabled = false;
          }
        });
        anchor.insertAdjacentElement('afterend', btn);
      });
    }
    setInterval(refresh, 1500);

    // When AccuLynx finishes: reopen THIS thread (if needed) and post "current"
    GM_addValueChangeListener(KEY_DONE, (_k, _old, done) => {
      if (!done || done.originTab !== TAB_ID) return;            // only the tab that clicked
      if (location.href !== done.threadUrl) {
        sessionStorage.setItem('amosSendCurrent', done.threadUrl);
        location.href = done.threadUrl;
        return;
      }
      sendCurrent();
    });

    async function sendCurrent() {
      GM_deleteValue(KEY_DONE);
      const box = await waitFor(() => document.querySelector('[role="textbox"]') || document.querySelector('[contenteditable="true"]') || document.querySelector('textarea'));
      if (!box) return toast('Could not find the GroupMe message box', '#c33');
      typeInto(box, 'current');
      await sleep(500);
      const send = [...document.querySelectorAll('button')].find((b) => visible(b) && !b.disabled && /^send message$/i.test(b.getAttribute('aria-label') || b.title || ''));
      if (send) send.click(); else pressEnter(box);
      await sleep(1200);
      if ((box.innerText || box.value || '').trim()) return toast('Typed "current" but it did not send — press Enter.', '#e80');
      toast('Dispo entered and "current" posted.');
      document.querySelectorAll('.amosDispoBtn').forEach((b) => { if (b.textContent === 'Entering...') { b.textContent = 'Done ✓'; } });
    }
    if (sessionStorage.getItem('amosSendCurrent') === location.href) {
      sessionStorage.removeItem('amosSendCurrent');
      setTimeout(sendCurrent, 2500);
    }
  }

  // =====================================================================
  //  ACCULYNX SIDE
  // =====================================================================
  if (location.host === 'my.acculynx.com') {
    const SKEY = 'amosDispoTab';
    const JOB_RE = /\/jobs\/[0-9a-f-]{36}/i;
    let posting = false;                                     // blocks a second postComment while one is running

    (async function run() {
      const job = GM_getValue(KEY_JOB);
      if (!job || Date.now() - job.created > 15 * 60 * 1000) return;     // nothing pending
      // Only the tab that the Enter Dispo button opened may act (never your own AccuLynx tabs)
      if (location.href.includes('amosDispo=' + job.created)) sessionStorage.setItem(SKEY, String(job.created));
      if (sessionStorage.getItem(SKEY) !== String(job.created)) return;

      try {
        if (!sessionStorage.getItem('amosDispoSearched')) return await doSearch(job);
        if (JOB_RE.test(location.pathname)) return await postComment(job);
        watchForJobPage(job);
      } catch (err) {
        status('stopped — ' + (err && err.message ? err.message : err), '#c33');
      }
    })();

    // Wait until the dropdown of search results stops changing
    async function waitStable(getItems, timeout) {
      const end = Date.now() + timeout;
      let last = -1, same = 0, items = [];
      while (Date.now() < end) {
        items = getItems();
        if (items.length && items.length === last) { if (++same >= 2) return items; } else same = 0;
        last = items.length;
        await sleep(500);
      }
      return items;
    }
    function pickMatches(items, job) {
      const jobs = items.filter((a) => /\/jobs\//.test(a.getAttribute('href') || ''));
      let hits = job.jobNum ? jobs.filter((a) => a.textContent.toUpperCase().includes(job.jobNum)) : [];
      if (!hits.length) {
        hits = jobs.filter((a) => { const t = norm(a.textContent); return job.tokens.length && job.tokens.every((k) => t.includes(k)); });
        if (job.addr) { const byAddr = hits.filter((a) => norm(a.textContent).includes(job.addr)); if (byAddr.length) hits = byAddr; }
        // Names can differ between GroupMe and AccuLynx — fall back to the street address alone
        if (!hits.length && job.addr) hits = jobs.filter((a) => norm(a.textContent).includes(job.addr));
      }
      // Same address twice (an old IN-job from a past sale AND the new lead)? The dispo says
      // "Job: N/A", i.e. no job number yet, so it belongs to the lead — the one without an IN number.
      if (hits.length > 1 && !job.jobNum) {
        const leads = hits.filter((a) => !/\bIN-\d+/i.test(a.textContent));
        if (leads.length === 1) hits = leads;
      }
      return hits;
    }

    async function doSearch(job) {
      const box = await waitFor(() => document.getElementById('js-site-search') || [...document.querySelectorAll('input[type="search"]')].find(visible));
      if (!box) return toast('Could not find the AccuLynx search box. Open the job yourself — the dispo will post when you do.', '#c33');
      sessionStorage.setItem('amosDispoSearched', '1');
      status('searching AccuLynx for ' + job.search + '...');
      await sleep(3000);                                  // the page is still starting up; typing too early is ignored
      let hits = [];
      const terms = [job.search, ...(job.alts || [])];
      for (let ti = 0; ti < terms.length && !hits.length; ti++) {
        const tries = ti === 0 ? 3 : 2;                    // the first term gets extra tries while the page warms up
        for (let attempt = 1; attempt <= tries && !hits.length; attempt++) {
          typeInto(box, '');
          await sleep(300);
          typeInto(box, terms[ti]);
          box.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
          const items = await waitStable(() => [...document.querySelectorAll('a.refinement-controls__search-result')].filter((a) => visible(a) && a.textContent.trim()), 8000);
          hits = pickMatches(items, job);
          if (!hits.length) status('no result for "' + terms[ti] + '" (try ' + attempt + '/' + tries + ')' + (ti + 1 < terms.length || attempt < tries ? ', trying again...' : ''), '#e80');
        }
      }
      if (hits.length === 1) { status('job found, opening it...'); hits[0].click(); }   // exactly one match: open it
      else toast(hits.length ? `${hits.length} jobs match — click the correct one and the dispo will post.` : 'No match found — open the correct job and the dispo will post.', '#e80');
      watchForJobPage(job);
    }

    function watchForJobPage(job) {
      const t = setInterval(() => {
        if (JOB_RE.test(location.pathname)) { clearInterval(t); postComment(job); }
      }, 700);
      setTimeout(() => clearInterval(t), 10 * 60 * 1000);
    }

    const fail = (msg) => toast(msg, '#c33');

    async function postComment(job) {
      if (posting) return;
      if (sessionStorage.getItem('amosDispoPosted') === String(job.created)) return;   // never post twice
      const id = location.pathname.match(JOB_RE)[0];
      if (!/\/comments/i.test(location.pathname)) { location.href = id + '/comments'; return; }  // Messages tab
      posting = true;
      try {
        await postCommentInner(job);
      } finally {
        posting = false;
      }
    }

    async function postCommentInner(job) {
      // Make sure this is the right job before posting anything
      // (A lead has no IN number in its title; then its own emails/comments must mention the number.)
      if (job.jobNum) {
        const verdict = await waitFor(() => {
          const t = document.title.toUpperCase();
          if (t.includes(job.jobNum)) return 'yes';
          if (/\bIN-\d+/.test(t)) return 'no';                        // it is a different numbered job
          return document.body.innerText.toUpperCase().includes(job.jobNum) ? 'yes' : null;
        }, 10000);
        const ok = verdict === 'yes';
        if (!ok) return fail(`This is not ${job.jobNum} — nothing was posted. Open ${job.jobNum} and the dispo will post.`);
      }
      status('on the job, preparing the comment...');
      const box = await waitFor(() => document.querySelector('textarea.form-v3-text__input') || [...document.querySelectorAll('textarea')].find(visible), 15000);
      if (!box) return fail('Could not find the AccuLynx comment box.');
      await sleep(2000);                                                     // let existing comments load

      // Already recorded on this job? Then do not record it again.
      const key = dupKey(job.text);
      if (key && norm(document.body.innerText).includes(norm(key))) {
        toast('This dispo is already on the job — not posting it again.', '#e80');
        return finish(job);
      }

      typeInto(box, job.comment);
      const post = await waitFor(() => {
        const b = [...document.querySelectorAll('button')].find((x) => visible(x) && x.innerText.trim() === 'Post');
        return b && !b.disabled ? b : null;
      }, 6000);
      if (!post) return fail('Comment typed but Post stayed disabled — click Post yourself.');
      sessionStorage.setItem('amosDispoPosted', String(job.created));
      post.click();
      const cleared = await waitFor(() => {
        const b = document.querySelector('textarea.form-v3-text__input');
        return !b || !b.value;
      }, 8000);
      if (!cleared) return fail('Clicked Post but the box did not clear — please check the job.');
      status('posted. Closing this tab...', '#2b7');
      finish(job);
    }

    function finish(job) {
      sessionStorage.removeItem('amosDispoSearched');
      GM_deleteValue(KEY_JOB);
      GM_setValue(KEY_DONE, { threadUrl: job.threadUrl, originTab: job.originTab, at: Date.now() });
      setTimeout(() => window.close(), 1200);                                  // back to GroupMe
    }
  }
})();
