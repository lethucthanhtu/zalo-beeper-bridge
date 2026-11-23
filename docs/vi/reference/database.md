# Schema cơ sở dữ liệu

Bridge giữ trạng thái của nó trong một file SQLite duy nhất, `bridge.db` (nằm ở `/data` trong container). File được mở bằng [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) ở chế độ WAL bởi `src/bridge/mapping-store.ts`. Công cụ nhập lịch sử cũng mở chính file này. Cả hai đặt `busy_timeout` 5 giây, nên một lần ghi gặp khoá ghi của tiến trình kia sẽ chờ thay vì lỗi.

Cơ sở dữ liệu **chỉ chứa id và ánh xạ**: phòng Matrix nào thuộc về chat Zalo nào, ghost nào thuộc về người dùng Zalo nào, và sự kiện Matrix nào thuộc về tin nhắn Zalo nào. Nó không lưu văn bản tin nhắn hay media. Ngoại lệ duy nhất là `zalo_file`, bảng giữ địa chỉ trên content repo của mỗi ảnh sticker đã tải lên và, với bản tải lên mã hoá, khoá để giải mã nó.

## Các bảng

### `portal`

Một dòng cho mỗi chat Zalo được bridge (DM hoặc nhóm).

| Cột           | Kiểu    | Ghi chú                                                     |
| ------------- | ------- | ----------------------------------------------------------- |
| `thread_id`   | TEXT PK | Id thread Zalo: uid của đối phương với DM, id nhóm với nhóm |
| `thread_type` | TEXT    | `user` hoặc `group`                                         |
| `room_id`     | TEXT    | Id phòng Matrix, duy nhất                                   |
| `name`        | TEXT    | Tên chat được biết gần nhất                                 |
| `created_at`  | INTEGER | Unix ms                                                     |
| `account_id`  | TEXT    | Uid Zalo của tài khoản mà chat thuộc về (v7)                |

### `puppet`

Một dòng cho mỗi người dùng Zalo có ghost Matrix.

| Cột                  | Kiểu    | Ghi chú                                                                |
| -------------------- | ------- | ---------------------------------------------------------------------- |
| `zalo_uid`           | TEXT PK | Id người dùng Zalo                                                     |
| `mxid`               | TEXT    | Id người dùng của ghost, ví dụ `@sh-zalo_<uid>:beeper.local`, duy nhất |
| `display_name`       | TEXT    | Tên được đặt gần nhất trên ghost                                       |
| `updated_at`         | INTEGER | Unix ms                                                                |
| `avatar_url`         | TEXT    | URL avatar Zalo được đồng bộ gần nhất vào ghost (v2)                   |
| `profile_checked_at` | INTEGER | Lần tra cứu sửa hồ sơ gần nhất (v6)                                    |

### `message`

Một dòng cho mỗi tin nhắn được bridge, theo cả hai chiều. Dùng để chống trùng, chặn echo, trả lời, chỉnh sửa, reaction, thu hồi và read receipt.

| Cột           | Kiểu    | Ghi chú                                                               |
| ------------- | ------- | --------------------------------------------------------------------- |
| `zalo_msg_id` | TEXT PK | Id tin nhắn Zalo                                                      |
| `room_id`     | TEXT    | Id phòng Matrix                                                       |
| `event_id`    | TEXT    | Id sự kiện Matrix, duy nhất                                           |
| `direction`   | TEXT    | `inbound` (Zalo → Beeper) hoặc `outbound` (Beeper → Zalo)             |
| `ts`          | INTEGER | Unix ms                                                               |
| `quote_json`  | TEXT    | Dữ liệu Zalo cần để trích dẫn tin nhắn này trong một câu trả lời (v3) |
| `cli_msg_id`  | TEXT    | Id tin nhắn phía client của Zalo, cần cho reaction và thu hồi (v4)    |
| `sender_id`   | TEXT    | Uid Zalo của người gửi (v5)                                           |
| `msg_type`    | TEXT    | Kiểu tin nhắn Zalo, cần cho sự kiện "đã xem" (v5)                     |
| `account_id`  | TEXT    | Uid Zalo của tài khoản (v7)                                           |

### `account`

Một dòng cho mỗi tài khoản Zalo mà bridge đã đăng nhập (v7). Được liệt kê bởi lệnh [`accounts`](../guide/bot-commands#accounts).

| Cột             | Kiểu    | Ghi chú                                     |
| --------------- | ------- | ------------------------------------------- |
| `zalo_uid`      | TEXT PK | Id người dùng Zalo của tài khoản            |
| `creds_path`    | TEXT    | Đường dẫn file thông tin xác thực đã mã hoá |
| `added_at`      | INTEGER | Unix ms                                     |
| `last_login_at` | INTEGER | Unix ms                                     |

### `reaction`

Một dòng cho mỗi reaction được bridge theo cả hai chiều (v8), để reaction bị gỡ ở một phía có thể được gỡ ở phía còn lại.

| Cột             | Kiểu    | Ghi chú                              |
| --------------- | ------- | ------------------------------------ |
| `event_id`      | TEXT PK | Id sự kiện reaction Matrix           |
| `room_id`       | TEXT    | Id phòng Matrix                      |
| `target_msg_id` | TEXT    | Id tin nhắn Zalo mà reaction gắn vào |
| `sender_id`     | TEXT    | Uid Zalo của người thả reaction      |
| `zalo_icon`     | TEXT    | Mã icon reaction của Zalo            |
| `ts`            | INTEGER | Unix ms                              |

Index `reaction_target (target_msg_id, sender_id)`. Bảng `message` còn có một partial index trên các dòng không có `account_id`, được dùng khi gán những dòng đó cho một tài khoản.

### `poll`

Một dòng cho mỗi bình chọn nhóm được bridge (v9): bình chọn Zalo và sự kiện `poll.start` Matrix hiển thị nó.

| Cột            | Kiểu       | Ghi chú                                                                         |
| -------------- | ---------- | ------------------------------------------------------------------------------- |
| `poll_id`      | INTEGER PK | Id bình chọn Zalo                                                               |
| `room_id`      | TEXT       | Id phòng Matrix                                                                 |
| `event_id`     | TEXT       | Id sự kiện `poll.start` (duy nhất)                                              |
| `creator_id`   | TEXT       | Uid Zalo của người tạo, null khi không rõ                                       |
| `options_json` | TEXT       | Danh sách JSON ánh xạ mỗi id lựa chọn Zalo sang id đáp án Matrix và nội dung    |
| `multi`        | INTEGER    | 1 khi được chọn nhiều hơn một lựa chọn                                          |
| `closed`       | INTEGER    | 1 khi bình chọn đã bị khoá hoặc kết thúc                                        |
| `votes_json`   | TEXT       | JSON lượt bình chọn được bridge gần nhất của mỗi người (uid Zalo → id lựa chọn) |

Index `poll_room (room_id)`.

### `media_failure`

Một dòng cho mỗi ảnh hoặc file live chỉ đến được Matrix dưới dạng thông báo `[Zalo … could not be bridged]` (v10). Lệnh bot `media-failures` chỉ liệt kê một dòng khi dòng `message` của cùng tin nhắn Zalo vẫn trỏ tới đúng phòng và sự kiện đó, nên lần dựng lại thay thế thông báo sẽ đóng dòng này. Cơ chế tự sửa media cũng đóng dòng này: nó trỏ dòng `message` tới file đã sửa và xoá dòng.

| Cột           | Kiểu    | Ghi chú                                                 |
| ------------- | ------- | ------------------------------------------------------- |
| `zalo_msg_id` | TEXT PK | Id tin nhắn Zalo                                        |
| `room_id`     | TEXT    | Id phòng Matrix                                         |
| `event_id`    | TEXT    | Id sự kiện của thông báo                                |
| `kind`        | TEXT    | Loại media: `photo`, `video`, `file`, `voice`, `gif`, … |
| `error`       | TEXT    | Lỗi tải về, chỉ có host CDN (không có link đã ký)       |
| `ts`          | INTEGER | Thời điểm lỗi (ms)                                      |
| `account_id`  | TEXT    | Uid Zalo của tài khoản, null với cơ sở dữ liệu cũ hơn   |

Index `media_failure_room (room_id)`. Xoá tin nhắn của một phòng hoặc portal của nó cũng xoá các dòng này.

### `zalo_file`

Các bản tải lên dùng lại được của file Zalo, hiện là ảnh sticker (v11). Bảng có cùng dạng với bảng `telegram_file` của mautrix-telegram. Cùng một sticker được gửi nhiều lần, nên bridge và công cụ nhập lịch sử chỉ tải ảnh của nó lên một lần cho mỗi chế độ rồi dùng lại ở mọi phòng, kể cả sau khi khởi động lại. Chỉ ảnh đã qua kiểm tra mới được lưu. Bản tải lên mã hoá không gắn với phòng nào, vì mỗi sự kiện mang theo khoá của nó, nên một dòng phục vụ mọi phòng mã hoá, giống mautrix-telegram. Sticker Zalo là ảnh công khai, nên dùng chung khoá giữa các phòng không làm lộ thêm gì.

| Cột               | Kiểu    | Ghi chú                                                                                    |
| ----------------- | ------- | ------------------------------------------------------------------------------------------ |
| `id`              | TEXT    | Khoá chính: `sticker-<id sticker>`, thêm `-encrypted` cho bản tải lên mã hoá               |
| `mxc`             | TEXT    | Địa chỉ của bản tải lên trên content repo                                                  |
| `mime_type`       | TEXT    | Mimetype của ảnh                                                                           |
| `size`            | INTEGER | Kích thước ảnh (byte)                                                                      |
| `width`           | INTEGER | Chiều rộng (pixel), null khi không biết                                                    |
| `height`          | INTEGER | Chiều cao (pixel), null khi không biết                                                     |
| `timestamp`       | INTEGER | Thời điểm tải lên (giây Unix)                                                              |
| `decryption_info` | TEXT    | Với bản tải lên mã hoá, JSON của đối tượng `file` kèm khoá; null trong các trường hợp khác |

Index `zalo_file_mxc_idx (mxc)`. Xoá các dòng này là an toàn: lần gửi sticker tiếp theo sẽ tải nó lên lại.

## Migrations

Phiên bản schema được lưu trong `PRAGMA user_version`. Phiên bản hiện tại là **11**.

| Phiên bản | Thay đổi                                                         |
| --------- | ---------------------------------------------------------------- |
| 1         | `portal`, `puppet`, `message`                                    |
| 2         | `puppet.avatar_url`                                              |
| 3         | `message.quote_json`                                             |
| 4         | `message.cli_msg_id`                                             |
| 5         | `message.sender_id`, `message.msg_type`                          |
| 6         | `puppet.profile_checked_at`                                      |
| 7         | bảng `account`, `portal.account_id`, `message.account_id`, index |
| 8         | bảng `reaction` và index                                         |
| 9         | bảng `poll` và index                                             |
| 10        | bảng `media_failure` và index                                    |
| 11        | bảng `zalo_file` và index                                        |

Migration chạy khi khởi động bên trong một transaction `BEGIN IMMEDIATE` duy nhất, đọc lại phiên bản trước tiên. Nếu bridge và công cụ nhập mở một cơ sở dữ liệu cũ cùng lúc, chỉ một trong hai migrate, và một lần crash giữa chừng sẽ để cơ sở dữ liệu ở phiên bản cũ mà không có thay đổi dở dang nào.

Mỗi migration chỉ **thêm** bảng, cột hoặc index. Vì vậy phiên bản bridge cũ hơn vẫn chạy được trên cơ sở dữ liệu mới hơn, nhờ đó việc rollback một image là an toàn (xem [Vận hành](../deployment/operations#rollback)).

## Kiểm tra nó

Hãy dừng bridge hoặc làm việc trên một bản sao, sau đó:

```bash
sqlite3 bridge.db 'PRAGMA user_version;'
sqlite3 bridge.db 'SELECT thread_type, count(*) FROM portal GROUP BY thread_type;'
```

Sau khi đăng nhập Zalo, bridge log `[bridge] account <uid>: N portals, N messages assigned` khi nó gắn tài khoản đang đăng nhập vào các dòng cũ hơn.
