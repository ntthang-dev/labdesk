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
