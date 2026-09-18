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
