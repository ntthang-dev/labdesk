# LabDesk — Kế hoạch nâng cấp từ MVP lên Production

> **Ngày lập:** 2026-09-17  
> **Phiên bản hiện tại:** MVP (commit `ce6bf94a6`)  
> **Mục tiêu:** Chuyển LabDesk sang trạng thái production-ready cho vận hành thực tế với nhiều sinh viên, suốt kỳ học.

---

## 1. Đánh giá tổng quan hiện trạng

### ✅ Những gì đã hoạt động tốt (MVP)

| Thành phần | Trạng thái | Ghi chú |
|---|---|---|
| Đăng nhập sinh viên (MSSV + Tên) | ✅ Hoạt động | Xác thực qua Google Apps Script |
| Kết nối remote desktop tự động | ✅ Hoạt động | Direct IP qua Tailscale |
| Phiên polling 12s + tự giải phóng 60s | ✅ Hoạt động | Heartbeat + stale session reaping |
| Admin kick qua Sheets | ✅ Hoạt động | Gõ `kick` vào cột `admin_action` |
| Whitelist sinh viên + suspend | ✅ Hoạt động | Sheet `Students` |
| Audit log | ✅ Hoạt động | Sheet `AuditLog` — tự ghi |
| View-only co-viewing | ✅ Hoạt động | Sinh viên thứ 2 xem không điều khiển |
| Ẩn IP/password/settings | ✅ Hoạt động | Security hardening đã hoàn thành |
| CI/CD build Windows + macOS | ✅ Hoạt động | GitHub Actions workflow |
| TLA+ formal verification | ✅ Hoạt động | Chứng minh không race condition |

### ❌ Những vấn đề cần giải quyết

```
┌─────────────────────────────────────────────────────────────────────┐
│  CRITICAL (ảnh hưởng trực tiếp đến vận hành)                      │
│  ─────────────────────────────────────────────────────              │
│  ❌ 1. Không có cơ chế đăng ký lịch (scheduling)                  │
│  ❌ 2. Không có file transfer tích hợp từ LabDesk                 │
│  ❌ 3. Không quản trị đóng/cắt từ xa (admin panel)                │
│                                                                     │
│  HIGH (ảnh hưởng UX và quản trị)                                   │
│  ──────────────────────────────────                                 │
│  ⚠️  4. UI login quá đơn giản, chưa có user guide                 │
│  ⚠️  5. Audit log chỉ có MSSV, không có tên sinh viên             │
│  ⚠️  6. Logo "LabDesk" lộ trên tab bar + chưa đúng branding       │
│  ⚠️  7. Sheets chưa tận dụng hết (nhiều trường chưa work)         │
│  ⚠️  8. Chưa có settings sinh viên có thể chỉnh                   │
│                                                                     │
│  MEDIUM (chất lượng & ổn định)                                     │
│  ─────────────────────────────                                     │
│  📋  9. Bản cài cho sinh viên chưa đảm bảo (notarize, installer)  │
│  📋 10. Chưa có cơ chế auto-update                                │
│  📋 11. Tên user hiển thị mỗi phiên cần cải thiện                 │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phân tích chi tiết từng vấn đề

### Vấn đề 1: Không có cơ chế đăng ký lịch

**Hiện trạng:** First-come first-served. Sinh viên đăng nhập → nếu có máy trống → dùng. Nếu hết → "Không còn máy trống".

**Vấn đề thực tế:** Với nhiều sinh viên cùng cần dùng suốt kỳ, không thể ai "xí" được giờ. Sinh viên không biết bao giờ máy trống, không thể lên lịch trước.

**Giải pháp đề xuất:**
- Thêm sheet `Schedule` với các cột: `date`, `time_slot`, `machine_id`, `student_id`, `full_name`, `status`
- Apps Script bổ sung actions: `book`, `my_bookings`, `cancel_booking`, `check_availability`
- LabDesk client thêm tab "Đặt lịch" hiển thị lịch tuần, chọn slot, đặt trước
- Khi đến giờ, sinh viên đăng nhập sẽ được ưu tiên máy đã book
- Admin quản lý slot qua Sheets (thêm/xóa time slot, block ngày lễ)

### Vấn đề 2: File transfer (QUAN TRỌNG NHẤT)

**Hiện trạng:** RustDesk có sẵn tính năng file transfer — trong toolbar của remote session có nút "Transfer file" (tại [`toolbar.dart` L461-466](file:///Users/ristresso/Developers/rustdesk/flutter/lib/common/widgets/toolbar.dart#L461-L466)). Nút này mở cửa sổ [`FileManagerPage`](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/file_manager_page.dart) hai cột (local ↔ remote) để kéo thả file.

**Vấn đề:** Sinh viên hiện kết nối qua LabDesk bằng `connect()` trong [`login_gate_page.dart`](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/login_gate_page.dart#L130-L135). Remote toolbar có nút "Transfer file" nhưng:
1. Nút này ẩn sâu trong **Control Actions menu** (icon ⚡ trên toolbar floating) → sinh viên không biết
2. Khi bấm, nó gọi `connectWithToken(isFileTransfer: true)` → mở **cửa sổ File Manager riêng** 2 cột (local ↔ remote) với đầy đủ tính năng: drag & drop, breadcrumb nav, progress bar, upload/download/delete/rename
3. **Cần kiểm tra:** FileManagerPage có lộ IP/hostname không (tab title, path breadcrumb)?
4. **Host-side permission:** Cần `enable-file-transfer` option trên host được bật (mặc định là YES trên official RustDesk)
5. **One-way transfer:** Host có option `one-way-file-transfer` — nếu bật, sinh viên chỉ tải lên được, không tải xuống

**Tóm tắt kỹ thuật:** File transfer engine RustDesk rất mạnh (chunk 128KB, nén tự động, resume, path traversal protection, atomic write). Chỉ cần expose đúng cách.

**Giải pháp đề xuất:**
- **Ngắn hạn (T1a):** Xác nhận file transfer hoạt động trong lab mode → test thủ công → fix nếu lộ IP
- **Ngắn hạn (T1b):** Thêm nút "📁 Truyền file" rõ ràng trên `_buildActiveSessionView` của LoginGatePage — nút này gọi `connectWithToken(isFileTransfer: true)` mở FileManager riêng
- **Trung hạn:** Thêm user guide in-app giải thích cách kéo thả file giữa local ↔ remote
- **Dài hạn:** Tạo quick-upload zone trên LoginGatePage cho phép sinh viên kéo file vào trước khi kết nối

### Vấn đề 3: Quản trị đóng/cắt từ xa

**Hiện trạng:** Admin phải mở Google Sheets → tìm đúng dòng → gõ `kick`. Không có giao diện quản trị riêng.

**Giải pháp đề xuất:**
- **Phase 2A:** Tạo Google Apps Script Web App riêng (hoặc HTML Service) — trang admin dashboard hiển thị:
  - Danh sách máy + trạng thái realtime (free/occupied/ai đang dùng)
  - Nút Kick cho từng sinh viên
  - Nút "Block IP" / "Suspend MSSV"
  - Thống kê sử dụng (số phiên/ngày, thời gian trung bình)
- **Phase 2B:** Bổ sung thêm actions trong `Code.gs`:
  - `admin_dashboard` — trả JSON trạng thái tất cả máy
  - `admin_kick` — kick theo machine_id hoặc student_id
  - `admin_suspend` — tạm khoá MSSV
  - `admin_broadcast` — gửi thông báo đến tất cả client đang online

### Vấn đề 4: UI login đơn giản + chưa có user guide

**Hiện trạng:** [`LoginGatePage`](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/login_gate_page.dart) chỉ có:
- Logo + tên "LabDesk"
- Một dòng hướng dẫn ngắn
- 2 field nhập + nút đăng nhập

**Giải pháp đề xuất:**
- Thêm **user guide** dạng expandable section ngay trên login page:
  - "📘 Hướng dẫn sử dụng" — collapsible
  - Bước 1: Nhập MSSV và Họ tên chính xác
  - Bước 2: Hệ thống tự kết nối
  - Bước 3: Cách truyền file (nút trên toolbar)
  - Bước 4: Cách ngắt kết nối an toàn
  - Liên hệ hỗ trợ
- Thêm **status indicator**: hiển thị số máy trống/bận trước khi đăng nhập (gọi API `check_availability`)
- Cải thiện layout: thêm gradient background, animation khi đăng nhập, trạng thái rõ ràng hơn

### Vấn đề 5: Audit log chỉ có MSSV

**Hiện trạng:** [`AuditLog`](file:///Users/ristresso/Developers/rustdesk/apps_script/Code.gs#L36-L39) ghi: `timestamp | student_id | machine_id | event_type | detail`. Cột `detail` có ghi `full_name` nhưng nằm lẫn trong text dạng "Nguyen Van A - Admin kick", không dễ filter.

**Giải pháp:** 
- Thêm cột `full_name` riêng biệt vào `AuditLog` (sửa `writeAuditLog()` thành 6 cột)
- Hoặc tạo sheet `AuditLogV2` với cấu trúc chuẩn: `timestamp | student_id | full_name | machine_id | event_type | detail`
- Admin dashboard hiển thị log có filter theo MSSV/tên/ngày

### Vấn đề 6: Logo "LabDesk" còn lộ + branding chưa đúng

**Hiện trạng:** 
- [`tabbar_widget.dart` L652](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/widgets/tabbar_widget.dart#L652): Hiển thị "RustDesk" trong tab bar (không lab-mode-gated)
- [`tabbar_widget.dart` L289](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/widgets/tabbar_widget.dart#L289): Tab label đã đúng "LabDesk" 
- [`tabbar_widget.dart` L647](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/widgets/tabbar_widget.dart#L646-L648): `loadIcon(16)` — vẫn dùng RustDesk icon trên title bar
- [`desktop_setting_page.dart` L2462](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/desktop_setting_page.dart#L2462): "About RustDesk" card

**Giải pháp:**
- Gate đoạn hiển thị "RustDesk" trong tab bar bằng `LabConfig.isLabMode` → thay bằng "LabDesk" hoặc ẩn
- Thay icon trong title bar khi lab mode
- Settings page không hiển thị cho sinh viên (đã ẩn), nhưng kiểm tra lại không có path nào lộ

### Vấn đề 7: Sheets chưa tận dụng hết

**Hiện trạng phân tích:**

| Sheet | Cột | Trạng thái |
|---|---|---|
| `Students` | `student_id` | ✅ Dùng whitelist |
| `Students` | `full_name` | ✅ Override tên nhập sai |
| `Students` | `status` | ✅ `suspended` → block |
| `ActiveSessions` | `machine_id` | ✅ Kết nối |
| `ActiveSessions` | `machine_name` | ✅ Hiển thị tên thân thiện |
| `ActiveSessions` | `status` | ✅ free/occupied |
| `ActiveSessions` | `student_id` | ✅ Ai đang dùng |
| `ActiveSessions` | `full_name` | ✅ Tên đang dùng |
| `ActiveSessions` | `session_token` | ✅ Token phiên |
| `ActiveSessions` | `started_at` | ✅ Thời điểm login |
| `ActiveSessions` | `admin_action` | ✅ Kick |
| `ActiveSessions` | `machine_pass` | ✅ Password động |
| `ActiveSessions` | `last_seen` | ✅ Heartbeat |
| `AuditLog` | Tất cả | ✅ Tự ghi |

**Chưa tận dụng / Cần bổ sung:**
- **Sheet `Students`**: Thiếu thông tin lớp, khóa, email, SĐT → khó quản lý khi đông
- **Sheet `ActiveSessions`**: Thiếu `duration` (thời gian dùng), `ip_client` (IP sinh viên đăng nhập từ đâu)
- **Sheet mới `Schedule`**: Cần cho đăng ký lịch
- **Sheet mới `Statistics`**: Tổng hợp thống kê hàng ngày/tuần
- **Sheet mới `Settings`**: Cấu hình hệ thống (giờ mở cửa lab, số phiên tối đa/ngày/SV, timeout)

### Vấn đề 8: Chưa có settings cho sinh viên

**Hiện trạng:** [`lab_init.dart`](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/lab_init.dart) ẩn hoàn toàn tất cả settings (general, security, network, server, proxy).

**Giải pháp:** Lộ ra một số settings an toàn cho sinh viên:
- **Display quality** (image quality: best/balanced/low)
- **Scroll style** (smooth vs. pixel)
- **View style** (original/adaptive/shrink)
- **Dark/Light mode**
- **Keyboard layout** (VN/EN)
- **Audio on/off** (nếu dùng audio streaming)

Cách thực hiện: Tạo một panel settings nhỏ trên `LoginGatePage` hoặc trên `_buildActiveSessionView` — chỉ expose các tùy chọn hiển thị, KHÔNG expose bất kỳ thông tin kết nối nào.

### Vấn đề 9: Bản cài cho sinh viên

**Hiện trạng:**
- Windows: Portable `.exe` (LabDesk-windows-x64.exe) ✅
- macOS: `.dmg` (unsigned) — cần `xattr -dr com.apple.quarantine` thủ công ⚠️
- Chưa có installer tự động cập nhật

**Giải pháp:**
- **Windows:** Tạo NSIS/WiX installer thay vì portable exe → tự tạo shortcut, đăng ký uninstall
- **macOS:** Ký notarize nếu có Apple Developer account ($99/năm) — nếu không, thêm hướng dẫn chi tiết vào user guide in-app
- **Auto-update:** Apps Script trả `latest_version` → client so sánh → hiển thị banner "Có bản mới, tải tại: ..."

### Vấn đề 10: Tên user hiển thị mỗi phiên

**Hiện trạng:** Trên `_buildActiveSessionView` hiển thị `_nameController.text` — tên từ ô nhập, không phải tên chính thức từ Sheets.

**Giải pháp:** Sau khi login thành công, `LoginResult` trả về `full_name` từ Sheets (Code.gs đã override bằng tên từ whitelist). Hiển thị tên chính thức này thay vì tên tự nhập.

---

## 3. Kế hoạch triển khai theo Phase

### Phase 2A: Nền tảng vận hành (ưu tiên cao nhất)

> **Mục tiêu:** LabDesk đủ điều kiện vận hành suốt kỳ học

| # | Nhiệm vụ | Ưu tiên | Scope | Phụ thuộc |
|---|---|---|---|---|
| T1 | **File Transfer tích hợp**: Xác nhận hoạt động trong lab mode, thêm nút "📁 Truyền file" trên active session view, thêm hướng dẫn | 🔴 Critical | M (3-4 files) | Không |
| T2 | **Cơ chế đăng ký lịch (Scheduling)**: Thêm sheet Schedule + API `book`/`cancel`/`check_availability` + UI đặt lịch trong LabDesk | 🔴 Critical | L (5-7 files) | Không |
| T3 | **Admin Dashboard**: Trang web quản trị (Google Apps Script HTML Service) với danh sách máy, nút kick, suspend, thống kê | 🔴 Critical | M (2-3 files) | Không |
| T4 | **Audit Log cải thiện**: Thêm cột `full_name` riêng vào AuditLog, hiển thị trên admin dashboard | 🟡 High | S (1-2 files) | T3 |
| T5 | **User Guide in-app**: Hướng dẫn sử dụng collapsible trên LoginGatePage + active session view | 🟡 High | S (1 file) | Không |

### Phase 2B: Chất lượng UX (ưu tiên cao)

| # | Nhiệm vụ | Ưu tiên | Scope | Phụ thuộc |
|---|---|---|---|---|
| T6 | **UI Login nâng cấp**: Thêm status indicator (máy trống/bận), cải thiện layout, gradient, animation | 🟡 High | S (1-2 files) | Không |
| T7 | **Branding fix**: Ẩn "RustDesk" trong tab bar khi lab mode, thay icon, kiểm tra tất cả branding leaks | 🟡 High | S (2-3 files) | Không |
| T8 | **Settings sinh viên**: Panel nhỏ cho phép chỉnh display quality, view style, dark/light mode | 🟡 High | S (2 files) | Không |
| T9 | **Tên user chính thức**: Hiển thị full_name từ LoginResult thay vì tên tự nhập, lưu vào state | 🟢 Medium | XS (1 file) | Không |
| T10 | **Sheets Students mở rộng**: Thêm cột lớp, khóa, email vào Students sheet + hiển thị trên admin dashboard | 🟢 Medium | S (2 files) | T3 |

### Phase 2C: Ổn định & Phân phối (ưu tiên trung bình)

| # | Nhiệm vụ | Ưu tiên | Scope | Phụ thuộc |
|---|---|---|---|---|
| T11 | **Windows Installer**: Tạo NSIS installer với shortcut, uninstall registry | 🟢 Medium | M (CI workflow) | Không |
| T12 | **Auto-update banner**: Apps Script `latest_version` + client check + banner download link | 🟢 Medium | S (2 files) | Không |
| T13 | **Sheets Settings**: Sheet `Settings` cho cấu hình runtime (giờ mở cửa, max phiên/SV/ngày, timeout) | 🟢 Medium | S (2 files) | T2 |
| T14 | **Thống kê sử dụng**: Sheet `Statistics` tự tổng hợp + biểu đồ trên admin dashboard | 🟢 Medium | M (3 files) | T3 |
| T15 | **macOS Notarize** (nếu có Apple Developer Account) | 🔵 Low | S (CI workflow) | Không |

---

## 4. Chi tiết nhiệm vụ ưu tiên

### Task 1: File Transfer tích hợp

**Mô tả:** Tính năng file transfer của RustDesk đã có sẵn (toolbar "Transfer file" → [`FileManagerPage`](file:///Users/ristresso/Developers/rustdesk/flutter/lib/desktop/pages/file_manager_page.dart)). Cần xác nhận hoạt động trong lab mode và expose rõ ràng cho sinh viên.

**Acceptance Criteria:**
- [ ] File transfer hoạt động khi sinh viên đang trong phiên kết nối lab mode
- [ ] Nút "📁 Truyền file" hiển thị rõ ràng trên `_buildActiveSessionView`
- [ ] Hướng dẫn ngắn cách dùng hiển thị khi bấm nút
- [ ] File transfer KHÔNG lộ IP/hostname của máy host

**Files likely touched:**
- `flutter/lib/desktop/pages/login_gate_page.dart` — thêm nút
- `flutter/lib/common/widgets/toolbar.dart` — xác nhận behavior
- `flutter/lib/desktop/pages/file_manager_page.dart` — kiểm tra lab mode compatibility

**Verification:**
- [ ] Build thành công trên macOS và Windows
- [ ] Test thủ công: copy file từ local → remote và ngược lại
- [ ] Không lộ IP/hostname ở bất kỳ đâu trong file manager

---

### Task 2: Cơ chế đăng ký lịch

**Mô tả:** Cho phép sinh viên đặt trước slot thời gian dùng máy lab. Admin quản lý slot qua Sheets.

**Acceptance Criteria:**
- [ ] Sheet `Schedule` tạo với các cột: `date`, `time_slot_start`, `time_slot_end`, `machine_id`, `student_id`, `full_name`, `status`
- [ ] API `check_availability` trả danh sách slot trống
- [ ] API `book` đặt slot, trả xác nhận
- [ ] API `cancel_booking` hủy đặt, trả xác nhận
- [ ] LabDesk hiển thị lịch tuần (dạng grid) + chọn slot + đặt
- [ ] Khi đến giờ, sinh viên đã book được ưu tiên (nếu login trong 10 phút đầu slot)
- [ ] Nếu sinh viên không login trong 10 phút, slot tự giải phóng

**Files likely touched:**
- `apps_script/Code.gs` — thêm handlers
- `flutter/lib/desktop/pages/login_gate_page.dart` — thêm tab/view lịch
- `flutter/lib/desktop/pages/lab_api_service.dart` — thêm API calls
- `apps_script/SETUP.md` — cập nhật hướng dẫn

---

### Task 3: Admin Dashboard

**Mô tả:** Trang web quản trị chạy trên Google Apps Script HTML Service, miễn phí.

**Acceptance Criteria:**
- [ ] Trang web hiển thị tất cả máy + trạng thái (free/occupied)
- [ ] Nút Kick cho từng sinh viên đang online
- [ ] Nút Suspend/Unsuspend cho MSSV
- [ ] Bảng audit log có filter theo ngày/MSSV/tên
- [ ] Bảo mật: chỉ admin (xác thực Google account) truy cập được
- [ ] Tự động refresh trạng thái máy mỗi 10 giây

**Files likely touched:**
- `apps_script/Code.gs` — thêm admin actions
- `apps_script/AdminDashboard.html` — trang web admin (mới)
- `apps_script/SETUP.md` — hướng dẫn deploy admin dashboard

---

## 5. Sơ đồ kiến trúc mục tiêu

```
┌──────────────────────────────────────────────────────────────────────┐
│  STUDENT CLIENT (LabDesk v2)                                        │
│  ┌───────────────────────────────┐  ┌────────────────────────────┐  │
│  │  LoginGatePage (nâng cấp)     │  │  Remote Session            │  │
│  │  • Status indicator           │  │  • Remote desktop          │  │
│  │  • Đặt lịch (Schedule tab)   │  │  • File Transfer (button)  │  │
│  │  • User guide (collapsible)   │  │  • Student settings        │  │
│  │  • Quick file upload          │  │  • View-only indicator     │  │
│  └───────────────────────────────┘  └────────────────────────────┘  │
│  • Auto-update banner                                               │
│  • Tên chính thức từ whitelist                                      │
│  • LabDesk branding (không lộ RustDesk)                             │
└──────────────────────────────────────────────────────────────────────┘
         │                                         │
         │ HTTP (Apps Script API)                   │ Direct IP (Tailscale)
         v                                         v
┌──────────────────────────────────────┐  ┌───────────────────────┐
│  BACKEND (Google Sheets + Script)    │  │  LAB HOST (Windows)   │
│                                      │  │  • Unmodified RustDesk│
│  Sheets:                             │  │  • Tailscale          │
│  • Students (whitelist + info mở)    │  │  • Direct IP 21118    │
│  • ActiveSessions (trạng thái máy)   │  └───────────────────────┘
│  • AuditLog v2 (full_name riêng)     │
│  • Schedule (NEW - đặt lịch)         │
│  • Settings (NEW - config runtime)   │
│  • Statistics (NEW - thống kê)       │
│                                      │
│  API Actions:                        │
│  • login, logout, status, ping       │
│  • book, cancel, check_availability  │  ← NEW
│  • admin_dashboard, admin_kick       │  ← NEW
│  • admin_suspend, latest_version     │  ← NEW
│                                      │
│  Admin Dashboard (HTML Service):     │  ← NEW
│  • Realtime machine status           │
│  • Kick / Suspend / Statistics       │
│  • Audit log viewer                  │
└──────────────────────────────────────┘
```

---

## 6. Rủi ro và biện pháp

| Rủi ro | Mức độ | Biện pháp |
|---|---|---|
| Google Apps Script rate limit (nhiều SV cùng poll) | Medium | Tăng poll interval lên 15-20s khi nhiều user; cache response; batch writes |
| File transfer lộ hostname/IP máy host | High | Kiểm tra kỹ FileManagerPage — nếu lộ, gate bằng LabConfig tương tự tabbar |
| Scheduling phức tạp quá → SV không biết dùng | Medium | UI đơn giản dạng calendar grid, chọn click, confirm ngay |
| Admin dashboard bị unauthorized access | High | Google Apps Script HTML Service chỉ cho phép Google account cụ thể |
| macOS unsigned gây khó cho SV M1/M2 | Medium | Hướng dẫn rõ trong user guide; ưu tiên ký nếu có tài khoản |
| Nhiều SV book slot nhưng không đến | Medium | Auto-release sau 10 phút + limit số book/SV/tuần |

---

## 7. Chi phí dự kiến

| Hạng mục | Chi phí |
|---|---|
| Google Apps Script + Sheets | **Miễn phí** (giới hạn ~20,000 calls/ngày — dư cho <100 SV) |
| GitHub Actions (build CI/CD) | **Miễn phí** (repo public) hoặc 2,000 phút/tháng (private) |
| GitHub Releases (lưu file cài) | **Miễn phí** |
| Admin Dashboard (HTML Service) | **Miễn phí** (chạy trong Apps Script) |
| Apple Developer Account (notarize) | $99/năm (tùy chọn) |
| **Tổng** | **0 đồng** (trừ Apple notarize nếu cần) |

---

## 8. Lịch trình gợi ý

```
Tuần 1-2:  T1 (File Transfer) + T7 (Branding fix) + T9 (Tên user)
Tuần 3-4:  T5 (User Guide) + T6 (UI Login) + T8 (Settings SV)
Tuần 5-6:  T4 (Audit Log) + T3 (Admin Dashboard)
Tuần 7-8:  T2 (Scheduling) + T10 (Students mở rộng)
Tuần 9-10: T11 (Installer) + T12 (Auto-update) + T13 (Settings Sheet)
Tuần 11+:  T14 (Thống kê) + T15 (Notarize)
```

> [!IMPORTANT]
> **Thứ tự ưu tiên:** T1 (File Transfer) → T7 (Branding) → T5 (User Guide) → T3 (Admin Dashboard) → T2 (Scheduling). File transfer là tính năng sinh viên cần nhất, và RustDesk đã có sẵn — chỉ cần expose đúng cách.

---

## 9. Câu hỏi mở cần xác nhận

1. **Số lượng máy lab:** Hiện tại chỉ 1 máy trong `ActiveSessions`. Bao nhiêu máy sẽ có trong production?
2. **Thời gian slot:** Mỗi slot đặt lịch bao lâu? 1 giờ? 2 giờ? Tùy chọn?
3. **Giờ mở cửa lab:** Lab mở từ mấy giờ đến mấy giờ? Có mở cuối tuần không?
4. **Apple Developer Account:** Có sẵn để notarize macOS không? Nếu không, SV dùng macOS nhiều không?
5. **Số sinh viên dự kiến:** Bao nhiêu SV sẽ dùng đồng thời? (ảnh hưởng Apps Script rate limit)
6. **Support contact:** Đã set `LAB_SUPPORT_CONTACT` chưa? (hiện đang trống)
7. **Admin Google account:** Email nào sẽ là admin cho dashboard?

---

## 10. Tính năng host-side RustDesk có thể tận dụng

> [!TIP]
> Lab host chạy official RustDesk **không** cần sửa code, nhưng có nhiều option cấu hình sẵn có thể bật từ xa hoặc cài sẵn:

| Tính năng | Option key | Mô tả | Đề xuất |
|---|---|---|---|
| Auto-disconnect khi idle | `allow-auto-disconnect` + `auto-disconnect-timeout` | Tự ngắt kết nối nếu không có input trong X phút (default 10 min) | Bật cho lab để giải phóng máy khi SV quên logout |
| Lock screen sau phiên | `lock-after-session-end` | Tự khóa màn hình Windows khi SV ngắt kết nối | Bật — bảo mật SV trước |
| Block local input | `enable-block-input` | Chặn chuột/bàn phím vật lý trên host khi có remote | Bật nếu host không cần thao tác trực tiếp |
| One-way file transfer | `one-way-file-transfer` | Chỉ cho SV upload lên host, không download xuống | Tùy yêu cầu — mặc định nên để 2 chiều |
| Max file transfer files | `file-transfer-max-files` | Giới hạn số file trong 1 phiên transfer (default 10,000) | Hạ xuống nếu lo SV lạm dụng |
| Remote restart | `enable-remote-restart` | Cho phép SV restart máy từ xa | TẮT — chỉ admin nên restart |

---

## 11. Regression Surface (Kiểm tra trước khi deploy)

Mỗi phase hoàn thành phải đảm bảo:
- [ ] `flutter test test/lab_client_test.dart` — 8/8 pass
- [ ] `node apps_script/test/run_test.js` — tất cả test pass
- [ ] Build thành công trên cả Windows x64 và macOS arm64
- [ ] Không lộ IP/password/secret ở bất kỳ UI nào
- [ ] Admin kick vẫn hoạt động
- [ ] Session timeout 60s vẫn hoạt động
- [ ] View-only co-viewing vẫn hoạt động
