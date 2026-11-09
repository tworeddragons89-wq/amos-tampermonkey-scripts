// ==UserScript==
// @name         Amos Storm Report Button
// @namespace    amos-exteriors
// @version      1.5
// @updateURL    https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/storm-report-button.user.js
// @downloadURL  https://raw.githubusercontent.com/tworeddragons89-wq/amos-tampermonkey-scripts/main/storm-report-button.user.js
// @description  One click on Overview > Insurance tab: storm report (biggest hail) from Predictive Sales AI into Documents > Other, plus the 5 closest insurance jobs within 1 mile posted as a message.
// @match        https://my.acculynx.com/jobs/*
// @match        https://apps.predictivesalesai.com/admin/weather/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_openInTab
// @grant        GM_xmlhttpRequest
// @connect      scciwidgetops.blob.core.windows.net
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const RADIUS_MILES = 1;
  const MAX_JOBS = 5;
  const MILESTONES = ['Approved', 'Completed', 'Invoiced', 'Closed'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, timeoutMs = 60000, stepMs = 500) {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(stepMs);
    }
    return null;
  }

  function toast(msg, isError) {
    let box = document.getElementById('amos-storm-toast');
    if (!box) {
      box = document.createElement('div');
      box.id = 'amos-storm-toast';
      box.style.cssText = 'position:fixed;top:70px;right:20px;z-index:99999;max-width:360px;padding:12px 16px;border-radius:6px;font:14px Arial;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3)';
      document.body.appendChild(box);
    }
    box.style.background = isError ? '#c0392b' : '#2c3e50';
    box.textContent = msg;
  }

  // =====================================================================
  // PREDICTIVE SALES AI SIDE — runs only when the AccuLynx button sent it
  // =====================================================================
  if (location.host === 'apps.predictivesalesai.com') {
    const task = GM_getValue('psaiTask');
    if (!task || Date.now() - task.time > 5 * 60 * 1000) return;
    if (!/\/admin\/weather\/map/.test(location.pathname)) return;

    (async () => {
      toast('Amos: waiting for the storm list…');
      const findRadios = () => {
        const r = document.querySelectorAll('#modal-weather-report input[name=storm-report-select]');
        return r.length ? [...r] : null;
      };
      // v1.2: if the report window doesn't pop up on its own, click "Pull Report" to open it
      let radios = await waitFor(findRadios, 30000);
      if (!radios) {
        const pull = [...document.querySelectorAll('button,a')].find((b) => /Pull Report/i.test(b.textContent) && b.offsetParent);
        if (pull) pull.click();
        radios = await waitFor(findRadios, 60000);
      }
      if (!radios) return finish({ error: 'No storm list appeared in Predictive Sales AI.' });

      toast('Amos: picking the biggest hail storm…');
      // Biggest hail; ties go to the most recent (list is newest first)
      let best = -1, bestSize = 0, bestLabel = '';
      radios.forEach((r, i) => {
        const label = (r.closest('label,li,div')?.innerText || '').replace(/\s+/g, ' ').trim();
        const m = label.match(/([\d.]+)\s*"/);
        const size = m ? parseFloat(m[1]) : 0;
        if (size > bestSize) { bestSize = size; best = i; bestLabel = label; }
      });
      if (best < 0) return finish({ error: 'No hail storms listed for this address (wind only).' });

      radios[best].click();
      await sleep(600);
      const next = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Next' && b.offsetParent);
      if (!next) return finish({ error: 'Could not find the Next button in Predictive Sales AI.' });
      next.click();

      toast('Amos: generating the report…');
      const link = await waitFor(() => document.querySelector('#download-storm-report-btn')?.dataset.fileLink, 120000, 1000);
      if (!link) return finish({ error: 'Predictive Sales AI did not finish the report.' });

      const date = (bestLabel.match(/\d{1,2}\/\d{1,2}\/\d{4}/) || [''])[0].replace(/\//g, '-');
      finish({ link, size: bestSize, date });
    })();

    function finish(result) {
      GM_setValue('psaiResult_' + task.jobId, Object.assign({ time: Date.now() }, result));
      GM_deleteValue('psaiTask');
      if (result.error) { toast('Amos: ' + result.error, true); return; }
      toast('Amos: report sent back to AccuLynx. Closing…');
      setTimeout(() => window.close(), 1500);
    }
    return;
  }

  // =====================================================================
  // ACCULYNX SIDE
  // =====================================================================
  const jobId = (location.pathname.match(/\/jobs\/([0-9a-f-]{36})/) || [])[1];
  if (!jobId) return;

  // ---- Step 3 (on the Messages page): post the nearby-jobs message ----
  if (/\/comments/.test(location.pathname)) {
    const pending = GM_getValue('amosPost_' + jobId);
    if (pending && Date.now() - pending.time < 5 * 60 * 1000) {
      (async () => {
        const ta = await waitFor(() => [...document.querySelectorAll('textarea')].find((e) => e.offsetParent), 30000);
        if (!ta) return toast('Amos: could not find the message box.', true);
        ta.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(ta, pending.text);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        ta.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(800);
        const post = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Post' && b.offsetParent && !b.disabled);
        if (!post) return toast('Amos: message is filled in — click Post yourself.', true);
        post.click();
        GM_deleteValue('amosPost_' + jobId);
        toast('Amos: done! Storm report is in Other and the nearby jobs are posted.');
      })();
    }
    return;
  }

  // v1.3 FIX: AccuLynx's new Documents layout puts each folder in an .ax-panel
  // wrapped by a .dropzone. The old version grabbed the "Other" item in the
  // filter dropdown instead. Returns the Other folder's drop area.
  function otherFolderRow() {
    const title = [...document.querySelectorAll('.ax-panel__title')].find((e) => /^\s*Other\s*\(\d+\)\s*$/.test(e.textContent));
    return title ? title.closest('.dropzone') : null;
  }

  // ---- Step 2 (on the Documents page): upload the storm report to Other ----
  if (/\/documents/.test(location.pathname)) {
    const pending = GM_getValue('amosUpload_' + jobId);
    if (pending && Date.now() - pending.time < 5 * 60 * 1000) {
      (async () => {
        try {
          toast('Amos: uploading the storm report to Other…');
          // v1.5: a job with no documents shows an empty list with no folders,
          // so wait for either the Other folder or the "+ Document" button
          const ready = await waitFor(() => otherFolderRow() || addDocButton(), 30000);
          if (!ready) throw new Error('Could not find the Other folder or the Document button.');
          await sleep(1500);
          const blob = await downloadPdf(pending.link);
          await uploadToOther(blob, pending.fileName);
          GM_deleteValue('amosUpload_' + jobId);
          GM_setValue('amosPost_' + jobId, { text: pending.text, time: Date.now() });
          toast('Amos: posting the nearby jobs message…');
          location.href = `/jobs/${jobId}/comments`;
        } catch (err) {
          toast('Amos: ' + err.message, true);
        }
      })();
    }
    return;
  }

  // ---- Button on the Overview page, inside the Insurance tab ----
  if (!/^\/jobs\/[0-9a-f-]{36}\/?(overview)?\/?$/i.test(location.pathname)) return;

  setInterval(() => {
    const tab = [...document.querySelectorAll('h2.widget-title')].find((e) => /^\s*Insurance\s*$/i.test(e.textContent));
    if (!tab) return;
    const body = tab.closest('header')?.parentElement?.querySelector('.widget-body');
    const existing = document.querySelector('.amos-storm-btn');
    const active = tab.classList.contains('active');
    if (!active) { if (existing && !existing.disabled) existing.remove(); return; }
    if (!body || body.querySelector('.amos-storm-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'amos-storm-btn';
    btn.type = 'button';
    btn.textContent = 'Storm Report';
    btn.style.cssText = 'margin:4px 0 10px;padding:4px 12px;background:#c0392b;color:#fff;border:none;border-radius:4px;font:bold 12px Arial;cursor:pointer';
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(btn); });
    body.prepend(btn);
  }, 1000);

  async function getLead() {
    const name = document.querySelector('h1, .job-name, [class*=job-header] [class*=name]')?.textContent.trim() || '';
    const addrText = [...document.querySelectorAll('a')].map((a) => a.textContent.trim()).find((t) => /\b(IN|In)\s+\d{5}/.test(t)) || '';
    const street = addrText.split(',')[0];
    const queries = [street, street.split(/\s+/).slice(0, 2).join(' '), name].filter(Boolean);
    for (const q of queries) {
      const r = await fetch('/api/Search/GetTypeAheadSearch?noContacts=false&query=' + encodeURIComponent(q));
      const j = await r.json();
      const hit = (j.results || []).find((x) => x.Id === jobId);
      if (hit && hit.FullAddressGeoLocation) return hit;
    }
    throw new Error('Could not find this lead\'s address/location in AccuLynx.');
  }

  function miles(a, b) {
    const R = 3958.8, t = (x) => (x * Math.PI) / 180;
    const dLat = t(b.lat - a.lat), dLon = t(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  async function nearbyInsuranceJobs(lead) {
    const zip = (lead.FullAddress.match(/\b\d{5}\b(?!.*\b\d{5}\b)/) || [])[0];
    const city = (lead.FullAddress.split(',')[1] || '').trim();
    const searches = [zip, city].filter(Boolean);
    const found = new Map();
    for (const q of searches) {
      for (const ms of MILESTONES) {
        const p = new URLSearchParams({ filters: 'currentMilestoneList=' + ms, loadAll: 'true', onlyBalanceDue: 'false', onlyWatchList: 'false', page: '1', query: q, sort: 'lastTouched|desc', type: '2' });
        const j = await (await fetch('/api/joblist?' + p)).json();
        for (const r of j.results || []) {
          if (r.Id === jobId || !r.FullAddressGeoLocation) continue;
          // v1.4 FIX: skip other jobs at the lead's own house (same street address)
          if (r.FullAddress.split(',')[0].trim().toLowerCase() === lead.FullAddress.split(',')[0].trim().toLowerCase()) continue;
          if (!(r.WorkTypes || []).includes('Insurance')) continue;
          const d = miles(lead.FullAddressGeoLocation, r.FullAddressGeoLocation);
          if (d > RADIUS_MILES) continue;
          const contact = r.PrimaryContact?.Name || r.PrimaryContact?.FullName || '';
          const label = r.Name && contact && r.Name !== contact ? `${r.Name}: ${contact}` : (r.Name || contact);
          found.set(r.Id, { label, addr: r.FullAddress, d });
        }
      }
    }
    return [...found.values()].sort((a, b) => a.d - b.d).slice(0, MAX_JOBS);
  }

  function downloadPdf(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, responseType: 'blob',
        onload: (r) => (r.status === 200 ? resolve(r.response) : reject(new Error('Download failed (' + r.status + ')'))),
        onerror: () => reject(new Error('Download failed')),
      });
    });
  }

  function addDocButton() {
    return [...document.querySelectorAll('.job-docs-header_button')].find((b) => b.textContent.trim() === 'Document' && b.offsetParent);
  }

  function dropFile(zone, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const t of ['dragenter', 'dragover', 'drop']) {
      zone.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  }

  // v1.5: fallback for jobs with no documents yet — use "+ Document" →
  // folder Other → Next → Upload → drop the file → Add
  async function uploadViaAddDocument(file) {
    const btn = addDocButton();
    if (!btn) throw new Error('Could not find the Document button.');
    btn.click();
    const sel = await waitFor(() => document.querySelector('.ax-modal-content .select-folder select'), 15000);
    if (!sel) throw new Error('The Add Document window did not open.');
    const opt = [...sel.options].find((o) => /^\s*Other\s*\(/.test(o.textContent));
    if (!opt) throw new Error('No Other folder in the Add Document window.');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(800);
    const modalBtn = (txt) => [...document.querySelectorAll('.ax-modal-content button')].find((b) => b.textContent.trim() === txt && b.offsetParent);
    modalBtn('Next')?.click();
    const upTab = await waitFor(() => modalBtn('Upload'), 15000);
    if (!upTab) throw new Error('Could not find the Upload option.');
    upTab.click();
    const zone = await waitFor(() => document.querySelector('.ax-modal-content .local-file-uploader__drop-zone'), 15000);
    if (!zone) throw new Error('Could not find the upload drop area.');
    dropFile(zone, file);
    await sleep(2000);
    const add = await waitFor(() => { const b = modalBtn('Add'); return b && !b.disabled ? b : null; }, 30000);
    if (!add) throw new Error('The Add button never turned on — file may not have attached.');
    add.click();
  }

  async function uploadToOther(blob, fileName) {
    const file = new File([blob], fileName, { type: 'application/pdf' });
    const zone = otherFolderRow();
    if (zone) dropFile(zone, file);
    else await uploadViaAddDocument(file);
    // Confirm it landed in Other
    const folderId = '0f36d609-7ada-4c93-8b3a-b79a69c7c341';
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const folders = await (await fetch(`/api/v4/job-documents/${jobId}/job-document-folders`)).json();
      const other = folders.find((f) => f.Id === folderId || f.Name === 'Other');
      const files = other ? await (await fetch(`/api/v4/job-documents/${jobId}/job-document-folder-contents/${other.Id}`)).json() : [];
      if (JSON.stringify(files).includes(fileName)) return;
    }
    throw new Error('Upload did not show up in the Other folder — please check Documents.');
  }

  async function run(btn) {
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      toast('Amos: finding the lead\'s location…');
      const lead = await getLead();

      toast('Amos: finding insurance jobs within 1 mile…');
      const jobs = await nearbyInsuranceJobs(lead);

      toast('Amos: opening Predictive Sales AI…');
      GM_deleteValue('psaiResult_' + jobId);
      GM_setValue('psaiTask', { jobId, time: Date.now() });
      const g = lead.FullAddressGeoLocation;
      const psaiUrl = 'https://apps.predictivesalesai.com/admin/weather/map?' + new URLSearchParams({
        lat: g.lat, long: g.lon, zoom: '11', exactcoords: 'true',
        displayaddress: lead.FullAddress + ' USA', generatereport: 'true',
      });
      // v1.2 FIX: open in the FOREGROUND. Chrome pauses the map in background tabs,
      // so the storm list never appeared. The tab closes itself and returns you here.
      GM_openInTab(psaiUrl, { active: true, insert: true, setParent: true });

      const result = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ error: 'Predictive Sales AI took too long (3 min).' }), 180000);
        GM_addValueChangeListener('psaiResult_' + jobId, (k, o, v) => { if (v) { clearTimeout(timer); resolve(v); } });
      });
      if (result.error) throw new Error(result.error);

      const street = lead.FullAddress.split(',')[0];
      const fileName = `Storm Report - ${street} - Hail ${result.date}.pdf`;
      const text = jobs.length
        ? 'Jobs with insurance damage within 1 mile:\n\n' + jobs.map((j, i) => `${i + 1}. ${j.label}\n${j.addr}`).join('\n')
        : 'Jobs with insurance damage within 1 mile:\n\nNone found.';
      GM_setValue('amosUpload_' + jobId, { link: result.link, fileName, text, time: Date.now() });
      toast('Amos: report ready — going to Documents to upload…');
      location.href = `/jobs/${jobId}/documents`;
    } catch (err) {
      toast('Amos: ' + err.message, true);
      btn.disabled = false;
      btn.textContent = 'Storm Report';
    }
  }
})();
