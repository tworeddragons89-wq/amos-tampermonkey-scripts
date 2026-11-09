// ==UserScript==
// @name         Mars 3 NAX2 Follow-Up (AccuLynx)
// @namespace    amos-exteriors.andrew
// @version      1.7
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/mars3-nax2-followup.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/mars3-nax2-followup.user.js
// @description  Adds a "Mars 3" button to AccuLynx jobs. One click: reads NAX2 history, moves the Mars 3 appointment (1 mo / 3 mo / 6 mo / 1 yr), posts the AST comment, and texts the customer.
// @match        https://my.acculynx.com/jobs/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // true = one click does everything (no Run box). Change to false to get the review box back.
  const AUTO_RUN = true;
  const KEY = 'mars3nax2_state';
  const STEPS = [
    { label: '1 month', months: 1 },
    { label: '3 months', months: 3 },
    { label: '6 months', months: 6 },
    { label: '1 year', months: 12 },
  ];

  // ---------- helpers ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!(el && el.offsetParent);
  const txt = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  async function waitFor(fn, timeout = 15000, every = 250) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) { /* keep waiting */ }
      await sleep(every);
    }
    throw new Error('Timed out waiting for the page');
  }

  function setVal(el, v) {
    const p = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    p.set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function click(el) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }

  const jobId = () => (location.pathname.match(/\/jobs\/([0-9a-f-]{36})/i) || [])[1];
  const getState = () => { try { return JSON.parse(sessionStorage.getItem(KEY)); } catch (e) { return null; } };
  const setState = (s) => sessionStorage.setItem(KEY, JSON.stringify(s));
  const clearState = () => sessionStorage.removeItem(KEY);

  function go(path) {
    const url = '/jobs/' + getState().job + path;
    if (location.pathname !== url) location.href = url;
    else location.reload();
  }

  function mdy(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }

  function addMonths(base, n) {
    const d = new Date(base.getFullYear(), base.getMonth() + n, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(base.getDate(), last));
    if (d.getDay() === 6) d.setDate(d.getDate() + 2); // Saturday -> Monday
    if (d.getDay() === 0) d.setDate(d.getDate() + 1); // Sunday -> Monday
    return d;
  }

  // ---------- status box ----------
  function status(msg, kind) {
    let box = document.getElementById('m3-status');
    if (!box) {
      box = document.createElement('div');
      box.id = 'm3-status';
      box.style.cssText = 'position:fixed;right:20px;bottom:150px;z-index:99999;max-width:340px;padding:10px 14px;border-radius:6px;font:13px/1.4 sans-serif;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:pre-wrap';
      document.body.appendChild(box);
    }
    box.style.background = kind === 'err' ? '#c62828' : kind === 'ok' ? '#2e7d32' : '#1565c0';
    box.textContent = 'Mars 3 NAX2: ' + msg;
  }

  function fail(msg) {
    clearState();
    status(msg + '\n\nNothing further was done. Finish this lead by hand.', 'err');
  }

  // In-page pop-up (Chrome/AccuLynx can block normal prompt boxes)
  function modal(text, editable) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#222;width:520px;max-width:92vw;padding:18px 20px;border-radius:8px;font:14px/1.45 sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4)';
      const h = document.createElement('div');
      h.textContent = 'Mars 3 NAX2';
      h.style.cssText = 'font-weight:bold;font-size:16px;margin-bottom:8px;color:#ef6c00';
      const p = document.createElement('div');
      p.style.whiteSpace = 'pre-wrap';
      p.textContent = text;
      box.append(h, p);
      let ta = null;
      if (editable !== null) {
        ta = document.createElement('textarea');
        ta.value = editable;
        ta.style.cssText = 'width:100%;height:120px;margin-top:10px;padding:8px;font:14px sans-serif;border:1px solid #999;border-radius:4px;box-sizing:border-box';
        box.append(ta);
      }
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:flex-end;gap:10px;margin-top:14px';
      const mk = (label, bg, fg) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = `padding:8px 18px;border:none;border-radius:4px;background:${bg};color:${fg};font:bold 14px sans-serif;cursor:pointer`; return b; };
      const cancel = mk('Cancel', '#ddd', '#222');
      const run = mk('Run', '#ef6c00', '#fff');
      cancel.id = 'm3-cancel'; run.id = 'm3-run';
      cancel.onclick = () => { wrap.remove(); resolve(null); };
      run.onclick = () => { const v = ta ? ta.value : ''; wrap.remove(); resolve(v); };
      row.append(cancel, run);
      box.append(row);
      wrap.append(box);
      document.body.append(wrap);
      if (ta) ta.focus();
    });
  }

  // ---------- button ----------
  function addButton() {
    if (document.getElementById('m3-btn') || !document.body) return;
    const b = document.createElement('button');
    b.id = 'm3-btn';
    b.textContent = 'Mars 3';
    b.title = 'NAX2 follow-up: move appointment, post comment, text customer';
    b.style.cssText = 'position:fixed;right:20px;bottom:95px;z-index:99999;padding:10px 18px;background:#ef6c00;color:#fff;border:none;border-radius:22px;font:bold 14px sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.35)';
    b.onclick = () => {
      if (!jobId()) return alert('Open a job first.');
      const s = getState();
      if (s && s.job === jobId() && !confirm('A Mars 3 run is already in progress on this job. Start over?')) return;
      setState({ job: jobId(), step: 'overview' });
      go('');
    };
    document.body.appendChild(b);
  }

  // ---------- steps ----------
  function dd(label) {
    const dt = [...document.querySelectorAll('dt')].find((d) => txt(d) === label && visible(d));
    return dt && dt.nextElementSibling ? dt.nextElementSibling : null;
  }

  async function stepOverview(s) {
    status('Reading contact info…');
    // wait until name, address and lead source have actually filled in
    await waitFor(() => txt(dd('Name:')) && txt(dd('Address:')) && txt(dd('Lead Source:')), 20000);
    await sleep(800);
    const nameDd = dd('Name:');
    const addrDd = dd('Address:');
    const phoneDt = [...document.querySelectorAll('dt')].find((d) => /^Phone/.test(txt(d)) && visible(d));
    const phoneDd = phoneDt ? phoneDt.nextElementSibling : null;
    const lead = txt(dd('Lead Source:'));
    const trade = txt(dd('Trade:'));
    const name = txt(nameDd);
    const address = addrDd ? addrDd.innerText.split('\n').map((x) => x.trim()).filter(Boolean).join(' ').replace(/\s+,/g, ',') : '';
    const phoneText = phoneDd ? phoneDd.innerText : '';
    const repName = (lead.split(':')[1] || '').trim().split(/\s+/)[0] || '';
    s.first = name.split(/\s+/)[0] || document.title.split(/\s+/)[0] || '';
    s.address = address;
    s.lead = lead;
    s.rep = repName;
    s.met = /event/i.test(lead) ? 'the event' : 'the home';
    s.trade = trade;
    // Phone label is "Phone (1):"; wait up to 6s for the opt-in text to render
    await waitFor(() => /Text opt in:/i.test(document.body.innerText), 6000).catch(() => null);
    s.optIn = /Text opt in:\s*Yes/i.test(phoneText) || /Text opt in:\s*Yes/i.test(document.body.innerText);
    s.step = 'readComments';
    setState(s);
    go('/comments');
  }

  async function expandAll() {
    for (let i = 0; i < 30; i++) {
      const more = [...document.querySelectorAll('a,button,span,div')].find((e) =>
        visible(e) && e.children.length === 0 && /^(Show More Comments(?! \(-)|View \d+ more repl)/i.test(txt(e)));
      if (!more) return;
      click(more);
      await sleep(1200);
    }
  }

  async function stepReadComments(s) {
    status('Reading comments for earlier NAX2 steps…');
    await waitFor(() => [...document.querySelectorAll('textarea.ax-textarea__input')].some(visible));
    await sleep(1500);
    await expandAll();
    const body = document.body.innerText;
    let found = -1;
    const re = /AST\s*-\s*NAX2 moved out (1 month|3 months|6 months|1 year)/gi;
    let m;
    while ((m = re.exec(body))) {
      const idx = STEPS.findIndex((x) => x.label === m[1].toLowerCase());
      if (idx > found) found = idx;
    }
    const next = STEPS[Math.min(found + 1, 3)];
    const newDate = addMonths(new Date(), next.months);

    // product interest: Mars 2 "Product Interest:", then "Interest:", then Trade
    let product = '';
    const pm = body.match(/Product Interest:\s*([^\n]+)/i) || body.match(/\bInterest:\s*([^\n.]+)/i);
    if (pm) product = pm[1].trim();
    if (!product) product = s.trade;
    product = product.replace(/\.$/, '').toLowerCase() || 'project';
    // "siding / soffit / fascia" -> "siding, soffit and fascia"
    const parts = product.split(/\s*(?:\/|,|&|\+|\band\b)\s*/).filter(Boolean);
    if (parts.length > 1) product = parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];

    const draft = `Hey ${s.first}! This is Andrew with Amos Exteriors. You met with ${s.rep} at ${s.met}. I was calling about the ${product} at ${s.address}. Call me back when you get a chance.`;

    const summary = `Last NAX2 on this job: ${found < 0 ? 'none' : STEPS[found].label}\n` +
      `Next step: ${next.label}  →  new appointment date ${mdy(newDate)}\n` +
      `Text opt-in: ${s.optIn ? 'YES (text will be sent)' : 'NO (text will be skipped)'}\n\n`;

    const message = AUTO_RUN ? (s.optIn ? draft : '') : await modal(summary + (s.optIn
      ? 'Check the text below, fix anything, then click Run.'
      : 'Click Run to move the appointment and post the comment.'), s.optIn ? draft : null);
    if (message === null) { clearState(); status('Cancelled. Nothing was changed.'); return; }

    s.stepLabel = next.label;
    s.date = { y: newDate.getFullYear(), m: newDate.getMonth(), d: newDate.getDate() };
    s.dateStr = mdy(newDate);
    s.message = message.trim();
    s.step = 'moveAppt';
    setState(s);
    go('/appointments');
  }

  async function stepMoveAppt(s) {
    status('Moving the Mars 3 appointment to ' + s.dateStr + '…');
    const rows = await waitFor(() => {
      const r = [...document.querySelectorAll('tr.appointment-table-row')];
      return r.length ? r : null;
    }, 15000).catch(() => null);
    if (!rows) return fail('No appointments found on this job.');
    const mars = rows.filter((r) => /^Mars 3/i.test(txt(r.children[0])));
    if (!mars.length) return fail('No Mars 3 appointment found on this job.');
    if (mars.length > 1) return fail('This job has more than one Mars 3 appointment. Please move the right one by hand.');
    const row = mars[0];
    const editBtn = row.children[7] && row.children[7].querySelector('button');
    if (!editBtn) return fail('Could not find the edit (pencil) button.');
    click(editBtn);

    const startInput = await waitFor(() => {
      const i = document.querySelectorAll('input.flatpickr-input')[0];
      return visible(i) ? i : null;
    });
    await sleep(800);

    // Pick the date on the flatpickr calendar tied to Start Date
    const cal = [...document.querySelectorAll('.flatpickr-calendar')][0];
    const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    const aria = `${months[s.date.m]} ${s.date.d}, ${s.date.y}`;
    let day = null;
    for (let i = 0; i < 15; i++) {
      day = [...cal.querySelectorAll('.flatpickr-day')].find((d) => d.getAttribute('aria-label') === aria && !d.classList.contains('prevMonthDay') && !d.classList.contains('nextMonthDay'));
      if (day) break;
      click(cal.querySelector('.flatpickr-next-month'));
      await sleep(300);
    }
    if (!day) return fail('Could not find ' + aria + ' on the calendar.');
    click(day);
    await sleep(700);
    const want = String(s.date.m + 1).padStart(2, '0') + '/' + String(s.date.d).padStart(2, '0') + '/' + s.date.y;
    if (startInput.value !== want) return fail('Start date did not change (shows ' + startInput.value + ').');

    const save1 = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Save' && visible(b));
    click(save1);
    await waitFor(() => /Notify attendees/i.test(document.body.innerText));
    await sleep(1200);

    const shortMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const shown = `${shortMonths[s.date.m]} ${s.date.d}, ${s.date.y}`;
    const moved = () => [...document.querySelectorAll('tr.appointment-table-row')]
      .some((r) => /^Mars 3/i.test(txt(r.children[0])) && txt(r.children[4]).startsWith(shown));
    let ok = false;
    // Click the Save inside the "Notify attendees" panel; retry a few times if it doesn't take.
    for (let i = 0; i < 4 && !ok; i++) {
      const note = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /Notify attendees/i.test(e.textContent) && visible(e));
      let panel = note;
      while (panel && !(panel.querySelector && [...panel.querySelectorAll('button')].some((b) => txt(b) === 'Save'))) panel = panel.parentElement;
      const save2 = panel ? [...panel.querySelectorAll('button')].find((b) => txt(b) === 'Save' && visible(b)) : null;
      if (save2) { save2.click(); }
      ok = await waitFor(moved, 5000).catch(() => false);
    }
    if (!ok) return fail('Saved, but the appointment does not show ' + shown + '. Please check it.');

    s.step = 'post';
    setState(s);
    go('/comments');
  }

  async function stepPost(s) {
    status('Posting the comment…');
    const ta = await waitFor(() => [...document.querySelectorAll('textarea.ax-textarea__input')].find(visible));
    await sleep(1000);
    ta.focus();
    setVal(ta, `AST - NAX2 moved out ${s.stepLabel} for a follow up\n${s.dateStr}`);
    await sleep(400);
    const area = ta.closest('.add-comment') || document;
    const portal = [...area.querySelectorAll('input[type=checkbox]')].find((c) => /Customer Portal/i.test(txt(c.closest('label') || c.parentElement)));
    if (portal && portal.checked) click(portal);
    const post = [...document.querySelectorAll('.add-comment__actions button')].find((b) => txt(b) === 'Post' && visible(b));
    if (!post || post.disabled) return fail('Post button not available.');
    click(post);
    const ok = await waitFor(() => /Comment submitted successfully/i.test(document.body.innerText), 15000).catch(() => false);
    if (!ok) return fail('Did not see "Comment submitted successfully". Check whether the comment posted.');
    await sleep(1500);

    if (!s.optIn) {
      clearState();
      return status(`Done: ${s.stepLabel} NAX2, moved to ${s.dateStr}. Customer NOT opted in to texts, so no text was sent.`, 'ok');
    }

    status('Sending the text…');
    const tab = [...document.querySelectorAll('.ax-tabs__tab')].find((t) => txt(t) === 'Text Message');
    click(tab);
    const to = await waitFor(() => [...document.querySelectorAll('input.ti-new-tag-input')].find(visible));
    to.focus();
    setVal(to, s.first);
    const item = await waitFor(() => [...document.querySelectorAll('.ti-autocomplete li.ti-item')].find((li) => visible(li)), 10000).catch(() => null);
    if (!item) return fail('No contact found for "' + s.first + '" in Send To. Comment and appointment are done; send the text by hand.');
    click(item.firstElementChild || item);
    await waitFor(() => document.querySelector('.ti-tags li.ti-tag'), 5000).catch(() => null);
    if (!document.querySelector('.ti-tags li.ti-tag')) return fail('Could not pick the text recipient. Send the text by hand.');
    const sms = [...document.querySelectorAll('textarea.ax-textarea__input')].find(visible);
    sms.focus();
    setVal(sms, s.message);
    await sleep(500);
    const send = [...document.querySelectorAll('button')].find((b) => txt(b) === 'Send' && visible(b));
    if (!send || send.disabled) return fail('Send button not available.');
    click(send);
    const sent = await waitFor(() => /Text message submitted successfully/i.test(document.body.innerText), 15000).catch(() => false);
    clearState();
    if (!sent) return status('Comment posted and appointment moved, but I did not see "Text message submitted successfully". Check the text.', 'err');
    status(`Done: ${s.stepLabel} NAX2, moved to ${s.dateStr}, text sent.`, 'ok');
  }

  // ---------- runner ----------
  async function run() {
    const s = getState();
    if (!s || s.job !== jobId()) return;
    const path = location.pathname.replace(/\/$/, '');
    const base = '/jobs/' + s.job;
    try {
      if (s.step === 'overview' && (path === base || path === base + '/overview')) await stepOverview(s);
      else if (s.step === 'readComments' && path === base + '/comments') await stepReadComments(s);
      else if (s.step === 'moveAppt' && path === base + '/appointments') await stepMoveAppt(s);
      else if (s.step === 'post' && path === base + '/comments') await stepPost(s);
    } catch (e) {
      fail(e.message || String(e));
    }
  }

  setInterval(addButton, 1000);
  addButton();
  run();
})();
