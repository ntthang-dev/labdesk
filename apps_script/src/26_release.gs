// ----- automatic version publishing (CI -> Config!latest_version) -----
//
// Before this, "update phần mềm từ xa" required an admin to manually edit
// two cells in `Config` after every build - easy to forget, and the whole
// reason `download_url` pointed at expiring `gh run download` links more
// than once (see docs/RELEASES_AND_CI.md). The build workflow now computes
// a semver version, cuts a GitHub Release, and calls this action itself.
//
// Deliberately does NOT touch `min_version`: that is a forced-upgrade
// trigger (blocks login below it), and auto-setting it from every build
// would let a single bad release lock every student out with no admin in
// the loop. Only `latest_version`/`download_url` (a dismissible banner) are
// safe to automate.
function ensureConfigSheet() {
  let sheet = getSheet('Config');
  if (sheet) return sheet;
  sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Config');
  sheet.appendRow(['key', 'value']);
  return sheet;
}

function upsertConfigValue(key, value) {
  const sheet = ensureConfigSheet();
  const data = sheet.getDataRange().getValues();
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][0] || '').trim() === key) {
      sheet.getRange(r + 1, 2).setValue(value);
      return;
    }
  }
  sheet.appendRow([key, value]);
}

function handlePublishRelease(body) {
  const version = String(body.version || '').trim();
  const downloadUrl = String(body.download_url || '').trim();
  if (!version) {
    return jsonResponse({ success: false, reason: 'Thiếu version.' });
  }
  upsertConfigValue('latest_version', version);
  if (downloadUrl) upsertConfigValue('download_url', downloadUrl);
  invalidateConfigCache();
  writeAuditLog('CI', '', 'release_published', version + (downloadUrl ? ' - ' + downloadUrl : ''));
  return jsonResponse({ success: true, latest_version: version });
}
