# Tham khảo log

Bridge ghi log ra stdout và stderr. Mỗi dòng bắt đầu bằng một tiền tố (prefix) nêu tên thành phần bridge đã ghi dòng đó. Các dòng log **chỉ mang id, số đếm và trạng thái**, không bao giờ chứa văn bản tin nhắn.

Đọc log bằng lệnh:

::: code-group

```bash [Container]
podman logs -f zalo-beeper-bridge      # hoặc: docker logs -f zalo-beeper-bridge
```

```bash [macOS launchd]
tail -f ~/zalo-beeper-bridge/logs/bridge.log   # đường dẫn đặt trong plist
```

:::

## Tiền tố

| Tiền tố        | Được ghi bởi                                       |
| -------------- | -------------------------------------------------- |
| `[zalo]`       | Đăng nhập Zalo, listener và các sự kiện đến        |
| `[zalo:ws]`    | Trace websocket thô (chỉ khi có `ZALO_WS_TRACE=1`) |
| `[zalo:http]`  | Yêu cầu lịch sử gần đây (`ZALO_WS_TRACE=1`)        |
| `[bridge]`     | Xử lý tin nhắn đến và đi                           |
| `[sync]`       | Lệnh `sync` và catch-up sau khi kết nối lại        |
| `[beeper]`     | Beeper account state và thương hiệu mạng           |
| `[media]`      | Tải về từ Zalo CDN                                 |
| `[audio]`      | Chuyển đổi voice note                              |
| `[outbound]`   | Gửi tin nhắn sang Zalo                             |
| `[appservice]` | Yêu cầu HTTP từ `bbctl proxy`                      |
| `[import]`     | Công cụ nhập lịch sử                               |
| `[verify]`     | Importer `--verify`                                |
| `[retire]`     | Xoá phòng của công cụ nhập                         |

## `[zalo]`

| Dòng log                                                    | Ý nghĩa                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `in\|own <threadType> <kind> thread=… msg=…`                | Một tin nhắn đến từ người khác (`in`) hoặc từ chính tài khoản của bạn trên thiết bị khác (`own`).            |
| `re-logged in from saved credentials (uid …)`               | Đăng nhập lúc khởi động bằng phiên đã lưu mã hoá thành công.                                                 |
| `no valid saved credentials — send 'login'`                 | Không có phiên khả dụng. Hãy gửi `login` cho bot.                                                            |
| `listener connected`                                        | Websocket Zalo đã kết nối. Tiếp theo là quá trình catch-up.                                                  |
| `listener reconnecting (attempt N, in Nms)`                 | Websocket bị đóng; bridge thử lại với backoff. Bình thường khi mất mạng.                                     |
| `listener error:`                                           | Một lỗi do listener báo cáo. Thường theo sau bởi một lần kết nối lại.                                        |
| `listener restart skipped:`                                 | zca-js báo cáo listener đã đang chạy; được coi là đã phục hồi.                                               |
| `listener DEAD: <reason> — send 'login'…`                   | Zalo đã kết thúc phiên (cookie hết hạn, hoặc Zalo Web mở ở nơi khác). Xem [Xử lý sự cố](../troubleshooting). |
| `E2EE DM push (cmd 551) seen — rerouting to the DM handler` | Một DM đến dưới định dạng push mã hoá mới hơn của Zalo và được xử lý như DM thông thường.                    |
| `history batch type=group\|user raw=N usable=N`             | Một trang lịch sử gần đây đã được lấy về.                                                                    |
| `unhandled ws cmd N (subCmd N) — not bridged`               | Zalo gửi một kiểu sự kiện mà bridge không xử lý.                                                             |

Với `ZALO_WS_TRACE=1`, bridge còn ghi `[zalo:ws] cmd=… sub=… bytes=…` cho mỗi frame websocket và `[zalo:http] getCloudMessage <groupId> cursor=… msgs=N` cộng với metadata cursor của phản hồi (không bao giờ có nội dung tin nhắn) cho mỗi yêu cầu lịch sử. Chỉ dùng khi debug; log này rất dài.

## `[bridge]`

| Dòng log                                                          | Ý nghĩa                                                                                                                       |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `account <uid>: N portals, N messages assigned`                   | Các dòng cũ hơn được gắn nhãn với tài khoản đã đăng nhập (một lần, sau khi nâng cấp).                                         |
| `removed N malformed portal(s)`                                   | Dọn dẹp lúc khởi động các portal mà một lệnh `sync` cũ đã tạo với id không hợp lệ; bạn rời khỏi các phòng trống đó.           |
| `profile repair: N profiles checked, N named, N avatars set`      | Các ghost thiếu tên hoặc avatar được tra cứu lại.                                                                             |
| `profile repair lookup failed`                                    | Lượt tra cứu đó thất bại; nó sẽ được thử lại sau.                                                                             |
| `inbound <msgId> failed:`                                         | Một tin nhắn Zalo không thể đăng lên Beeper.                                                                                  |
| `unsupported Zalo msgType <type> (content keys: …)`               | Một kiểu tin nhắn Zalo mới. Beeper hiển thị một placeholder; xem [Xử lý sự cố](../troubleshooting#unknown-zalo-message-type). |
| `reply target not bridged`                                        | Một tin nhắn trả lời trên Zalo trích dẫn một tin nhắn không có sự kiện Beeper (ví dụ cũ hơn bridge).                          |
| `redact … failed`                                                 | Một lượt thu hồi từ Zalo không thể áp dụng trong Beeper.                                                                      |
| `chat.delete without message ids`                                 | Một sự kiện "xoá ở phía tôi" của Zalo không kèm id đã bị bỏ qua.                                                              |
| `owner auto-join … failed (manual accept needed)`                 | Chấp nhận lời mời vào phòng trong Beeper bằng tay.                                                                            |
| `owner leave … failed`                                            | Việc rời khỏi portal lỗi cấu trúc thay cho bạn thất bại; các dòng của nó dù sao cũng bị bỏ.                                   |
| `recording the Zalo account failed (retried on the next connect)` | Dòng `account` không thể ghi (thường do công cụ nhập đang giữ khoá cơ sở dữ liệu).                                            |

Có hai thông báo được đăng dưới dạng notice **trong chat** thay vì ghi log: `[bridge] this message type is not supported outbound yet` (bạn đã gửi thứ mà bridge chưa hỗ trợ gửi sang Zalo) và `[bridge] Zalo only allows recalling your own messages` (bạn đã xoá tin nhắn của người khác).

## `[sync]`

| Dòng log                                                        | Ý nghĩa                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `catch-up user\|group: N page(s)[ (stopped at the page limit)]` | Lịch sử gần đây được đọc sau một lần kết nối lại.                        |
| `catch-up: N missed message(s) to bridge`                       | Các tin nhắn đến trong lúc listener ngừng hoạt động, nay đang được đăng. |
| `catch-up failed:`                                              | Quá trình catch-up thất bại; lần kết nối lại tiếp theo sẽ thử lại.       |

## `[beeper]`, `[media]`, `[audio]`, `[outbound]`, `[appservice]`

| Dòng log                                                 | Ý nghĩa                                                                             |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `[beeper] remote state <X> rejected: HTTP …`             | Beeper từ chối cập nhật account state. Mạng có thể hiển thị là đã ngắt kết nối.     |
| `[beeper] remote state <X> failed:`                      | Bản cập nhật không gửi được.                                                        |
| `[beeper] own avatar upload failed`                      | Logo bridge không upload được; account state được đăng mà không có logo.            |
| `[media] download from <host> failed: <reason>`          | Tải từ Zalo CDN thất bại (thường do link hết hạn). Một dòng văn bản được đăng thay. |
| `[audio] voice transcode to AAC failed: …`               | Một voice note từ Beeper không thể chuyển đổi cho Zalo.                             |
| `[outbound] quoted send failed, retrying without quote:` | Zalo từ chối câu trả lời trích dẫn; tin nhắn được gửi dưới dạng văn bản thường.     |
| `[appservice] unhandled <METHOD> <path>`                 | `bbctl proxy` đã gọi một endpoint mà bridge không có route. Thường vô hại.          |

## Công cụ nhập: `[import]`, `[verify]`, `[retire]`

| Dòng log                                                   | Ý nghĩa                                               |
| ---------------------------------------------------------- | ----------------------------------------------------- |
| `[verify] <key> → <room>: N mapped, N timeline events, OK` | Phòng của chat chứa đầy đủ mọi tin nhắn đã export.    |
| `[verify] <key> → <room>: … PROBLEMS: …`                   | Có thứ gì đó bị thiếu; phòng cũ vẫn được giữ lại.     |
| `[retire] <roomId>: <outcome>, N stale mapping(s) dropped` | Một phòng đã bị thay thế được xoá.                    |
| `[retire] delete … as … failed`                            | Xoá phòng thất bại; hãy tự xoá phòng đó trong Beeper. |

Xem [Nhập lịch sử](../history-import/) để biết thêm về chính công cụ nhập.
