# `apps_script/src/` — mã nguồn backend, đã tách module

`Code.gs` ở thư mục cha **không sửa trực tiếp** — nó được **sinh tự động** bằng
cách nối các file trong thư mục này theo thứ tự tên file.

## Vì sao tách ở đây mà không tách trên Apps Script?

Apps Script **có** hỗ trợ nhiều file `.gs` trong cùng 1 project (mọi file dùng
chung 1 global scope, không cần `import`). Nhưng mỗi file thêm vào là một thứ
nữa admin phải tự tạo và tự đồng bộ bằng tay trong trình soạn thảo web — và
việc lệch phiên bản giữa các file đã khiến dự án này hỏng deploy 3 lần.

Nên: **tách để dev cho dễ, ghép lại thành 1 file để deploy cho an toàn.**
Quy trình dán 1 file vào Apps Script giữ nguyên như cũ.

## Các module

| File | Nội dung |
|---|---|
| `00_core.gs` | Hằng số, `SHARED_SECRET`, `CODE_VERSION`, helper Sheets, cache, `readConfig` |
| `10_schedule.gs` | Khung giờ, đặt lịch, huỷ lịch, kiểm tra máy đã được đặt trước |
| `20_misc.gs` | So sánh phiên bản, hàng đợi (Queue) |
| `30_router.gs` | `doGet` / `doPost` — định tuyến toàn bộ API |
| `40_session.gs` | `handleLogin` / `handleStatus` / `handleLogout` |
| `50_feedback.gs` | Góp ý của sinh viên, `jsonResponse` |
| `60_admin.gs` | Menu LabDesk trong Sheets, `setupAllSheets` |

Tiền tố số quyết định thứ tự nối. Hàm trong JS được hoisted nên thứ tự gọi
không quan trọng, nhưng `const` ở cấp cao nhất thì có — vì vậy `00_core.gs`
luôn đứng đầu.

## Lệnh

```bash
node apps_script/build.js          # sinh lại Code.gs sau khi sửa src/
node apps_script/build.js --check  # báo lỗi nếu Code.gs lệch với src/ (dùng trong CI)
node apps_script/test/run_test.js  # chạy test trên Code.gs đã sinh
```

**Sau khi sửa bất kỳ file nào trong `src/`, phải chạy `build.js` rồi mới dán
`Code.gs` lên Apps Script** — nếu quên, bản deploy sẽ không có thay đổi của bạn.
