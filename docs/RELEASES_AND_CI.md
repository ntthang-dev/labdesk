# GitHub Release là gì? "Bridge" trong build là gì?

Tài liệu này giải thích 2 khái niệm hay gặp khi xem CI (`gh run` /
tab **Actions** trên GitHub) và khi tải file cài cho sinh viên, viết cho
người **không rành lập trình**.

## 1. "Build" xong rồi thì file cài nằm ở đâu?

Có **2 chỗ khác nhau**, dễ nhầm:

### (a) Artifact của 1 lần chạy CI — tạm thời, ~90 ngày

Mỗi lần code được push lên `master`, GitHub tự chạy build
(`.github/workflows/lab-client-build.yml`) và đính file `.exe`/`.dmg` vào
**chính lần chạy đó** dưới dạng "Artifact". Đây là thứ bạn thấy khi làm:

```bash
gh run download <RUN_ID> -R ntthang-dev/labdesk
```

hoặc bấm vào 1 run cụ thể trong tab Actions rồi tải file ở cuối trang.

**Nhược điểm:** link này gắn với 1 run cụ thể, **tự xoá sau ~90 ngày**, và
nếu bạn build lại (dù không đổi gì) sẽ ra 1 run mới với link khác — không
phải là link "ổn định" để gửi cho hàng chục sinh viên dùng lâu dài.

### (b) GitHub Release — cố định, không hết hạn

Một **Release** là một "bản phát hành chính thức" gắn với 1 tag phiên bản
(ví dụ `v1.0.3`), có **link tải cố định**, không tự xoá. Đây là cách đúng để
phân phối file cho sinh viên. Tạo release mới:

```bash
gh release create v1.0.3 \
  Output/LabDesk-windows-x64.exe \
  LabDesk-macOS.dmg \
  -R ntthang-dev/labdesk \
  --title "LabDesk v1.0.3" \
  --notes "Ghi chú ngắn về bản này"
```

Sau đó link tải luôn là dạng:
`https://github.com/ntthang-dev/labdesk/releases/download/v1.0.3/LabDesk-windows-x64.exe`
— gửi link này cho sinh viên, hoặc điền vào `Config!download_url` trong
Sheets để app tự hiện banner "Có bản mới, tải tại: ..." (xem mục cập nhật
trong `HUONG_DAN_QUAN_TRI.md`).

**Tóm lại:** build CI (artifact) = bản nháp dùng thử/kiểm tra nội bộ; Release
= bản chính thức gửi cho sinh viên.

## 2. "Bridge" trong log CI là gì?

Trong log build bạn sẽ thấy 2 job tên `generate-bridge` chạy **trước** cả
job build Windows/macOS:

```
generate-bridge / generate_bridge (..., bridge-artifact)
generate-bridge / generate_bridge (..., bridge-artifact-flutter-3.44)
```

RustDesk viết phần lõi (chụp màn hình, điều khiển chuột/bàn phím, kết nối
mạng...) bằng **Rust**, còn giao diện viết bằng **Dart/Flutter**. Hai ngôn
ngữ này không tự nói chuyện được với nhau — cần một lớp "cầu nối" (bridge)
tự động sinh ra bởi công cụ `flutter_rust_bridge`, dịch các hàm Rust thành
hàm Dart gọi được. Lớp cầu nối này là **hàng nghìn dòng code Dart/Rust sinh
tự động**, không ai viết tay, và phải sinh lại mỗi khi code Rust thay đổi.

Job `generate-bridge` chạy công cụ đó và lưu kết quả thành 1 artifact riêng
(`bridge-artifact`), để job build Windows/macOS phía sau **tải về dùng lại**
thay vì mỗi job build tự sinh lại (tốn thời gian, dễ lỗi phiên bản công cụ
khác nhau giữa các máy build). Có 2 bản (`3.22.3` và `3.44.8`) vì đây là 2
phiên bản Flutter khác nhau mà phần build Windows và macOS/Linux của
RustDesk hiện dùng — không phải lỗi, là thiết kế có chủ đích của repo gốc.

**Bạn không cần đụng vào phần này.** Nếu job `generate-bridge` thất bại,
thường là do thay đổi gì đó trong code Rust (`src/`, `libs/`) làm công cụ
sinh cầu nối không chạy được — báo lại kèm log lỗi để xử lý, không phải lỗi
do bạn thao tác sai trên Sheets/app.

## 3. Số phiên bản (version) đến từ đâu?

**Tự động, theo chuẩn [semver](https://semver.org/) `MAJOR.MINOR.PATCH`**,
không cần bạn tự gõ số mỗi lần build:

- `MAJOR.MINOR` lấy từ file `flutter/VERSION` (vd `1.1`) — bạn chỉ sửa file
  này bằng tay khi có thay đổi lớn/breaking, không phải mỗi lần build.
- `PATCH` = **số commit đã có kể từ lần cuối `flutter/VERSION` được sửa** —
  CI tự đếm bằng `git rev-list --count`, tăng dần tự nhiên theo mỗi lần code
  thay đổi, không cần bạn làm gì.
- Ví dụ: `flutter/VERSION` chứa `1.1`, đã có 23 commit kể từ lần sửa file đó
  gần nhất → build ra bản `1.1.23`.
- Muốn ép 1 số cụ thể (vd để khớp với thông báo lỗi bạn đang debug)? Điền vào
  ô **`app_version`** khi chạy `gh workflow run` hoặc trong màn hình
  "Run workflow" trên GitHub — override tự động luôn.
- Push tag `vX.Y.Z` (vd `git tag v1.2.0 && git push origin v1.2.0`) → bản
  build đó **lấy đúng số trong tag**, bỏ qua công thức đếm commit — đây là
  cách chuẩn để đánh dấu 1 bản phát hành chính thức.

## 4. Quy trình phát hành 1 bản LabDesk mới, đầy đủ (tự động)

1. Code sửa xong, push lên `master`.
2. Chạy build **kèm phát hành**:
   ```bash
   gh workflow run lab-client-build.yml -R ntthang-dev/labdesk -r master \
     -f publish_release=true
   ```
   (hoặc trên web: tab Actions → "Build LabDesk Clients" → "Run workflow" →
   tick ô **"Cut a GitHub Release..."**)
3. Chờ CI xong. Khi xong, tự động — **không cần bạn làm gì thêm**:
   - Một **GitHub Release** mới được tạo, đúng tag `vMAJOR.MINOR.PATCH`, đính
     sẵn cả `.exe` và `.dmg` với link tải cố định.
   - `Config!latest_version` và `Config!download_url` trong Sheets được **ghi
     thẳng** qua action `publish_release` (`apps_script/src/26_release.gs`) —
     sinh viên mở app lên sẽ thấy banner "Có bản mới" ngay từ lần đăng nhập
     kế tiếp.
4. Nếu muốn **ép buộc** mọi sinh viên phải cập nhật mới được đăng nhập tiếp
   (vd vừa vá lỗi bảo mật) — bước duy nhất còn phải làm tay: mở Sheets, đặt
   `Config!min_version` bằng đúng số phiên bản mới. Đây là quyết định có chủ
   đích (khoá hết mọi sinh viên chưa cập nhật), nên **không tự động**.

**Build thử, không phát hành** (như mọi lần trong quá trình phát triển): chạy
`gh workflow run` như bình thường, **không** thêm `-f publish_release=true`
— build vẫn chạy đầy đủ, chỉ là không tạo Release/không đụng vào `Config` của
Sheets thật. Push tag `v*` luôn tự phát hành (không cần cờ `publish_release`).
