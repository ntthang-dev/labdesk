# Google Sheets + Apps Script Setup Guide

## 1. Create the Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) → Create new spreadsheet
2. Name it: `Lab Login System`

## 2. Create Sheets (tabs)

### Sheet 1: `Students` (optional — for whitelist)
| student_id | full_name | status |
|-----------|-----------|--------|
| 20210001  | Nguyen Van A | active |
| 20210002  | Tran Thi B | active |

> If you don't need whitelist validation, skip this sheet. The script will still work.

### Sheet 2: `ActiveSessions`
**Pre-populate one row per lab machine:**

| machine_id | machine_name | status | student_id | full_name | session_token | started_at | admin_action | machine_pass | last_seen |
|-----------|-------------|--------|-----------|-----------|---------------|-----------|--------------|--------------|-----------|
| 100.83.83.70 | PC Lab 01 | free   |           |           |               |           |              | (mật khẩu máy lab) |           |

> `machine_id` có thể là IP Tailscale (`100.83.83.70`) hoặc mã RustDesk ID (9 chữ số). `machine_pass` là mật khẩu cố định đã đặt trên máy lab (`rustdesk.exe --password <pass>`) — client lấy mật khẩu từ đây nên **không** cần bake vào bản build.
>
> `last_seen` được script tự ghi mỗi lần client poll. Nếu quên tạo cột, script sẽ tự thêm ở lần `login` đầu tiên. Một phiên không còn heartbeat quá 60 giây sẽ tự được giải phóng và ghi `expired` vào `AuditLog` — nhờ vậy sinh viên tắt cứng app không làm kẹt máy.
>
> **Nhiều máy lab: đã hỗ trợ sẵn, không cần sửa code.** Thêm dòng nữa vào
> sheet này (mỗi dòng 1 máy, mỗi máy 1 `machine_pass` riêng) là xong.
> `handleLogin` tự quét tìm máy trống đầu tiên; hết máy trống thì sinh viên
> tiếp theo được vào **chế độ xem** máy đang bận + xếp hàng, y như với 1 máy.
> (`apps_script/test/run_test.js` test #15 kiểm chứng đúng hành vi này.)

### Sheet 3: `AuditLog`
**Just create the header row:**

| timestamp | student_id | machine_id | event_type | detail |
|----------|-----------|-----------|-----------|--------|

> Data will be appended automatically by the script.

### Sheet 4: `Config` (optional — remote update control)

| key | value |
|-----|-------|
| min_version | 1.0.0 |
| latest_version | 1.0.0 |
| download_url | |

> Toàn bộ sheet là tùy chọn — nếu không tạo, tính năng cập nhật từ xa tự tắt,
> mọi client đều đăng nhập bình thường.
> - `min_version`: client cũ hơn số này **bị chặn đăng nhập**, kèm nút tải bản mới.
>   Dùng khi phải bắt buộc toàn bộ sinh viên lên bản mới (vd: vừa vá lỗi bảo mật).
> - `latest_version`: client cũ hơn (nhưng vẫn ≥ `min_version`) chỉ thấy banner
>   "có bản mới", vẫn dùng được bình thường.
> - `download_url`: link tải bản mới nhất — nên trỏ tới **GitHub Release**
>   (`gh release create v1.0.1 ...`), không dùng link `gh run download` (hết hạn
>   sau ~90 ngày).
> - So khớp version: 2 số càng nhiều đoạn `.` càng chi tiết (`1.2.0` < `1.10.0`
>   đúng theo số, không so như chuỗi ký tự).
>
> Thêm key `max_minutes` (số phút) vào cùng sheet `Config` để giới hạn thời
> gian mỗi phiên — hết giờ, client tự bị đăng xuất ở lần poll kế tiếp (≤12s),
> y hệt cơ chế mất kết nối 60s đã có. Không thêm key này = không giới hạn
> giờ, như hiện tại.

### Sheet 5: `Queue` (optional — hàng đợi)

| student_id | full_name | machine_id | requested_at |
|-----------|-----------|-----------|--------------|

> Tùy chọn — nếu không tạo, sinh viên vào chế độ xem như bình thường,
> chỉ không có số thứ tự. Nếu tạo (chỉ cần header row, script tự ghi):
> khi máy đang bận, sinh viên login được vào **chế độ xem** kèm số thứ tự
> hàng đợi (`Vị trí của bạn: #2`). **Không có thông báo đẩy** — sinh viên
> phải tự thử đăng nhập lại vài phút sau để kiểm tra máy đã trống chưa;
> đây là hàng đợi đơn giản cho MVP, không phải đặt chỗ tự động.
> Khi 1 sinh viên trong hàng đợi login thành công (vào được với vai trò
> điều khiển), họ tự được xoá khỏi `Queue`; những người còn lại không đổi.

## 3. Add the Apps Script

1. In the spreadsheet → **Extensions** → **Apps Script**
2. Delete all existing code in `Code.gs`
3. Copy-paste the contents of `apps_script/Code.gs` from this repo
4. Save (Ctrl+S)

## 4. Set Script Properties

1. In Apps Script editor → **Project Settings** (gear icon on left)
2. Scroll to **Script Properties** → **Add script property**
3. Add: `SHARED_SECRET` = `your-secret-key-here` (choose a strong random string)
4. Click **Save script properties**

> Sinh một chuỗi mạnh bằng `openssl rand -hex 24`. `SHARED_SECRET` **không phải** mật khẩu RustDesk của máy lab — nó chỉ để chặn người ngoài gọi thẳng Web App URL.

## 5. Deploy as Web App

1. Click **Deploy** → **New deployment**
2. Type: **Web app**
3. Description: `Lab Login API`
4. Execute as: **Me**
5. Who has access: **Anyone** (important — the client needs to reach it without Google login)
6. Click **Deploy**
7. Copy the **Web app URL** — this is your `LAB_API_URL`
8. **Authorize** the script when prompted (grant spreadsheet access)

## 6. Test the API

### Test login:
```bash
curl -X POST "YOUR_WEB_APP_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"login","student_id":"20210001","full_name":"Nguyen Van A","secret":"your-secret-key-here"}'
```

Expected: `{"allowed":true,"session_token":"...","machine_id":"100.83.83.70","machine_name":"PC Lab 01","machine_pass":"..."}`

### Test status:
```bash
curl "YOUR_WEB_APP_URL?action=status&token=THE_TOKEN&secret=your-secret-key-here"
```

Expected: `{"status":"active"}`

### Test kick (admin):
1. In the spreadsheet, find the occupied row in `ActiveSessions`
2. Type `kick` in the `admin_action` column
3. Call status again → Expected: `{"status":"kicked"}`

### Test logout:
```bash
curl -X POST "YOUR_WEB_APP_URL" \
  -H "Content-Type: application/json" \
  -d '{"action":"logout","session_token":"THE_TOKEN","secret":"your-secret-key-here"}'
```

Expected: `{"success":true}`

## Admin Usage

- **View who's connected**: Open `ActiveSessions` sheet — see `status`, `student_id`, `full_name`, `started_at`
- **Kick a student**: Type `kick` in `admin_action` column of that row → within 12-15 seconds the student's client disconnects
- **View logs**: Open `AuditLog` sheet — all events logged with timestamps
- **Slot bị kẹt**: không cần làm gì, sau 60 giây không có heartbeat script tự trả máy về `free`
- **Block a student**: In `Students` sheet, change their `status` to `suspended`

## Sau khi sửa `Code.gs`

Apps Script chỉ phục vụ phiên bản đã deploy. Mỗi lần dán code mới phải:
**Deploy → Manage deployments → (biểu tượng bút chì ✏️ bên cạnh deployment đang có) → Version: New version → Deploy**.
URL Web App giữ nguyên, không cần build lại client.

> [!WARNING]
> **Đừng bấm "Deploy" ở màn hình chính rồi chọn "New deployment"** — cái đó tạo
> ra một **deployment hoàn toàn mới với URL khác**, không cập nhật cái đang
> chạy. Lỗi này đã xảy ra nhiều lần: dán code mới xong tưởng đã xong, nhưng
> app vẫn gọi vào URL cũ (code cũ). Luôn vào theo đường:
> **Deploy → Manage deployments** (không phải nút Deploy to lớn ở góc trên) →
> tìm deployment **đã có sẵn** → bấm ✏️ → **Version: New version**.
>
> Nếu lỡ tạo deployment mới: copy URL mới, báo lại để cập nhật
> `LAB_API_URL` trong GitHub Secrets (`gh secret set LAB_API_URL --body "<url mới>"`)
> rồi build lại app — nếu không app vẫn gọi vào URL cũ.
