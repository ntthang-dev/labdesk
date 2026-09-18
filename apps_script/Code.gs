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

// Bump this string whenever a deployed feature set changes. `action=version`
// (doGet, no secret required - see below) exists purely so an admin can
// confirm "did my copy-paste + New version deploy actually take effect?"
// with a single URL in a browser tab, without hunting for SHARED_SECRET
// first. Only ever returns this static string + a feature list, never any
// sheet data, so it deliberately skips the secret check that guards every
// other action.
const CODE_VERSION = '2026-09-18-schedule-feedback-group';
const CODE_FEATURES = ['view_only_queue', 'expires_at_countdown', 'group_restricted_view', 'schedule_booking', 'feedback', 'version_gate'];

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
// Shared by findSessionRow (always a fresh read) and handleStatus's cached
// read - the search itself doesn't care where `data` came from.
function searchSessionRow(data, headerName, value) {
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

function findSessionRow(headerName, value) {
  const sheet = getSheet('ActiveSessions');
  return searchSessionRow(sheet.getDataRange().getValues(), headerName, value);
}

// A busy lab (many students, each polling status() every ~12s) turns into
// N/12 sheet reads per second, all hitting the same ActiveSessions sheet -
// SpreadsheetApp reads are the slow part of every status() call. Caching a
// short-lived snapshot means concurrent polls landing within the same
// window share one read instead of each doing their own.
//
// Deliberately NOT used by handleLogin's allocation scan or by
// findSessionRow/handleLogout: those paths must always see the live sheet -
// this file's apps_script/formal/ TLA+ proof assumes exactly that, and nothing
// here changes the write side, only this one read path.
const ACTIVE_SESSIONS_CACHE_KEY = 'active_sessions_snapshot_v1';
const ACTIVE_SESSIONS_CACHE_TTL_SEC = 4; // < 12s poll interval; worst case
    // this adds ~4s to kick/expiry detection latency, still well inside the
    // ~15s the client and SETUP.md already document.

function getActiveSessionsDataCached() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(ACTIVE_SESSIONS_CACHE_KEY);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch (e) {
      // Corrupt cache entry: fall through to a fresh read rather than error.
    }
  }
  const sheet = getSheet('ActiveSessions');
  const data = sheet.getDataRange().getValues();
  cache.put(ACTIVE_SESSIONS_CACHE_KEY, JSON.stringify(data), ACTIVE_SESSIONS_CACHE_TTL_SEC);
  return data;
}

// Called only after kick/expiry processing (freeSessionRow via the cached
// read path) - without this, a second poll landing inside the same TTL
// window (e.g. a viewer sharing the just-kicked controller's token) would
// see the pre-free snapshot and reprocess the same kick/expiry a second
// time. The common "still active" path deliberately does NOT call this: it
// never changes status/admin_action/session_token, so leaving the cache as
// is there is what makes the caching worth doing at all.
function invalidateActiveSessionsCache() {
  CacheService.getScriptCache().remove(ACTIVE_SESSIONS_CACHE_KEY);
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
  setSessionCell(row, headers, 'expires_at', '');
  setSessionCell(row, headers, 'group', '');
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
  const expiresAtCol = headers.indexOf('expires_at');
  if (statusCol === -1 || lastSeenCol === -1) return false;

  const cutoff = Date.now() - SESSION_TIMEOUT_MS;
  const nowMs = Date.now();
  let changed = false;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][statusCol]).trim().toLowerCase() !== 'occupied') continue;
    const studentId = data[r][headers.indexOf('student_id')];
    const machineId = data[r][headers.indexOf('machine_id')];
    const fullName = data[r][headers.indexOf('full_name')] || '';

    // Per-session time limit (Config!max_minutes), separate from the
    // heartbeat check below - a student who is actively polling can still
    // be over their allotted time.
    const expiresAt = expiresAtCol === -1 ? 0 : parseTime(data[r][expiresAtCol]);
    if (expiresAt && nowMs >= expiresAt) {
      writeAuditLog(studentId, machineId, 'expired', fullName + ' - Time limit reached');
      freeSessionRow(r + 1, headers);
      changed = true;
      continue;
    }

    const seen = parseTime(data[r][lastSeenCol]) ||
        parseTime(data[r][headers.indexOf('started_at')]);
    if (seen === 0 || seen > cutoff) continue;
    writeAuditLog(studentId, machineId, 'expired', fullName + ' - No heartbeat');
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

// ----- scheduling (optional Schedule sheet, self-creating like Feedback) -----
//
// Reservation model: a fixed grid of same-length slots per day
// (Config!slot_start_hour..slot_end_hour, split into slot_duration_minutes
// chunks - defaults 7:00-19:00 in 2h blocks = 6 slots/day), not free-form
// time ranges. That keeps the "is this slot taken" check an exact string
// match instead of interval-overlap math, which is the whole reason this
// stays simple enough to trust: no two bookings can partially overlap by
// construction, only coincide or not.
// `parseInt(x, 10) || fallback` breaks for a legitimate 0 (e.g.
// slot_start_hour=0 for a lab open from midnight) - 0 is falsy in JS, so it
// silently gets overridden by the fallback instead of respected. Only an
// actually-missing/unparseable value should fall back.
function intConfig(value, fallback) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function slotConfig(config) {
  return {
    startHour: intConfig(config.slot_start_hour, 7),
    endHour: intConfig(config.slot_end_hour, 19),
    durationMin: intConfig(config.slot_duration_minutes, 120),
    daysAhead: intConfig(config.booking_days_ahead, 7),
  };
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// All slot label strings for one day, e.g. ["07:00-09:00", "09:00-11:00", ...].
function getSlotsForDay(config) {
  const sc = slotConfig(config);
  const slots = [];
  for (let mins = sc.startHour * 60; mins + sc.durationMin <= sc.endHour * 60; mins += sc.durationMin) {
    const startH = Math.floor(mins / 60), startM = mins % 60;
    const endMins = mins + sc.durationMin;
    const endH = Math.floor(endMins / 60), endM = endMins % 60;
    slots.push(pad2(startH) + ':' + pad2(startM) + '-' + pad2(endH) + ':' + pad2(endM));
  }
  return slots;
}

function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// The slot label covering right now, or null outside operating hours /
// between slots. Login-time enforcement (handleLogin) and check_availability
// both need "which slot is 'current'" to agree, so this is the one place
// that decides it.
function getCurrentSlot(config) {
  const now = new Date();
  const slots = getSlotsForDay(config);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const slot of slots) {
    const start = slot.split('-')[0].split(':');
    const startMin = parseInt(start[0], 10) * 60 + parseInt(start[1], 10);
    if (nowMin >= startMin && nowMin < startMin + slotConfig(config).durationMin) {
      return { date: dateStr(now), slot: slot };
    }
  }
  return null;
}

function ensureScheduleSheet() {
  let sheet = getSheet('Schedule');
  if (sheet) return sheet;
  sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Schedule');
  sheet.appendRow(['date', 'time_slot', 'machine_id', 'student_id', 'full_name', 'status', 'created_at']);
  return sheet;
}

// Active (status=booked) bookings as [{row, date, time_slot, machine_id,
// student_id, full_name}]. Loaded once per call site instead of re-scanning
// per lookup - the sheet stays small enough (days_ahead x slots x machines)
// that this is cheap.
function readActiveBookings() {
  const sheet = getSheet('Schedule');
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const cols = {
    date: headers.indexOf('date'), slot: headers.indexOf('time_slot'),
    machine: headers.indexOf('machine_id'), sid: headers.indexOf('student_id'),
    name: headers.indexOf('full_name'), status: headers.indexOf('status'),
  };
  const out = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][cols.status] || '').trim().toLowerCase() !== 'booked') continue;
    out.push({
      row: r + 1,
      date: String(data[r][cols.date] || '').trim(),
      time_slot: String(data[r][cols.slot] || '').trim(),
      machine_id: String(data[r][cols.machine] || '').trim(),
      student_id: String(data[r][cols.sid] || '').trim(),
      full_name: String(data[r][cols.name] || '').trim(),
    });
  }
  return out;
}

// Machine reserved for someone else right now? handleLogin's free-machine
// scan calls this so a walk-up student can't take a seat someone booked
// ahead of time - the entire point of having a schedule.
function reservedForSomeoneElse(machineId, studentId, config) {
  const current = getCurrentSlot(config);
  if (!current) return null;
  const booking = readActiveBookings().find(b =>
      b.date === current.date && b.time_slot === current.slot &&
      b.machine_id === machineId.trim());
  if (booking && booking.student_id !== String(studentId).trim()) return booking;
  return null;
}

function handleCheckAvailability(params) {
  const config = readConfig();
  const sc = slotConfig(config);
  const date = params.date || dateStr(new Date());
  const slots = getSlotsForDay(config);
  const bookings = readActiveBookings().filter(b => b.date === date);

  const sessSheet = getSheet('ActiveSessions');
  const machines = sessSheet ? sessSheet.getDataRange().getValues().slice(1)
      .map(r => ({ id: String(r[0] || '').trim(), name: String(r[1] || '').trim() })) : [];

  const grid = [];
  for (const slot of slots) {
    for (const m of machines) {
      const booking = bookings.find(b => b.time_slot === slot && b.machine_id === m.id);
      grid.push({
        date: date,
        time_slot: slot,
        machine_id: m.id,
        machine_name: m.name || m.id,
        available: !booking,
        booked_by: booking ? booking.full_name : null,
        booked_by_student_id: booking ? booking.student_id : null,
      });
    }
  }
  return jsonResponse({ date: date, days_ahead: sc.daysAhead, slots: grid });
}

function handleMyBookings(params) {
  const studentId = String(params.student_id || '').trim();
  if (!studentId) return jsonResponse({ bookings: [] });
  const today = dateStr(new Date());
  const bookings = readActiveBookings()
      .filter(b => b.student_id === studentId && b.date >= today)
      .map(b => ({ date: b.date, time_slot: b.time_slot, machine_id: b.machine_id }));
  return jsonResponse({ bookings: bookings });
}

function handleBook(body) {
  const studentId = String(body.student_id || '').trim();
  const fullName = String(body.full_name || '').trim();
  const date = String(body.date || '').trim();
  const timeSlot = String(body.time_slot || '').trim();
  const machineId = String(body.machine_id || '').trim();
  if (!studentId || !date || !timeSlot || !machineId) {
    return jsonResponse({ success: false, reason: 'Thiếu thông tin đặt lịch.' });
  }

  const config = readConfig();
  const sc = slotConfig(config);
  if (getSlotsForDay(config).indexOf(timeSlot) === -1) {
    return jsonResponse({ success: false, reason: 'Khung giờ không hợp lệ.' });
  }
  const today = dateStr(new Date());
  const maxDate = dateStr(new Date(Date.now() + sc.daysAhead * 86400000));
  if (date < today || date > maxDate) {
    return jsonResponse({ success: false, reason: 'Chỉ được đặt lịch trong ' + sc.daysAhead + ' ngày tới.' });
  }

  const existing = readActiveBookings();
  if (existing.some(b => b.date === date && b.time_slot === timeSlot && b.machine_id === machineId)) {
    return jsonResponse({ success: false, reason: 'Khung giờ này đã có người đặt máy này. Vui lòng chọn máy hoặc khung giờ khác.' });
  }
  if (existing.some(b => b.date === date && b.time_slot === timeSlot && b.student_id === studentId)) {
    return jsonResponse({ success: false, reason: 'Bạn đã đặt một máy khác trong khung giờ này rồi.' });
  }
  // Only slots that haven't happened yet count against the cap - nothing
  // ever flips an elapsed booking's status, so counting every row a student
  // has ever booked would lock them out permanently once they first hit the
  // cap. handleMyBookings() applies the same `>= today` filter.
  const maxPerWeek = parseInt(config.max_bookings_per_week, 10);
  const upcomingForStudent = existing.filter(
      b => b.student_id === studentId && b.date >= today);
  if (maxPerWeek > 0 && upcomingForStudent.length >= maxPerWeek) {
    return jsonResponse({ success: false, reason: 'Bạn đang giữ tối đa ' + maxPerWeek + ' lượt đặt sắp tới. Huỷ bớt một lượt để đặt lượt mới.' });
  }

  const sheet = ensureScheduleSheet();
  sheet.appendRow([date, timeSlot, machineId, studentId, fullName, 'booked', now()]);
  writeAuditLog(studentId, machineId, 'booked', fullName + ' - ' + date + ' ' + timeSlot);
  return jsonResponse({ success: true });
}

function handleCancelBooking(body) {
  const studentId = String(body.student_id || '').trim();
  const date = String(body.date || '').trim();
  const timeSlot = String(body.time_slot || '').trim();
  const machineId = String(body.machine_id || '').trim();

  const sheet = getSheet('Schedule');
  if (!sheet) return jsonResponse({ success: false, reason: 'Chưa có lịch nào.' });
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const cols = {
    date: headers.indexOf('date'), slot: headers.indexOf('time_slot'),
    machine: headers.indexOf('machine_id'), sid: headers.indexOf('student_id'),
    status: headers.indexOf('status'),
  };
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][cols.date]).trim() === date &&
        String(data[r][cols.slot]).trim() === timeSlot &&
        String(data[r][cols.machine]).trim() === machineId &&
        String(data[r][cols.sid]).trim() === studentId &&
        String(data[r][cols.status]).trim().toLowerCase() === 'booked') {
      sheet.getRange(r + 1, cols.status + 1).setValue('cancelled');
      writeAuditLog(studentId, machineId, 'booking_cancelled', date + ' ' + timeSlot);
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, reason: 'Không tìm thấy lịch đặt này.' });
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

// Optional `Queue` sheet (student_id | full_name | machine_id | requested_at)
// for students who hit a fully-occupied machine. No live push notification -
// a queued student has to try logging in again; this only tracks position so
// they know roughly how many people are ahead of them, and de-dupes repeat
// attempts from the same student instead of stacking duplicate entries.
function queuePositionFor(machineId, studentId, fullName) {
  const sheet = getSheet('Queue');
  if (!sheet) return null;
  const data = sheet.getDataRange().getValues();
  const headers = data.length ? data[0] : ['student_id', 'full_name', 'machine_id', 'requested_at'];
  const sidCol = headers.indexOf('student_id');
  const midCol = headers.indexOf('machine_id');
  if (sidCol === -1 || midCol === -1) return null;

  const forMachine = [];
  let existingIdx = -1;
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][midCol]).trim() !== String(machineId).trim()) continue;
    forMachine.push(data[r]);
    if (String(data[r][sidCol]).trim() === String(studentId).trim()) {
      existingIdx = forMachine.length - 1;
    }
  }
  if (existingIdx !== -1) return existingIdx + 1;

  sheet.appendRow([studentId, fullName, machineId, now()]);
  return forMachine.length + 1;
}

function dequeueStudent(machineId, studentId) {
  const sheet = getSheet('Queue');
  if (!sheet) return;
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return;
  const headers = data[0];
  const sidCol = headers.indexOf('student_id');
  const midCol = headers.indexOf('machine_id');
  if (sidCol === -1 || midCol === -1) return;
  // Delete bottom-up so row indices already removed don't shift the ones
  // still to be checked.
  for (let r = data.length - 1; r >= 1; r--) {
    if (String(data[r][midCol]).trim() === String(machineId).trim() &&
        String(data[r][sidCol]).trim() === String(studentId).trim()) {
      sheet.deleteRow(r + 1);
    }
  }
}

// ----- API handlers -----

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || e.parameter.action;

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    // feedback() and cancel_booking() only touch a single row each (append,
    // or cancel-by-owner) - no read-then-write race like login/book, so
    // neither needs (or benefits from) the allocation lock below.
    if (action === 'feedback') {
      return handleFeedback(body);
    }
    if (action === 'cancel_booking') {
      return handleCancelBooking(body);
    }

    // Allocating a machine (login) or a schedule slot (book) is
    // read-then-write; without a lock two simultaneous requests can both
    // see the same row/slot as free.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (action) {
        case 'login':
          return handleLogin(body);
        case 'logout':
          return handleLogout(body);
        case 'book':
          return handleBook(body);
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

    // No secret check here on purpose - see CODE_VERSION comment above.
    if (action === 'version') {
      return jsonResponse({ code_version: CODE_VERSION, features: CODE_FEATURES });
    }

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
      case 'check_availability':
        return handleCheckAvailability(e.parameter);
      case 'my_bookings':
        return handleMyBookings(e.parameter);
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
  // student_group stays '' unless the Students sheet actually has a
  // `group` column - that column's mere presence is what turns on
  // group-restricted viewing below (reservedForSomeoneElse's sibling
  // check), same opt-in pattern as every other optional column here.
  let student_group = '';
  let groupsInUse = false;
  const studentsSheet = getSheet('Students');
  if (studentsSheet) {
    const students = studentsSheet.getDataRange().getValues();
    if (students.length > 1) {
      const headers = students[0];
      const idCol = headers.indexOf('student_id');
      const statusCol = headers.indexOf('status');
      const nameCol = headers.indexOf('full_name');
      const groupCol = headers.indexOf('group');
      groupsInUse = groupCol !== -1;
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
        if (groupCol !== -1) {
          student_group = String(found[groupCol] || '').trim();
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
      // A free machine reserved by someone else for the current slot
      // (Schedule sheet, optional) isn't available to a walk-up student -
      // that reservation is the entire point of booking ahead.
      const reservedBy = reservedForSomeoneElse(sessData[r][machineIdCol], student_id, config);
      if (reservedBy) continue;
      targetRow = { row: r + 1, data: {}, headers: sessHeaders };
      sessHeaders.forEach((h, i) => { targetRow.data[h] = sessData[r][i]; });
      break;
    } else if (!occupiedFallback) {
      occupiedFallback = { row: r + 1, data: {}, headers: sessHeaders };
      sessHeaders.forEach((h, i) => { occupiedFallback.data[h] = sessData[r][i]; });
    }
  }

  if (!targetRow) {
    // Group-restricted viewing (opt-in: only when Students has a `group`
    // column at all - see groupsInUse above). Without this, any student can
    // watch any session; with it, only classmates in the controller's own
    // group can. Denied here rather than granted with a caveat, since
    // silently watching someone outside your section is the failure mode
    // that matters, not an inconvenience.
    if (occupiedFallback && occupiedFallback.data['session_token'] &&
        groupsInUse && (occupiedFallback.data['group'] || '') !== student_group) {
      writeAuditLog(student_id, occupiedFallback.data['machine_id'], 'login_denied',
          'View denied: different group (' + student_group + ' vs ' + occupiedFallback.data['group'] + ')');
      return jsonResponse({
        allowed: false,
        reason: 'Máy đang có sinh viên nhóm khác sử dụng. Vui lòng thử máy khác hoặc chờ.'
      });
    }
    if (occupiedFallback && occupiedFallback.data['session_token']) {
      // Sheets data entry is human-typed and easy to leave a stray leading/
      // trailing space in (this is exactly how a real spreadsheet had one on
      // machine_id) - trimmed here since a space in an IP the client passes
      // straight to RustDesk's connect(), or in a password, silently breaks
      // the connection with no useful error.
      const machineId = String(occupiedFallback.data['machine_id'] || '').trim();
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
        machine_name: String(occupiedFallback.data['machine_name'] || machineId).trim(),
        machine_pass: String(occupiedFallback.data['machine_pass'] || '').trim(),
        full_name: full_name,
        latest_version: config.latest_version || '',
        download_url: config.download_url || '',
        queue_position: queuePositionFor(machineId, student_id, full_name),
        // So a viewer knows who to contact, and can see the same countdown
        // the controller sees.
        controller_name: controllerName,
        controller_student_id: occupiedFallback.data['student_id'],
        expires_at: occupiedFallback.data['expires_at'] || ''
      });
    }
    writeAuditLog(student_id, body.machine_id || '', 'login_denied', 'No free machine');
    return jsonResponse({
      allowed: false,
      reason: 'Hiện không còn máy trống. Vui lòng thử lại sau.',
      queue_position: body.machine_id ? queuePositionFor(body.machine_id, student_id, full_name) : null
    });
  }

  // Allocate the session
  const token = generateToken();
  const machineId = String(targetRow.data['machine_id'] || '').trim();
  setSessionCell(targetRow.row, sessHeaders, 'status', 'occupied');
  setSessionCell(targetRow.row, sessHeaders, 'student_id', student_id);
  setSessionCell(targetRow.row, sessHeaders, 'full_name', full_name);
  setSessionCell(targetRow.row, sessHeaders, 'session_token', token);
  setSessionCell(targetRow.row, sessHeaders, 'started_at', now());
  setSessionCell(targetRow.row, sessHeaders, 'admin_action', '');
  setSessionCell(targetRow.row, sessHeaders, 'last_seen', now());

  // Stashed on the row (not re-looked-up from Students at view-join time)
  // so a viewer's group check below doesn't need a second Students scan.
  if (groupsInUse) {
    ensureColumn('ActiveSessions', 'group');
    setSessionCell(targetRow.row, sessHeaders, 'group', student_group);
  }

  // Per-session time limit (Config!max_minutes, optional - absent/invalid
  // means no limit, same as today). reapStaleSessions() enforces this on the
  // next status() poll, same path as the no-heartbeat timeout.
  ensureColumn('ActiveSessions', 'expires_at');
  const maxMinutes = parseInt(config.max_minutes, 10);
  let expiresAtIso = '';
  if (maxMinutes > 0) {
    expiresAtIso = new Date(Date.now() + maxMinutes * 60 * 1000).toISOString();
    setSessionCell(targetRow.row, sessHeaders, 'expires_at', expiresAtIso);
  }

  // This student no longer needs their spot in line for this machine, if
  // they had one (view-mode join or an earlier denied attempt).
  dequeueStudent(machineId, student_id);

  writeAuditLog(student_id, machineId, 'login_allowed', full_name);

  return jsonResponse({
    allowed: true,
    session_token: token,
    machine_id: machineId,
    machine_name: String(targetRow.data['machine_name'] || machineId).trim(),
    machine_pass: String(targetRow.data['machine_pass'] || '').trim(),
    // The roster name (already overridden from Students above), so the client
    // shows the official name rather than whatever was typed at login.
    full_name: full_name,
    latest_version: config.latest_version || '',
    download_url: config.download_url || '',
    expires_at: expiresAtIso
  });
}

// ----- status -----

function handleStatus(params) {
  const token = params.token;
  if (!token) {
    return jsonResponse({ status: 'not_found' });
  }

  let found = searchSessionRow(getActiveSessionsDataCached(), 'session_token', token);
  if (!found) {
    // Could be a real not_found, or just a session the cache hasn't picked
    // up yet (e.g. logged in within the last few seconds). Falling back to
    // a fresh read before giving up means a legitimately active client is
    // never wrongly told to disconnect because of cache staleness.
    found = findSessionRow('session_token', token);
  }
  if (!found) {
    return jsonResponse({ status: 'not_found' });
  }

  const adminAction = String(found.data['admin_action'] || '').trim().toLowerCase();
  const studentId = found.data['student_id'];
  const machineId = found.data['machine_id'];

  if (adminAction === 'kick') {
    // Process the kick
    freeSessionRow(found.row, found.headers);
    invalidateActiveSessionsCache();

    writeAuditLog(studentId, machineId, 'kicked',
        (found.data['full_name'] || studentId) + ' - Admin kick');
    return jsonResponse({ status: 'kicked' });
  }

  // Time-limit expiry has to be caught here, not just in reapStaleSessions():
  // a student who is actively polling never goes heartbeat-stale, so that
  // path alone would never end their session at Config!max_minutes.
  const expiresAt = parseTime(found.data['expires_at']);
  if (expiresAt && Date.now() >= expiresAt) {
    freeSessionRow(found.row, found.headers);
    invalidateActiveSessionsCache();
    writeAuditLog(studentId, machineId, 'expired',
        (found.data['full_name'] || studentId) + ' - Time limit reached');
    return jsonResponse({ status: 'expired' });
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

// ----- feedback -----

// `Feedback` is self-creating (unlike every other sheet here, which the
// admin is expected to have set up per SETUP.md) - a student's feedback
// button shouldn't silently do nothing just because nobody remembered to
// add one more tab.
function ensureFeedbackSheet() {
  let sheet = getSheet('Feedback');
  if (sheet) return sheet;
  sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Feedback');
  sheet.appendRow(['timestamp', 'student_id', 'full_name', 'message']);
  return sheet;
}

function handleFeedback(body) {
  const studentId = String(body.student_id || '').trim();
  const message = String(body.message || '').trim();
  if (!message) {
    return jsonResponse({ success: false, reason: 'Vui lòng nhập nội dung góp ý.' });
  }
  // Cap length: this sheet is meant for short notes, not a support ticket
  // system, and an unbounded string is one more thing a malicious caller
  // (SHARED_SECRET is a required gate, but defense in depth is cheap here)
  // could use to bloat the spreadsheet.
  const trimmedMessage = message.length > 2000 ? message.slice(0, 2000) : message;

  const sheet = ensureFeedbackSheet();
  sheet.appendRow([now(), studentId, String(body.full_name || '').trim(), trimmedMessage]);
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
