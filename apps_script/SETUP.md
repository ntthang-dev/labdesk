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

### Sheet 3: `AuditLog`
**Just create the header row:**

| timestamp | student_id | machine_id | event_type | detail |
|----------|-----------|-----------|-----------|--------|

> Data will be appended automatically by the script.

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
**Deploy → Manage deployments → (biểu tượng bút chì) → Version: New version → Deploy**.
URL Web App giữ nguyên, không cần build lại client.
