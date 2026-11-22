# Triển khai bằng container (Docker hoặc Podman)

Một image chạy **cả hai** tiến trình mà bridge cần: appservice (`node src/index.ts`)
và `bbctl proxy`. Chúng dùng chung loopback của container, nên `registration.yaml` giữ
`url: http://localhost:29350` và không có gì được publish ra máy host.

> Chỉ chạy đúng **một** instance cho mỗi registration. Một bridge/proxy thứ hai (container
> khác, `npm run dev`, một launchd agent, `bbctl proxy` trong WSL…) sẽ đá instance đầu tiên ra.

## 1. Đầu vào (`container-config/`, nằm trong gitignore) {#_1-inputs-container-config-gitignored}

| File                             | Lấy từ đâu                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `config.yaml`                    | `cp config.yaml.example` rồi điền vào (đường dẫn tương đối dùng được, chúng được tính từ `/data`) |
| `registration.yaml`              | `bbctl register -o registration.yaml sh-zalo`, với `url: http://localhost:29350`                  |
| `bbctl-config.json` _(tuỳ chọn)_ | `~/.config/bbctl/config.json` sẵn có của bạn (đăng nhập Beeper; `bbctl proxy` cần file này)       |

Thay cho `bbctl-config.json`, bạn có thể đặt `MATRIX_ACCESS_TOKEN` (giá trị `access_token`
trong file đó), hoặc đăng nhập một lần bên trong container:

```bash
docker compose run --rm zalo-bridge bbctl login      # or: podman compose run --rm ...
```

Với Podman rootless, các file phải đọc được bởi user của container: chạy `chmod 644`
trên máy host (file quyền 600 sẽ không đọc được bên trong). Trên máy có SELinux (Fedora/RHEL),
đổi mount trong `compose.yaml` thành `./container-config:/config:ro,Z`.

## 2. Chạy

```bash
# Docker
docker compose up -d --build
docker compose logs -f

# Podman (podman compose uses podman-compose or docker-compose as provider)
podman compose up -d --build
podman logs -f zalo-beeper-bridge
```

Không dùng compose:

```bash
podman build -t localhost/zalo-beeper-bridge .          # or docker build
podman run -d --name zalo-beeper-bridge --restart unless-stopped \
  -v ./container-config:/config:ro -v zalo-data:/data \
  localhost/zalo-beeper-bridge
```

Log khởi động bình thường:

```
Appservice listening on localhost:29350 ...
DBG Appservice transaction websocket opened        <- bbctl proxy connected to Beeper
[zalo] no valid saved credentials — send 'login'   <- first run only
```

## 3. Thêm tài khoản Zalo và đồng bộ

1. Trong Beeper, mở DM với `@sh-zalobot:beeper.local` và gửi `login`.
2. Quét mã QR bằng app Zalo trên điện thoại và xác nhận. Kỳ vọng thấy `✓ Logged in to Zalo`.
3. Gửi `sync`. Lệnh này tạo phòng cho các chat được ghim và **mọi** nhóm, cho bạn vào
   các phòng đó và điền vào các phòng còn trống bằng bất kỳ lịch sử nào Zalo cung cấp cho phiên này.
   Lệnh chạy có nhịp độ (1,5 giây mỗi bước); khoảng 50 nhóm mất chừng 2 phút.

Từ đó trở đi, mọi tin nhắn Zalo mới (DM hoặc nhóm, kể cả tin bạn gửi từ
điện thoại) đều xuất hiện trong Beeper. Zalo không gửi lại những gì đến khi bridge tạm dừng
(container tắt, PC ngủ, mất mạng). Do đó, sau mỗi lần kết nối lại, bridge yêu cầu
Zalo cung cấp mọi tin nhắn mới hơn tin cuối cùng đã bridge (luồng dữ liệu chạy tiến từ một
id tin nhắn, 50 tin mỗi trang, tối đa 10 trang cho DM và nhóm) rồi phát lại khoảng trống
theo đúng thứ tự. Log hiển thị `[sync] catch-up user|group: N page(s)` và
`[sync] catch-up: N missed message(s) to bridge`.

Phiên Zalo đã mã hoá nằm trên volume `zalo-data`, nên khởi động lại và build lại
đều đăng nhập lại một cách âm thầm (`[zalo] re-logged in from saved credentials`).

### Những gì Zalo không cho phép

- **Lịch sử từ trước lúc đăng nhập.** Zalo chỉ cung cấp cho phiên web những tin nhắn
  nhận được sau khi phiên đó được tạo. Lịch sử nhóm trên cloud trả về
  `isFiltered=1` (máy chủ có tin nhắn nhưng giữ lại không trả); DM được giữ trên
  điện thoại, không nằm trên máy chủ Zalo. App của chính Zalo chỉ lấy được các chat cũ qua
  việc chuyển "đồng bộ tin nhắn" từ điện thoại, mà không client bên thứ ba nào dùng được.
- **Thời gian gốc** cho tin nhắn được lấy lại/backfill (chúng mang thời gian của bridge).

## Xử lý sự cố

Danh sách đầy đủ nằm ở trang [Xử lý sự cố](../troubleshooting).

| Triệu chứng                                          | Cần kiểm tra                                                                                                         |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Chat không hiện trong Beeper dù log có `[zalo] in …` | Bạn đang dừng ở trạng thái "invite" (phiên bản cũ). Khởi động lại: lúc khởi động bridge cho bạn vào mọi portal       |
| Không có dòng `[zalo] in/own …` nào                  | Đóng Zalo Web trên trình duyệt (chỉ một phiên web), rồi `logout` + `login`                                           |
| Frame giao thức lạ                                   | `ZALO_WS_TRACE=1 podman compose up -d` log header của mọi frame (chỉ cmd/kích thước, không bao giờ log nội dung)     |
| Thấy mạng trong Beeper Desktop nhưng không có chat   | Thiếu remote-account state, xem [Xử lý sự cố](../troubleshooting#beeper-desktop-shows-the-zalo-network-but-no-chats) |

Mỗi tin nhắn Zalo được bridge ghi một dòng log chỉ chứa id: `[zalo] in group text thread=… msg=…`.
Các push 1-1 mã hoá đầu cuối (cmd 551, bị zca-js bỏ đi) được chuyển hướng sang handler DM.

## Trạng thái và sao lưu

Mọi thứ có trạng thái đều nằm trong named volume (`/data`): `bridge.db` (ánh xạ
portal/tin nhắn), `zalo-creds.session.json` cùng khoá của nó, và thông tin đăng nhập bbctl. Dùng
named volume là có chủ ý: SQLite WAL không đáng tin cậy trên bind mount của Windows.

Xem [Vận hành](./operations#backup) để biết về sao lưu, nâng cấp và rollback.

## Nhập lịch sử và tài khoản thứ hai

- Nhập lịch sử bằng `scripts/zalo-pc/import.ps1` (Windows) hoặc `scripts/zalo-pc/import.sh` (macOS) (xem [Nhập lịch sử](../history-import/)). Chúng chạy công cụ nhập bên trong container này (`-ContainerCli docker` / `-r docker` cho Docker, `-Container` / `-n` cho container có tên khác).
- Tài khoản Zalo thứ hai chạy như một bridge thứ hai với tên `bbctl register`, thư mục cấu hình và volume riêng (xem [Nhiều tài khoản](../guide/multiple-accounts)).

## Giới hạn

- Tin nhắn backfill chỉ được đưa vào các phòng còn trống (tin nhắn cũ không bao giờ
  được thêm xuống dưới tin nhắn mới hơn trong một phòng đã có tin nhắn).
- Podman build ra image OCI, vốn bỏ `HEALTHCHECK` của Dockerfile; `compose.yaml`
  khai báo lại nó để cả hai engine đều báo trạng thái sức khoẻ. Cả hai đều dò `GET /health`
  của chính appservice (do matrix-appservice phục vụ) bằng `curl`, entrypoint cũng làm vậy
  trước khi khởi động `bbctl proxy`.
