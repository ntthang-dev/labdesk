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
