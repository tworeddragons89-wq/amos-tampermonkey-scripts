/**
 * Lead Sheet App - back end (Google Apps Script)
 *
 * What it does:
 *  1. A rep types their name in the app -> a row is added to the "Reps" sheet and you get an email.
 *  2. YOU paste that rep's GroupMe Bot ID into column D of their row. That assigns their thread.
 *  3. The app then unlocks for that rep. Their posts are sent to GroupMe from here,
 *     so Bot IDs never reach anyone's phone.
 *
 * To CHANGE a rep's thread: edit the Bot ID in column D.
 * To REMOVE a rep: clear the Bot ID cell (or delete the row). Their app locks again.
 */

const NOTIFY_EMAIL = "mars2@amosexteriors.com";   // where new-request emails go
const SHEET_TITLE  = "Lead Sheet App - Reps";
const HEADERS      = ["Requested", "Name", "Device ID", "Bot ID (YOU fill this in)", "Last Post", "Notes"];
const MAX_ROWS     = 500;

/* ---------- RUN THIS ONCE from the editor (Run button) ---------- */
function setup() {
  const ss = getSpreadsheet_();
  MailApp.sendEmail(NOTIFY_EMAIL, "Lead Sheet App is set up",
    "Your rep sheet is here:\n" + ss.getUrl() +
    "\n\nNew rep requests will appear in it, and you will get an email each time.");
  Logger.log("Sheet: " + ss.getUrl());
}

/* ---------- Web app entry points ---------- */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action === "status") {
    if (!validDevice_(p.device)) return json_({ ok: false, error: "bad device" });
    return json_(stateFor_(p.device));
  }
  return json_({ ok: true, hello: "Lead Sheet App" });
}

function doPost(e) {
  let body;
  try { body = JSON.parse(e.postData.contents); }
  catch (err) { return json_({ ok: false, error: "bad request" }); }
  if (!validDevice_(body.device)) return json_({ ok: false, error: "bad device" });

  if (body.action === "register") return register_(body);
  if (body.action === "post")     return post_(body);
  return json_({ ok: false, error: "unknown action" });
}

/* ---------- Actions ---------- */
function register_(body) {
  const name = cleanName_(body.name);
  if (name.length < 2) return json_({ ok: false, error: "Please type your full name." });

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const existing = findRow_(body.device);
    if (existing) return json_(stateFor_(body.device));   // already asked: don't duplicate

    const sh = getSheet_();
    if (sh.getLastRow() > MAX_ROWS) return json_({ ok: false, error: "Too many requests. Contact Andrew." });
    sh.appendRow([new Date(), name, body.device, "", "", ""]);

    try {
      MailApp.sendEmail(NOTIFY_EMAIL, "Lead Sheet App: " + name + " needs a thread",
        name + " asked for access.\n\nOpen the sheet, find their row, and paste their GroupMe Bot ID in column D:\n" +
        getSpreadsheet_().getUrl());
    } catch (mailErr) { /* the row is saved even if email fails */ }
  } finally {
    lock.releaseLock();
  }
  return json_({ ok: true, state: "pending", name: name });
}

function post_(body) {
  const text = String(body.text || "");
  if (!text.trim()) return json_({ ok: false, error: "Nothing to post." });
  if (text.length > 1000) return json_({ ok: false, error: "Message is over GroupMe's 1000-character limit. Shorten it and try again." });

  const r = findRow_(body.device);
  if (!r)     return json_({ ok: false, state: "none",    error: "This phone is not registered." });
  if (!r.bot) return json_({ ok: false, state: "pending", name: r.name, error: "Your thread has not been assigned yet." });

  const res = UrlFetchApp.fetch("https://api.groupme.com/v3/bots/post", {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ bot_id: r.bot, text: text }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 200 && code < 300) {
    getSheet_().getRange(r.row, 5).setValue(new Date());
    return json_({ ok: true, state: "assigned", name: r.name });
  }
  return json_({ ok: false, state: "assigned", name: r.name,
    error: "GroupMe refused the post (code " + code + "). Ask Andrew to check your Bot ID." });
}

/* ---------- Helpers ---------- */
function stateFor_(device) {
  const r = findRow_(device);
  if (!r)     return { ok: true, state: "none" };
  if (!r.bot) return { ok: true, state: "pending",  name: r.name };
  return            { ok: true, state: "assigned", name: r.name };
}

function findRow_(device) {
  const data = getSheet_().getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][2]) === device) {
      return { row: i + 1, name: String(data[i][1]), bot: String(data[i][3] || "").trim() };
    }
  }
  return null;
}

function validDevice_(d) { return typeof d === "string" && /^[A-Za-z0-9]{16,64}$/.test(d); }

function cleanName_(n) {
  let s = String(n || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (/^[=+\-@]/.test(s)) s = "'" + s;      // stop spreadsheet formula tricks
  return s;
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("SHEET_ID");
  if (id) { try { return SpreadsheetApp.openById(id); } catch (e) { /* recreate below */ } }
  const ss = SpreadsheetApp.create(SHEET_TITLE);
  props.setProperty("SHEET_ID", ss.getId());
  const sh = ss.getSheets()[0];
  sh.setName("Reps");
  sh.appendRow(HEADERS);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, HEADERS.length).setFontWeight("bold");
  sh.setColumnWidth(2, 200); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 260);
  return ss;
}

function getSheet_() {
  const ss = getSpreadsheet_();
  return ss.getSheetByName("Reps") || ss.getSheets()[0];
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
