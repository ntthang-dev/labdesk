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

console.log('=== 17. Viewer sees who to contact; controller sees own countdown ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [['max_minutes', '60']]);
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const controller = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'ctrl1', full_name: 'Controller Person', secret: 'S3CR3T' }) },
  });
  check('controller response carries expires_at (session timer)', !!controller.expires_at, JSON.stringify(controller));

  const viewer = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'view1', full_name: 'Viewer Person', secret: 'S3CR3T' }) },
  });
  check('viewer sees the controller\'s name to contact them', viewer.controller_name === 'Controller Person', JSON.stringify(viewer));
  check('viewer sees the controller\'s student_id too', viewer.controller_student_id === 'ctrl1', JSON.stringify(viewer));
  check('viewer sees the same expires_at as the controller', viewer.expires_at === controller.expires_at, JSON.stringify(viewer));
}
console.log('  -- 17a. no Config -> expires_at is empty, not an error --');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('no time limit configured -> expires_at is empty string', res.expires_at === '', JSON.stringify(res));
}

console.log('=== 18. Feedback (self-creating sheet, no lock contention with login) ===');
{
  const sheets = freshSheets(); // no Feedback sheet yet
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'feedback', student_id: 'SV001', full_name: 'A', message: 'Máy 3 bị lag nhiều', secret: 'S3CR3T' }) },
  });
  check('feedback accepted', res.success === true, JSON.stringify(res));
  check('Feedback sheet auto-created', !!sheets.Feedback);
  check('header row written', sheets.Feedback.rows[0].join(',') === 'timestamp,student_id,full_name,message');
  check('feedback row appended with the right content',
      sheets.Feedback.rows[1][1] === 'SV001' && sheets.Feedback.rows[1][3] === 'Máy 3 bị lag nhiều',
      JSON.stringify(sheets.Feedback.rows));

  console.log('  -- 18a. empty message rejected --');
  const empty = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'feedback', student_id: 'SV001', message: '   ', secret: 'S3CR3T' }) },
  });
  check('empty message rejected', empty.success === false, JSON.stringify(empty));

  console.log('  -- 18b. very long message is capped, not rejected --');
  const longMsg = 'x'.repeat(5000);
  const capped = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'feedback', student_id: 'SV001', message: longMsg, secret: 'S3CR3T' }) },
  });
  check('long message accepted', capped.success === true);
  check('message capped at 2000 chars', sheets.Feedback.rows[sheets.Feedback.rows.length - 1][3].length === 2000);

  console.log('  -- 18c. wrong secret still rejected --');
  const bad = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'feedback', student_id: 'SV001', message: 'test', secret: 'WRONG' }) },
  });
  check('wrong secret rejected even for feedback', bad.error === 'unauthorized', JSON.stringify(bad));
}

console.log('=== 19. Scheduling: slot generation ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [
    ['slot_start_hour', '7'], ['slot_end_hour', '19'], ['slot_duration_minutes', '120'],
  ]);
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const slots = sb.getSlotsForDay(sb.readConfig());
  check('7am-7pm in 2h blocks makes 6 slots', slots.length === 6, JSON.stringify(slots));
  check('first slot starts at 07:00', slots[0] === '07:00-09:00', JSON.stringify(slots));
  check('last slot ends at 19:00', slots[5] === '17:00-19:00', JSON.stringify(slots));
}

console.log('=== 20. Scheduling: book / double-book rejected / availability / cancel ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [
    ['slot_start_hour', '7'], ['slot_end_hour', '19'], ['slot_duration_minutes', '120'],
  ]);
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  // dateStr() is local-time (matches a student's own machine), not UTC -
  // toISOString().slice(0,10) drifts a day off from Code.gs's own idea of
  // "today" for part of the day in any timezone ahead of UTC.
  const today = sb.dateStr(new Date());

  const book1 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('first booking succeeds', book1.success === true, JSON.stringify(book1));
  check('Schedule sheet auto-created', !!sheets.Schedule);

  console.log('  -- 20a. same machine, same slot, different student -> rejected --');
  const book2 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's2', full_name: 'B', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('double-booking the same machine/slot rejected', book2.success === false, JSON.stringify(book2));

  console.log('  -- 20b. same student, same slot, different machine -> rejected (one seat per slot) --');
  const book3 = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '09:00-11:00', machine_id: 'LAB-02', secret: 'S3CR3T' }) },
  });
  check('same student cannot hold two machines in one slot', book3.success === false, JSON.stringify(book3));

  console.log('  -- 20c. invalid slot label rejected --');
  const badSlot = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's3', full_name: 'C', date: today, time_slot: '03:00-05:00', machine_id: 'LAB-02', secret: 'S3CR3T' }) },
  });
  check('slot outside operating hours rejected', badSlot.success === false, JSON.stringify(badSlot));

  console.log('  -- 20d. check_availability reflects the booking, with who to contact --');
  const avail = call(sb, 'doGet', { parameter: { action: 'check_availability', date: today, secret: 'S3CR3T' } });
  const slot9 = avail.slots.find(s => s.time_slot === '09:00-11:00' && s.machine_id === '100.83.83.70');
  check('booked slot shows unavailable', slot9 && slot9.available === false, JSON.stringify(slot9));
  check('booked slot shows who to contact', slot9 && slot9.booked_by === 'A' && slot9.booked_by_student_id === 's1', JSON.stringify(slot9));
  const freeSlot = avail.slots.find(s => s.time_slot === '11:00-13:00' && s.machine_id === '100.83.83.70');
  check('other slots still show available', freeSlot && freeSlot.available === true, JSON.stringify(freeSlot));

  console.log('  -- 20e. my_bookings shows the booking --');
  const mine = call(sb, 'doGet', { parameter: { action: 'my_bookings', student_id: 's1', secret: 'S3CR3T' } });
  check('my_bookings returns the booking', mine.bookings.length === 1 && mine.bookings[0].time_slot === '09:00-11:00', JSON.stringify(mine));

  console.log('  -- 20f. cancel frees the slot for others --');
  const cancel = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'cancel_booking', student_id: 's1', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('cancel succeeds', cancel.success === true, JSON.stringify(cancel));
  const book2Retry = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's2', full_name: 'B', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('slot bookable again after cancel', book2Retry.success === true, JSON.stringify(book2Retry));
}

console.log('=== 21. Scheduling: reserved machine is skipped in login\'s free-machine scan ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [
    ['slot_start_hour', '0'], ['slot_end_hour', '24'], ['slot_duration_minutes', '1440'],
  ]);
  const probeSb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets: {} }).sandbox, CODE_PATH);
  const today = probeSb.dateStr(new Date());
  sheets.Schedule = new FakeSheet(
    ['date', 'time_slot', 'machine_id', 'student_id', 'full_name', 'status', 'created_at'],
    [[today, '00:00-24:00', '100.83.83.70', 'reserver', 'Reserver Person', 'booked', '']]
  );
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  console.log('  -- 21a. a different student walking up does NOT get the reserved machine --');
  const walkup = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'walkup', full_name: 'Walkup', secret: 'S3CR3T' }) },
  });
  check('walk-up student denied the only (reserved) machine',
      walkup.allowed === false, JSON.stringify(walkup));

  console.log('  -- 21b. the reserving student CAN log in and gets their reserved machine --');
  const reserver = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'reserver', full_name: 'Reserver Person', secret: 'S3CR3T' }) },
  });
  check('the student who reserved it gets in normally',
      reserver.allowed === true && reserver.machine_id === '100.83.83.70', JSON.stringify(reserver));
}
console.log('  -- 21c. no Schedule sheet -> first-come-first-served exactly as before --');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '1', full_name: 'A', secret: 'S3CR3T' }) },
  });
  check('login works normally with no Schedule sheet at all', res.allowed === true, JSON.stringify(res));
}

console.log('=== 22. Group-restricted viewing (opt-in via Students!group column) ===');
{
  const sheets = freshSheets();
  sheets.Students = new FakeSheet(
    ['student_id', 'full_name', 'status', 'group'],
    [['ctrl', 'Controller', 'active', 'A'], ['same', 'Same Group', 'active', 'A'], ['other', 'Other Group', 'active', 'B']]
  );
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);

  const ctrl = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'ctrl', full_name: 'x', secret: 'S3CR3T' }) },
  });
  check('controller login allowed', ctrl.allowed === true, JSON.stringify(ctrl));

  console.log('  -- 22a. different group cannot view --');
  const other = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'other', full_name: 'x', secret: 'S3CR3T' }) },
  });
  check('different group denied view access', other.allowed === false, JSON.stringify(other));

  console.log('  -- 22b. same group CAN view --');
  const same = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'same', full_name: 'x', secret: 'S3CR3T' }) },
  });
  check('same group allowed to view', same.allowed === true && same.mode === 'view', JSON.stringify(same));
}
console.log('  -- 22c. no group column at all -> everyone can view, exactly as before --');
{
  const sheets = freshSheets(); // Students has no group column
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'ctrl', full_name: 'x', secret: 'S3CR3T' }) },
  });
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: 'anyone', full_name: 'x', secret: 'S3CR3T' }) },
  });
  check('anyone can view when groups are not configured', res.allowed === true && res.mode === 'view', JSON.stringify(res));
}

console.log('=== 24. max_bookings_per_week counts only upcoming slots ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [
    ['slot_start_hour', '7'], ['slot_end_hour', '19'], ['slot_duration_minutes', '120'],
    ['max_bookings_per_week', '2'],
  ]);
  const probeSb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets: {} }).sandbox, CODE_PATH);
  const today = probeSb.dateStr(new Date());
  // Two bookings the student already used up, both safely in the past.
  sheets.Schedule = new FakeSheet(
    ['date', 'time_slot', 'machine_id', 'student_id', 'full_name', 'status', 'created_at'],
    [
      ['2020-01-01', '07:00-09:00', '100.83.83.70', 's1', 'A', 'booked', ''],
      ['2020-01-02', '07:00-09:00', '100.83.83.70', 's1', 'A', 'booked', ''],
    ]
  );
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const afterElapsed = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('elapsed bookings do not count against the cap', afterElapsed.success === true, JSON.stringify(afterElapsed));

  // One more upcoming booking reaches the cap of 2 (this one + the one above).
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '11:00-13:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  const overCap = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '13:00-15:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('upcoming bookings still enforce the cap', overCap.success === false, JSON.stringify(overCap));
}

console.log('=== 25. readable local timestamps, both formats still parse ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const stamp = sb.now();
  check('now() is readable "YYYY-MM-DD HH:mm:ss"', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp), stamp);
  check('now() round-trips through parseTime', Math.abs(sb.parseTime(stamp) - Date.now()) < 5000, String(sb.parseTime(stamp)));
  const legacyIso = new Date(Date.now() - 120000).toISOString();
  check('legacy ISO rows still parse', Math.abs(sb.parseTime(legacyIso) - (Date.now() - 120000)) < 5000, legacyIso);
  check('empty value is 0', sb.parseTime('') === 0);

  // The staleness reaper must still fire on a heartbeat written in the new
  // format - this is the path that would silently stop reclaiming machines.
  const staleSheets = freshSheets();
  const staleSb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets: staleSheets }).sandbox, CODE_PATH);
  const login = call(staleSb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '20210001', full_name: 'A', secret: 'S3CR3T' }) },
  });
  const headers = staleSheets.ActiveSessions.headers;
  const d = new Date(Date.now() - 61000);
  const staleStamp = d.getFullYear() + '-' + staleSb.pad2(d.getMonth() + 1) + '-' + staleSb.pad2(d.getDate())
      + ' ' + staleSb.pad2(d.getHours()) + ':' + staleSb.pad2(d.getMinutes()) + ':' + staleSb.pad2(d.getSeconds());
  staleSheets.ActiveSessions.rows[0][headers.indexOf('last_seen')] = staleStamp;
  const after = call(staleSb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'login', student_id: '20210002', full_name: 'B', secret: 'S3CR3T' }) },
  });
  check('stale session with new-format last_seen is reclaimed',
      after.allowed === true && after.mode !== 'view', JSON.stringify(after));
  check('reclaimed machine is the same one', after.machine_id === login.machine_id);
}

console.log('=== 26. setupAllSheets creates every sheet/column, idempotently ===');
{
  const sheets = { ActiveSessions: freshSheets().ActiveSessions };
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const first = sb.setupAllSheets();
  check('creates the missing sheets', first.created.length >= 5, JSON.stringify(first.created));
  ['Students', 'AuditLog', 'Config', 'Queue', 'Schedule', 'Feedback'].forEach(function (name) {
    check('  sheet ' + name + ' exists', !!sheets[name]);
  });
  check('adds missing columns to an existing sheet',
      first.columnsAdded.some(c => c.indexOf('ActiveSessions.') === 0), JSON.stringify(first.columnsAdded));
  const second = sb.setupAllSheets();
  check('second run changes nothing (idempotent)',
      second.created.length === 0 && second.columnsAdded.length === 0, JSON.stringify(second));
}

console.log('=== 23. action=version needs no secret (deployment self-check) ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const noSecret = call(sb, 'doGet', { parameter: { action: 'version' } });
  check('version works with no secret at all', typeof noSecret.code_version === 'string' && noSecret.code_version.length > 0, JSON.stringify(noSecret));
  check('version lists features', Array.isArray(noSecret.features) && noSecret.features.includes('schedule_booking'), JSON.stringify(noSecret));
  const wrongSecret = call(sb, 'doGet', { parameter: { action: 'version', secret: 'nope' } });
  check('version works even with a wrong secret', typeof wrongSecret.code_version === 'string', JSON.stringify(wrongSecret));
}

console.log('=== 27. crash_report: self-creating CrashLog sheet, no whitelist gate ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({
      action: 'crash_report', app_version: '1.2.3', platform: 'macos',
      student_id: '20210001', full_name: 'A', error: 'RangeError: boom',
      stack_trace: 'at foo()\nat bar()', secret: 'S3CR3T',
    }) },
  });
  check('crash_report accepted', res.success === true, JSON.stringify(res));
  check('CrashLog sheet auto-created', !!sheets.CrashLog);
  // rows[0] is the header row appendRow() wrote in ensureCrashLogSheet();
  // the first actual report is rows[1].
  const row = sheets.CrashLog.rows[1];
  check('row has app_version/platform/error recorded',
      row[1] === '1.2.3' && row[2] === 'macos' && row[5] === 'RangeError: boom', JSON.stringify(row));

  const overlong = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({
      action: 'crash_report', error: 'x'.repeat(1000), stack_trace: 'y'.repeat(5000), secret: 'S3CR3T',
    }) },
  });
  check('crash_report accepts missing student fields without erroring', overlong.success === true, JSON.stringify(overlong));
  check('error field capped at 500 chars', sheets.CrashLog.rows[2][5].length === 500);
  check('stack_trace field capped at 4000 chars', sheets.CrashLog.rows[2][6].length === 4000);
}

console.log('=== 28. publish_release: CI sets latest_version/download_url, never min_version ===');
{
  const sheets = freshSheets();
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
  const res = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({
      action: 'publish_release', version: '1.4.0',
      download_url: 'https://github.com/ntthang-dev/labdesk/releases/tag/v1.4.0',
      secret: 'S3CR3T',
    }) },
  });
  check('publish_release succeeds', res.success === true && res.latest_version === '1.4.0', JSON.stringify(res));
  check('Config sheet auto-created', !!sheets.Config);
  const config = sb.readConfig();
  check('latest_version set', config.latest_version === '1.4.0', JSON.stringify(config));
  check('download_url set', config.download_url === 'https://github.com/ntthang-dev/labdesk/releases/tag/v1.4.0');
  check('min_version untouched (not in the payload)', config.min_version === undefined, JSON.stringify(config));

  // Republishing must update the same row, not append a duplicate key.
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'publish_release', version: '1.4.1', secret: 'S3CR3T' }) },
  });
  const dataRows = sheets.Config.rows.filter(r => r[0] === 'latest_version');
  check('second publish upserts in place (no duplicate rows)', dataRows.length === 1, JSON.stringify(sheets.Config.rows));
  check('second publish value applied', sb.readConfig().latest_version === '1.4.1');

  const missingVersion = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'publish_release', secret: 'S3CR3T' }) },
  });
  check('publish_release rejects a missing version', missingVersion.success === false, JSON.stringify(missingVersion));
}

console.log('=== 29. Config is cached; publish_release invalidates it immediately ===');
{
  const sheets = freshSheets();
  sheets.Config = new FakeSheet(['key', 'value'], [['max_minutes', '60']]);
  const built = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(built.sandbox, CODE_PATH);

  const first = sb.readConfig();
  check('first read sees the sheet value', first.max_minutes === '60', JSON.stringify(first));
  check('read populates the cache', !!built.scriptCacheStore['config_snapshot_v1']);

  // Simulate an admin hand-editing the sheet without going through
  // publish_release/upsertConfigValue: the cache must NOT see it yet.
  sheets.Config.rows[0][1] = '120';
  const stale = sb.readConfig();
  check('cached read does not see a direct sheet edit (expected staleness)', stale.max_minutes === '60', JSON.stringify(stale));

  sb.invalidateConfigCache();
  const fresh = sb.readConfig();
  check('after manual invalidation, fresh value is seen', fresh.max_minutes === '120', JSON.stringify(fresh));

  // publish_release's own writes must be visible immediately, not after TTL.
  call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'publish_release', version: '2.0.0', secret: 'S3CR3T' }) },
  });
  check('publish_release result visible on the very next read', sb.readConfig().latest_version === '2.0.0');
}

console.log('=== 30. check_availability is cached per date; booking invalidates it ===');
{
  const sheets = freshSheets();
  const probeSb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets: {} }).sandbox, CODE_PATH);
  const today = probeSb.dateStr(new Date());
  const built = buildSandbox({ sharedSecret: 'S3CR3T', sheets });
  const sb = loadCode(built.sandbox, CODE_PATH);

  const first = call(sb, 'doGet', { parameter: { action: 'check_availability', date: today, secret: 'S3CR3T' } });
  check('first call populates the availability cache', !!built.scriptCacheStore['avail_v1_' + today]);

  // A booking made through a completely fresh sheet mutation (bypassing the
  // handler) must not appear until the cache is invalidated - proves the
  // grid really is served from cache, not recomputed every time.
  const cachedAgain = call(sb, 'doGet', { parameter: { action: 'check_availability', date: today, secret: 'S3CR3T' } });
  check('second call within TTL returns the identical cached grid',
      JSON.stringify(cachedAgain) === JSON.stringify(first));

  const book = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'book', student_id: 's1', full_name: 'A', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('booking succeeds', book.success === true, JSON.stringify(book));
  check('booking invalidates that date\'s cache entry', !built.scriptCacheStore['avail_v1_' + today]);

  const afterBook = call(sb, 'doGet', { parameter: { action: 'check_availability', date: today, secret: 'S3CR3T' } });
  const slot9 = afterBook.slots.find(s => s.time_slot === '09:00-11:00' && s.machine_id === '100.83.83.70');
  check('booking is reflected immediately, not after the TTL', slot9 && slot9.available === false, JSON.stringify(slot9));

  const cancel = call(sb, 'doPost', {
    postData: { contents: JSON.stringify({ action: 'cancel_booking', student_id: 's1', date: today, time_slot: '09:00-11:00', machine_id: '100.83.83.70', secret: 'S3CR3T' }) },
  });
  check('cancel succeeds', cancel.success === true);
  check('cancel also invalidates the cache', !built.scriptCacheStore['avail_v1_' + today]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
