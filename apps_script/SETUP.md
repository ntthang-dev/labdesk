# Google Sheets + Apps Script Setup Guide

## 1. Create the Spreadsheet

1. Go to [Google Sheets](https://sheets.google.com) → Create new spreadsheet
2. Name it: `Lab Login System`

## 2. Create Sheets (tabs)

### Sheet 1: `Students` (optional — for whitelist)
| student_id | full_name | status | group |
|-----------|-----------|--------|-------|
| 20210001  | Nguyen Van A | active | Nhom1 |
| 20210002  | Tran Thi B | active | Nhom1 |

> If you don't need whitelist validation, skip this sheet. The script will still work.
>
> Cột `group` là **tùy chọn**. Nếu không tạo cột này, mọi sinh viên đều xem
> được máy đang bận (chế độ xem) như hiện tại — không có gì thay đổi. Nếu
> tạo cột `group` và điền giá trị (vd tên nhóm/lớp thực hành), sinh viên
> **khác nhóm** với người đang điều khiển máy sẽ **không vào được chế độ
> xem** của máy đó nữa (bị từ chối với lý do "Máy đang có sinh viên nhóm
> khác sử dụng"), còn sinh viên **cùng nhóm** vẫn xem được và thấy tên người
> đang điều khiển để liên hệ. Dùng khi nhiều nhóm thực hành dùng chung dãy
> máy và không muốn nhóm này nhìn thấy nhóm kia đang làm gì.

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
> **`latest_version`/`download_url` giờ có thể tự cập nhật, không cần sửa tay**:
> chạy CI với tuỳ chọn `publish_release=true` (hoặc push tag `vX.Y.Z`), workflow
> sẽ tự tính version, tạo GitHub Release, và gọi thẳng action `publish_release`
> để ghi 2 giá trị này — xem `docs/RELEASES_AND_CI.md`. `min_version` vẫn luôn
> phải admin tự đặt tay (quyết định "bắt buộc" không nên tự động).
>
> Thêm key `max_minutes` (số phút) vào cùng sheet `Config` để giới hạn thời
> gian mỗi phiên — hết giờ, client tự bị đăng xuất ở lần poll kế tiếp (≤12s),
> y hệt cơ chế mất kết nối 60s đã có. Không thêm key này = không giới hạn
> giờ, như hiện tại.
>
> Thêm key `max_bookings_per_week` (số nguyên) để giới hạn mỗi sinh viên chỉ
> được đặt tối đa N lượt đang hiệu lực (chưa huỷ, chưa qua) cùng lúc — chống
> 1 người ôm hết khung giờ. Không thêm key này = không giới hạn số lượt đặt.

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

### Sheet 6: `Schedule` (tự tạo — đặt lịch dùng máy theo tuần)

> **Không cần tạo tay** — script tự tạo sheet này (kèm header) lần đầu có
> ai đó gọi tính năng đặt lịch. Header tự sinh:
> `date, time_slot, machine_id, student_id, full_name, status, created_at`.
>
> Cấu hình khung giờ đặt lịch qua sheet `Config` (mục 4), thêm các key:
> - `slot_start_hour` (mặc định 7): giờ mở cửa lab, ví dụ `7` = 7:00
> - `slot_end_hour` (mặc định 19): giờ đóng cửa, ví dụ `19` = 19:00
> - `slot_duration_minutes` (mặc định 120): độ dài mỗi khung giờ đặt, tính
>   bằng phút — ví dụ `120` chia ngày thành các khung `07:00-09:00`,
>   `09:00-11:00`, ...
> - `booking_days_ahead` (mặc định 7): cho phép đặt trước tối đa bao nhiêu
>   ngày kể từ hôm nay.
>
> Sinh viên đặt 1 khung giờ cho 1 máy cụ thể qua nút "Đặt lịch dùng máy"
> trong app. Khi tới đúng khung giờ đã đặt, nếu có sinh viên **khác** (không
> phải người đặt) cố đăng nhập vào **đúng máy đó**, họ sẽ bị bỏ qua trong
> lượt quét tìm máy trống — máy đó coi như "đã có chủ" cho khung giờ này,
> dù đang `free` trên `ActiveSessions`. Người đã đặt vẫn đăng nhập bình
> thường vào đúng máy của mình. Không đặt lịch = hành vi y hệt hiện tại
> (ai vào trước dùng trước).
>
> Không tạo `Config!slot_*` cũng không sao — script dùng giá trị mặc định
> ở trên, tính năng đặt lịch vẫn hoạt động.

### Sheet 7: `Feedback` (tự tạo — góp ý từ sinh viên)

> **Không cần tạo tay** — script tự tạo khi có sinh viên gửi góp ý lần đầu
> qua nút "Gửi góp ý" trong app. Header tự sinh:
> `timestamp, student_id, full_name, message`. Mở sheet này để đọc góp ý;
> không cần làm gì thêm, không có xử lý tự động nào khác trên dữ liệu này.

### Sheet 8: `CrashLog` (tự tạo — báo lỗi/crash tự động từ app)

> **Không cần tạo tay** — script tự tạo khi app gặp lỗi lần đầu và tự gửi
> báo cáo (sinh viên không cần làm gì, không cần biết đã có lỗi xảy ra).
> Header tự sinh: `timestamp, app_version, platform, student_id, full_name,
> error, stack_trace`. Khác với `Feedback` (góp ý bằng lời của sinh viên):
> sheet này là log kỹ thuật, dùng để tìm lỗi phần mềm.
>
> Mở sheet này khi nghi ngờ có lỗi hàng loạt (nhiều dòng cùng cột `error`
> trong thời gian ngắn = lỗi thật, cần báo cho người phát triển kèm cột
> `stack_trace`). Sheet có thể lớn dần theo thời gian — admin có thể tự xoá
> bớt dòng cũ định kỳ, không có cơ chế tự dọn.

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
