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
>
> **Tự kiểm tra ngay sau khi deploy — không cần `SHARED_SECRET`, dán thẳng
> vào trình duyệt**:
> ```
> <URL_WEB_APP_CỦA_BẠN>?action=version
> ```
> Nếu thấy `{"code_version":"...","features":[...]}` → deploy đã thành công,
> đúng bản mới. Nếu thấy `{"error":"unauthorized"}` → **vẫn là code cũ**
> (bản cũ không có action này) — quay lại làm đúng 2 bước Deploy ở trên.
> Cách này nhanh hơn hẳn việc nhờ AI/người khác `curl` hộ bằng secret.

## Sửa `Code.gs` — bây giờ sửa ở đâu?

Mã nguồn backend **đã tách thành nhiều module** trong `apps_script/src/`
(`00_core.gs`, `10_schedule.gs`, `20_misc.gs`, `30_router.gs`, `40_session.gs`,
`50_feedback.gs`, `60_admin.gs`) cho dễ đọc và dễ sửa.

`apps_script/Code.gs` **là file được sinh tự động** — vẫn là thứ bạn dán vào
Apps Script như cũ (1 file duy nhất, không phải tạo 7 file trên trình soạn thảo
web). Quy trình:

```bash
# sau khi sửa bất kỳ file nào trong apps_script/src/
node apps_script/build.js       # sinh lại Code.gs
node apps_script/test/run_test.js   # chạy 143 test
```
rồi mới dán `Code.gs` lên Apps Script. **Quên chạy `build.js` = bản deploy
không có thay đổi của bạn.**

## Tạo sẵn toàn bộ sheets trong 1 cú bấm

Mở Sheets → menu **LabDesk** → **"Tạo/kiểm tra toàn bộ sheets"**. Nó tạo mọi
sheet còn thiếu (kể cả `Schedule`, `Feedback`, `Queue`) và thêm mọi cột còn
thiếu, **không đụng tới dữ liệu đang có**, bấm bao nhiêu lần cũng an toàn.
Dùng khi mới dựng hệ thống, hoặc khi nghi ngờ thiếu sheet/cột nào đó.

## Sinh viên thấy thời gian còn lại ở đâu?

Hai chỗ:
1. **Màn hình LabDesk** (cửa sổ đăng nhập): đồng hồ đếm ngược, chuyển màu cam
   khi còn dưới 5 phút.
2. **Trong phiên điều khiển máy** (cửa sổ remote): ô đếm ngược góc trên bên
   phải, viền tím LabDesk, chuyển đỏ khi còn dưới 5 phút. Có cảnh báo (banner
   + âm thanh hệ thống) ở mốc **còn 10 phút / 5 phút / 1 phút**.

Đồng hồ này chỉ để sinh viên *nhìn thấy*; việc cắt phiên thật sự vẫn do server
quyết định (`expires_at` trong `handleStatus`), nên không thể "lách" bằng cách
sửa máy client.

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

## Cập nhật LabDesk cho sinh viên — đã tự động, chi phí 0đ

**Quy trình đầy đủ giờ chỉ còn 1 lệnh**: `gh workflow run lab-client-build.yml
-r master -f publish_release=true`. CI tự làm hết: tính số phiên bản (chuẩn
semver, xem `docs/RELEASES_AND_CI.md`), build Windows + macOS, tạo GitHub
Release với link tải cố định, và **tự ghi `Config!latest_version` +
`download_url` vào Sheets** — không cần bạn mở Sheets sửa tay nữa.

Sinh viên mở app lên, lần đăng nhập kế tiếp tự thấy banner "Có bản mới, tải
tại: ...". Muốn **ép buộc** cập nhật (khoá đăng nhập với bản cũ) — việc duy
nhất còn lại phải làm tay: đặt `Config!min_version` (xem `apps_script/SETUP.md`
mục Sheet 4), vì đây là quyết định "khoá hết ai chưa cập nhật", không nên tự
động hoá.

**Chi phí hạ tầng: vẫn 0đ** — GitHub Actions + Releases (miễn phí cho phần
này), Google Apps Script + Sheets (miễn phí, dư hạn mức cho vài chục sinh
viên/ngày).

Không có auto-install (tự tải + tự cài đè mà sinh viên không biết) — rủi ro
cao hơn giá trị mang lại ở quy mô phòng lab, sinh viên vẫn cần tự bấm tải và
cài lại khi thấy banner.

## App tự báo lỗi khi crash — không cần sinh viên report

App giờ tự bắt mọi lỗi Flutter chưa xử lý (crash khi vẽ giao diện, lỗi mạng
không lường trước, v.v.) và tự gửi báo cáo về sheet **`CrashLog`** (tự tạo,
xem `apps_script/SETUP.md` Sheet 8) — sinh viên **không thấy gì cả, không
cần làm gì, không cần biết đã có lỗi xảy ra**.

Mỗi dòng trong `CrashLog` có: thời điểm, phiên bản app, nền tảng (macOS/
Windows), MSSV + tên (nếu sinh viên đó đang đăng nhập lúc crash), thông điệp
lỗi, và stack trace đầy đủ (giúp debug). Khác với sheet `Feedback` (góp ý
bằng lời của sinh viên) — đây là log kỹ thuật.

**Cách dùng khi nghi ngờ có lỗi**: mở `CrashLog`, lọc theo cột `error` — nếu
nhiều dòng giống nhau xuất hiện dồn dập, đó là lỗi thật đang lặp lại, báo lại
kèm nội dung cột `stack_trace` để debug. Có giới hạn tối đa 20 báo cáo/phiên
làm việc của 1 app (tránh 1 lỗi lặp vô hạn làm đầy sheet), và không có cơ chế
tự dọn dòng cũ — admin tự xoá bớt định kỳ nếu sheet quá lớn.

## Hiệu năng — đã tối ưu, không cần làm gì thêm

Hai điểm chậm nhất đo được (dialog đặt lịch mất 3-4 giây) đã được cache:
- `Config` (đọc ở hầu hết mọi request) — cache 15 giây.
- Lưới khung giờ đặt lịch (`check_availability`) — cache 20 giây theo từng
  ngày, **tự xoá cache ngay lập tức** khi có ai đặt/huỷ lịch trong ngày đó,
  nên "đặt xong có thấy liền không" luôn đúng dù đang cache.

Đánh đổi duy nhất: sửa `Config` trực tiếp trong Sheets (không qua
`publish_release`) có thể mất tới 15 giây mới có hiệu lực ở mọi nơi — chấp
nhận được, vì admin hiếm khi cần thay đổi tức thì trong lúc lớp đang học.

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
