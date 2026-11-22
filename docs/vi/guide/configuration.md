# Cấu hình

Khi khởi động, bridge đọc `config.yaml` trong thư mục làm việc của nó (`/data` trong container). File này được kiểm tra bằng schema: thiếu trường bắt buộc hoặc giá trị nằm ngoài khoảng cho phép sẽ khiến bridge dừng lại kèm thông báo lỗi rõ ràng. Các mục tuỳ chọn dùng giá trị mặc định ghi bên dưới.

Bắt đầu từ file ví dụ:

```bash
cp config.yaml.example config.yaml
```

## Ví dụ đầy đủ

```yaml
matrix:
  homeserverUrl: https://matrix.beeper.com/_hungryserv/<your-beeper-username>
  domain: beeper.local
  registrationPath: registration.yaml
  port: 29350
  owner: '@<your-beeper-username>:beeper.com'

zalo:
  credsPath: zalo-creds.session.json
  messagesPerMinute: 60
  burst: 30

bridge:
  dbPath: bridge.db
  mediaMaxBytes: 10485760

encryption:
  enabled: false
  storePath: crypto
  upgradeExisting: true

network:
  name: Zalo
  networkId: zalo
  logoPath: assets/zalo-logo.png

logging:
  level: warn
```

Đường dẫn tương đối được tính từ thư mục làm việc.

## `matrix` (bắt buộc)

| Khoá               | Kiểu    | Mô tả                                                                                                                                  |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `homeserverUrl`    | URL     | URL client-server của homeserver. Với Beeper: `https://matrix.beeper.com/_hungryserv/<your-beeper-username>`.                          |
| `domain`           | string  | Domain của homeserver, dùng cho ghost user và bot. Với Beeper: `beeper.local`.                                                         |
| `registrationPath` | string  | Đường dẫn tới `registration.yaml` do `bbctl register` tạo ra.                                                                          |
| `port`             | integer | Cổng appservice lắng nghe (localhost). Phải khớp với cổng trong `url` của `registration.yaml`, là địa chỉ mà `bbctl proxy` chuyển tới. |
| `owner`            | string  | Matrix ID đầy đủ của bạn, ví dụ `@alice:beeper.com`. Chỉ người này được ra lệnh cho bot và được mời vào mọi portal.                    |

## `zalo`

| Khoá                | Mặc định                  | Mô tả                                                                                                                          |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `credsPath`         | `zalo-creds.session.json` | Nơi lưu phiên Zalo sau khi đăng nhập bằng QR. File được mã hoá; khoá nằm cạnh nó (xem bên dưới).                               |
| `messagesPerMinute` | `60` (tối đa `240`)       | Tốc độ gửi tin tới Zalo ở trạng thái ổn định. Mỗi tin gửi đi phải đợi một token từ token bucket, được nạp lại theo tốc độ này. |
| `burst`             | `30` (tối đa `120`)       | Dung lượng của token bucket: số tin có thể gửi liên tiếp, không chờ, trước khi giới hạn tốc độ có hiệu lực.                    |

Bộ giới hạn tốc độ bảo vệ tài khoản của bạn: một đợt tin nhắn dồn dập là lý do điển hình khiến Zalo gắn cờ tài khoản. Nếu Zalo hạn chế bạn, hãy giảm cả hai giá trị.

**Lưu trữ thông tin đăng nhập.** Phiên được lưu ở dạng mã hoá AES-256-GCM. File bắt đầu bằng `ZBENC1`; khoá 256-bit nằm trong file cùng thư mục tên `.<tên file>.key` với quyền `0600` (với giá trị mặc định là `.zalo-creds.session.json.key`). Hãy giữ hai file này cùng nhau khi sao lưu hoặc chuyển bridge sang nơi khác. Phiên do phiên bản cũ lưu ở dạng JSON thuần vẫn đọc được.

## `bridge`

| Khoá            | Mặc định            | Mô tả                                                                                                          |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `dbPath`        | `bridge.db`         | Cơ sở dữ liệu SQLite chứa ánh xạ portal, ghost và tin nhắn. Xem [Schema cơ sở dữ liệu](../reference/database). |
| `mediaMaxBytes` | `10485760` (10 MiB) | Giới hạn kích thước cho ảnh, sticker và ảnh xem trước của link. Video và file có giới hạn cố định là 100 MB.   |

## `encryption`

| Khoá              | Mặc định | Mô tả                                                                                                                                                                 |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`         | `false`  | Mã hoá đầu-cuối tới bridge (end-to-bridge). Bot của bridge có thiết bị crypto Matrix riêng, các portal mới được tạo ở dạng mã hoá, và bot mã hoá và giải mã trong đó. |
| `storePath`       | `crypto` | Thư mục chứa crypto store và file thiết bị của bot. Công cụ nhập lịch sử giữ thiết bị riêng ngay cạnh đó, trong `<storePath>-import`.                                 |
| `upgradeExisting` | `true`   | Bật mã hoá trong các portal thường hiện có khi khởi động (xem bên dưới).                                                                                              |

Matrix không thể mã hoá các sự kiện đã tồn tại, nên khi bật mã hoá, các portal thường hiện có có hai cách chuyển:

- **Tại chỗ** (`upgradeExisting: true`, mặc định). Khi khởi động, bridge thêm bot vào từng portal thường và bật mã hoá trong đó. Tin nhắn từ lúc đó được mã hoá; lịch sử trước đó vẫn ở dạng thường trong cùng phòng. Không phải dựng lại gì, nên đây là cách dễ nhất. Phòng nào lỗi (ví dụ lỗi quyền) được ghi log và thử lại ở lần khởi động sau.
- **Dựng lại** (`upgradeExisting: false`). Các portal giữ dạng thường cho tới khi bạn chuyển từng chat sang một phòng mã hoá mới kèm toàn bộ lịch sử bằng công cụ nhập lịch sử (xem [CLI của công cụ nhập](../history-import/importer-cli#encrypted-rooms)). Chọn cách này khi lịch sử cũ cũng phải được mã hoá.

## `network`

Cách Beeper đặt tên và nhận diện thương hiệu của mạng.

| Khoá        | Mặc định               | Mô tả                                                                                        |
| ----------- | ---------------------- | -------------------------------------------------------------------------------------------- |
| `name`      | `Zalo`                 | Tên hiển thị của mạng trong Beeper (hồ sơ bot và thông tin bridge của từng phòng).           |
| `networkId` | `zalo`                 | Protocol id ghi vào state `m.bridge` của các phòng.                                          |
| `logoPath`  | `assets/zalo-logo.png` | Logo được tải lên một lần mỗi lần khởi động, dùng làm avatar của bot và biểu tượng của mạng. |

Nhãn mạng cấp cao nhất trong danh sách tài khoản của Beeper vẫn là tên đăng ký bbctl (ví dụ `sh-zalo`); một appservice tuỳ chỉnh không đổi tên được nhãn này.

## `logging`

| Khoá    | Mặc định | Mô tả                                                                                                                                                                                  |
| ------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `level` | `warn`   | Mức log của matrix-appservice-bridge (phía Matrix): `debug`, `info`, `warn` hoặc `error`. Mức `info` còn log mọi HTTP request, kể cả lần kiểm tra sức khoẻ (health check) mỗi 30 giây. |

Các dòng log của chính bridge (`[zalo]`, `[bridge]`, `[sync]`, …) luôn được ghi. Xem [Log](../reference/logs).

## Biến môi trường

| Biến                  | Dùng bởi             | Mô tả                                                                                                                                         |
| --------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATRIX_ACCESS_TOKEN` | container            | Access token Beeper cho `bbctl proxy`, thay cho việc mount `bbctl-config.json`. Chỉ được dùng khi chưa có cấu hình bbctl.                     |
| `ZALO_WS_TRACE`       | bridge               | Đặt `1` để log phần header của mọi frame websocket Zalo (chỉ lệnh và kích thước, không bao giờ log nội dung). Dùng để chẩn đoán các frame lạ. |
| `TZ`                  | container            | Múi giờ của container. `compose.yaml` mặc định là `Asia/Ho_Chi_Minh`.                                                                         |
| `BBCTL_CONFIG`        | container            | Nơi `bbctl` giữ thông tin đăng nhập bên trong container. Mặc định đặt sẵn là `/data/bbctl/config.json`.                                       |
| `ZALO_CDP_URL`        | công cụ nhập lịch sử | Endpoint DevTools của Zalo PC. Mặc định là `http://127.0.0.1:9229`.                                                                           |
| `ZALO_APP`            | `import.sh`          | Đường dẫn tới `Zalo.app` trên macOS khi nó không nằm trong `/Applications`.                                                                   |

## Các file bridge tạo ra

| File                             | Nội dung                                              | Bí mật?  |
| -------------------------------- | ----------------------------------------------------- | -------- |
| `bridge.db` (+ `-wal`, `-shm`)   | Ánh xạ portal, ghost, tin nhắn và biểu cảm (reaction) | Riêng tư |
| `zalo-creds.session.json`        | Phiên Zalo đã mã hoá                                  | Có       |
| `.zalo-creds.session.json.key`   | Khoá của file phiên                                   | Có       |
| `registration.yaml` (bạn tự tạo) | Token của appservice                                  | Có       |
| `crypto/`, `crypto-import/`      | Khoá crypto của bot và access token của thiết bị      | Có       |

Tất cả đều nằm trong gitignore. Đừng bao giờ commit chúng hay dán vào issue.
