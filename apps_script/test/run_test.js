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
  const sb = loadCode(buildSandbox({ sharedSecret: 'S3CR3T', sheets }).sandbox, CODE_PATH);
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

  global.__ctx = { sb, sheets, token: res.session_token };
}

console.log('=== 3. status: active, then admin kick ===');
{
  const { sb, sheets, token } = global.__ctx;
  const st1 = call(sb, 'doGet', { parameter: { action: 'status', token, secret: 'S3CR3T' } });
  check('status active', st1.status === 'active', JSON.stringify(st1));

  const headers = sheets.ActiveSessions.headers;
  sheets.ActiveSessions.rows[0][headers.indexOf('admin_action')] = 'kick';

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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
