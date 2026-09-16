# Testing Code.gs without a live Google account

Google Apps Script has no local runtime, so `apps_script/Code.gs` can't be
`node`-executed directly — it calls global services (`PropertiesService`,
`SpreadsheetApp`, `LockService`, `ContentService`, `Utilities`) that only
exist inside Google's environment.

`mock_gas.js` is a minimal in-memory stand-in for those services (a fake
sheet backed by a 2D array), so `Code.gs` can be loaded unmodified via
Node's `vm` module and driven through `doGet`/`doPost` exactly as the real
Web App would call them.

## Run

```bash
node apps_script/test/run_test.js
```

Covers: ping/auth, login allocation, machine-occupied rejection,
duplicate-session-for-one-student rejection, status active/kicked/not_found,
logout, the 60s no-heartbeat auto-reclaim, the Students whitelist
(active/suspended/unlisted), and wrong-secret rejection.

This only proves the *logic* in `Code.gs` is correct — it does not touch
your live Sheet or deployment. After editing `Code.gs`, run this first, then
paste the file into the Apps Script editor and redeploy
(**Deploy → Manage deployments → New version**) to actually update the
live API.
