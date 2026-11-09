// ==UserScript==
// @name         Field Marketing – Today's Leads Check & GroupMe Snapshot
// @namespace    amos-exteriors-field-marketing
// @version      1.1.3
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/field-marketing-leads.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/field-marketing-leads.user.js
// @description  For the Events & Retail and Canvass managers: pulls today's Field Marketing leads from the AccuLynx Lead Sources Report, shows/downloads one report per team so lead sources can be checked, then builds an encouraging snapshot image for GroupMe.
// @match        https://my.acculynx.com/reports/basic/leadsources*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  SETTINGS – change these if names ever change in AccuLynx
   * ------------------------------------------------------------------ */
  const TEAMS = [
    {
      key: 'events',
      name: 'Events & Retail',
      thread: 'Field Marketing: Events and Retail',
      manager: 'Nathan Hedeen',
      // AccuLynx Lead Source text that belongs to this team
      matches: (src) => /events\s*&\s*retail/i.test(src),
      cheer: ['Show up, smile, and let the booth do the talking!', 'Every conversation is a future customer. Go get it!'],
      accent: '#E4572E',
    },
    {
      key: 'canvass',
      name: 'Canvass Team',
      thread: 'Field Marketing: Canvass',
      manager: 'Crissy Sanders',
      // Canvass = main lead source "Field Marketing"; any JW sub lead source (e.g. "JW Isaac") also counts as Canvass
      matches: (src, sub) => src.trim().toLowerCase() === 'field marketing' || /^jw\b/i.test((sub || '').trim()),
      cheer: ['Every door you knock gets us here. Keep it rolling!', 'Your hustle on the street is putting appointments on the board!'],
      accent: '#1B998B',
    },
  ];
  const EXCLUDE_MILESTONES = ['dead']; // canceled/dead leads are not "going out"
  // Leads sitting with these people are not part of today's run, so they are left out of the reports and the image
  const EXCLUDED_REPS = /^(mars\s*[123]\b|needs confirmed|bruce)/i;
  const COLUMNS = [
    'Lead Source', 'Sub Lead Source', 'Job Name', 'Primary Contact: Phone',
    'Current Milestone', 'Work Type', 'Job Last Touched Date', 'Dead Lead Reason',
  ];

  /* ------------------------------------------------------------------ *
   *  Small helpers
   * ------------------------------------------------------------------ */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const todayLabel = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const fileDate = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  let allRows = [];      // every lead scraped for today
  let confirmed = false; // managers ticked "lead sources are correct"
  let scrapeProblems = []; // groups that could not be fully read

  /* ------------------------------------------------------------------ *
   *  Step 1 – set the report to Today / Initial Appointment Date
   * ------------------------------------------------------------------ */
  function setSelect(sel, optionText) {
    const opt = [...sel.options].find((o) => o.text.trim() === optionText);
    if (!opt) throw new Error('Could not find "' + optionText + '" in the report options.');
    if (sel.value === opt.value) return false;
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  const MAX_TODAY_LEADS = 600; // a normal "Today" report is well under this; far more means the date did not apply
  function pageTotal() {
    const all = document.body.innerText.match(/Total Groups:\s*\d+\s*Total Records:\s*(\d+)/);
    return all ? +all[1] : null;
  }
  // Waits until the report's total is small and has stopped changing (or time runs out)
  async function waitForTodayTotal(maxMs) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const t = pageTotal();
      if (t !== null && t <= MAX_TODAY_LEADS) {
        await sleep(1500);
        if (pageTotal() === t) return t;
      }
      await sleep(700);
    }
    return pageTotal();
  }
  function topLeftSelect(optionText) {
    const list = $$('select').filter((s) => s.offsetParent !== null && [...s.options].some((o) => o.text.trim() === optionText));
    list.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top || a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    return list[0];
  }
  async function setReportToToday() {
    const refSel = topLeftSelect('Initial Appointment Date');
    const rangeSel = topLeftSelect('Yesterday');
    if (!refSel || !rangeSel) throw new Error('This does not look like the Lead Sources Report. Open Reports ▸ Lead Sources Report first.');
    setSelect(refSel, 'Initial Appointment Date');
    await sleep(800);
    let total = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Bounce through "Yesterday" so AccuLynx always re-pulls fresh data for Today
      setSelect(rangeSel, 'Yesterday');
      await sleep(2500);
      setSelect(rangeSel, 'Today');
      total = await waitForTodayTotal(25000);
      if (total === null || total <= MAX_TODAY_LEADS) return;
    }
    throw new Error('The report is showing ' + total + ' leads, which is far more than one day. Make sure Date Range says "Today" and Reference Date says "Initial Appointment Date", wait for the report to finish loading, and press Pull again.');
  }

  // OK = no filter, or a filter on the main (Parent) Lead Source that only lists Field Marketing sources.
  // Anything else (e.g. "Sub Lead Source contains JW") could hide leads, so the script stops and says so.
  function filterIsOk(f) {
    return /Parent Lead Source/i.test(f) && /Field Marketing/i.test(f) && !/Sub Lead Source|Salesperson|Milestone|Work Type|Job Name/i.test(f);
  }
  function currentFilterText() {
    const m = document.body.innerText.match(/Filter:\s*([^\n]*)/);
    return m ? m[1].trim() : '';
  }

  // Finds the filter rows in the "Edit Report" side panel (each looks like "Where ..." with a remove button beside it)
  const filterRows = () => $$('div').filter((d) => d.children.length === 2 && d.children[1].tagName === 'BUTTON' && /^Where /.test((d.children[0].textContent || '').trim()));
  // Takes off any filter that could hide leads (for example "Sub Lead Source contains JW"). Nothing is saved.
  async function clearRestrictiveFilters() {
    const filt = currentFilterText();
    if (!filt || filterIsOk(filt)) return false;
    msg('Removing the report filter “' + esc(filt) + '” (this is not saved)…');
    const open = $$('a').find((e) => (e.textContent || '').trim() === 'Edit Report');
    if (open) { open.click(); await sleep(1500); }
    for (let i = 0; i < 10; i++) {
      const bad = filterRows().find((d) => !filterIsOk((d.children[0].textContent || '').trim()));
      if (!bad) break;
      bad.children[1].click();
      await sleep(3000);
    }
    const left = currentFilterText();
    if (left && !filterIsOk(left)) throw new Error('I could not remove the filter “' + left + '”. Click Actions ▸ Edit Report, press the ✕ beside the filter, then press Pull again.');
    const close = $$('a').find((e) => (e.textContent || '').trim() === 'Close Edit');
    if (close) close.click();
    await sleep(1000);
    return true;
  }

  /* ------------------------------------------------------------------ *
   *  Step 2 – read every lead (the page only draws ~25 rows at a time,
   *  so each group is scrolled top-to-bottom and rows are collected)
   * ------------------------------------------------------------------ */
  const groupFilled = (tb) => !!$('td.nested-table th', tb);
  const waitFilled = async (tb, tries = 15) => { for (let i = 0; i < tries && !groupFilled(tb); i++) await sleep(200); return groupFilled(tb); };
  // Makes sure every salesperson group is open AND has its leads loaded.
  // (A group can be marked "open" but empty after a refresh – closing and re-opening it loads it.)
  async function loadGroup(tb) {
    const header = $('td.sticky-grouped-header', tb) || $('tr', tb);
    if (!header) return false;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (groupFilled(tb)) return true;
      if (tb.classList.contains('open')) { header.click(); await sleep(450); } // close it first
      header.click(); await sleep(450);                                        // (re)open it
      if (await waitFilled(tb)) return true;
    }
    return groupFilled(tb);
  }
  async function scrapeLeads() {
    const seen = new Map();
    const problems = [];
    for (const tb of $$('tbody.tbl-accordion-section')) {
      const header = $('td.sticky-grouped-header', tb);
      const name = ((header && header.textContent) || 'a group').trim();
      if (!(await loadGroup(tb))) { problems.push(name); continue; }
      const nested = $('td.nested-table', tb);
      const heads = $$('th', nested).map((t) => (t.innerText || t.textContent || '').trim());
      const scroller = $('.vue-recycle-scroller', nested);
      if (!scroller || !heads.length) continue;
      const m = nested.innerText.match(/Total Records:\s*(\d+)/);
      const expected = m ? +m[1] : null;
      const before = seen.size;
      const grab = () => {
        $$('tr.reports-table__row', scroller).forEach((tr) => {
          const cells = $$('td', tr).map((c) => (c.innerText || c.textContent || '').trim());
          const rec = {};
          heads.forEach((h, i) => { if (h) rec[h] = cells[i] || ''; });
          const key = name + '|' + heads.map((h) => rec[h] || '').join('|');
          if (!seen.has(key)) seen.set(key, rec);
        });
      };
      // Scroll the group top-to-bottom, as many passes as needed, until every lead the group claims is read
      for (let pass = 0; pass < 5; pass++) {
        scroller.scrollTop = 0;
        await sleep(350);
        grab();
        let guard = 0;
        while (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 2 && guard++ < 300) {
          scroller.scrollTop += Math.max(100, scroller.clientHeight - 60);
          await sleep(250);
          grab();
        }
        scroller.scrollTop = scroller.scrollHeight;
        await sleep(300);
        grab();
        if (expected === null || seen.size - before >= expected) break;
        await sleep(700);
      }
      scroller.scrollTop = 0;
      if (expected !== null && seen.size - before !== expected) problems.push(name + ' (read ' + (seen.size - before) + ' of ' + expected + ')');
    }
    const rows = [...seen.values()];
    const total = pageTotal();
    if (total !== null && rows.length !== total && !problems.length) problems.push('read ' + rows.length + ' leads but the report total is ' + total);
    scrapeProblems = problems;
    return rows;
  }

  /* ------------------------------------------------------------------ *
   *  Team splitting + summaries
   * ------------------------------------------------------------------ */
  const isDead = (r) => EXCLUDE_MILESTONES.includes((r['Current Milestone'] || '').trim().toLowerCase());
  const teamOf = (r) => TEAMS.find((t) => t.matches(r['Lead Source'] || '', r['Sub Lead Source'] || ''));
  // JW leads follow the same rule: if they are with Needs Confirmed / Mars / Bruce they are NOT going out.
  const isHeld = (r) => EXCLUDED_REPS.test((r['Primary Salesperson'] || '').trim());
  function teamRows(team, includeDead) {
    return allRows
      .filter((r) => teamOf(r) === team && !isHeld(r) && (includeDead || !isDead(r)))
      .sort((a, b) => (a['Sub Lead Source'] || '').localeCompare(b['Sub Lead Source'] || '') || (a['Job Name'] || '').localeCompare(b['Job Name'] || ''));
  }
  function countBy(rows, col, blank) {
    const m = new Map();
    rows.forEach((r) => { const k = (r[col] || '').trim() || blank; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }

  /* ------------------------------------------------------------------ *
   *  Excel reports (one workbook per team)
   * ------------------------------------------------------------------ */
  function downloadExcel(team) {
    if (typeof XLSX === 'undefined') { alert('The Excel library did not load. Check your internet connection and reload the page.'); return; }
    const incDead = $('#fml-dead').checked;
    const rows = teamRows(team, incDead);
    const sheet1 = XLSX.utils.json_to_sheet(rows.map((r) => Object.fromEntries(COLUMNS.map((c) => [c, r[c] || '']))), { header: COLUMNS });
    sheet1['!cols'] = [22, 22, 26, 18, 16, 10, 20, 18].map((w) => ({ wch: w }));
    const by = countBy(rows, 'Sub Lead Source', '(blank – needs a source)');
    const sheet2 = XLSX.utils.aoa_to_sheet([['Sub Lead Source', 'Leads Going Out'], ...by, ['TOTAL', rows.length]]);
    sheet2['!cols'] = [{ wch: 34 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet1, 'Leads Today');
    XLSX.utils.book_append_sheet(wb, sheet2, 'By Lead Source');
    XLSX.writeFile(wb, team.name.replace(/[^\w]+/g, '_') + '_Leads_' + fileDate() + '.xlsx');
  }

  /* ------------------------------------------------------------------ *
   *  GroupMe snapshot image (canvas → PNG)
   * ------------------------------------------------------------------ */
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function fitText(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 3 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }
  function drawList(ctx, title, items, x, y, w, accent, maxItems, topOverride) {
    ctx.fillStyle = '#0B2545'; ctx.font = '700 30px Arial, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(title, x, y);
    const shown = items.slice(0, maxItems);
    const rest = items.slice(maxItems).reduce((s, i) => s + i[1], 0);
    const top = topOverride || (shown[0] && shown[0][1]) || 1;
    let yy = y + 44;
    const rowH = 60;
    shown.forEach(([name, n]) => {
      ctx.textAlign = 'left'; ctx.fillStyle = '#0B2545'; ctx.font = '600 23px Arial, sans-serif';
      ctx.fillText(fitText(ctx, name, w - 60), x, yy);
      ctx.textAlign = 'right'; ctx.font = '800 26px Arial, sans-serif'; ctx.fillStyle = accent;
      ctx.fillText(String(n), x + w, yy);
      ctx.fillStyle = '#E3E9F2'; roundRect(ctx, x, yy + 10, w, 12, 6); ctx.fill();
      ctx.fillStyle = accent; roundRect(ctx, x, yy + 10, Math.max(14, (w * n) / top), 12, 6); ctx.fill();
      yy += rowH;
    });
    ctx.textAlign = 'left';
    if (rest > 0) { ctx.fillStyle = '#5B6B82'; ctx.font = 'italic 22px Arial, sans-serif'; ctx.fillText('+ ' + rest + ' more', x, yy); yy += 34; }
    return yy;
  }
  function buildImage(team) {
    const rows = teamRows(team, false);
    const W = 1080, H = 1350;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    // background
    ctx.fillStyle = '#F4F7FB'; ctx.fillRect(0, 0, W, H);
    // header band
    const g = ctx.createLinearGradient(0, 0, W, 330); g.addColorStop(0, '#0B2545'); g.addColorStop(1, '#13315C');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, 330);
    ctx.fillStyle = team.accent; ctx.fillRect(0, 330, W, 10);
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center';
    ctx.font = '700 28px Arial, sans-serif'; ctx.fillText(team.name.toUpperCase() + '  •  FIELD MARKETING', W / 2, 70);
    ctx.font = '800 66px Arial, sans-serif'; ctx.fillText('Leads Are Going Out!', W / 2, 160);
    ctx.font = '400 30px Arial, sans-serif'; ctx.fillStyle = '#C9D6EA'; ctx.fillText(todayLabel(), W / 2, 215);
    ctx.fillStyle = '#FFFFFF'; ctx.font = 'italic 28px Arial, sans-serif';
    ctx.fillText('Thank you for the hustle that put these on the board.', W / 2, 285);
    // big number card
    ctx.fillStyle = '#FFFFFF'; roundRect(ctx, 60, 370, W - 120, 210, 28); ctx.fill();
    ctx.fillStyle = team.accent; ctx.font = '800 150px Arial, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(String(rows.length), W / 2 - 170, 520);
    ctx.fillStyle = '#0B2545'; ctx.textAlign = 'left'; ctx.font = '800 44px Arial, sans-serif';
    ctx.fillText(rows.length === 1 ? 'appointment' : 'appointments', W / 2 - 60, 484);
    ctx.font = '400 30px Arial, sans-serif'; ctx.fillStyle = '#5B6B82'; ctx.fillText('going out today', W / 2 - 60, 530);
    // lists
    // Lead sources only – who the leads are assigned to is never shown on the image
    const bySrc = countBy(rows, 'Sub Lead Source', 'Unlabeled');
    ctx.textAlign = 'left';
    if (bySrc.length > 8) {
      const colW = (W - 180) / 2;
      drawList(ctx, 'Who Brought Them In', bySrc.slice(0, 8), 60, 650, colW, team.accent, 8, bySrc[0][1]);
      drawList(ctx, '', bySrc.slice(8), 60 + colW + 60, 650, colW, team.accent, 8, bySrc[0][1]);
    } else {
      drawList(ctx, 'Who Brought Them In', bySrc, 60, 650, W - 120, team.accent, 8);
    }
    // footer
    const cheer = team.cheer[new Date().getDate() % team.cheer.length];
    const fy = H - 150;
    ctx.fillStyle = '#0B2545'; roundRect(ctx, 60, fy, W - 120, 100, 24); ctx.fill();
    ctx.fillStyle = '#FFFFFF'; ctx.textAlign = 'center'; ctx.font = '700 30px Arial, sans-serif';
    ctx.fillText(fitText(ctx, cheer, W - 180), W / 2, fy + 60);
    return cv;
  }
  function showImage(team) {
    const cv = buildImage(team);
    const url = cv.toDataURL('image/png');
    const box = $('#fml-preview');
    box.innerHTML = '<div style="font-weight:700;margin:8px 0 4px">' + esc(team.name) + ' snapshot</div>' +
      '<img src="' + url + '" style="width:100%;border:1px solid #ccd;border-radius:8px"><br>' +
      '<a download="' + esc(team.name.replace(/[^\w]+/g, '_')) + '_Snapshot_' + fileDate() + '.png" href="' + url + '" class="fml-btn" style="display:inline-block;margin-top:8px;text-decoration:none">⬇ Download image for GroupMe</a>';
  }

  /* ------------------------------------------------------------------ *
   *  Panel UI
   * ------------------------------------------------------------------ */
  function css() {
    const s = document.createElement('style');
    s.textContent = `
    #fml-fab{position:fixed;right:18px;bottom:18px;z-index:99998;background:#13315C;color:#fff;border:0;border-radius:28px;padding:12px 18px;font:700 14px Arial;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)}
    #fml-panel{position:fixed;right:18px;bottom:70px;z-index:99999;width:440px;max-height:82vh;overflow:auto;background:#fff;border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.35);font:13px Arial,sans-serif;color:#0B2545;display:none}
    #fml-panel h3{margin:0;padding:14px 16px;background:#13315C;color:#fff;border-radius:14px 14px 0 0;font-size:16px}
    #fml-body{padding:12px 16px 16px}
    .fml-btn{background:#13315C;color:#fff;border:0;border-radius:8px;padding:9px 12px;font:700 13px Arial;cursor:pointer;margin:3px 4px 3px 0}
    .fml-btn[disabled]{background:#9aa7ba;cursor:not-allowed}
    .fml-warn{background:#FFF3CD;border:1px solid #ffe08a;border-radius:8px;padding:8px 10px;margin:8px 0}
    .fml-card{border:1px solid #d7deea;border-radius:10px;padding:10px;margin:10px 0}
    .fml-card h4{margin:0 0 6px;font-size:14px}
    .fml-t{width:100%;border-collapse:collapse;font-size:12px}.fml-t th,.fml-t td{border-bottom:1px solid #e6ebf3;padding:3px 4px;text-align:left}
    .fml-t th{background:#eef2f8}.fml-bad{background:#fde8e8}
    `;
    document.head.appendChild(s);
  }
  function build() {
    css();
    const fab = document.createElement('button'); fab.id = 'fml-fab'; fab.textContent = '📋 Field Marketing Leads'; document.body.appendChild(fab);
    const p = document.createElement('div'); p.id = 'fml-panel';
    p.innerHTML = '<h3>Field Marketing – Today’s Leads</h3><div id="fml-body"></div>';
    document.body.appendChild(p);
    fab.onclick = () => { p.style.display = p.style.display === 'block' ? 'none' : 'block'; if (p.style.display === 'block' && !allRows.length) home(); };
  }
  function home() {
    $('#fml-body').innerHTML =
      '<p><b>Step 1.</b> Pull today’s leads, then check the lead sources.<br><b>Step 2.</b> Tick the box to confirm, then make the GroupMe image.</p>' +
      '<button class="fml-btn" id="fml-run">▶ Pull Today’s Leads</button><div id="fml-msg"></div>';
    $('#fml-run').onclick = run;
  }
  function msg(html) { const m = $('#fml-msg'); if (m) m.innerHTML = html; }

  async function run() {
    confirmed = false;
    $('#fml-run').disabled = true;
    try {
      msg('Checking the report filter…');
      await clearRestrictiveFilters();
      msg('Setting the report to <b>Today</b> (Initial Appointment Date)…');
      await setReportToToday();
      msg('Reading every lead (this takes a few seconds)…');
      allRows = await scrapeLeads();
      if (!allRows.length) { msg('<div class="fml-warn">No leads found for today.</div>'); $('#fml-run').disabled = false; return; }
      results();
    } catch (e) {
      msg('<div class="fml-warn"><b>Something went wrong:</b> ' + esc(e.message) + '</div>');
      $('#fml-run').disabled = false;
    }
  }

  function results() {
    const incDead = $('#fml-dead') ? $('#fml-dead').checked : false;
    const unmatched = allRows.filter((r) => !teamOf(r));
    const held = allRows.filter((r) => teamOf(r) && isHeld(r)).length;
    const dead = allRows.filter((r) => teamOf(r) && !isHeld(r) && isDead(r)).length;
    let html = '<p><b>' + todayLabel() + '</b></p>';
    if (scrapeProblems.length) html += '<div class="fml-warn"><b>Check before you trust these numbers:</b> some leads may be missing (' + esc(scrapeProblems.join('; ')) + '). Press “Pull again”.</div>';
    if (held) html += '<div class="fml-warn">' + held + ' Field Marketing lead(s) are with Mars 1/2/3, Needs Confirmed or Bruce, so they are <b>not</b> part of today’s run and were left out.</div>';
    if (unmatched.length) {
      const srcs = [...new Set(unmatched.map((r) => r['Lead Source'] || '(blank)'))].join(', ');
      html += '<div class="fml-warn"><b>' + unmatched.length + ' lead(s) are not Field Marketing</b> (' + esc(srcs) + ') and were left out of both reports.</div>';
    }
    html += '<label><input type="checkbox" id="fml-dead"' + (incDead ? ' checked' : '') + '> Include Dead/canceled leads (' + dead + ')</label>';
    TEAMS.forEach((t) => {
      const rows = teamRows(t, incDead);
      const blanks = rows.filter((r) => !(r['Sub Lead Source'] || '').trim()).length;
      html += '<div class="fml-card"><h4>' + esc(t.name) + ' — ' + rows.length + ' lead' + (rows.length === 1 ? '' : 's') + ' <span style="font-weight:400">(' + esc(t.manager) + ')</span></h4>';
      const jw = rows.filter((r) => /^jw\b/i.test((r['Sub Lead Source'] || '').trim())).length;
      if (jw) html += '<div style="margin:0 0 6px;color:#5B6B82">Includes ' + jw + ' JW lead' + (jw === 1 ? '' : 's') + '.</div>';
      if (blanks) html += '<div class="fml-warn">' + blanks + ' lead(s) have no Sub Lead Source – please fix in AccuLynx.</div>';
      html += '<table class="fml-t"><tr><th>Sub Lead Source</th><th>Lead</th><th>Status</th></tr>' +
        rows.map((r) => '<tr' + (!(r['Sub Lead Source'] || '').trim() ? ' class="fml-bad"' : '') + '><td>' + esc(r['Sub Lead Source'] || '—') + '</td><td>' + esc(r['Job Name'] || '') + '</td><td>' + esc(r['Current Milestone'] || '') + '</td></tr>').join('') +
        '</table><button class="fml-btn" data-xl="' + t.key + '">⬇ Download ' + esc(t.name) + ' report (.xlsx)</button></div>';
    });
    html += '<div class="fml-card"><h4>Step 2 – GroupMe snapshot</h4>' +
      '<label><input type="checkbox" id="fml-ok"' + (confirmed ? ' checked' : '') + '> I have checked the lead sources and they are correct.</label><br>' +
      TEAMS.map((t) => '<button class="fml-btn" data-img="' + t.key + '" ' + (confirmed ? '' : 'disabled') + '>🖼 ' + esc(t.name) + ' image</button>').join('') +
      '<div id="fml-preview"></div></div>' +
      '<button class="fml-btn" id="fml-again">↻ Pull again (after fixing sources)</button>';
    $('#fml-body').innerHTML = html;
    $$('[data-xl]').forEach((b) => (b.onclick = () => downloadExcel(TEAMS.find((t) => t.key === b.dataset.xl))));
    $$('[data-img]').forEach((b) => (b.onclick = () => showImage(TEAMS.find((t) => t.key === b.dataset.img))));
    $('#fml-dead').onchange = results;
    $('#fml-ok').onchange = (e) => { confirmed = e.target.checked; $$('[data-img]').forEach((b) => (b.disabled = !confirmed)); };
    $('#fml-again').onclick = () => { allRows = []; home(); run(); };
  }

  /* ------------------------------------------------------------------ */
  const wait = setInterval(() => { if (document.body) { clearInterval(wait); build(); } }, 400);
})();
