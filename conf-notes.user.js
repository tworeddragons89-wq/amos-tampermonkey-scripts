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
