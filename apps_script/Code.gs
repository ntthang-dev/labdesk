// =============================================================
// Lab Login System — Google Apps Script Backend (MVP)
// =============================================================
// Deploy as Web App: Execute as "Me", Who has access: "Anyone"
//
// ENV CONFIG (Script Properties → Project Settings → Script Properties):
//   SHARED_SECRET  = your-secret-string
//
// Sheets required in the same spreadsheet:
//   - Students       (optional, for whitelist)
//   - ActiveSessions (pre-populate with 1 row per lab machine)
//   - AuditLog       (empty, auto-filled)
// =============================================================

const PROPS = PropertiesService.getScriptProperties();
const SHARED_SECRET = PROPS.getProperty('SHARED_SECRET') || 'change-me';

// A client polls `status` every ~12s. If nothing has been heard for this long the
// student's machine died or the app was force-quit, so the slot is reclaimed.
const SESSION_TIMEOUT_MS = 60 * 1000;

// ----- helpers -----

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function generateToken() {
  return Utilities.getUuid();
}

function now() {
  return new Date().toISOString();
}

function writeAuditLog(studentId, machineId, eventType, detail) {
  const sheet = getSheet('AuditLog');
  sheet.appendRow([now(), studentId, machineId, eventType, detail || '']);
}

// Find a row in ActiveSessions by a column header value.
// Returns {row: 1-based, data: {col_header: value, ...}} or null.
function findSessionRow(headerName, value) {
  const sheet = getSheet('ActiveSessions');
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return null;
  const headers = data[0];
  const colIdx = headers.indexOf(headerName);
  if (colIdx === -1) return null;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][colIdx]).trim() === String(value).trim()) {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = data[r][i]; });
      return { row: r + 1, data: obj, headers: headers };
    }
  }
  return null;
}

function setSessionCell(row, headers, colName, value) {
  const sheet = getSheet('ActiveSessions');
  const colIdx = headers.indexOf(colName);
  if (colIdx === -1) return;
  sheet.getRange(row, colIdx + 1).setValue(value);
}

// `last_seen` was added after the first deployments; create it so an existing
// spreadsheet keeps working without the admin editing headers by hand.
function ensureColumn(sheetName, colName) {
  const sheet = getSheet(sheetName);
  if (!sheet) return;
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  if (headers.indexOf(colName) === -1) {
    sheet.getRange(1, headers.length + 1).setValue(colName);
  }
}

function freeSessionRow(row, headers) {
  setSessionCell(row, headers, 'status', 'free');
  setSessionCell(row, headers, 'student_id', '');
  setSessionCell(row, headers, 'full_name', '');
  setSessionCell(row, headers, 'session_token', '');
  setSessionCell(row, headers, 'started_at', '');
  setSessionCell(row, headers, 'admin_action', '');
  setSessionCell(row, headers, 'last_seen', '');
}

function parseTime(value) {
  if (!value) return 0;
  if (value instanceof Date) return value.getTime();
  const t = new Date(String(value)).getTime();
  return isNaN(t) ? 0 : t;
}

// Free any occupied row whose client stopped checking in. Returns true if the
// sheet was modified, so the caller knows to re-read it.
function reapStaleSessions() {
  const sheet = getSheet('ActiveSessions');
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return false;
  const headers = data[0];
  const statusCol = headers.indexOf('status');
  const lastSeenCol = headers.indexOf('last_seen');
  if (statusCol === -1 || lastSeenCol === -1) return false;

  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  let changed = false;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][statusCol]).trim().toLowerCase() !== 'occupied') continue;
    const seen = parseTime(data[r][lastSeenCol]) ||
        parseTime(data[r][headers.indexOf('started_at')]);
    if (seen === 0 || seen > cutoff) continue;
    writeAuditLog(data[r][headers.indexOf('student_id')],
        data[r][headers.indexOf('machine_id')], 'expired',
        (data[r][headers.indexOf('full_name')] || '') + ' - No heartbeat');
    freeSessionRow(r + 1, headers);
    changed = true;
  }
  return changed;
}

// Optional `Config` sheet (key | value, 2 columns, 1 row per key) for
// settings an admin wants to change without redeploying: min_version,
// latest_version, download_url so far. Sheet may not exist at all -
// callers get {} and every feature that reads from it just no-ops.
function readConfig() {
  const sheet = getSheet('Config');
  if (!sheet) return {};
  const data = sheet.getDataRange().getValues();
  const config = {};
  for (let r = 0; r < data.length; r++) {
    const key = String(data[r][0] || '').trim();
    if (key) config[key] = String(data[r][1] || '').trim();
  }
  return config;
}

// Compares dot-separated numeric versions ("1.2.0" vs "1.10.0"). Returns
// negative/0/positive like a normal comparator. Unparseable segments count
// as 0, so a malformed Config value fails open (never blocks login) rather
// than throwing.
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ----- API handlers -----

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || e.parameter.action;

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    // Allocating a machine is read-then-write; without a lock two simultaneous
    // logins can both see the same row as free.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (action) {
        case 'login':
          return handleLogin(body);
        case 'logout':
          return handleLogout(body);
        default:
          return jsonResponse({ error: 'unknown action' }, 400);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    const secret = e.parameter.secret;

    if (secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    switch (action) {
      case 'ping':
        return jsonResponse({
          status: 'ok',
          message: 'Google Apps Script Web App is connected successfully!',
          time: now()
        });
      case 'status':
        return handleStatus(e.parameter);
      default:
        return jsonResponse({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

// ----- login -----

function handleLogin(body) {
  const { student_id } = body;
  // The name typed by the student is only a fallback: whenever the Students
  // whitelist has a matching row, its own full_name is authoritative below
  // and overrides it (fixes the name recorded in AuditLog/ActiveSessions not
  // matching the roster - a typo, nickname or wrong capitalization typed at
  // login no longer sticks).
  let full_name = body.full_name;
  if (!student_id || !full_name) {
    return jsonResponse({ allowed: false, reason: 'Vui lòng nhập đầy đủ họ tên và MSSV.' });
  }

  // Remote forced-update gate (Config sheet, optional - see readConfig()).
  // Runs before anything else touches ActiveSessions, so a rejected client
  // never occupies a machine.
  const config = readConfig();
  if (config.min_version && body.client_version &&
      compareVersions(body.client_version, config.min_version) < 0) {
    writeAuditLog(student_id, '', 'login_denied',
        'Client version ' + body.client_version + ' below min ' + config.min_version);
    return jsonResponse({
      allowed: false,
      force_update: true,
      download_url: config.download_url || '',
      reason: 'Phiên bản LabDesk này đã cũ, cần cập nhật bản mới trước khi đăng nhập.'
    });
  }

  // (Optional) Check Students whitelist
  const studentsSheet = getSheet('Students');
  if (studentsSheet) {
    const students = studentsSheet.getDataRange().getValues();
    if (students.length > 1) {
      const headers = students[0];
      const idCol = headers.indexOf('student_id');
      const statusCol = headers.indexOf('status');
      const nameCol = headers.indexOf('full_name');
      if (idCol !== -1) {
        const found = students.slice(1).find(r => String(r[idCol]).trim() === String(student_id).trim());
        if (!found) {
          writeAuditLog(student_id, '', 'login_denied', 'Student not in whitelist (typed name: ' + full_name + ')');
          return jsonResponse({ allowed: false, reason: 'MSSV không có trong danh sách. Vui lòng liên hệ Quản trị viên.' });
        }
        if (statusCol !== -1 && String(found[statusCol]).trim().toLowerCase() === 'suspended') {
          writeAuditLog(student_id, '', 'login_denied', 'Student suspended (' + full_name + ')');
          return jsonResponse({ allowed: false, reason: 'Tài khoản của bạn đã bị tạm khoá. Vui lòng liên hệ Quản trị viên.' });
        }
        if (nameCol !== -1 && String(found[nameCol]).trim()) {
          full_name = String(found[nameCol]).trim();
        }
      }
    }
  }

  ensureColumn('ActiveSessions', 'last_seen');
  reapStaleSessions();

  // Check if student already has an active session on ANY machine
  const sessSheet = getSheet('ActiveSessions');
  const sessData = sessSheet.getDataRange().getValues();
  if (sessData.length < 2) {
    return jsonResponse({ allowed: false, reason: 'Hệ thống phòng lab chưa sẵn sàng. Vui lòng liên hệ Quản trị viên.' });
  }
  const sessHeaders = sessData[0];
  const sidCol = sessHeaders.indexOf('student_id');
  const statusCol = sessHeaders.indexOf('status');
  const machineIdCol = sessHeaders.indexOf('machine_id');

  for (let r = 1; r < sessData.length; r++) {
    if (String(sessData[r][sidCol]).trim() === String(student_id).trim() &&
        String(sessData[r][statusCol]).trim().toLowerCase() === 'occupied') {
      const occupiedMachine = sessData[r][machineIdCol];
      writeAuditLog(student_id, occupiedMachine, 'login_denied', 'Already has active session');
      // The audit log keeps the machine id for the admin; the student never needs it.
      return jsonResponse({
        allowed: false,
        reason: 'Bạn đang có một phiên đăng nhập khác chưa đăng xuất. Vui lòng đăng xuất phiên cũ trước.'
      });
    }
  }

  // Find first free machine (or a specific machine if body.machine_id is provided).
  // Remember the first *occupied* row too: if nothing is free, that row lets a
  // second student join the existing session as a view-only observer instead
  // of being flatly denied (RustDesk allows multiple simultaneous connections
  // to one host; view-only is enforced client-side, see LabDesk's
  // login_gate_page.dart).
  let targetRow = null;
  let occupiedFallback = null;
  for (let r = 1; r < sessData.length; r++) {
    const isFree = String(sessData[r][statusCol]).trim().toLowerCase() === 'free';
    if (body.machine_id) {
      if (String(sessData[r][machineIdCol]).trim() === String(body.machine_id).trim()) {
        if (!isFree) {
          occupiedFallback = { row: r + 1, data: {}, headers: sessHeaders };
          sessHeaders.forEach((h, i) => { occupiedFallback.data[h] = sessData[r][i]; });
          break;
        }
        targetRow = { row: r + 1, data: {}, headers: sessHeaders };
        sessHeaders.forEach((h, i) => { targetRow.data[h] = sessData[r][i]; });
        break;
      }
    } else if (isFree) {
      targetRow = { row: r + 1, data: {}, headers: sessHeaders };
      sessHeaders.forEach((h, i) => { targetRow.data[h] = sessData[r][i]; });
      break;
    } else if (!occupiedFallback) {
      occupiedFallback = { row: r + 1, data: {}, headers: sessHeaders };
      sessHeaders.forEach((h, i) => { occupiedFallback.data[h] = sessData[r][i]; });
    }
  }

  if (!targetRow) {
    if (occupiedFallback && occupiedFallback.data['session_token']) {
      const machineId = occupiedFallback.data['machine_id'];
      const controllerName = occupiedFallback.data['full_name'] || occupiedFallback.data['student_id'];
      writeAuditLog(student_id, machineId, 'view_joined',
          full_name + ' joined as viewer (controller: ' + controllerName + ')');
      return jsonResponse({
        allowed: true,
        mode: 'view',
        // Deliberately the CONTROLLER's token, not a new one: no extra sheet
        // row is created for viewers, so status()/kick/expiry/logout on the
        // controller's session transparently ends every viewer's poll loop
        // too, with zero schema changes.
        session_token: occupiedFallback.data['session_token'],
        machine_id: machineId,
        machine_name: occupiedFallback.data['machine_name'] || machineId,
        machine_pass: occupiedFallback.data['machine_pass'] || '',
        full_name: full_name,
        latest_version: config.latest_version || '',
        download_url: config.download_url || ''
      });
    }
    writeAuditLog(student_id, body.machine_id || '', 'login_denied', 'No free machine');
    return jsonResponse({ allowed: false, reason: 'Hiện không còn máy trống. Vui lòng thử lại sau.' });
  }

  // Allocate the session
  const token = generateToken();
  const machineId = targetRow.data['machine_id'];
  setSessionCell(targetRow.row, sessHeaders, 'status', 'occupied');
  setSessionCell(targetRow.row, sessHeaders, 'student_id', student_id);
  setSessionCell(targetRow.row, sessHeaders, 'full_name', full_name);
  setSessionCell(targetRow.row, sessHeaders, 'session_token', token);
  setSessionCell(targetRow.row, sessHeaders, 'started_at', now());
  setSessionCell(targetRow.row, sessHeaders, 'admin_action', '');
  setSessionCell(targetRow.row, sessHeaders, 'last_seen', now());

  writeAuditLog(student_id, machineId, 'login_allowed', full_name);

  return jsonResponse({
    allowed: true,
    session_token: token,
    machine_id: machineId,
    machine_name: targetRow.data['machine_name'] || machineId,
    machine_pass: targetRow.data['machine_pass'] || '',
    // The roster name (already overridden from Students above), so the client
    // shows the official name rather than whatever was typed at login.
    full_name: full_name,
    latest_version: config.latest_version || '',
    download_url: config.download_url || ''
  });
}

// ----- status -----

function handleStatus(params) {
  const token = params.token;
  if (!token) {
    return jsonResponse({ status: 'not_found' });
  }

  const found = findSessionRow('session_token', token);
  if (!found) {
    return jsonResponse({ status: 'not_found' });
  }

  const adminAction = String(found.data['admin_action'] || '').trim().toLowerCase();

  if (adminAction === 'kick') {
    // Process the kick
    const studentId = found.data['student_id'];
    const machineId = found.data['machine_id'];
    freeSessionRow(found.row, found.headers);

    writeAuditLog(studentId, machineId, 'kicked',
        (found.data['full_name'] || studentId) + ' - Admin kick');
    return jsonResponse({ status: 'kicked' });
  }

  setSessionCell(found.row, found.headers, 'last_seen', now());
  return jsonResponse({ status: 'active' });
}

// ----- logout -----

function handleLogout(body) {
  const token = body.session_token;
  if (!token) {
    return jsonResponse({ success: false, reason: 'Missing session_token' });
  }

  const found = findSessionRow('session_token', token);
  if (!found) {
    return jsonResponse({ success: false, reason: 'Session not found' });
  }

  const studentId = found.data['student_id'];
  const machineId = found.data['machine_id'];

  freeSessionRow(found.row, found.headers);

  writeAuditLog(studentId, machineId, 'logout', found.data['full_name'] || '');
  return jsonResponse({ success: true });
}

// ----- response helper -----

function jsonResponse(data, code) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ----- admin menu (Sheets UI only - never runs inside a Web App request) -----
//
// Runs bound to this spreadsheet: a click here is by definition the sheet's
// owner, so there is no auth check to add - the whole point is to avoid
// asking the admin to hunt for the right row by hand, per
// HUONG_DAN_QUAN_TRI.md's "nút bấm trong Sheets" choice over a separate
// admin web page.

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('LabDesk')
    .addItem('Đá sinh viên đang chọn (Kick)', 'adminKickSelectedRow')
    .addSeparator()
    .addItem('Khoá MSSV đang chọn', 'adminSuspendSelectedStudent')
    .addItem('Mở khoá MSSV đang chọn', 'adminUnsuspendSelectedStudent')
    .addSeparator()
    .addItem('Xem phiên đang chạy', 'adminShowActiveSessions')
    .addToUi();
}

// Shared by every admin menu item: which row is the admin's cursor on right
// now, on which sheet. Returns null (after alerting) if nothing usable is
// selected, so callers can just early-return.
function adminSelectedRow(expectedSheetName) {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== expectedSheetName) {
    ui.alert('Vui lòng chọn một dòng trong sheet "' + expectedSheetName + '" trước.');
    return null;
  }
  const range = sheet.getActiveRange();
  const row = range ? range.getRow() : 0;
  if (row < 2) {
    ui.alert('Vui lòng chọn một dòng dữ liệu (không phải hàng tiêu đề).');
    return null;
  }
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  const data = {};
  headers.forEach((h, i) => { data[h] = values[i]; });
  return { sheet, row, headers, data };
}

function adminKickSelectedRow() {
  const ui = SpreadsheetApp.getUi();
  const found = adminSelectedRow('ActiveSessions');
  if (!found) return;
  if (String(found.data['status'] || '').trim().toLowerCase() !== 'occupied') {
    ui.alert('Máy này hiện đang trống, không có ai để đá.');
    return;
  }
  setSessionCell(found.row, found.headers, 'admin_action', 'kick');
  ui.alert('Đã đánh dấu kick cho ' + (found.data['full_name'] || found.data['student_id']) +
      '. Phiên sẽ bị ngắt trong tối đa ~15 giây (lần poll kế tiếp của client).');
}

function adminSuspendSelectedStudent() {
  const ui = SpreadsheetApp.getUi();
  const found = adminSelectedRow('Students');
  if (!found) return;
  const statusCol = found.headers.indexOf('status');
  if (statusCol === -1) {
    ui.alert('Sheet "Students" chưa có cột "status".');
    return;
  }
  found.sheet.getRange(found.row, statusCol + 1).setValue('suspended');
  ui.alert('Đã khoá MSSV ' + found.data['student_id'] + '.');
}

function adminUnsuspendSelectedStudent() {
  const ui = SpreadsheetApp.getUi();
  const found = adminSelectedRow('Students');
  if (!found) return;
  const statusCol = found.headers.indexOf('status');
  if (statusCol === -1) {
    ui.alert('Sheet "Students" chưa có cột "status".');
    return;
  }
  found.sheet.getRange(found.row, statusCol + 1).setValue('active');
  ui.alert('Đã mở khoá MSSV ' + found.data['student_id'] + '.');
}

function adminShowActiveSessions() {
  const ui = SpreadsheetApp.getUi();
  const sheet = getSheet('ActiveSessions');
  if (!sheet) {
    ui.alert('Không tìm thấy sheet "ActiveSessions".');
    return;
  }
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) {
    ui.alert('Chưa có máy nào được cấu hình.');
    return;
  }
  const headers = data[0];
  const lines = [];
  for (let r = 1; r < data.length; r++) {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = data[r][i]; });
    const status = String(obj['status'] || '').trim().toLowerCase();
    if (status === 'occupied') {
      lines.push((obj['machine_name'] || obj['machine_id']) + ': ' +
          (obj['full_name'] || obj['student_id']) + ' (từ ' + obj['started_at'] + ')');
    } else {
      lines.push((obj['machine_name'] || obj['machine_id']) + ': trống');
    }
  }
  ui.alert('Phiên đang chạy', lines.join('\n'), ui.ButtonSet.OK);
}
