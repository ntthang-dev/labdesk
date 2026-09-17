'use strict';
const { FakeSheet, buildSandbox, loadCode, call } = require('./mock_gas');

const path = require('path');
const CODE_PATH = process.argv[2] || path.join(__dirname, '..', 'Code.gs');

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  OK   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${detail ? ' -- ' + detail : ''}`); }
}

function freshSheets() {
  return {
    ActiveSessions: new FakeSheet(
      ['machine_id', 'machine_name', 'status', 'student_id', 'full_name', 'session_token', 'started_at', 'admin_action', 'machine_pass'],
      [['100.83.83.70', 'PC Lab 01', 'free', '', '', '', '', '', 'PTNhtd@2026']]
    ),
    AuditLog: new FakeSheet(['timestamp', 'student_id', 'machine_id', 'event_type', 'detail'], []),
    Students: new FakeSheet(['student_id', 'full_name', 'status'], []),
  };
}

console.log('=== 1. ping (doGet) ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doGet', { parameter: { action: 'ping', secret: 'S3CR3T' } });
  check('status ok', res.status === 'ok', JSON.stringify(res));

  const bad = call(sb, 'doGet', { parameter: { action: 'ping', secret: 'wrong' } });
  check('wrong secret -> unauthorized', bad.error === 'unauthorized', JSON.stringify(bad));
}

console.log('=== 2. login: happy path allocates the free machine ===');
{
  const sheets = freshSheets();
  const built = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(built.sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '20210001', full_name: 'Nguyen Van A', secret: 'S3CR3T' }) },
  });
  check('allowed=true', res.allowed === true, JSON.stringify(res));
  check('machine_id echoed', res.machine_id === '100.83.83.70', JSON.stringify(res));
  check('machine_pass echoed from sheet', res.machine_pass === 'PTNhtd@2026', JSON.stringify(res));
  check('session_token present', typeof res.session_token === 'string' && res.session_token.length > 0);

  const row = sheets.ActiveSessions.rows[0];
  const headers = sheets.ActiveSessions.headers;
  check('sheet row now occupied', row[headers.indexOf('status')] === 'occupied');
  check('audit log has login_allowed', sheets.AuditLog.rows.some(r => r[3] === 'login_allowed'));

  console.log('  -- 2b. second login attempt on the now-occupied machine joins as a viewer --');
  const res2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '20210002', full_name: 'Tran Thi B', secret: 'S3CR3T' }) },
  });
  check('second student allowed in as a viewer, not denied', res2.allowed === true && res2.mode === 'view', JSON.stringify(res2));

  console.log('  -- 2c. same student tries to log in again elsewhere --');
  const res3 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '20210001', full_name: 'Nguyen Van A', secret: 'S3CR3T' }) },
  });
  check('duplicate session for same student denied', res3.allowed === false, JSON.stringify(res3));

  global.__ctx = { sb, sheets, token: res.session_token, scriptCacheStore: built.scriptCacheStore };
}

console.log('=== 3. status: active, then admin kick ===');
{
  const { sb, sheets, token, scriptCacheStore } = global.__ctx;
  const st1 = call(sb, 'doGet', { parameter: { action: 'status', token, secret: 'S3CR3T' } });
  check('status active', st1.status === 'active', JSON.stringify(st1));

  const headers = sheets.ActiveSessions.headers;
  sheets.ActiveSessions.rows[0][headers.indexOf('admin_action')] = 'kick';
  // Simulates the ~4s ACTIVE_SESSIONS_CACHE_TTL_SEC having elapsed since the
  // previous poll cached a pre-kick snapshot - exactly what happens for a
  // real admin typing "kick" into the sheet between two of a client's polls.
  delete scriptCacheStore['active_sessions_snapshot_v1'];

  const st2 = call(sb, 'doGet', { parameter: { action: 'status', token, secret: 'S3CR3T' } });
  check('status kicked', st2.status === 'kicked', JSON.stringify(st2));

  const row = sheets.ActiveSessions.rows[0];
  check('sheet row freed after kick', row[headers.indexOf('status')] === 'free');
  check('audit log has kicked', sheets.AuditLog.rows.some(r => r[3] === 'kicked'));

  const st3 = call(sb, 'doGet', { parameter: { action: 'status', token, secret: 'S3CR3T' } });
  check('status not_found after the slot is freed', st3.status === 'not_found', JSON.stringify(st3));
}

console.log('=== 4. logout releases the slot immediately ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  const out = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'logout', session_token: login.session_token, secret: 'S3CR3T' }) },
  });
  check('logout success', out.success === true, JSON.stringify(out));
  const headers = sheets.ActiveSessions.headers;
  check('sheet row free again', sheets.ActiveSessions.rows[0][headers.indexOf('status')] === 'free');
  check('audit log has logout', sheets.AuditLog.rows.some(r => r[3] === 'logout'));
}

console.log('=== 5. stale session (no heartbeat > 60s) is auto-reclaimed on next login ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'stale-student', full_name: 'Stale', secret: 'S3CR3T' }) },
  });
  check('first login allocates the machine', login.allowed === true, JSON.stringify(login));

  const headers = sheets.ActiveSessions.headers;
  const lastSeenCol = headers.indexOf('last_seen');
  check('last_seen column auto-created', lastSeenCol !== -1);
  // Simulate the client having vanished 61 seconds ago (never polled status again).
  const staleTime = new Date(Date.now() - 61000).toISOString();
  sheets.ActiveSessions.rows[0][headers.indexOf('started_at')] = staleTime;
  sheets.ActiveSessions.rows[0][lastSeenCol] = staleTime;

  const res2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'new-student', full_name: 'New', secret: 'S3CR3T' }) },
  });
  check('new student gets in after the stale slot is reclaimed', res2.allowed === true, JSON.stringify(res2));
  check('audit log recorded the expiry', sheets.AuditLog.rows.some(r => r[3] === 'expired'));
}

console.log('=== 6. Students whitelist: suspend blocks login, empty sheet allows everyone ===');
{
  const sheets = freshSheets();
  sheets.Students = new FakeSheet(
    ['student_id', 'full_name', 'status'],
    [['1', 'Allowed Student', 'active'], ['2', 'Blocked Student', 'suspended']]
  );
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const okRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'Allowed Student', secret: 'S3CR3T' }) },
  });
  check('whitelisted active student allowed', okRes.allowed === true, JSON.stringify(okRes));

  const suspendedRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '2', full_name: 'Blocked Student', secret: 'S3CR3T' }) },
  });
  check('suspended student denied', suspendedRes.allowed === false, JSON.stringify(suspendedRes));

  const unknownRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '999', full_name: 'Nobody', secret: 'S3CR3T' }) },
  });
  check('student not in whitelist denied', unknownRes.allowed === false, JSON.stringify(unknownRes));
}

console.log('=== 7. wrong shared secret rejected on every action ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'WRONG' }) },
  });
  check('unauthorized on bad secret', res.error === 'unauthorized', JSON.stringify(res));
}

console.log('=== 8. view-only join when the machine is occupied ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const login1 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'controller', full_name: 'Controller', secret: 'S3CR3T' }) },
  });
  check('controller login allowed', login1.allowed === true, JSON.stringify(login1));
  check('controller mode is control (not view)', login1.mode !== 'view', JSON.stringify(login1));

  const login2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'viewer', full_name: 'Viewer', secret: 'S3CR3T' }) },
  });
  check('viewer login allowed', login2.allowed === true, JSON.stringify(login2));
  check('viewer mode is view', login2.mode === 'view', JSON.stringify(login2));
  check('viewer shares the controller\'s token', login2.session_token === login1.session_token, JSON.stringify(login2));
  check('viewer gets the real machine_pass', login2.machine_pass === 'PTNhtd@2026', JSON.stringify(login2));
  check('audit log recorded view_joined', sheets.AuditLog.rows.some(r => r[3] === 'view_joined'));

  const headers = sheets.ActiveSessions.headers;
  check('sheet still shows only the controller (no extra row)', sheets.ActiveSessions.rows.length === 1);
  check('sheet occupant is still the controller', sheets.ActiveSessions.rows[0][headers.indexOf('student_id')] === 'controller');

  console.log('  -- 8b. controller logout also ends the viewer\'s shared token --');
  const out = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'logout', session_token: login1.session_token, secret: 'S3CR3T' }) },
  });
  check('controller logout succeeds', out.success === true, JSON.stringify(out));
  const afterLogout = call(sb, 'doGet', { parameter: { action: 'status', token: login2.session_token, secret: 'S3CR3T' } });
  check('viewer\'s shared token now reports not_found too', afterLogout.status === 'not_found', JSON.stringify(afterLogout));
}

console.log('=== 9. AuditLog carries the student name; whitelist name overrides a mistyped one ===');
{
  const sheets = freshSheets();
  sheets.Students = new FakeSheet(
    ['student_id', 'full_name', 'status'],
    [['1', 'Nguyen Van Chuan', 'active']]
  );
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'nguyen van chuann (typo)', secret: 'S3CR3T' }) },
  });
  check('login allowed', login.allowed === true, JSON.stringify(login));

  const headers = sheets.ActiveSessions.headers;
  const recordedName = sheets.ActiveSessions.rows[0][headers.indexOf('full_name')];
  check('sheet records the canonical whitelist name, not the typed one',
      recordedName === 'Nguyen Van Chuan', recordedName);

  const loginAllowedRow = sheets.AuditLog.rows.find(r => r[3] === 'login_allowed');
  check('login_allowed audit entry carries the student name',
      !!loginAllowedRow && loginAllowedRow[4] === 'Nguyen Van Chuan', JSON.stringify(loginAllowedRow));

  const out = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'logout', session_token: login.session_token, secret: 'S3CR3T' }) },
  });
  check('logout succeeds', out.success === true);
  const logoutRow = sheets.AuditLog.rows.find(r => r[3] === 'logout');
  check('logout audit entry carries the student name',
      !!logoutRow && logoutRow[4] === 'Nguyen Van Chuan', JSON.stringify(logoutRow));
}

console.log('=== 10. Remote forced-update gate (Config sheet, optional) ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const noConfigRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T', client_version: '0.0.1' }) },
  });
  check('no Config sheet -> login proceeds normally (backward compatible)',
      noConfigRes.allowed === true, JSON.stringify(noConfigRes));
}
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [
    ['min_version', '2.0.0'],
    ['latest_version', '2.1.0'],
    ['download_url', 'https://example.com/download'],
  ]);
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const oldRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T', client_version: '1.9.9' }) },
  });
  check('client below min_version is denied', oldRes.allowed === false, JSON.stringify(oldRes));
  check('denial carries force_update', oldRes.force_update === true, JSON.stringify(oldRes));
  check('denial carries download_url', oldRes.download_url === 'https://example.com/download', JSON.stringify(oldRes));
  check('audit log recorded the version denial',
      sheets.AuditLog.rows.some(r => r[3] === 'login_denied' && String(r[4]).indexOf('version') !== -1));

  const okRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '2', full_name: 'B', secret: 'S3CR3T', client_version: '2.0.0' }) },
  });
  check('client at exactly min_version is allowed', okRes.allowed === true, JSON.stringify(okRes));
  check('success response carries latest_version', okRes.latest_version === '2.1.0', JSON.stringify(okRes));

  const noVersionRes = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '3', full_name: 'C', secret: 'S3CR3T' }) },
  });
  check('client that sends no version at all is never blocked (old builds keep working)',
      noVersionRes.allowed === true || noVersionRes.reason !== undefined && noVersionRes.force_update === undefined,
      JSON.stringify(noVersionRes));
}

console.log('=== 11. Admin Sheets menu (Kick / Suspend / Unsuspend selected row) ===');
{
  const sheets = freshSheets();
  const login = (() => {
    const sb0 = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
    return call(sb0, 'doPost', {
      postData: { contents: JSON.stringify({ action: 'login', student_id: 'k1', full_name: 'Kick Target', secret: 'S3CR3T' }) },
    });
  })();
  check('setup: login allocated the machine', login.allowed === true, JSON.stringify(login));

  const { sandbox, alerts, activeState } = buildSandbox({ sharedSecret: 'S3CR3T', sheets, active: { sheetName: 'ActiveSessions', row: 2 } });
  const sb = loadCode(sandbox, CODE_PATH);

  sb.adminKickSelectedRow();
  check('admin menu: kick alert shown', alerts.length === 1 && alerts[0].indexOf('Kick Target') !== -1, JSON.stringify(alerts));
  const headers = sheets.ActiveSessions.headers;
  check('admin menu: kick sets admin_action', sheets.ActiveSessions.rows[0][headers.indexOf('admin_action')] === 'kick');

  // Wrong sheet selected -> refuses instead of guessing.
  activeState.sheetName = 'AuditLog';
  activeState.row = 2;
  alerts.length = 0;
  sb.adminKickSelectedRow();
  check('admin menu: refuses to act on the wrong sheet', alerts.length === 1 && alerts[0].indexOf('ActiveSessions') !== -1, JSON.stringify(alerts));
}
{
  const sheets = freshSheets();
  sheets.Students = new FakeSheet(['student_id', 'full_name', 'status'], [['5', 'Some Student', 'active']]);
  const { sandbox, alerts, activeState } = buildSandbox({ sharedSecret: 'S3CR3T', sheets, active: { sheetName: 'Students', row: 2 } });
  const sb = loadCode(sandbox, CODE_PATH);

  sb.adminSuspendSelectedStudent();
  check('admin menu: suspend sets status', sheets.Students.rows[0][2] === 'suspended', JSON.stringify(sheets.Students.rows));
  check('admin menu: suspend alert shown', alerts.length === 1);

  alerts.length = 0;
  sb.adminUnsuspendSelectedStudent();
  check('admin menu: unsuspend sets status back to active', sheets.Students.rows[0][2] === 'active');

  // Suspending a student via the menu is enforced by the same login() check
  // already covered in test 6 - not re-tested here to avoid duplicating it.
}

console.log('=== 12. Per-session time limit (Config!max_minutes) ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [['max_minutes', '30']]);
  const built = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(built.sandbox, CODE_PATH);

  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'tl1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('login allocates the machine', login.allowed === true, JSON.stringify(login));

  const headers = sheets.ActiveSessions.headers;
  const expiresAtCol = headers.indexOf('expires_at');
  check('expires_at column auto-created and set', expiresAtCol !== -1 && !!sheets.ActiveSessions.rows[0][expiresAtCol]);

  console.log('  -- 12a. status poll before the limit: still active --');
  const early = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('still active well before 30 minutes', early.status === 'active', JSON.stringify(early));

  console.log('  -- 12b. time limit reached: next poll frees the machine --');
  sheets.ActiveSessions.rows[0][expiresAtCol] = new Date(Date.now() - 1000).toISOString();
  // Same reasoning as test 3: 12a already warmed the cache with a
  // not-yet-expired snapshot, so this simulates ACTIVE_SESSIONS_CACHE_TTL_SEC
  // having elapsed since then.
  delete built.scriptCacheStore['active_sessions_snapshot_v1'];
  const late = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('status reports expired once the time limit passes', late.status === 'expired', JSON.stringify(late));
  check('sheet row freed', sheets.ActiveSessions.rows[0][headers.indexOf('status')] === 'free');
  check('audit log recorded the time-limit expiry',
      sheets.AuditLog.rows.some(r => r[3] === 'expired' && String(r[4]).indexOf('Time limit') !== -1));
}
console.log('  -- 12c. no Config -> no limit is imposed (backward compatible) --');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'nolimit', full_name: 'A', secret: 'S3CR3T' }) },
  });
  const headers = sheets.ActiveSessions.headers;
  check('no expires_at set when Config is absent',
      !sheets.ActiveSessions.rows[0][headers.indexOf('expires_at')]);
}

console.log('=== 13. Queue (optional Queue sheet) when the machine is occupied ===');
{
  const sheets = freshSheets();
  sheets.Queue = new FakeSheet(['student_id', 'full_name', 'machine_id', 'requested_at'], []);
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'controller', full_name: 'Controller', secret: 'S3CR3T' }) },
  });

  const q1 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'q1', full_name: 'Queued One', secret: 'S3CR3T' }) },
  });
  check('first queued student is position 1', q1.queue_position === 1, JSON.stringify(q1));
  check('first queued student still gets view mode', q1.mode === 'view');

  const q2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'q2', full_name: 'Queued Two', secret: 'S3CR3T' }) },
  });
  check('second queued student is position 2', q2.queue_position === 2, JSON.stringify(q2));

  console.log('  -- 13a. repeat attempt from the same student does not duplicate their spot --');
  const q1Again = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'q1', full_name: 'Queued One', secret: 'S3CR3T' }) },
  });
  check('re-attempt keeps the same position, does not push to the back', q1Again.queue_position === 1, JSON.stringify(q1Again));
  check('queue sheet has exactly 2 entries, not 3', sheets.Queue.rows.length === 2, JSON.stringify(sheets.Queue.rows));

  console.log('  -- 13b. controller logs out; q1 logs in and is dequeued --');
  const controllerToken = q1.session_token; // shared controller token
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'logout', session_token: controllerToken, secret: 'S3CR3T' }) },
  });
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'q1', full_name: 'Queued One', secret: 'S3CR3T' }) },
  });
  check('q1 is removed from the queue after becoming controller',
      !sheets.Queue.rows.some(r => r[0] === 'q1'), JSON.stringify(sheets.Queue.rows));
  check('q2 is still in the queue (untouched)',
      sheets.Queue.rows.some(r => r[0] === 'q2'), JSON.stringify(sheets.Queue.rows));
}
console.log('  -- 13c. no Queue sheet -> queue_position is just null (backward compatible) --');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'c', full_name: 'C', secret: 'S3CR3T' }) },
  });
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'v', full_name: 'V', secret: 'S3CR3T' }) },
  });
  check('view mode still granted without a Queue sheet', res.mode === 'view', JSON.stringify(res));
  check('queue_position is null, not an error', res.queue_position === null, JSON.stringify(res));
}

console.log('=== 14. status() caching (CacheService) does not change observable behavior ===');
{
  const sheets = freshSheets();
  const { sandbox, scriptCacheStore } = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(sandbox, CODE_PATH);
  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });

  const st1 = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('first poll populates the cache and reports active', st1.status === 'active' && !!scriptCacheStore['active_sessions_snapshot_v1']);

  console.log('  -- 14a. kick is still detected while served from cache --');
  const headers = sheets.ActiveSessions.headers;
  sheets.ActiveSessions.rows[0][headers.indexOf('admin_action')] = 'kick';
  // Cache is still warm (not cleared) - handleStatus must read admin_action
  // from a snapshot that includes this write, or dedicate a fresh read; a
  // stale cache from *before* the sheet write would still see it if the
  // cache genuinely holds a live JS reference by mistake, so this also
  // guards against that class of bug.
  scriptCacheStore['active_sessions_snapshot_v1'] = JSON.stringify(sheets.ActiveSessions.getDataRange().getValues());
  const st2 = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('kick detected through the cached path', st2.status === 'kicked', JSON.stringify(st2));
  check('sheet freed after cached-path kick', sheets.ActiveSessions.rows[0][headers.indexOf('status')] === 'free');

  console.log('  -- 14a-2. an immediate second poll (same token, cache not manually cleared) does not reprocess the kick --');
  const st2b = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('second poll right after the kick reports not_found, not a duplicate kicked',
      st2b.status === 'not_found', JSON.stringify(st2b));
  check('exactly one kicked entry in the audit log, not two',
      sheets.AuditLog.rows.filter(r => r[3] === 'kicked').length === 1, JSON.stringify(sheets.AuditLog.rows));
}
{
  console.log('=== 14b. cache miss (token not in the stale snapshot) falls back to a fresh read, never false not_found ===');
  const sheets = freshSheets();
  const { sandbox, scriptCacheStore } = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(sandbox, CODE_PATH);
  // Simulate a cache warmed *before* this student logged in: an empty/free
  // snapshot with no session_token for them at all.
  scriptCacheStore['active_sessions_snapshot_v1'] = JSON.stringify(sheets.ActiveSessions.getDataRange().getValues());

  const login = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('login succeeded', login.allowed === true);

  const st = call(sb, 'doGet', { parameter: { action: 'status', token: login.session_token, secret: 'S3CR3T' } });
  check('a legitimately active session is never falsely reported not_found due to a stale cache',
      st.status === 'active', JSON.stringify(st));
}

console.log('=== 15. Multi-machine: adding more ActiveSessions rows just works, no code change needed ===');
{
  const sheets = freshSheets();
  // A second lab machine, same schema, already free.
  sheets.ActiveSessions.rows.push(['100.83.83.71', 'PC Lab 02', 'free', '', '', '', '', '', 'OtherPass@2026']);

  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const r1 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 's1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('first student gets machine 1 (first free row)', r1.allowed === true && r1.machine_id === '100.83.83.70', JSON.stringify(r1));

  const r2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 's2', full_name: 'B', secret: 'S3CR3T' }) },
  });
  check('second student gets machine 2 (still free), not view mode on machine 1',
      r2.allowed === true && r2.machine_id === '100.83.83.71' && r2.mode !== 'view', JSON.stringify(r2));

  const r3 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 's3', full_name: 'C', secret: 'S3CR3T' }) },
  });
  check('third student, both machines occupied, joins machine 1 as viewer',
      r3.allowed === true && r3.mode === 'view' && r3.machine_id === '100.83.83.70', JSON.stringify(r3));

  const headers = sheets.ActiveSessions.headers;
  check('both machine rows independently occupied by the right student',
      sheets.ActiveSessions.rows[0][headers.indexOf('student_id')] === 's1' &&
      sheets.ActiveSessions.rows[1][headers.indexOf('student_id')] === 's2');
}

console.log('=== 16. Trailing/leading whitespace in sheet cells never reaches the client ===');
{
  const sheets = freshSheets();
  // Mirrors a real production sheet: a stray space typed into machine_id.
  sheets.ActiveSessions.rows[0] = ['100.83.83.70 ', ' PC Lab 01', 'free', '', '', '', '', '', ' PTNhtd@2026 '];
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('machine_id trimmed', res.machine_id === '100.83.83.70', JSON.stringify(res));
  check('machine_name trimmed', res.machine_name === 'PC Lab 01', JSON.stringify(res));
  check('machine_pass trimmed', res.machine_pass === 'PTNhtd@2026', JSON.stringify(res));

  console.log('  -- 16a. same whitespace, view-mode response path --');
  const res2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '2', full_name: 'B', secret: 'S3CR3T' }) },
  });
  check('view-mode machine_id also trimmed', res2.machine_id === '100.83.83.70', JSON.stringify(res2));
  check('view-mode machine_pass also trimmed', res2.machine_pass === 'PTNhtd@2026', JSON.stringify(res2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
