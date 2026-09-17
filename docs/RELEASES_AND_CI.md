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

## 3. Quy trình phát hành 1 bản LabDesk mới, đầy đủ

1. Code được sửa xong, push lên `master` → CI tự chạy build.
2. Chờ CI xong (`gh run watch <RUN_ID> -R ntthang-dev/labdesk`), tải thử về
   máy kiểm tra (`gh run download ...`), cài và test.
3. Ưng ý → đóng gói thành Release chính thức (lệnh `gh release create` ở
   mục 1b).
4. Cập nhật 2 ô trong sheet `Config`: `latest_version` (số phiên bản mới) và
   `download_url` (link Release vừa tạo). Nếu muốn **ép buộc** mọi sinh viên
   phải cập nhật mới được đăng nhập tiếp, đặt thêm `min_version` bằng đúng
   số phiên bản mới.
5. Xong — sinh viên mở app lên, lần đăng nhập kế tiếp sẽ thấy banner/bị chặn
   theo đúng cấu hình ở bước 4, không cần bạn làm gì thêm phía client.
