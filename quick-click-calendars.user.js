// ==UserScript==
// @name         AccuLynx - Quick Click Calendars
// @namespace    amos-exteriors
// @version      1.0
// @description  Adds a "Quick Click" dropdown to the AccuLynx calendar page. One click opens only the calendars you need (VERIFY, RUNS, SALES or FINALS) and closes all the others.
// @match        https://my.acculynx.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
  HOW IT WORKS
  On the AccuLynx calendar page, a red "Quick Click" button appears next to "New Appointment".
  Click it, pick a group, and the calendars in that group are switched ON while every other
  calendar is switched OFF.

  TO CHANGE WHO IS IN A GROUP: edit the CONFIG block right below. One name per line, written the
  way it appears in the calendar list on the left side of the calendar page. If a person's name is
  spelled two ways, put both in one line separated by a | (example: 'Aaron Higginbotham|Arron Higginbotham').
  Press Ctrl+S after editing, then refresh AccuLynx.
*/

(function () {
  'use strict';

  // =====================================================================================
  // CONFIG - edit these when people change
  // =====================================================================================
  const CONFIG = {
    GROUPS: [
      {
        label: 'VERIFY',
        calendars: ['Terry Henton', 'Aaron Higginbotham|Arron Higginbotham'],
      },
      {
        label: 'RUNS',
        calendars: ['Needs Confirmed'],
      },
      {
        // Every rep calendar on the Lead Table, plus Matt Oneil
        label: 'SALES',
        calendars: [
          'Brian Freeman',
          'Cody Tumey',
          'Colin Spaeth',
          'Dakota Douglass',
          'David Karandos',
          'Duke Antonijevic',
          'Eric Bugh',
          'Fredrick Contreras',
          'Hunter Sroufe',
          'Jeremy Hilton',
          'Leah Young',
          'Matt LLoyd',
          'Nick Durm',
          'Pat Howard',
          'Pat Serak',
          'Patrick Murphy',
          'Robert Yailey',
          'Ryan Oldham',
          'Sean Michael',
          'Seth Mireles',
          'Zachary Laffin',
          'Matt ONeil|Matt Oneil|Matt O\'Neil',
        ],
      },
      {
        label: 'FINALS',
        calendars: ['Jamie Miller'],
      },
    ],
  };

  const BTN_ID = 'amos-quick-click-btn';
  const MENU_ID = 'amos-quick-click-menu';
  const TOAST_ID = 'amos-quick-click-toast';

  // ---------- helpers ----------

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Lower-case, no punctuation, single spaces - so "Fredrick  Contreras" == "fredrick contreras"
  const norm = (s) =>
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  // The calendar rows in the list on the left side of the calendar page
  function getItems() {
    return [...document.querySelectorAll('.calendar-item')].filter(
      (i) => i.querySelector('.calendar-item-name') && i.querySelector('.calendar-item-selector')
    );
  }
  const nameOf = (item) => item.querySelector('.calendar-item-name').textContent;
  const selectorOf = (item) => item.querySelector('.calendar-item-selector');
  const isOn = (item) => selectorOf(item).classList.contains('selected');

  // If something is typed in the "Find a calendar" box, it hides calendars - empty it first.
  async function clearCalendarSearch() {
    const panels = [...document.querySelectorAll('.filter-panel')];
    const panel = panels.find((p) => {
      const t = p.querySelector('.header-title');
      return t && /^\s*Calendars\s*$/.test(t.textContent);
    });
    const input = panel && panel.querySelector('input.form-v3-text__input');
    if (input && input.value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(400);
    }
  }

  async function waitForItems() {
    for (let i = 0; i < 30; i++) {
      if (getItems().length) return true;
      await sleep(100);
    }
    return false;
  }

  // ---------- the message that pops up after a click ----------

  let toastTimer = null;
  function toast(message, isProblem) {
    let t = document.getElementById(TOAST_ID);
    if (!t) {
      t = document.createElement('div');
      t.id = TOAST_ID;
      document.body.appendChild(t);
    }
    t.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:28px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'max-width:560px',
      'padding:12px 18px',
      'border-radius:6px',
      'font:600 14px/1.35 Arial,sans-serif',
      'color:#ffffff',
      'background:' + (isProblem ? '#b71c1c' : '#2e7d32'),
      'box-shadow:0 4px 14px rgba(0,0,0,0.35)',
    ].join(';');
    t.textContent = message;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.remove(), isProblem ? 9000 : 4500);
  }

  // ---------- do the work: turn the group ON, everything else OFF ----------

  let busy = false;

  async function applyGroup(group) {
    if (busy) return;
    busy = true;
    try {
      if (!(await waitForItems())) {
        toast('I could not find the calendar list on this page. Open the Calendar page and try again.', true);
        return;
      }
      await clearCalendarSearch();

      // each wanted calendar = a list of accepted spellings
      const wanted = group.calendars.map((c) => c.split('|').map(norm));
      const wantedSet = new Set(wanted.flat());

      const allNames = getItems().map((i) => norm(nameOf(i)));
      const notFound = group.calendars.filter((c, idx) => !wanted[idx].some((n) => allNames.includes(n)));

      // two passes so anything that got re-drawn in the middle is fixed
      for (let pass = 0; pass < 2; pass++) {
        let clicks = 0;
        for (const name of allNames) {
          const item = getItems().find((i) => norm(nameOf(i)) === name);
          if (!item) continue;
          const should = wantedSet.has(name);
          if (isOn(item) !== should) {
            selectorOf(item).click();
            clicks += 1;
            await sleep(80);
          }
        }
        await sleep(400);
        if (clicks === 0) break;
      }

      // check the result
      const items = getItems();
      const on = items.filter(isOn);
      const wrong = on.filter((i) => !wantedSet.has(norm(nameOf(i))));
      const missedOn = items.filter((i) => wantedSet.has(norm(nameOf(i))) && !isOn(i));

      let msg = group.label + ': ' + on.length + ' calendar' + (on.length === 1 ? '' : 's') + ' open.';
      let problem = false;
      if (notFound.length) {
        msg += ' Not in the calendar list: ' + notFound.map((n) => n.split('|')[0]).join(', ') + '.';
        problem = true;
      }
      if (wrong.length || missedOn.length) {
        msg += ' Some calendars did not switch - click ' + group.label + ' again.';
        problem = true;
      }
      toast(msg, problem);
    } catch (e) {
      toast('Quick Click ran into a problem: ' + (e && e.message ? e.message : e), true);
    } finally {
      busy = false;
    }
  }

  // ---------- the dropdown ----------

  function closeMenu() {
    const m = document.getElementById(MENU_ID);
    if (m) m.remove();
  }

  function openMenu(anchor) {
    if (document.getElementById(MENU_ID)) {
      closeMenu();
      return;
    }
    const r = anchor.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:' + r.left + 'px',
      'top:' + (r.bottom + 4) + 'px',
      'min-width:' + r.width + 'px',
      'background:#ffffff',
      'border:1px solid #d32f2f',
      'border-radius:4px',
      'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'padding:4px',
      'display:flex',
      'flex-direction:column',
      'gap:4px',
    ].join(';');

    CONFIG.GROUPS.forEach((group) => {
      const opt = document.createElement('button');
      opt.type = 'button';
      opt.textContent = group.label;
      opt.style.cssText = [
        'background:#d32f2f',
        'color:#ffffff',
        'border:1px solid #ffffff',
        'border-radius:4px',
        'font:700 13px/1 Arial,sans-serif',
        'padding:9px 12px',
        'cursor:pointer',
        'text-align:left',
        'white-space:nowrap',
      ].join(';');
      opt.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeMenu();
        applyGroup(group);
      });
      menu.appendChild(opt);
    });
    document.body.appendChild(menu);
  }

  // close the menu when you click elsewhere, press Escape, scroll or resize
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!document.getElementById(MENU_ID)) return;
      const inMenu = e.target.closest && e.target.closest('#' + MENU_ID);
      const onBtn = e.target.closest && e.target.closest('#' + BTN_ID);
      if (!inMenu && !onBtn) closeMenu();
    },
    true
  );
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeMenu();
  });
  window.addEventListener('scroll', closeMenu, true);
  window.addEventListener('resize', closeMenu);

  // ---------- the "Quick Click" button, next to "New Appointment" ----------

  function ensureButton() {
    const onCalendar = location.pathname.indexOf('/calendar') === 0;
    const existing = document.getElementById(BTN_ID);
    if (!onCalendar) {
      if (existing) existing.remove();
      closeMenu();
      return;
    }
    if (existing && document.body.contains(existing)) return;

    const appt = document.querySelector('button.button-appointment');
    if (!appt) return;

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.type = 'button';
    btn.textContent = 'Quick Click ▾';
    btn.title = 'Open only the calendars you need';
    btn.style.cssText = [
      'background:#d32f2f',
      'color:#ffffff',
      'border:1px solid #ffffff',
      'box-shadow:0 0 0 1px #d32f2f',
      'border-radius:4px',
      'font:700 14px/1 Arial,sans-serif',
      'padding:12px 16px',
      'margin:0 12px 0 0',
      'cursor:pointer',
      'flex-shrink:0',
      'white-space:nowrap',
    ].join(';');
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openMenu(btn);
    });

    // put it just before the divider line that sits in front of "New Appointment"
    const prev = appt.previousElementSibling;
    const anchor = prev && /divider/.test(prev.className) ? prev : appt;
    anchor.insertAdjacentElement('beforebegin', btn);
  }

  // AccuLynx swaps pages without reloading, so keep watching.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(ensureButton, 200);
  }).observe(document.body, { childList: true, subtree: true });

  ensureButton();
})();
