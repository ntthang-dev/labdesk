// ----- scheduling (optional Schedule sheet, self-creating like Feedback) -----
//
// Reservation model: a fixed grid of same-length slots per day
// (Config!slot_start_hour..slot_end_hour, split into slot_duration_minutes
// chunks - defaults 7:00-19:00 in 2h blocks = 6 slots/day), not free-form
// time ranges. That keeps the "is this slot taken" check an exact string
// match instead of interval-overlap math, which is the whole reason this
// stays simple enough to trust: no two bookings can partially overlap by
// construction, only coincide or not.
// `parseInt(x, 10) || fallback` breaks for a legitimate 0 (e.g.
// slot_start_hour=0 for a lab open from midnight) - 0 is falsy in JS, so it
// silently gets overridden by the fallback instead of respected. Only an
// actually-missing/unparseable value should fall back.
function intConfig(value, fallback) {
  const n = parseInt(value, 10);
  return isNaN(n) ? fallback : n;
}

function slotConfig(config) {
  return {
    startHour: intConfig(config.slot_start_hour, 7),
    endHour: intConfig(config.slot_end_hour, 19),
    durationMin: intConfig(config.slot_duration_minutes, 120),
    daysAhead: intConfig(config.booking_days_ahead, 7),
  };
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// All slot label strings for one day, e.g. ["07:00-09:00", "09:00-11:00", ...].
function getSlotsForDay(config) {
  const sc = slotConfig(config);
  const slots = [];
  for (let mins = sc.startHour * 60; mins + sc.durationMin <= sc.endHour * 60; mins += sc.durationMin) {
    const startH = Math.floor(mins / 60), startM = mins % 60;
    const endMins = mins + sc.durationMin;
    const endH = Math.floor(endMins / 60), endM = endMins % 60;
    slots.push(pad2(startH) + ':' + pad2(startM) + '-' + pad2(endH) + ':' + pad2(endM));
  }
  return slots;
}

function dateStr(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// The slot label covering right now, or null outside operating hours /
// between slots. Login-time enforcement (handleLogin) and check_availability
// both need "which slot is 'current'" to agree, so this is the one place
// that decides it.
function getCurrentSlot(config) {
  const now = new Date();
  const slots = getSlotsForDay(config);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const slot of slots) {
    const start = slot.split('-')[0].split(':');
    const startMin = parseInt(start[0], 10) * 60 + parseInt(start[1], 10);
    if (nowMin >= startMin && nowMin < startMin + slotConfig(config).durationMin) {
      return { date: dateStr(now), slot: slot };
    }
  }
  return null;
}

function ensureScheduleSheet() {
  let sheet = getSheet('Schedule');
  if (sheet) return sheet;
  sheet = SpreadsheetApp.getActiveSpreadsheet().insertSheet('Schedule');
  sheet.appendRow(['date', 'time_slot', 'machine_id', 'student_id', 'full_name', 'status', 'created_at']);
  return sheet;
}

// Active (status=booked) bookings as [{row, date, time_slot, machine_id,
// student_id, full_name}]. Loaded once per call site instead of re-scanning
// per lookup - the sheet stays small enough (days_ahead x slots x machines)
// that this is cheap.
function readActiveBookings() {
  const sheet = getSheet('Schedule');
  if (!sheet) return [];
  const data = sheet.getDataRange().getValues();
  if (data.length < 2) return [];
  const headers = data[0];
  const cols = {
    date: headers.indexOf('date'), slot: headers.indexOf('time_slot'),
    machine: headers.indexOf('machine_id'), sid: headers.indexOf('student_id'),
    name: headers.indexOf('full_name'), status: headers.indexOf('status'),
  };
  const out = [];
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][cols.status] || '').trim().toLowerCase() !== 'booked') continue;
    out.push({
      row: r + 1,
      date: String(data[r][cols.date] || '').trim(),
      time_slot: String(data[r][cols.slot] || '').trim(),
      machine_id: String(data[r][cols.machine] || '').trim(),
      student_id: String(data[r][cols.sid] || '').trim(),
      full_name: String(data[r][cols.name] || '').trim(),
    });
  }
  return out;
}

// Machine reserved for someone else right now? handleLogin's free-machine
// scan calls this so a walk-up student can't take a seat someone booked
// ahead of time - the entire point of having a schedule.
function reservedForSomeoneElse(machineId, studentId, config) {
  const current = getCurrentSlot(config);
  if (!current) return null;
  const booking = readActiveBookings().find(b =>
      b.date === current.date && b.time_slot === current.slot &&
      b.machine_id === machineId.trim());
  if (booking && booking.student_id !== String(studentId).trim()) return booking;
  return null;
}

function handleCheckAvailability(params) {
  const config = readConfig();
  const sc = slotConfig(config);
  const date = params.date || dateStr(new Date());
  const slots = getSlotsForDay(config);
  const bookings = readActiveBookings().filter(b => b.date === date);

  const sessSheet = getSheet('ActiveSessions');
  const machines = sessSheet ? sessSheet.getDataRange().getValues().slice(1)
      .map(r => ({ id: String(r[0] || '').trim(), name: String(r[1] || '').trim() })) : [];

  const grid = [];
  for (const slot of slots) {
    for (const m of machines) {
      const booking = bookings.find(b => b.time_slot === slot && b.machine_id === m.id);
      grid.push({
        date: date,
        time_slot: slot,
        machine_id: m.id,
        machine_name: m.name || m.id,
        available: !booking,
        booked_by: booking ? booking.full_name : null,
        booked_by_student_id: booking ? booking.student_id : null,
      });
    }
  }
  return jsonResponse({ date: date, days_ahead: sc.daysAhead, slots: grid });
}

function handleMyBookings(params) {
  const studentId = String(params.student_id || '').trim();
  if (!studentId) return jsonResponse({ bookings: [] });
  const today = dateStr(new Date());
  const bookings = readActiveBookings()
      .filter(b => b.student_id === studentId && b.date >= today)
      .map(b => ({ date: b.date, time_slot: b.time_slot, machine_id: b.machine_id }));
  return jsonResponse({ bookings: bookings });
}

function handleBook(body) {
  const studentId = String(body.student_id || '').trim();
  const fullName = String(body.full_name || '').trim();
  const date = String(body.date || '').trim();
  const timeSlot = String(body.time_slot || '').trim();
  const machineId = String(body.machine_id || '').trim();
  if (!studentId || !date || !timeSlot || !machineId) {
    return jsonResponse({ success: false, reason: 'Thiếu thông tin đặt lịch.' });
  }

  const config = readConfig();
  const sc = slotConfig(config);
  if (getSlotsForDay(config).indexOf(timeSlot) === -1) {
    return jsonResponse({ success: false, reason: 'Khung giờ không hợp lệ.' });
  }
  const today = dateStr(new Date());
  const maxDate = dateStr(new Date(Date.now() + sc.daysAhead * 86400000));
  if (date < today || date > maxDate) {
    return jsonResponse({ success: false, reason: 'Chỉ được đặt lịch trong ' + sc.daysAhead + ' ngày tới.' });
  }

  const existing = readActiveBookings();
  if (existing.some(b => b.date === date && b.time_slot === timeSlot && b.machine_id === machineId)) {
    return jsonResponse({ success: false, reason: 'Khung giờ này đã có người đặt máy này. Vui lòng chọn máy hoặc khung giờ khác.' });
  }
  if (existing.some(b => b.date === date && b.time_slot === timeSlot && b.student_id === studentId)) {
    return jsonResponse({ success: false, reason: 'Bạn đã đặt một máy khác trong khung giờ này rồi.' });
  }
  // Only slots that haven't happened yet count against the cap - nothing
  // ever flips an elapsed booking's status, so counting every row a student
  // has ever booked would lock them out permanently once they first hit the
  // cap. handleMyBookings() applies the same `>= today` filter.
  const maxPerWeek = parseInt(config.max_bookings_per_week, 10);
  const upcomingForStudent = existing.filter(
      b => b.student_id === studentId && b.date >= today);
  if (maxPerWeek > 0 && upcomingForStudent.length >= maxPerWeek) {
    return jsonResponse({ success: false, reason: 'Bạn đang giữ tối đa ' + maxPerWeek + ' lượt đặt sắp tới. Huỷ bớt một lượt để đặt lượt mới.' });
  }

  const sheet = ensureScheduleSheet();
  sheet.appendRow([date, timeSlot, machineId, studentId, fullName, 'booked', now()]);
  writeAuditLog(studentId, machineId, 'booked', fullName + ' - ' + date + ' ' + timeSlot);
  return jsonResponse({ success: true });
}

function handleCancelBooking(body) {
  const studentId = String(body.student_id || '').trim();
  const date = String(body.date || '').trim();
  const timeSlot = String(body.time_slot || '').trim();
  const machineId = String(body.machine_id || '').trim();

  const sheet = getSheet('Schedule');
  if (!sheet) return jsonResponse({ success: false, reason: 'Chưa có lịch nào.' });
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const cols = {
    date: headers.indexOf('date'), slot: headers.indexOf('time_slot'),
    machine: headers.indexOf('machine_id'), sid: headers.indexOf('student_id'),
    status: headers.indexOf('status'),
  };
  for (let r = 1; r < data.length; r++) {
    if (String(data[r][cols.date]).trim() === date &&
        String(data[r][cols.slot]).trim() === timeSlot &&
        String(data[r][cols.machine]).trim() === machineId &&
        String(data[r][cols.sid]).trim() === studentId &&
        String(data[r][cols.status]).trim().toLowerCase() === 'booked') {
      sheet.getRange(r + 1, cols.status + 1).setValue('cancelled');
      writeAuditLog(studentId, machineId, 'booking_cancelled', date + ' ' + timeSlot);
      return jsonResponse({ success: true });
    }
  }
  return jsonResponse({ success: false, reason: 'Không tìm thấy lịch đặt này.' });
}

// Compares dot-separated numeric versions ("1.2.0" vs "1.10.0"). Returns
// negative/0/positive like a normal comparator. Unparseable segments count
// as 0, so a malformed Config value fails open (never blocks login) rather
// than throwing.
