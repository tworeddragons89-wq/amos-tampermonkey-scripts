// ==UserScript==
// @name         CONF NOTES
// @namespace    amos-exteriors
// @version      1.1
// @description  Adds a small red "CONF" button that fills in the confirmation notes template with one click. It shows up next to the paper clip on comment and reply boxes, and above the Notes box when creating a new lead.
// @match        https://my.acculynx.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const BTN_ATTR = 'data-amos-conf-btn';

  // The EXACT confirmation template, double spaced (a blank line between each line).
  // Some lines end with a space on purpose.
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
  ].join('\n\n');

  // Put the text in the box so AccuLynx notices it
  function fillTextarea(ta, text) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.dispatchEvent(new Event('blur', { bubbles: true }));
    ta.focus();
  }

  // Fill the template and put the cursor at the end of the first line (Lead Source)
  function fillConf(ta) {
    fillTextarea(ta, CONF_TEMPLATE);
    try {
      const pos = CONF_TEMPLATE.indexOf('\n');
      ta.setSelectionRange(pos, pos);
    } catch (e) { /* not important */ }
  }

  function makeConfButton(margin, ta) {
    const b = document.createElement('button');
    b.type = 'button'; // never submits the form
    b.setAttribute(BTN_ATTR, '1');
    b.textContent = 'CONF';
    b.title = 'Confirmation notes template';
    b.setAttribute('aria-label', 'Confirmation notes template');
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
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillConf(ta);
    });
    return b;
  }

  // 1) Comment boxes: the main "Comment" tab box and the reply-to-comment box.
  //    The button goes right next to the paper clip.
  const COMMENT_BOXES = [
    { ta: '.add-comment textarea', box: '.add-comment', clip: '.add-comment__message-options > button' },
    { ta: 'textarea[placeholder="Enter Comment"]', box: '.inline-form', clip: 'button.btn-attachments' },
  ];

  function addCommentButtons() {
    COMMENT_BOXES.forEach((cfg) => {
      document.querySelectorAll(cfg.ta).forEach((ta) => {
        const box = ta.closest(cfg.box);
        if (!box) return;
        if (box.querySelector('[' + BTN_ATTR + ']')) return; // already added
        const clip = box.querySelector(cfg.clip);
        if (!clip) return;
        clip.insertAdjacentElement('afterend', makeConfButton('0 8px', ta));
      });
    });
  }

  // 2) Create Lead page: the Notes box has no paper clip, so the button goes right above it.
  function addLeadNotesButton() {
    document
      .querySelectorAll('.create-lead-view__tools-panel textarea.accu-textarea__textarea')
      .forEach((ta) => {
        const wrap = ta.closest('.accu-textarea');
        if (!wrap || !wrap.parentElement) return;
        if (wrap.parentElement.querySelector('[' + BTN_ATTR + ']')) return; // already added
        wrap.insertAdjacentElement('beforebegin', makeConfButton('0 0 6px 0', ta));
      });
  }

  function addAll() {
    addCommentButtons();
    addLeadNotesButton();
  }

  // AccuLynx loads pieces of the page as you click around, so keep watching.
  let timer = null;
  new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(addAll, 200);
  }).observe(document.body, { childList: true, subtree: true });

  addAll();
})();
