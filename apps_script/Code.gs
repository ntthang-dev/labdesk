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
        machine_pass: occupiedFallback.data['machine_pass'] || ''
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
    machine_pass: targetRow.data['machine_pass'] || ''
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
