# Cách hoạt động

Trang này giải thích bridge làm gì khi chạy, theo thứ tự bạn sẽ gặp. Về cách tổ chức mã nguồn, xem [Kiến trúc](../reference/architecture).

## Hai tiến trình

Bridge cần hai tiến trình chạy song song:

1. **Appservice** (`node src/index.ts`): đăng nhập Zalo bằng zca-js, lắng nghe tin nhắn Zalo và giao tiếp với homeserver Matrix. Nó phục vụ API appservice tại `localhost:<matrix.port>` (mặc định 29350), gồm cả `GET /health`.
2. **`bbctl proxy`**: mở một websocket đi ra tới Beeper và chuyển các transaction appservice của Beeper tới cổng local. Không có gì lắng nghe trên internet.

Container chạy cả hai và dừng container nếu một trong hai thoát, để chính sách restart đưa cả hai trở lại cùng lúc.

## Phòng và ghost

- **Phòng portal:** mỗi cuộc trò chuyện Zalo (DM hoặc nhóm) có một phòng Matrix. Bridge tạo phòng khi có tin nhắn đầu tiên của cuộc trò chuyện đó, hoặc với các chat được ghim và nhóm thì khi bạn chạy [`sync`](./bot-commands#sync). Bạn được mời và tham gia tự động; khi khởi động, bridge cũng cho bạn vào mọi portal mà bạn mới chỉ được mời.
- **Ghost user:** mỗi liên hệ Zalo là một người dùng Matrix `@<bridge name>_<zalo uid>:beeper.local` với tên và ảnh đại diện của liên hệ đó. Hồ sơ được kiểm tra lại tối đa một lần mỗi ngày. Các ghost chưa có tên (ví dụ do công cụ nhập lịch sử tạo) được điền thêm ở nền sau khi đăng nhập: mỗi lô 20 hồ sơ, nghỉ 15 giây giữa các lô, và nếu Zalo từ chối thì lần thử tiếp theo chờ một giờ.
- **Double-puppeting:** trên máy chủ single-tenant của Beeper, token appservice có thể hành động thay bạn, nên tin nhắn bạn gửi từ app Zalo trên điện thoại hiện trong Beeper như do chính bạn gửi.
- **Thương hiệu:** hồ sơ bot và state `m.bridge` của mỗi phòng đặt tên mạng là "Zalo" kèm logo, để Beeper xếp các chat vào mạng đó. Huy hiệu nhỏ trên avatar chat vẫn là huy hiệu chung: app Beeper chỉ hiển thị huy hiệu riêng cho các bridge chính thức, còn bridge tự host đăng ký dưới loại chung `bridgev2`.

## Zalo → Beeper

1. zca-js chuyển một sự kiện Zalo thô qua websocket của nó.
2. `event-normalizer` chuyển nó thành một tin nhắn có kiểu (văn bản, ảnh, sticker, file, link, vị trí, …).
3. `inbound-handler` tìm hoặc tạo portal và ghost, dựng nội dung (media đi qua `media-content`, dùng chung với công cụ nhập lịch sử), gửi dưới danh nghĩa ghost (hoặc dưới danh nghĩa bạn, với tin nhắn của chính bạn) và lưu ánh xạ id tin nhắn Zalo → id sự kiện Matrix vào SQLite.

Mỗi tin nhắn được bridge ghi một dòng log chỉ chứa id, ví dụ `[zalo] in group text thread=… msg=…`.

## Beeper → Zalo

1. Beeper gửi một transaction qua `bbctl proxy` tới appservice.
2. `outbound-handler` ánh xạ phòng sang thread Zalo, chuyển đổi nhắc tên (@mention), trả lời, media và tin nhắn thoại, đợi một token từ [bộ giới hạn tốc độ](./configuration#zalo) rồi gửi bằng zca-js.
3. Zalo dội mọi tin nhắn trở lại listener của chính người gửi. **Echo suppressor** khớp tin dội lại đó (theo id tin nhắn, có phương án dự phòng theo nội dung) để tin nhắn của bạn không bị đăng hai lần.

Biểu cảm (reaction), đã xem (read receipt), đang soạn tin (typing) và thu hồi cũng đi theo cách tương tự.

## Listener và kết nối lại {#listener-and-reconnects}

Zalo chỉ cho phép **một** phiên web cho mỗi tài khoản. Listener chính là websocket của phiên đó.

- Khi kết nối đóng, listener kết nối lại với backoff 5 giây, 15 giây, 60 giây, rồi cứ 5 phút một lần.
- Bộ đếm lỗi được đặt lại khi một kết nối giữ được 60 giây.
- Sau 8 lần lỗi liên tiếp mà không có kết nối ổn định, listener bỏ cuộc và chuyển sang trạng thái **dead**. Mất mạng (close code 1006) là ngoại lệ: bridge tiếp tục thử lại suốt thời gian mạng còn mất.
- Close code 3000 nghĩa là một phiên Zalo Web khác đã chiếm phiên. Hãy đóng tab trình duyệt đó; bridge sẽ kết nối lại.
- Listener ở trạng thái dead cần `login` lại. Log hiển thị `[zalo] listener DEAD: … — send 'login' in the management room`.

## Lấy lại tin nhắn sau thời gian ngừng hoạt động

Zalo không gửi lại những tin nhắn đến khi bridge tạm dừng (container dừng, máy tính ngủ, mất mạng). Sau mỗi lần kết nối lại, bridge yêu cầu Zalo cung cấp mọi tin nhắn mới hơn tin cuối cùng đã bridge, tách riêng cho chat riêng (DM) và nhóm: 50 tin mỗi trang, tối đa 10 trang mỗi loại. Sau đó bridge phát lại khoảng trống đó theo đúng thứ tự.

```
[zalo] listener connected
[sync] catch-up user: 1 page(s)
[sync] catch-up group: 3 page(s)
[sync] catch-up: 42 missed message(s) to bridge
```

Nếu có hơn khoảng 500 tin nhắn cùng loại đến, log thêm `(stopped at the page limit)` và những tin mới nhất trong số đó không được lấy về. Hãy khởi động lại bridge để chạy thêm một lần lấy lại từ điểm đó. Tin nhắn được lấy lại mang thời gian lúc chúng được bridge, không phải thời gian gốc.

## Trạng thái tài khoản trên Beeper

Beeper chỉ liệt kê các chat của một bridge khi bridge đã công bố remote-account state của nó. Bridge gửi trạng thái này mỗi khi listener thay đổi:

| Sự kiện                    | Trạng thái             |
| -------------------------- | ---------------------- |
| Listener đã kết nối        | `CONNECTED`            |
| Đang kết nối lại           | `TRANSIENT_DISCONNECT` |
| Listener ở trạng thái dead | `BAD_CREDENTIALS`      |
| `logout`                   | `LOGGED_OUT`           |

Việc `bbctl proxy` kết nối lại có thể xoá trạng thái này, nên bridge gửi lại nó mỗi phút. Bạn có thể kiểm tra bằng `bbctl whoami --raw` ở mục `remoteState`.

## Những gì Zalo không cho phép

- **Lịch sử từ trước lúc đăng nhập.** Zalo chỉ cung cấp cho phiên web những tin nhắn nhận được sau khi phiên được tạo. Lịch sử nhóm từ cloud trả về đã bị lọc, còn DM được giữ trên điện thoại chứ không nằm trên máy chủ Zalo. [Công cụ nhập lịch sử](../history-import/) khắc phục bằng cách đọc kho dữ liệu local của Zalo PC.
- **Hai phiên web.** Mở Zalo Web ở nơi khác sẽ đá bridge ra.
- **Thời gian gốc khi lấy lại tin nhắn trực tiếp.** Chỉ công cụ nhập lịch sử mới đặt được thời gian gốc.
