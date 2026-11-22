# Các bước thủ công

Trang này mô tả những gì các [script bắt đầu nhanh](./quick-start) tự động hoá. Hãy dùng nó để hiểu rõ quy trình hoặc tự chạy từng bước riêng lẻ.

## Bước 1: Chạy Zalo PC với cổng debug local {#step-1-run-zalo-pc-with-a-local-debug-port}

Các công cụ đọc dữ liệu đã giải mã của chính Zalo PC qua Chrome DevTools Protocol chỉ trên `127.0.0.1`. Thoát hẳn Zalo PC, sau đó khởi động lại với:

::: code-group

```powershell [Windows]
& "$env:LOCALAPPDATA\Programs\Zalo\Zalo-<version>\Zalo.exe" --remote-debugging-port=9229
```

```bash [macOS]
open -a Zalo --args --remote-debugging-port=9229
```

:::

Các công cụ tìm thấy nó tại `http://127.0.0.1:9229`; đặt `ZALO_CDP_URL` để dùng địa chỉ khác.

## Bước 2 (tuỳ chọn): Chuẩn bị media từ bản sao lưu Zalo PC {#step-2-optional-prepare-media-from-a-zalo-pc-backup}

Thực hiện bước này khi bạn muốn giữ lại ảnh, video và file cũ có liên kết CDN Zalo đã hết hạn.

Tạo bản sao lưu trong Zalo PC: **Cài đặt → Sao lưu & đồng bộ → Xuất dữ liệu**. Thao tác này tạo ra `backup_zalo_<date>.zl.zip`, một luồng tar được mã hoá bằng AES-256-CBC:

- key = SHA-256 của UIN phiên đăng nhập (`dkey`),
- IV = `"zie"` + 13 ký tự đầu tiên của UIN.

UIN chỉ lấy được từ Zalo PC đang chạy và đã đăng nhập của tài khoản đã tạo bản sao lưu.

```bash
npm install          # dev dependencies (@jsquash JPEG XL / JPEG codecs)

# 1. Đọc khoá sao lưu. BÍ MẬT: bất kỳ ai có khoá này đều giải mã được các bản sao lưu của bạn.
node scripts/zalo-pc/get-uin.mjs > ~/zalo-uin.txt

# 2. Kiểm tra khoá, sau đó giải nén cơ sở dữ liệu và media (file sao lưu chỉ được đọc)
node scripts/zalo-pc/backup-extract.mjs backup_zalo_22_10_2026.zl.zip ~/zalo-uin.txt work/backup --peek
node scripts/zalo-pc/backup-extract.mjs backup_zalo_22_10_2026.zl.zip ~/zalo-uin.txt work/backup --all
rm ~/zalo-uin.txt

# 3. Ánh xạ file media vào tin nhắn, giải mã các file bị xáo trộn, chuyển đổi JPEG XL sang JPEG
node scripts/zalo-pc/backup-media.mjs work/backup/<yourZaloUid>/ZaloDownloads <yourZaloUid> work/media
```

`<yourZaloUid>` là thư mục cấp cao nhất bên trong bản sao lưu đã giải nén. `backup-media.mjs` ghi ra `work/media/<msgId>.<ext>` và `work/media/media-index.json`. Những file không đọc được (ví dụ file đính kèm được mã hoá bởi Intune) sẽ bị bỏ qua và thay bằng một dòng thông báo văn bản.

Không có bản sao lưu thì vẫn dùng được thư mục Zalo PC đang chạy. Thư mục này không có cơ sở dữ liệu tin nhắn, nên hãy truyền file xuất từ `export-cdp.mjs` (một file `.ndjson`, hoặc cả thư mục) làm tham số thứ 4:

```bash
node scripts/zalo-pc/backup-media.mjs "<Zalo Data>/media/<yourZaloUid>/ZaloDownloads" <yourZaloUid> work/media work/export/<chatKey>.ndjson
```

Chỉ có media mà Zalo PC đã tải về; phần còn lại vẫn lấy từ CDN hoặc thay bằng dòng văn bản.

Sao chép thư mục vào trong container:

```bash
tar -C work/media -cf - . | podman exec -i zalo-beeper-bridge sh -c 'mkdir -p /data/import-media && tar -C /data/import-media -xf - && chown -R node:node /data/import-media'
```

## Bước 3: Export và import {#step-3-export-and-import}

`scripts/zalo-pc/migrate-all.sh` xử lý theo từng chat: một bản export mới của chat từ Zalo PC, sau đó chạy công cụ nhập với `--rebuild --remove-old` bên trong container.

- Script sẽ tạm dừng khi không kết nối được tới Beeper hoặc Zalo PC.
- Script ghi `OK <key>`, `OKMEDIA <key>` hoặc `FAIL <key>` vào `<workDir>/done.txt` và bỏ qua các chat OK và OKMEDIA khi chạy lại.
- `OKMEDIA` nghĩa là mọi tin nhắn đã vào phòng mới, nhưng một số media không tải được (ví dụ host CDN của Zalo đã chết và phòng cũ không có bản sao) hoặc một tin nhắn live không chuyển sang được. Chạy lại chat cũng không lấy lại được các media đó.
- Lần dựng lại với `--media-dir` cũng thay các thông báo live `[Zalo photo could not be bridged …]` bằng file thật ở những chỗ Zalo PC còn bản sao. Lệnh bot [`media-failures`](../guide/bot-commands#media-failures) liệt kê các phòng có những thông báo như vậy.
- Chat bị lỗi vẫn giữ nguyên phòng cũ và bạn có thể chạy lại một cách đơn giản.
- Script không truyền `--include-encrypted`, nên nó bỏ qua các chat có phòng mã hoá đầu cuối. Hãy rebuild các chat đó bằng cách gọi trực tiếp công cụ nhập và không dùng `--remove-old`; sau đó kiểm tra log xem có dòng `old-room:undecryptable` và WARNING không, rồi mới xoá phòng cũ bằng `--retire`. Xem [Kiểm toán độ đầy đủ](importer-cli#completeness-audit).
- `BASELINE_DB` phải trỏ tới một bản sao `bridge.db` bên trong container, tạo trước khi chạy (ví dụ `sqlite3 bridge.db ".backup bridge.db.bak-pre-migrate"`). Công cụ nhập đối chiếu mọi tin nhắn của phòng cũ với bản sao này trước khi xoá phòng cũ.

```bash
# order.txt: mỗi dòng một chat key, "g<groupId>" cho nhóm, uid đối phương cho DM.
# Lấy mọi key bằng một lần export trước:
node scripts/zalo-pc/export-cdp.mjs work/export
ls work/export/*.ndjson | xargs -n1 basename | sed 's/\.ndjson$//' > work/order.txt   # sắp xếp lại tuỳ ý

BASELINE_DB=/data/bridge.db.bak-pre-migrate \
  scripts/zalo-pc/migrate-all.sh work work/order.txt <yourZaloUid> /data/import-media
tail -f work/run.log
```

Script chạy công cụ nhập được đóng gói sẵn trong image (`/app/src/tools/import-zalo-export.ts`). Hãy build lại image sau khi bạn cập nhật mã nguồn.

## Các công cụ trong `scripts/zalo-pc/`

| Script               | Mục đích                                                                    |
| -------------------- | --------------------------------------------------------------------------- |
| `import.ps1`         | Nhập chỉ với một lệnh trên Windows                                          |
| `import.sh`          | Nhập chỉ với một lệnh trên macOS                                            |
| `migrate-all.sh`     | Export và nhập từng chat, kèm `done.txt` và `run.log`                       |
| `export-cdp.mjs`     | Export chat từ Zalo PC dưới dạng NDJSON qua cổng debug                      |
| `get-uin.mjs`        | Đọc khoá sao lưu từ Zalo PC đang chạy                                       |
| `backup-extract.mjs` | Giải mã và giải nén bản sao lưu `.zl.zip` (`--peek` để kiểm tra khoá trước) |
| `backup-media.mjs`   | Ánh xạ media từ bản sao lưu sang message id và chuyển đổi định dạng         |
| `cdp.mjs`            | DevTools client dùng chung (sử dụng `ZALO_CDP_URL`)                         |
