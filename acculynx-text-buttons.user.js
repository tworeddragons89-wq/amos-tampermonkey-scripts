// ==UserScript==
// @name         AccuLynx - "24", "Any", "M", "!" and "CONF" Buttons
// @namespace    amos-exteriors
// @version      3.3
// @description  Adds small red buttons: "24" and "Any" on text-message boxes; one "M" button with a menu (M1 - PER TXT., M1 - PER ATT., M2 - CONF., M3 - NO CONT.) and one "!" button with a quick-notes menu (NA, NALVM, NAX2LVM, PL, PL!, RH) on comment boxes; and "CONF" above the Notes box when creating a lead. One click fills in the text.
// @match        https://my.acculynx.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ATTR = 'data-amos-text-btn';

  // ---------- Pull the pieces of the text from the page ----------

  // Customer first name, from the job header (e.g. "Amy Walker" -> "Amy")
  function getFirstName() {
    const spans = document.querySelectorAll('.job-name span.ng-binding');
    for (const s of spans) {
      const t = s.textContent.trim();
      if (!t || t === ':' || t === '#' || s.classList.contains('ng-hide')) continue;
      // Skip job numbers shown before the name, like "IN-27345:"
      if (/^[A-Za-z]{0,6}-?\d+:?$/.test(t) || /:$/.test(t)) continue;
      return t.split(/\s+/)[0];
    }
    return '';
  }

  // Full street address from the job header, ignoring hidden pieces
  // (e.g. "3984 Hillside Drive Greenwood, IN 46143-9479")
  function getAddress() {
    const el = document.querySelector('.job-address');
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('.ng-hide, svg').forEach((n) => n.remove());
    return clone.textContent.replace(/\s+/g, ' ').trim();
  }

  // Lead source and trade are NOT always on the page (AccuLynx only loads them
  // when the Overview tab is opened), so we ask AccuLynx for them directly.
  const infoCache = {};

  async function fetchJobInfo() {
    const m = location.pathname.match(/\/jobs\/([0-9a-f-]{36})/i);
    if (!m) return null;
    const id = m[1];
    if (infoCache[id]) return infoCache[id];
    try {
      // Give up after 8 seconds so a slow AccuLynx never leaves the button hanging
      const ctrl = new AbortController();
      const killer = setTimeout(() => ctrl.abort(), 8000);
      let res;
      try {
        res = await fetch('/api/jobOverview/' + id + '/GetLocationInformationWithInsurance', { signal: ctrl.signal });
      } finally {
        clearTimeout(killer);
      }
      if (!res.ok) return null;
      const data = await res.json();
      const job = (data && data.job) || {};
      const ls = (job.JobDetail && job.JobDetail.LeadSource) || {};
      const firstContact = (job.JobContacts && job.JobContacts[0] && job.JobContacts[0].Contact) || {};
      const info = {
        // The customer's real first name as saved on the job. If it holds two
        // people (e.g. "John and Lesley"), only the first single name is used ("John").
        firstName: String(firstContact.FirstName || '').trim().split(/\s+/)[0],
        leadSource: ls.FullName || ls.Name || '',
        trades: (job.Trades || []).map((t) => t && t.Name).filter(Boolean),
      };
      infoCache[id] = info;
      return info;
    } catch (e) {
      return null;
    }
  }

  // Backup: read the labeled value from the page if it happens to be there
  function getLabeledValue(label) {
    const re = new RegExp('^\\s*' + label + ':?\\s*$', 'i');
    for (const dt of document.querySelectorAll('dt')) {
      if (re.test(dt.textContent) && dt.nextElementSibling) {
        return dt.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
      }
    }
    return '';
  }

  // Lead source, e.g. "Field Marketing: Brandon Dean" -> "Brandon"
  function cleanLeadSource(raw) {
    if (!raw) return '';
    if (raw.includes(':')) {
      const after = raw.split(':').pop().trim();
      return after.split(/\s+/)[0];
    }
    return raw.trim();
  }

  // The "You met with ___." sentence.
  // RULE: if the lead source is "Internet", you can't meet with the internet,
  // so it says "You reached out to us." instead.
  function meetSentence(leadRaw) {
    const source = cleanLeadSource(leadRaw);
    if (/^internet$/i.test(source)) return 'You reached out to us.';
    return 'You met with ' + (source || '__________') + '.';
  }

  // Trade / product, e.g. "Siding / Soffit / Fascia" -> "siding, soffit and fascia"
  function formatTrade(tradeNames) {
    const parts = [];
    tradeNames.forEach((name) => {
      String(name)
        .split('/')
        .map((p) => p.trim().toLowerCase())
        .filter((p) => p && p !== '--')
        .forEach((p) => parts.push(p));
    });
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
  }

  // ---------- The two messages ----------

  async function buildNextDayMessage() {
    const info = await fetchJobInfo();
    const leadRaw = (info && info.leadSource) || getLabeledValue('Lead Source');
    const name = (info && info.firstName) || getFirstName() || '__________';
    const address = getAddress() || '__________';
    return (
      'Hey ' + name + '! This is Andrew with Amos. ' +
      meetSentence(leadRaw) + ' ' +
      'I was calling about our penciled in appointment tomorrow at ' + address + '. ' +
      'Call me back when you get a chance.'
    );
  }

  async function buildAnyMessage() {
    const info = await fetchJobInfo();
    const leadRaw = (info && info.leadSource) || getLabeledValue('Lead Source');
    const tradeNames = info && info.trades.length ? info.trades : [getLabeledValue('Trade')];
    const name = (info && info.firstName) || getFirstName() || '__________';
    const trade = formatTrade(tradeNames) || '__________';
    const address = getAddress() || '__________';
    return (
      'Hey ' + name + '! This is Andrew with Amos. ' +
      meetSentence(leadRaw) + ' ' +
      'I was calling about the ' + trade + ' at ' + address + '. ' +
      'Call me back when you get a chance.'
    );
  }

  // ---------- The M3 comment (goes in COMMENT boxes, not text messages) ----------

  // Date a number of days from today, using the day the button is clicked.
  // Format: Month/Day/Year with no leading zeros and a 2-digit year, e.g. 12/3/26
  function dateFromToday(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(-2);
  }

  // M3 = exactly 2 weeks (14 days) out
  function buildM3Message() {
    return (
      'Required number of calls/texts/attempts have been made. ' +
      'Pushing out to Mars 3 for a 2 week FU. \n' +
      dateFromToday(14)
    );
  }

  // M1 = exactly 4 weeks (28 days) out, so it always lands on the same day of the week
  // ("txt" = PER TXT., anything else = PER ATT.)
  function buildM1Message(kind) {
    const first =
      kind === 'txt'
        ? 'Per Text: Pushing out to Mars 1 for a 4 week FU.'
        : 'Required number of calls have been made. Pushing out to Mars 1 for a 4 week FU.';
    return first + '\n' + dateFromToday(28);
  }

  // ---------- The CONF confirmation notes template (EXACT format, left blank to fill in) ----------
  // Note: some lines end with a space on purpose, exactly as in the original template.
  const CONF_TEMPLATE = [
    'Lead Source:  ',
    'Product Interest:',
    'Current Product Material: ',
    'Current Issues/Concerns: ',
    'Age of Product: ',
    'Year of Home Built: ',
    'Year Home was Purchased: ',
    'Style of Home:',
    'Email:',
    'Work Schedules ',
    'Mrs: ',
    'Mr:',
  ].join('\n');

  // ---------- Put the text in the box so AccuLynx notices it ----------

  function fillTextarea(ta, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    ta.focus();
  }

  // ---------- Build and place the buttons ----------

  function makeButton(label, title, margin) {
    const b = document.createElement('button');
    b.type = 'button'; // never submits the form
    b.setAttribute(BTN_ATTR, label);
    b.textContent = label;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = [
      'background:#d32f2f',
      'color:#ffffff',
      'border:1px solid #ffffff',
      'box-shadow:0 0 0 1px #d32f2f',
      'border-radius:4px',
      'font-size:11px',
      'font-weight:700',
      'line-height:1',
      'padding:4px 6px',
      'margin:' + margin,
      'cursor:pointer',
      'align-self:center',
    ].join(';');
    return b;
  }

  // Every kind of text-message box in AccuLynx:
  //   1) the "Text Message" tab at the top of the Messages page (new text)
  //   2) the reply box that opens under a message (Reply button)
  const SMS_TEXTAREAS = [
    'textarea[placeholder="Enter Text Message"]', // reply box
    '.text-message-form textarea',                // new Text Message tab
  ].join(',');

  function addButtons() {
    document.querySelectorAll(SMS_TEXTAREAS).forEach((ta) => {
      const box = ta.closest('.inline-form') || ta.closest('.text-message-form');
      if (!box) return;
      if (box.querySelector('[' + BTN_ATTR + ']')) return; // already added

      // Find the paper clip (Attachments) button in this same box
      const clip =
        box.querySelector('button.btn-attachments') ||
        box.querySelector('.text-message__bottom-row button');
      if (!clip) return;

      const btn24 = makeButton('24', 'Next day text', '0 6px 0 16px');
      btn24.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        fillTextarea(ta, await buildNextDayMessage());
      });

      const btnAny = makeButton('Any', 'Any appointment text', '0 16px 0 0');
      btnAny.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        fillTextarea(ta, await buildAnyMessage());
      });

      clip.insertAdjacentElement('afterend', btn24);
      btn24.insertAdjacentElement('afterend', btnAny);
    });
  }

  // The comment boxes: the main "Comment" tab box and the reply-to-comment box.
  // The "M" button goes right next to the paper clip.
  const COMMENT_BOXES = [
    { ta: '.add-comment textarea', box: '.add-comment', clip: '.add-comment__message-options > button' },
    { ta: 'textarea[placeholder="Enter Comment"]', box: '.inline-form', clip: 'button.btn-attachments' },
  ];

  function addCommentButtons() {
    COMMENT_BOXES.forEach((cfg) => {
      document.querySelectorAll(cfg.ta).forEach((ta) => {
        const box = ta.closest(cfg.box);
        if (!box) return;
        if (box.querySelector('[' + BTN_ATTR + '="M"]')) return; // already added
        const clip = box.querySelector(cfg.clip);
        if (!clip) return;

        // One "M" button next to the paper clip. Clicking it opens the 4-option menu.
        const btnM = makeButton('M', 'Mars comments', '0 8px');
        btnM.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(btnM, ta, M_MENU_ITEMS);
        });

        // One "!" button right next to the M button. Clicking it opens the quick-notes menu.
        const btnBang = makeButton('!', 'Quick notes', '0 8px 0 0');
        btnBang.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(btnBang, ta, BANG_MENU_ITEMS);
        });

        // Order next to the paper clip: M, then !
        clip.insertAdjacentElement('afterend', btnM);
        btnM.insertAdjacentElement('afterend', btnBang);
      });
    });
  }

  // The options in the "!" menu, in order. Each one types its text into the comment box.
  // (The name on the button is on the left, the text it enters is on the right.)
  const BANG_MENU_ITEMS = [
    ['NA', 'NA'],
    ['NALVM', 'NA LVM'],
    ['NAX2LVM', 'NAX2 LVM'],
    ['PL', 'NAX2 (Pipeline Work)'],
    ['PL!', 'NAX2 (Pipeline Work) Required number of calls have been made. Pushing out to Mars 1 for a 1 month FU.'],
    ['RH', 'NA Rehash'],
  ].map(([label, text]) => [label, (ta) => fillTextarea(ta, text)]);

  // The four options in the "M" menu, in order. Each one fills the comment box.
  const M_MENU_ITEMS = [
    ['M1 - PER TXT.', (ta) => fillTextarea(ta, buildM1Message('txt'))],
    ['M1 - PER ATT.', (ta) => fillTextarea(ta, buildM1Message('att'))],
    ['M2 - CONF.', (ta) => fillConf(ta)],
    ['M3 - NO CONT.', (ta) => fillTextarea(ta, buildM3Message())],
  ];

  // CONF button: same red/white look as the others
  function makeConfButton(margin) {
    return makeButton('CONF', 'Confirmation notes template', margin);
  }

  // Fill the template and put the cursor at the end of the first line (Lead Source)
  function fillConf(ta) {
    fillTextarea(ta, CONF_TEMPLATE);
    try {
      const pos = CONF_TEMPLATE.indexOf('\n');
      ta.setSelectionRange(pos, pos);
    } catch (e) { /* not important */ }
  }

  // The Notes box on the "Create Lead" page has no paper clip, so the CONF
  // button goes right above the Notes box.
  function addLeadNotesButton() {
    document
      .querySelectorAll('.create-lead-view__tools-panel textarea.accu-textarea__textarea')
      .forEach((ta) => {
        const wrap = ta.closest('.accu-textarea');
        if (!wrap || !wrap.parentElement) return;
        if (wrap.parentElement.querySelector('[' + BTN_ATTR + '="CONF"]')) return; // already added

        const btn = makeConfButton('0 0 6px 0');
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          fillConf(ta);
        });
        wrap.insertAdjacentElement('beforebegin', btn);
      });
  }

  // ---------- The little menu that opens under the "M" and "!" buttons ----------

  let mMenu = null;

  function closeMenu() {
    if (mMenu) {
      clearInterval(mMenu._timer);
      mMenu.remove();
      mMenu = null;
    }
  }

  function openMenu(anchor, ta, items) {
    // Clicking the same button again while its menu is open just closes it
    if (mMenu && mMenu._anchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();

    const r = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu._anchor = anchor;
    menu.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:' + r.left + 'px',
      'top:' + (r.bottom + 4) + 'px',
      'background:#ffffff',
      'border:1px solid #d32f2f',
      'border-radius:4px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'padding:4px',
      'display:flex',
      'flex-direction:column',
      'gap:4px',
    ].join(';');

    items.forEach(([label, action]) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.textContent = label;
      opt.style.cssText = [
        'background:#d32f2f',
        'color:#ffffff',
        'border:1px solid #ffffff',
        'border-radius:4px',
        'font-size:11px',
        'font-weight:700',
        'line-height:1',
        'padding:6px 10px',
        'cursor:pointer',
        'text-align:left',
        'white-space:nowrap',
      ].join(';');
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        action(ta);
        closeMenu();
      });
      menu.appendChild(opt);
    });

    document.body.appendChild(menu);
    mMenu = menu;

    // The comment box grows and shrinks as you click in it, which moves the M button.
    // Keep the menu stuck right under the M button while it is open.
    menu._timer = setInterval(() => {
      if (!document.body.contains(anchor)) {
        closeMenu();
        return;
      }
      const rr = anchor.getBoundingClientRect();
      menu.style.left = rr.left + 'px';
      menu.style.top = rr.bottom + 4 + 'px';
    }, 80);
  }

  // Close the menu when you click anywhere else, press Escape, or scroll
  document.addEventListener(
    'mousedown',
    (e) => {
      if (
        mMenu &&
        !mMenu.contains(e.target) &&
        !(e.target.closest && e.target.closest('[' + BTN_ATTR + '="M"],[' + BTN_ATTR + '="!"]'))
      ) {
        closeMenu();
      }
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('scroll', closeMenu, true);

  function addAllButtons() {
    addButtons();
    addCommentButtons();
    addLeadNotesButton();
  }

  // AccuLynx loads pieces of the page as you click around, so keep watching.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(addAllButtons, 200);
  }).observe(document.body, { childList: true, subtree: true });

  addAllButtons();
})();
