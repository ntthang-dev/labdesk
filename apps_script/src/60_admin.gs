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
    .addSeparator()
    .addItem('Tạo/kiểm tra toàn bộ sheets', 'adminSetupAllSheets')
    .addToUi();
}

// Every sheet this backend ever touches, with its header row. Sheets that
// self-create on first use (Schedule, Feedback) are listed too, so an admin
// can have them exist up front instead of wondering why they are missing
// before anyone has booked or sent feedback.
const SHEET_SCHEMA = {
  ActiveSessions: ['machine_id', 'machine_name', 'status', 'student_id', 'full_name',
    'session_token', 'started_at', 'admin_action', 'machine_pass', 'last_seen',
    'expires_at', 'group'],
  Students: ['student_id', 'full_name', 'status', 'group'],
  AuditLog: ['timestamp', 'student_id', 'machine_id', 'event_type', 'detail'],
  Config: ['key', 'value'],
  Queue: ['student_id', 'full_name', 'machine_id', 'requested_at'],
  Schedule: ['date', 'time_slot', 'machine_id', 'student_id', 'full_name', 'status', 'created_at'],
  Feedback: ['timestamp', 'student_id', 'full_name', 'message'],
};

// Creates any missing sheet and appends any missing column, without ever
// touching existing data or reordering existing columns. Returns a report of
// what it changed so the caller can show it.
function setupAllSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const created = [];
  const columnsAdded = [];
  for (const name in SHEET_SCHEMA) {
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(SHEET_SCHEMA[name]);
      created.push(name);
      continue;
    }
    const lastCol = sheet.getLastColumn();
    const headers = lastCol > 0 ? sheet.getRange(1, 1, 1, lastCol).getValues()[0] : [];
    if (headers.length === 0) {
      sheet.appendRow(SHEET_SCHEMA[name]);
      created.push(name + ' (thêm dòng tiêu đề)');
      continue;
    }
    SHEET_SCHEMA[name].forEach(function (col) {
      if (headers.indexOf(col) === -1) {
        ensureColumn(name, col);
        columnsAdded.push(name + '.' + col);
      }
    });
  }
  return { created: created, columnsAdded: columnsAdded };
}

function adminSetupAllSheets() {
  const report = setupAllSheets();
  const lines = [];
  lines.push(report.created.length
      ? 'Đã tạo sheet: ' + report.created.join(', ')
      : 'Không thiếu sheet nào.');
  lines.push(report.columnsAdded.length
      ? 'Đã thêm cột: ' + report.columnsAdded.join(', ')
      : 'Không thiếu cột nào.');
  lines.push('');
  lines.push('Lưu ý: cột "group" (Students/ActiveSessions) để trống thì tính năng '
      + 'giới hạn xem theo nhóm vẫn tắt, không ảnh hưởng gì.');
  SpreadsheetApp.getUi().alert('LabDesk — Kiểm tra sheets', lines.join('\n'),
      SpreadsheetApp.getUi().ButtonSet.OK);
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
