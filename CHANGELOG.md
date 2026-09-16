# LabDesk — Changelog & Architecture Guide for AI Agents & Developers

> **System Purpose:** Custom RustDesk client for University Computer Lab Access (MVP).
> **Target Audience:** Future AI Agents (Antigravity, Claude Code, Cursor, Codex) and Human Maintainers.
> **Repository:** `https://github.com/ntthang-dev/labdesk`

---

## 1. System Architecture & MVP Scope

```
+-------------------------------------------------------------------------------+
| STUDENT CLIENT (LabDesk - macOS / Windows)                                    |
| - Custom Flutter UI (LoginGatePage: Name + MSSV only)                         |
| - No settings gear, no IP/password exposure                                   |
| - Authenticates with Google Apps Script Web App                               |
| - Automatic Direct IP connection to Lab Host via internal FFI                  |
| - Active polling (12s interval) to detect remote admin kick / session expiry  |
+-------------------------------------------------------------------------------+
                                      |
         1. HTTP POST action=login    | 2. Connect via Tailscale
            (Name, MSSV, Secret)      |    (100.83.83.70:21118)
                                      v
+----------------------------------+    +---------------------------------------+
| BACKEND (Google Sheets + Script) |    | LAB HOST MACHINE (Windows)            |
| - Google Apps Script (Code.gs)   |    | - 100% UNMODIFIED OFFICIAL RUSTDESK   |
| - Sheets: Students,              |    | - Running as Windows Service          |
|           ActiveSessions,        |    | - Permanent Password configured       |
|           AuditLog               |    | - "Enable direct IP access" (21118)   |
| - Admin kicks by typing "kick"   |    | - Connected to Tailscale (100.83.83.70|
+----------------------------------+    +---------------------------------------+
```

### Strict Scope Constraints (MVP)
* **Lab Host:** Strictly runs official, unmodified `rustdesk.exe`. **NO custom code, NO agent daemon** on the host.
* **Student Machine:** Runs `LabDesk` (customized viewer). Students **only** enter their Full Name and Student ID (MSSV).
* **Backend:** Serverless Google Sheets + Apps Script (`apps_script/Code.gs`).
* **Excluded (Phase 2):** Windows Host Agent daemon, NTFS ACL scripts, Wake-on-LAN, shutdown blocker. Do not implement these in MVP.

---

## 2. Changelog & Commit History

### Commit 1: `4bd618ed7` — Initial MVP Customization & CI/CD
- **Custom Branding:**
  - Renamed client from RustDesk to **LabDesk**.
  - Replaced application icons (`res/icon.png`, `res/icon.ico`, `res/mac-icon.png`, `flutter/macos/Runner/AppIcon.icns`).
  - Updated window titles and bundle identifiers (`flutter/macos/Runner/Configs/AppInfo.xcconfig`, `flutter/windows/runner/Runner.rc`).
- **Flutter UI & Core Entry Points:**
  - Created `flutter/lib/desktop/pages/login_gate_page.dart`: custom login screen replacing the standard RustDesk home tabs.
  - Created `flutter/lib/desktop/pages/lab_api_service.dart`: HTTP service communicating with Google Apps Script.
  - Added preview entrypoint `flutter/lib/main_lab_preview.dart` for fast desktop development.
- **Backend Implementation:**
  - Created `apps_script/Code.gs` supporting `login`, `status`, `logout`, and admin `kick` actions.
  - Created `apps_script/SETUP.md` with setup checklist for Google Sheets.
- **CI/CD Pipeline:**
  - Created `.github/workflows/lab-client-build.yml` for automated Windows x64 and macOS DMG compilation.

### Commit 2: `bb0a1bd98` — CI Triggers
- Updated workflow dispatch to trigger on pushes to `master` and tag releases (`v*`).

### Commit 3: `6531bf31f` — Google Apps Script 302 Redirect Handling & Ping
- **Issue:** Google Apps Script Web App returns HTTP 302 redirects to `script.googleusercontent.com` on POST requests. The default HTTP client failed to follow 302 with a payload, returning HTML and causing `FormatException`.
- **Fix:** Added `_sendWithRedirect()` in `flutter/lib/desktop/pages/lab_api_service.dart` to intercept 301/302/303 responses and follow with GET to retrieve the JSON response.
- Added `ping` action in `apps_script/Code.gs` for live connectivity validation.

### Commit 4: `325fffcf1` — macOS Window Launch Fix & Unit Tests
- **Issue:** `LabDesk.app` ran in background on macOS (PID active) but did not show any window.
- **Root Cause:** In `flutter/macos/Runner/MainFlutterWindow.swift`, the `window_manager` plugin hooked `hiddenWindowAtLaunch()`. Because the lab preview entrypoint did not explicitly call `windowManager.show()`, the window remained invisible.
- **Fix:**
  - Disabled `hiddenWindowAtLaunch()` in `MainFlutterWindow.swift`.
  - Added `windowManager.ensureInitialized()` and `windowManager.show()` + `windowManager.focus()` in `flutter/lib/main_lab_preview.dart`.
- **Unit Tests:** Created `flutter/test/lab_client_test.dart` testing `LabConfig`, `LoginResult`, `SessionStatus`, and `LabApiService` error handling.

### Commit 5: `1c8883b23` — Dart 3 Type Soundness Fix
- **Issue:** Xcode build failed on GitHub Actions runner with:
  `Error: The argument type 'Future<Null> Function(String)?' can't be assigned to the parameter type 'dynamic Function(dynamic)?'`
- **Fix:** In `flutter/lib/desktop/pages/desktop_setting_page.dart`, adjusted `onChanged(String value)` callbacks in `viewStyle`, `scrollStyle`, `imageQuality`, and `privacyMode` to `onChanged(dynamic value) async` with `.toString()`.

### Commit 6: `57e8d57cb` — Pre-generated Flutter Rust Bridge Files
- **Issue:** GitHub Actions macOS runner failed because `lib/models/native_model.dart` could not find `RustdeskImpl`.
- **Root Cause:** `flutter/lib/generated_bridge.dart` and `flutter/lib/generated_bridge.freezed.dart` were gitignored by upstream RustDesk. The cloud CI did not run `flutter_rust_bridge_codegen`.
- **Fix:** Force-tracked `generated_bridge.dart` and `generated_bridge.freezed.dart` with `git add -f`.

### Commit 7: `cf3072ac4` — macOS Native Bridge Header
- **Issue:** Xcode build failed on CI runner with:
  `Build input file cannot be found: '.../flutter/macos/Runner/bridge_generated.h'`.
- **Fix:** Force-tracked `flutter/macos/Runner/bridge_generated.h` with `git add -f`.

### Commit 8: `509c6227d` — Security Hardening & Eradication of Credential Exposure
- **Security Flaw:** The initial preview had a settings gear icon ⚙️ that opened `_showConfigDialog()`, exposing the Google Apps Script Web App URL, Shared Secret, Host IP (`100.83.83.70`), and Permanent Password to any student.
- **Hardening Applied:**
  1. **Completely deleted** `_showConfigDialog()` and the settings icon ⚙️ from `flutter/lib/desktop/pages/login_gate_page.dart`.
  2. **Removed** the unconfigured warning banner.
  3. **Centered** logo and constrained student inputs to **Full Name** and **Student ID (MSSV)** only.
  4. **Hidden IP Address:** The active connection view now displays the friendly machine name (e.g. `PC Lab 01` or `Máy phòng Lab`) instead of raw IP `100.83.83.70`.
  5. **Secure Defaults:** Embedded safe defaults in `LabConfig` from `apps_script/SETUP.md`:
     - Default Machine ID: `100.83.83.70`
     - Default Machine Password: `mat_khau_may_lab`
     - Default Shared Secret: `your-secret-key-here`
  6. **Sanitized Errors:** Generic error messages are presented to students (`Hệ thống phòng lab đang bận hoặc chưa sẵn sàng. Vui lòng liên hệ Quản trị viên.`) without leaking URLs, keys, or stack traces.
  7. **Admin Silent Provisioning:** Admins can still configure `~/.labdesk_config.json` locally or pass `--dart-define=LAB_API_URL=...` during build.

---

## 3. Important Files Reference

| Path | Purpose | Sensitive? |
|---|---|---|
| `flutter/lib/desktop/pages/login_gate_page.dart` | Main student login UI (Name + MSSV only). | User-facing |
| `flutter/lib/desktop/pages/lab_api_service.dart` | Communication with Apps Script (with 302 redirect handler). | Internal |
| `flutter/lib/main_lab_preview.dart` | Desktop app entrypoint for LabDesk preview. | Entrypoint |
| `apps_script/Code.gs` | Google Apps Script backend handling auth & kick logic. | Backend |
| `apps_script/SETUP.md` | Deployment instructions for the Google Spreadsheet. | Documentation |
| `flutter/test/lab_client_test.dart` | Automated test suite for LabDesk logic (8/8 passing). | Testing |
| `.github/workflows/lab-client-build.yml` | Multi-platform CI/CD for Windows x64 and macOS DMG. | CI/CD |
| `~/.labdesk_config.json` | Local admin config file (optional, overrides defaults). | Confidential |

---

## 4. How to Test & Verify

### Running Unit Tests
```bash
cd flutter
flutter test test/lab_client_test.dart
```
*Expected: 8/8 test cases pass with 0 failures.*

### Running macOS App Locally
```bash
cd flutter
flutter run -d macos -t lib/main_lab_preview.dart
```

### Packaging macOS DMG
```bash
cd /path/to/rustdesk
flutter/build/macos/Build/Products/Debug/LabDesk.app
hdiutil create -volname "LabDesk" -srcfolder flutter/build/macos/Build/Products/Debug/LabDesk.app -ov -format UDZO LabDesk-macOS.dmg
```

### Admin Configuration (`~/.labdesk_config.json`)
If you need to point the local client to your live Google Apps Script without recompiling:
```json
{
  "api_url": "https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec",
  "shared_secret": "your-secret-key-here",
  "machine_id": "100.83.83.70",
  "machine_password": "mat_khau_may_lab"
}
```

---

## 5. Instructions for Future AI Agents

1. **Follow `AGENTS.md`:**
   - Keep all diffs minimal.
   - Do not refactor unrelated RustDesk code.
   - Do not touch `src/rendezvous_mediator.rs` or `libs/hbb_common/` unless explicitly required.
2. **Never Re-introduce Credentials to the Student UI:**
   - The student screen must **NEVER** display IP addresses, passwords, secrets, or API endpoints.
   - Do not add debug buttons or settings modals to `LoginGatePage`.
3. **Lab Host Compatibility:**
   - The lab host must always remain a standard, unmodified RustDesk installation (`rustdesk.exe`).
   - If a feature requires changes on the host, push it to Phase 2.
