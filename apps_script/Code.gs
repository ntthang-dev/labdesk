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

// ----- API handlers -----

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || e.parameter.action;

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    switch (action) {
      case 'login':
        return handleLogin(body);
      case 'logout':
        return handleLogout(body);
      default:
        return jsonResponse({ error: 'unknown action' }, 400);
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
  const { student_id, full_name } = body;
  if (!student_id || !full_name) {
    return jsonResponse({ allowed: false, reason: 'Missing student_id or full_name' });
  }

  // (Optional) Check Students whitelist
  const studentsSheet = getSheet('Students');
  if (studentsSheet) {
    const students = studentsSheet.getDataRange().getValues();
    if (students.length > 1) {
      const headers = students[0];
      const idCol = headers.indexOf('student_id');
      const statusCol = headers.indexOf('status');
      if (idCol !== -1) {
        const found = students.slice(1).find(r => String(r[idCol]).trim() === String(student_id).trim());
        if (!found) {
          writeAuditLog(student_id, '', 'login_denied', 'Student not in whitelist');
          return jsonResponse({ allowed: false, reason: 'Student ID not recognized' });
        }
        if (statusCol !== -1 && String(found[statusCol]).trim().toLowerCase() === 'suspended') {
          writeAuditLog(student_id, '', 'login_denied', 'Student suspended');
          return jsonResponse({ allowed: false, reason: 'Account suspended' });
        }
      }
    }
  }

  // Check if student already has an active session on ANY machine
  const sessSheet = getSheet('ActiveSessions');
  const sessData = sessSheet.getDataRange().getValues();
  if (sessData.length < 2) {
    return jsonResponse({ allowed: false, reason: 'No machines configured' });
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
      return jsonResponse({
        allowed: false,
        reason: 'You already have an active session on machine ' + occupiedMachine
      });
    }
  }

  // Find first free machine (or a specific machine if body.machine_id is provided)
  let targetRow = null;
  for (let r = 1; r < sessData.length; r++) {
    const isFree = String(sessData[r][statusCol]).trim().toLowerCase() === 'free';
    if (body.machine_id) {
      if (String(sessData[r][machineIdCol]).trim() === String(body.machine_id).trim()) {
        if (!isFree) {
          const occupant = sessData[r][sessHeaders.indexOf('full_name')] || sessData[r][sidCol];
          writeAuditLog(student_id, body.machine_id, 'login_denied', 'Machine occupied by ' + occupant);
          return jsonResponse({
            allowed: false,
            reason: 'Machine ' + body.machine_id + ' is currently in use'
          });
        }
        targetRow = { row: r + 1, data: {}, headers: sessHeaders };
        sessHeaders.forEach((h, i) => { targetRow.data[h] = sessData[r][i]; });
        break;
      }
    } else if (isFree) {
      targetRow = { row: r + 1, data: {}, headers: sessHeaders };
      sessHeaders.forEach((h, i) => { targetRow.data[h] = sessData[r][i]; });
      break;
    }
  }

  if (!targetRow) {
    writeAuditLog(student_id, body.machine_id || '', 'login_denied', 'No free machine');
    return jsonResponse({ allowed: false, reason: 'No machine available' });
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

  writeAuditLog(student_id, machineId, 'login_allowed', '');

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
    setSessionCell(found.row, found.headers, 'status', 'free');
    setSessionCell(found.row, found.headers, 'student_id', '');
    setSessionCell(found.row, found.headers, 'full_name', '');
    setSessionCell(found.row, found.headers, 'session_token', '');
    setSessionCell(found.row, found.headers, 'started_at', '');
    setSessionCell(found.row, found.headers, 'admin_action', '');

    writeAuditLog(studentId, machineId, 'kicked', 'Admin kick');
    return jsonResponse({ status: 'kicked' });
  }

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

  setSessionCell(found.row, found.headers, 'status', 'free');
  setSessionCell(found.row, found.headers, 'student_id', '');
  setSessionCell(found.row, found.headers, 'full_name', '');
  setSessionCell(found.row, found.headers, 'session_token', '');
  setSessionCell(found.row, found.headers, 'started_at', '');
  setSessionCell(found.row, found.headers, 'admin_action', '');

  writeAuditLog(studentId, machineId, 'logout', '');
  return jsonResponse({ success: true });
}

// ----- response helper -----

function jsonResponse(data, code) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
