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
const CODE_VERSION = '2026-09-18-modular-readable-timestamps';
const CODE_FEATURES = ['view_only_queue', 'expires_at_countdown', 'group_restricted_view',
  'schedule_booking', 'feedback', 'version_gate', 'readable_timestamps', 'setup_all_sheets'];

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

// Human-readable local timestamp ("2026-09-18 01:02:03") for every column an
// admin actually reads in Sheets. The old ISO form was both ugly and wrong-
// looking to a Vietnamese admin, since it printed UTC (7 hours behind local).
// `expires_at` deliberately stays ISO - see handleLogin - because the client
// parses it across a machine boundary where the two timezones might differ.
function now() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
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
  const s = String(value).trim();
  // "YYYY-MM-DD HH:mm:ss" from now(), parsed as local time via explicit
  // components rather than trusting the engine's handling of the space form.
  // Rows written before this format change are ISO and fall through to
  // Date's own parser, so existing sheets keep working untouched.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  const t = new Date(s).getTime();
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
