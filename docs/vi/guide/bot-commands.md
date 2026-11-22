# Lệnh của bot

Bot của bridge (`@sh-zalobot:beeper.local` với bridge đăng ký tên `sh-zalo`) là cách bạn điều khiển bridge. Hãy bắt đầu một cuộc trò chuyện với nó trong Beeper; bot sẽ tham gia ngay khi **bạn** (người được cấu hình là `owner`) mời nó, rồi trả lời bằng danh sách lệnh:

```
sh-zalo bridge bot ready. Commands: ping | login | logout | status | sync | accounts | media-failures
```

Lệnh không phân biệt chữ hoa chữ thường. Tin nhắn từ bất kỳ ai khác ngoài owner đều bị bỏ qua.

| Lệnh                                | Chức năng                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------- |
| [`ping`](#ping)                     | Kiểm tra sức khoẻ. Trả lời `pong!` kèm thời gian hoạt động (uptime).            |
| [`login`](#login)                   | Bắt đầu đăng nhập Zalo bằng mã QR.                                              |
| [`logout`](#logout)                 | Đăng xuất khỏi Zalo và xoá phiên đã lưu.                                        |
| [`status`](#status)                 | Hiển thị uptime, trạng thái đăng nhập Zalo và trạng thái listener.              |
| [`sync`](#sync)                     | Tạo phòng cho các chat được ghim và mọi nhóm, rồi điền vào các phòng còn trống. |
| [`accounts`](#accounts)             | Liệt kê các tài khoản Zalo mà bridge này đã đăng nhập. Chỉ đọc.                 |
| [`media-failures`](#media-failures) | Liệt kê các phòng có ảnh hoặc file chỉ đến được dưới dạng thông báo. Chỉ đọc.   |

## `ping`

```
pong! uptime 76h 12m 5s
```

Dùng lệnh này để kiểm tra Beeper, `bbctl proxy` và appservice đều đang kết nối. Không có phản hồi nghĩa là một trong số đó đang ngừng hoạt động; xem [Xử lý sự cố](../troubleshooting).

## `login`

1. Bot gửi `Generating Zalo QR — scan it with the Zalo app, then confirm on your phone.` kèm ảnh mã QR.
2. Quét mã bằng app Zalo trên điện thoại và xác nhận.
3. Thành công: `✓ Logged in to Zalo (uid …), listener started.` Nếu thất bại, bot gửi `Zalo login failed: <reason>`.

Nếu đã có một phiên đang hoạt động, bot từ chối với `Already logged in to Zalo … Use 'logout' first to switch.` Phiên được lưu ở dạng mã hoá, nên sau khi khởi động lại, bridge tự đăng nhập lại (`[zalo] re-logged in from saved credentials`). Bạn chỉ cần `login` lại khi phiên hết hạn hoặc bị Zalo kết thúc.

## `logout`

Dừng listener, kết thúc phiên trên máy chủ Zalo và xoá file phiên đã lưu. Sau đó Beeper hiển thị tài khoản ở trạng thái đã đăng xuất. Các phòng hiện có và cơ sở dữ liệu vẫn được giữ lại; đăng nhập lại bằng `login`.

Nếu Zalo không xác nhận việc đăng xuất trong vòng 15 giây (ví dụ do mất mạng), bridge vẫn đăng xuất ở phía local và nói rõ điều đó trong phản hồi. Khi đó phiên có thể vẫn còn trong danh sách thiết bị đang đăng nhập trong app Zalo; hãy gỡ nó ở đó.

## `status`

```
bridge uptime: 76h 12m 5s
zalo: logged in (uid 1111111111111111111)
listener: connected
```

`listener` có thể là `connected`, `reconnecting`, `dead` hoặc `stopped`. `dead` nghĩa là listener đã bỏ cuộc sau nhiều lần lỗi liên tiếp; hãy gửi lại `login` (xem [Cách hoạt động](./how-it-works#listener-and-reconnects)).

## `sync`

Tạo một phòng portal cho mỗi chat **được ghim** và mỗi **nhóm** bạn tham gia, mời và cho bạn vào các phòng đó, rồi điền vào những phòng còn trống bằng lịch sử gần đây mà Zalo cung cấp cho phiên này. Kết thúc bằng một bản tóm tắt như sau:

```
Sync done: 52/52 pinned/group conversations ensured (4 pinned, 48 groups).
```

- Lệnh chạy có nhịp độ (1,5 giây giữa các bước) để tránh dồn dập lời gọi API trên tài khoản của bạn: khoảng 50 nhóm mất 2 phút.
- Lịch sử bị giới hạn ở những gì Zalo cung cấp cho một phiên web, tức là không có gì từ trước lúc đăng nhập. Hãy dùng [công cụ nhập lịch sử](../history-import/) cho các tin nhắn cũ hơn.
- Tin nhắn cũ không bao giờ được chèn vào phòng đã có tin nhắn, nên chạy lại `sync` là an toàn.
- Chat riêng (DM) không được ghim sẽ có phòng khi tin nhắn đầu tiên đến.

## `accounts`

Liệt kê mọi tài khoản Zalo mà bridge này đã đăng nhập, kèm thời điểm đăng nhập gần nhất (UTC), và đánh dấu tài khoản hiện tại:

```
Zalo accounts:
● 1111111111111111111 — last login 2026-11-01 08:30 UTC (logged in, listener connected)
○ 2222222222222222222 — last login 2026-10-20 14:05 UTC
```

Lệnh này chỉ đọc. Một bridge phục vụ một tài khoản Zalo tại một thời điểm; xem [Nhiều tài khoản](./multiple-accounts).

## `media-failures`

Khi bridge không tải được một ảnh hoặc file, kể cả sau khi đã thử link HD và link thumbnail của ảnh và thử lại một lần với lỗi mạng, nó gửi `[Zalo photo could not be bridged: …]` vào phòng và ghi lại tin nhắn đó. Lệnh này liệt kê các phòng vẫn còn những thông báo như vậy:

```
Media that reached Matrix only as a notice (3 in 2 room(s)):
• Family — 2 photo, last 2026-11-20 09:14 UTC (thread 1234567890)
• Work — 1 file, last 2026-11-21 16:02 UTC (thread 9876543210)
1 of them are still being retried automatically (up to about an hour).
To repair the rest: rebuild the chat with the history importer and --media-dir ...
```

Trước tiên bridge tự thử lại từng lỗi, sau 2, 15 và 60 phút (các lần sau lấy lại tin nhắn từ Zalo để có link mới). File sửa được sẽ được gửi vào cuối timeline của phòng và thông báo lỗi bị gỡ. Sau khi khởi động lại, các lỗi trong 7 ngày gần nhất được thử lại. Zalo chỉ trả về 200 tin mới nhất của nhóm và khoảng một tuần của chat riêng, nên lỗi cũ hơn vẫn nằm trong danh sách.

Để tự sửa một phòng, hãy dựng lại phòng đó bằng [công cụ nhập lịch sử](../history-import/manual) với `--media-dir` trỏ tới thư mục media của Zalo PC: lần dựng lại sẽ thay mỗi thông báo bằng file thật. Phòng biến khỏi danh sách khi đã được dựng lại hoặc bị xoá. Lệnh này chỉ đọc.
