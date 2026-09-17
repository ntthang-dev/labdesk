# Kiểm chứng hình thức luồng cấp phát phiên (TLA+)

`LabSession.tla` mô hình hoá đúng cơ chế cấp máy trong `apps_script/Code.gs`:
`handleLogin()` đọc `ActiveSessions` để tìm máy trống rồi mới ghi `occupied`
(read-then-write), và toàn bộ thao tác đó được bọc trong
`LockService.getScriptLock()`.

## Chạy lại

```bash
# Tải công cụ TLA+ chính thức (1 lần)
curl -sL -o /tmp/tla2tools.jar \
  "https://github.com/tlaplus/tlaplus/releases/latest/download/tla2tools.jar"

cd apps_script/formal

# Mô hình ĐANG CÓ khoá — đúng code hiện tại
java -cp /tmp/tla2tools.jar tlc2.TLC -config WithLock.cfg LabSession.tla

# Mô hình NẾU BỎ khoá — minh hoạ lỗi mà khoá đang ngăn
java -cp /tmp/tla2tools.jar tlc2.TLC -config WithoutLock.cfg LabSession.tla
```

## Kết quả

| Mô hình | Kết quả |
|---|---|
| `WithoutLock.cfg` (bỏ khoá) | **Tìm thấy lỗi** trong 5 bước: 2 sinh viên cùng đọc thấy 1 máy trống, cả hai đều nhận `allowed:true`, ghi đè lặng lẽ lên nhau — 1 người nghĩ đã kết nối được nhưng hệ thống không còn ghi nhận phiên của họ. |
| `WithLock.cfg` (đúng code hiện tại) | **Không có lỗi** — kiểm chứng cạn kiệt (exhaustive model checking), 9 trạng thái, không vi phạm |
| `WithLock_Large.cfg` (3 sinh viên, 2 máy) | **Không có lỗi** — 55 trạng thái, không vi phạm |

Kết luận: khoá `LockService.getScriptLock()` trong `handleLogin`/`handleLogout`
là **cần thiết** (thiếu nó thì lỗi race condition có thật) và **đủ** (có nó
thì không còn lỗi double-booking trong toàn bộ không gian trạng thái đã kiểm).

## Không mô hình hoá (ngoài phạm vi)

- `status()` (xử lý `kick`/hết hạn) và `logout()` chỉ chuyển `occupied → free`,
  không bao giờ cấp phát — nên không thể xung đột với `login()` dù không có
  khoá; điều này được phản ánh qua hành động `Free` trong spec (luôn chạy độc
  lập, không tranh khoá).
- Không mô hình hoá tính sống (liveness) — ví dụ "mọi máy occupied cuối cùng
  sẽ được giải phóng" — vì phụ thuộc hành vi polling phía client (12s) và cơ
  chế hết hạn 60s, tốt hơn nên kiểm bằng test thời gian thực
  (`apps_script/test/`) thay vì TLA+.
