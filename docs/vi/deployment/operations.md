# Vận hành

Việc vận hành hằng ngày của bản triển khai bằng container: sức khoẻ, log, nâng cấp, sao lưu và rollback. Các lệnh dùng Podman; hãy thay `podman` bằng `docker` nếu bạn dùng Docker.

## Sức khoẻ

Image có một health check gửi request tới `http://127.0.0.1:29350/health` bên trong container mỗi 30 giây. Podman bỏ `HEALTHCHECK` của Dockerfile khỏi image OCI, nên `compose.yaml` khai báo lại nó.

```bash
podman ps --filter name=zalo-beeper-bridge      # STATUS shows (healthy) / (unhealthy)
```

Health check chỉ cho bạn biết appservice có trả lời. Để kiểm tra Zalo, hãy gửi `status` cho bot: nó hiển thị uptime, Zalo đã đăng nhập chưa và trạng thái listener.

Để kiểm tra Beeper đang thấy gì:

```bash
podman exec zalo-beeper-bridge sh -c 'bbctl -c "$BBCTL_CONFIG" whoami --raw' | grep -A3 remoteState
```

Bình thường là có một mục cho Zalo uid của bạn với `"state_event": "CONNECTED"`.

## Log

```bash
podman logs -f zalo-beeper-bridge
podman logs --since 1h zalo-beeper-bridge | grep -E '\[zalo\] listener|\[sync\]'
```

Xem [tham khảo log](../reference/logs) để biết từng dòng. Chỉ đặt `ZALO_WS_TRACE=1` trong môi trường (xem `compose.yaml`) khi đang debug; nó log header của mọi frame websocket.

## Nâng cấp

```bash
git pull
podman compose build
podman compose up -d
```

`up -d` tạo lại container từ image mới. Data volume được giữ nguyên, và [migration cơ sở dữ liệu](../reference/database#migrations) chạy khi khởi động. Trước khi nâng cấp có thay đổi schema cơ sở dữ liệu, hãy chuẩn bị [rollback](#rollback) trước.

Công cụ nhập lịch sử cũng chạy từ image, nên hãy build lại sau khi cập nhật mã nguồn và trước khi nhập.

## Sao lưu {#backup}

Mọi thứ có trạng thái đều nằm trong named volume mount tại `/data`:

| File                                                       | Nội dung                            |
| ---------------------------------------------------------- | ----------------------------------- |
| `bridge.db` (+ `-wal`, `-shm`)                             | Ánh xạ portal, ghost và tin nhắn    |
| `zalo-creds.session.json` + `.zalo-creds.session.json.key` | Phiên Zalo đã mã hoá và khoá của nó |
| `bbctl/config.json`                                        | Đăng nhập Beeper của `bbctl`        |

Compose đặt tên volume là `<project>_zalo-data`, ví dụ `zalo-beeper-bridge_zalo-data` khi thư mục repo tên là `zalo-beeper-bridge`. `podman volume ls` liệt kê nó.

**Cả volume**, khi container đã dừng để SQLite nhất quán:

```bash
podman compose stop
podman run --rm -v zalo-beeper-bridge_zalo-data:/data -v "$PWD":/backup docker.io/library/busybox \
  tar czf /backup/zalo-data.tgz -C /data .
podman compose start
```

**Chỉ cơ sở dữ liệu**, trong khi bridge đang chạy (sao lưu online của SQLite):

```bash
podman exec zalo-beeper-bridge node -e "new (require('/app/node_modules/better-sqlite3'))('/data/bridge.db',{readonly:true}).backup('/data/bridge.db.bak-<name>')"
podman exec zalo-beeper-bridge chmod 600 /data/bridge.db.bak-<name>
```

::: danger
Bản lưu trữ chứa phiên Zalo và khoá của nó. Bất kỳ ai có cả hai đều dùng được tài khoản Zalo của bạn. Hãy lưu nó ở dạng mã hoá và đừng bao giờ commit.
:::

## Rollback

Trước một lần nâng cấp có rủi ro, hãy giữ ba thứ: image đang chạy, mã nguồn và cơ sở dữ liệu.

```bash
podman tag "$(podman inspect zalo-beeper-bridge --format '{{.Image}}')" localhost/zalo-beeper-bridge:rollback-<name>
git tag -a rollback/<name> -m "last deployed state"
# plus a database backup as shown above
```

**Rollback mã nguồn** (trường hợp thông thường; cơ sở dữ liệu giữ nguyên):

```bash
podman tag localhost/zalo-beeper-bridge:rollback-<name> localhost/zalo-beeper-bridge:latest
podman compose up -d --no-build --force-recreate
git switch --detach rollback/<name>   # so the next build does not bring the change back
```

Migration chỉ thêm bảng và cột, nên mã cũ chạy được trên cơ sở dữ liệu mới hơn. Điều này đã được kiểm chứng cho schema v7 → v6 trên một bản sao của cơ sở dữ liệu đang chạy: mã v6 đọc và ghi bình thường, và các dòng mới của nó không có `account_id` cho đến khi mã mới hơn chạy lại. Mã cũ cũng gửi lại state `m.bridge` của mỗi portal mà không có `fi.mau.receiver`.

**Khôi phục cơ sở dữ liệu** chỉ khi nó bị hỏng. Các tin nhắn đã được bridge kể từ lúc sao lưu sẽ mất ánh xạ, nên trả lời và biểu cảm trên chúng ngừng hoạt động.

```bash
podman compose stop
podman run --rm -v zalo-beeper-bridge_zalo-data:/data --entrypoint sh localhost/zalo-beeper-bridge:latest \
  -c 'cd /data && rm -f bridge.db-wal bridge.db-shm && cp bridge.db bridge.db.broken && cp bridge.db.bak-<name> bridge.db'
podman compose up -d
```

## Đăng nhập lại

Khi Zalo kết thúc phiên (log hiện `listener DEAD`, `status` cho thấy listener ở trạng thái dead, hoặc Beeper hiện mạng bị ngắt kết nối), hãy gửi `login` cho bot và quét mã QR mới trong app Zalo. Trước đó, hãy xem [Xử lý sự cố](../troubleshooting#messages-stop-flowing-listener-not-connected) để biết nguyên nhân.
