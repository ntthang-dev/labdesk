# LabDesk — Hướng dẫn nhanh cho Quản trị viên

Tài liệu này trả lời các câu hỏi vận hành thường gặp. Chi tiết kỹ thuật hơn
xem `CHANGELOG.md` (kiến trúc), `apps_script/SETUP.md` (setup Sheets), và
`apps_script/formal/README.md` (kiểm chứng hình thức luồng cấp phiên).

> [!WARNING]
> **Lỗi hay gặp nhất khi cập nhật `Code.gs`**: bấm nút **Deploy** to ở góc
> trên rồi chọn **New deployment** → việc này tạo ra **deployment MỚI với URL
> khác** thay vì cập nhật deployment đang chạy. App vẫn gọi vào URL cũ (code
> cũ) — dán code mới tưởng xong nhưng thực ra chưa có gì thay đổi. Đã xảy ra
> **2 lần** trong quá trình làm việc. Luôn làm đúng theo:
> **Deploy → Manage deployments → bấm ✏️ cạnh deployment đã có → Version: New
> version → Deploy**. Nếu lỡ tạo deployment mới, báo ngay để cập nhật lại
> `LAB_API_URL` trong GitHub Secrets và build lại app.

## App đang nằm ở đâu trên máy tôi?

`/Applications/LabDesk.app` — chỉ có **đúng 1 bản**. Nếu bạn nghi ngờ có
nhiều bản trùng nhau, chạy:
```bash
find / -maxdepth 6 -iname "LabDesk.app" 2>/dev/null
```
`/System/Volumes/Data/Applications/...` (nếu có) chỉ là cùng 1 file macOS
tự liên kết, không phải bản khác.

## Cài trên Windows bị chặn "Windows protected your PC" — làm sao?

**Sự thật thẳng thắn:** không có cách nào loại bỏ hoàn toàn cảnh báo này nếu
không **ký số (code signing)** file `.exe`, và ký số cần mua chứng chỉ
(~100-400 USD/năm cho chứng chỉ thường, có "thời gian làm quen" trước khi
Windows tin tưởng; ~300-600 USD/năm cho chứng chỉ EV thì tin tưởng ngay lập
tức). Tôi không thể tự mua hộ bạn — đây là quyết định + chi phí bạn phải
chọn nếu muốn xử lý tận gốc (mục **D3** trong kế hoạch nâng cấp).

**Việc làm ngay được, miễn phí — hướng dẫn sinh viên 3 bước:**
1. Chạy file `LabDesk-windows-x64.exe` → Windows hiện "Windows protected your PC"
2. Bấm chữ **"More info"** (chữ nhỏ, dễ bỏ sót)
3. Bấm nút **"Run anyway"** xuất hiện bên dưới

Chỉ cần làm 1 lần — sau đó Windows nhớ và không hỏi lại với đúng file đó (hỏi
lại nếu tải file mới sau khi bạn ra bản cập nhật).

**Việc tôi có thể chuẩn bị sẵn** nếu bạn quyết định mua chứng chỉ sau này:
CI đã có sẵn cấu trúc để thêm bước ký (`signtool.exe` + chứng chỉ lưu trong
GitHub Secrets) — chỉ cần bạn có file `.pfx` và mật khẩu, báo tôi để nối vào
pipeline, không cần đổi gì phía code app.

## Sheet `ActiveSessions` hoạt động ra sao?

Đây **không phải log** — mỗi dòng là **trạng thái sống hiện tại** của 1 máy
lab (MVP hiện chỉ có 1 dòng cho 1 máy). Các cột:

| Cột | Ý nghĩa |
|---|---|
| `machine_id` | IP Tailscale của máy lab (client dùng để kết nối) |
| `machine_name` | Tên thân thiện hiện cho sinh viên (VD "PC Lab 01") |
| `status` | `free` (trống) hoặc `occupied` (đang có người dùng) |
| `student_id`, `full_name` | Ai đang chiếm máy (rỗng khi `free`) |
| `session_token` | Mã phiên ngẫu nhiên, client dùng để poll trạng thái |
| `started_at` | Thời điểm login |
| `last_seen` | Lần cuối client poll — dùng để tự thu hồi nếu client "biến mất" quá 60s |
| `admin_action` | **Gõ tay `kick` vào đây để đá sinh viên đang dùng máy** |
| `machine_pass` | Mật khẩu vĩnh viễn RustDesk của máy — client lấy từ đây mỗi lần login, **không** nung cứng trong app |

**Bạn không cần sửa gì khác** ngoài `admin_action` (để kick) và `machine_pass`
(khi đổi mật khẩu máy lab). Mọi cột khác do script tự quản lý.

## Đổi mật khẩu vĩnh viễn trên máy lab thì sao?

1. Trên máy lab: `rustdesk.exe --password <mật_khẩu_mới>`
2. Trên Sheets, sửa cột `machine_pass` của dòng máy đó thành mật khẩu mới
3. Xong — **không cần build lại app**. Client luôn lấy `machine_pass` mới
   nhất từ API mỗi lần đăng nhập (đã sửa ở commit `a7b5c38a9`/`89c6ae6aa`:
   giá trị từ Sheets luôn được ưu tiên hơn giá trị nung cứng lúc build).

## Sinh viên biết có ai đang dùng máy chưa?

Khi máy đang `occupied`, sinh viên khác bấm đăng nhập sẽ thấy ngay:
*"Hiện không còn máy trống. Vui lòng thử lại sau."* — không cần họ tự đoán,
không lộ ai đang dùng hay IP máy. Muốn biết **chính xác ai** đang dùng, bạn
mở sheet `ActiveSessions`, xem cột `student_id`/`full_name`.

## Sinh viên bị kẹt / không hiểu thì liên hệ ai?

Đã thêm khung liên hệ hỗ trợ hiện ngay dưới thông báo lỗi trên màn hình
login — **nhưng mặc định đang trống** vì tôi không có SĐT/email thật của
bạn để điền sẵn. Cách bật:

```bash
gh secret set LAB_SUPPORT_CONTACT -R ntthang-dev/labdesk --body "SĐT/email quản trị viên"
```
rồi build lại (`gh workflow run lab-client-build.yml`). Từ đó mọi lỗi hiện
ra cho sinh viên đều kèm dòng "Cần hỗ trợ? Liên hệ: ...".

## Cập nhật LabDesk cho sinh viên trong tương lai — chi phí & cách làm

**Hiện tại (MVP): không có cơ chế tự động cập nhật.** Mỗi lần bạn build
xong (`gh workflow run lab-client-build.yml`), sinh viên phải **tự tải lại**
file `.exe`/`.dmg` mới và cài đè — giống hệt cách bạn đang làm bây giờ.

**Chi phí hạ tầng hiện tại: 0đ.**
- GitHub Actions (build): miễn phí cho repo public, có hạn mức phút chạy
  miễn phí/tháng cho repo private.
- Google Apps Script + Sheets: miễn phí, có hạn mức số lượt gọi/ngày (dư
  dùng cho vài chục sinh viên/ngày).
- Phân phối file cài: **GitHub Releases** là chỗ lưu file `.exe`/`.dmg` miễn
  phí, không giới hạn dung lượng thực tế cho repo private nội bộ — thay vì
  gửi link `gh run download` (hết hạn sau ~90 ngày), tạo 1 bản Release cố
  định (`gh release create v1.0 Output/LabDesk-windows-x64.exe LabDesk-macOS.dmg`)
  để có 1 link tải ổn định, không cần build lại app khi cần re-share link.

**Nếu sau này cần tự động cập nhật** (sinh viên mở app luôn có bản mới nhất,
không cần bạn nhắc tải lại): đây là việc **Phase 2**, không làm trong MVP
này theo đúng phạm vi đã thống nhất. Hướng khả thi, không tốn thêm tiền:
- App tự gọi 1 API (chính Apps Script hiện có, thêm action `latest_version`)
  hỏi "bản mới nhất là bao nhiêu", so với bản đang chạy, nếu cũ hơn thì hiện
  banner "Có bản mới, tải tại: <link GitHub Release>" — sinh viên tự tải,
  không cần bạn làm gì thêm. Không cần auto-install (phức tạp, rủi ro cao
  hơn giá trị mang lại cho quy mô phòng lab).

## Hướng tối ưu hoá toàn diện — Phase 2 (không làm ngay, chỉ để tham khảo)

Theo đúng ranh giới đã thống nhất từ đầu (`CHANGELOG.md` mục 1), các hướng
sau **cố ý chưa làm** trong MVP, xếp theo độ ưu tiên nếu bạn mở rộng:

1. **UI Admin riêng** thay vì gõ tay `kick` vào Sheets — 1 trang web nhỏ
   (cũng chạy trên Apps Script, miễn phí) hiện danh sách máy + nút Kick,
   đỡ phải mở Sheets tìm đúng dòng.
2. **Nhiều máy lab** — `Code.gs` đã có sẵn nhánh xử lý `body.machine_id`,
   chỉ cần thêm dòng vào `ActiveSessions` là chạy được, không cần sửa code.
3. **Windows Agent** — khoá thư mục theo NTFS ACL, chặn shutdown, Wake-on-LAN.
4. **Thông báo tự động cập nhật** như trên.
5. **Ký & công chứng (code sign + notarize)** bản macOS — hiện app chạy
   được (đã verify) nhưng cần `xattr -dr com.apple.quarantine` thủ công lần
   đầu; ký thật sẽ bỏ được bước này, cần tài khoản Apple Developer (99 USD/năm).

## Kiểm chứng đã có sẵn — dùng khi nghi ngờ có lỗi

```bash
# Logic Apps Script (không cần tài khoản Google, chạy trong vài giây)
node apps_script/test/run_test.js

# Unit test client Flutter
cd flutter && flutter test test/lab_client_test.dart

# Kiểm chứng hình thức race-condition khi 2 sinh viên login cùng lúc
cd apps_script/formal
java -cp /tmp/tla2tools.jar tlc2.TLC -config WithLock.cfg LabSession.tla
```
