// ----- crash / error reporting -----
//
// Separate from `Feedback` (student opinions, read by a human) on purpose:
// a crash report is machine-generated, needs different columns (app
// version, platform, stack trace), and an admin triaging bugs wants to
// filter it out from "sinh viên góp ý máy chậm" without regex-ing a shared
// sheet. Self-creating like Feedback/Schedule - a crash before anyone has
// ever crashed shouldn't be blocked on an admin remembering to add a tab.
function ensureCrashLogSheet() {
  let sheet = getSheet('CrashLog');
  if (sheet) return sheet;
  sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('CrashLog');
  sheet.appendRow(['timestamp', 'app_version', 'platform', 'student_id', 'full_name', 'error', 'stack_trace']);
  return sheet;
}

// Caps mirror handleFeedback's - this sheet has no whitelist gate beyond
// SHARED_SECRET (a crash can happen before/without a successful login), so
// an unbounded string is the same cheap defense-in-depth concern.
function capLength(s, max) {
  s = String(s || '');
  return s.length > max ? s.slice(0, max) : s;
}

// Fire-and-forget from the client's perspective (see lab_crash_reporter.dart)
// - it must never throw in a way that surfaces to a student mid-crash, so
// this handler is intentionally forgiving: missing fields just write blanks
// rather than rejecting the report.
function handleCrashReport(body) {
  const sheet = ensureCrashLogSheet();
  sheet.appendRow([
    now(),
    capLength(body.app_version, 40),
    capLength(body.platform, 40),
    capLength(body.student_id, 40),
    capLength(body.full_name, 200),
    capLength(body.error, 500),
    capLength(body.stack_trace, 4000),
  ]);
  return jsonResponse({ success: true });
}
