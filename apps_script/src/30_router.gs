// ----- API handlers -----

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action || e.parameter.action;

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    // feedback()/crash_report()/cancel_booking() only touch a single row
    // each (append, or cancel-by-owner) - no read-then-write race like
    // login/book, so none of them need (or benefit from) the allocation
    // lock below. publish_release() writes at most 2 Config cells by exact
    // key match (upsertConfigValue), same reasoning.
    if (action === 'feedback') {
      return handleFeedback(body);
    }
    if (action === 'crash_report') {
      return handleCrashReport(body);
    }
    if (action === 'cancel_booking') {
      return handleCancelBooking(body);
    }
    if (action === 'publish_release') {
      return handlePublishRelease(body);
    }

    // Allocating a machine (login) or a schedule slot (book) is
    // read-then-write; without a lock two simultaneous requests can both
    // see the same row/slot as free.
    const lock = LockService.getScriptLock();
    lock.waitLock(20000);
    try {
      switch (action) {
        case 'login':
          return handleLogin(body);
        case 'logout':
          return handleLogout(body);
        case 'book':
          return handleBook(body);
        default:
          return jsonResponse({ error: 'unknown action' }, 400);
      }
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    const secret = e.parameter.secret;

    // No secret check here on purpose - see CODE_VERSION comment above.
    if (action === 'version') {
      return jsonResponse({ code_version: CODE_VERSION, features: CODE_FEATURES });
    }

    if (secret !== SHARED_SECRET) {
      return jsonResponse({ error: 'unauthorized' }, 403);
    }

    switch (action) {
      case 'ping':
        return jsonResponse({
          status: 'ok',
          message: 'Google Apps Script Web App is connected successfully!',
          time: now()
        });
      case 'status':
        return handleStatus(e.parameter);
      case 'check_availability':
        return handleCheckAvailability(e.parameter);
      case 'my_bookings':
        return handleMyBookings(e.parameter);
      default:
        return jsonResponse({ error: 'unknown action' }, 400);
    }
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}
