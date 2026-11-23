# Nhập lịch sử

Zalo Web, và do đó cả bridge chạy trực tiếp, không lấy được tin nhắn từ trước lúc phiên bắt đầu. Công cụ nhập lịch sử thay vào đó điền Beeper từ **kho tin nhắn local của Zalo PC**, và có thể bổ sung media từ **file sao lưu của Zalo PC** (`.zl.zip`).

Mỗi cuộc trò chuyện được dựng lại thành một phòng Beeper mới với toàn bộ lịch sử theo đúng thứ tự và thời gian gốc. Sau đó bridge được trỏ sang phòng mới, và phòng cũ chỉ bị xoá khi phòng mới đã được kiểm tra xong.

- **[Bắt đầu nhanh](./quick-start)**: một script làm tất cả, có bộ chọn chat.
- **[Các bước thủ công](./manual)**: những gì script tự động hoá, từng bước, gồm cả media từ file sao lưu.
- **[CLI của công cụ nhập](./importer-cli)**: mọi tuỳ chọn của chính công cụ nhập.

## Những gì được nhập và hiển thị ra sao

Tin nhắn được nhập hiển thị y hệt tin nhắn trực tiếp; cả hai cùng dùng `src/bridge/media-content.ts`.

| Tin nhắn Zalo                                      | Trong Beeper                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Văn bản, rich text                                 | `m.text`, @nhắc tên dạng pill, trích dẫn Zalo thành reply Matrix thật          |
| Ảnh                                                | `m.image` (ảnh JPEG XL được chuyển sang JPEG)                                  |
| Sticker                                            | `m.sticker` WebP động (PNG tĩnh với sticker một khung hình)                    |
| GIF                                                | `m.image` `image/gif`                                                          |
| Video / file / tin nhắn thoại                      | `m.video` / `m.file` / `m.audio` dạng voice note                               |
| Thẻ liên kết                                       | văn bản + `com.beeper.linkpreviews` (tiêu đề, mô tả, ảnh thu nhỏ)              |
| Nhật ký cuộc gọi                                   | ô cuộc gọi của Beeper (`com.beeper.action_message`)                            |
| Vị trí, dòng hệ thống (ghim, vào nhóm, bình chọn…) | văn bản hoặc thông báo dễ đọc; ghim và vào nhóm do bot của bridge đăng         |
| Bình chọn (poll)                                   | thông báo kèm câu hỏi và các lựa chọn được đánh số (không phải poll trực tiếp) |
| Media mà dữ liệu không còn ở đâu nữa               | một dòng văn bản, ví dụ `📷 [Ảnh 1920×1080 — không còn trên máy chủ Zalo]`     |

## Media lấy từ đâu

Theo thứ tự: bản sao trong file sao lưu (nếu bạn đã chuẩn bị), rồi đến CDN của Zalo.

**Link CDN Zalo của ảnh, video, file và tin nhắn thoại hết hạn khoảng 14 ngày sau khi gửi.** Zalo Cloud (`zpcloud`/`zfcloud`), host của GIF và sticker thì tồn tại vĩnh viễn. Vì vậy media cũ chỉ còn lại nhờ file sao lưu, nơi chứa media mà Zalo PC đã tải về.

## Các hành vi khác

- **Loại bỏ trùng lặp.** Zalo PC giữ thêm một dòng local thứ hai (`msgId_NNN`, cùng `cliMsgId` và cùng kiểu) cho một số tin nhắn của chính bạn. Các bản sao trùng lặp đó được loại bỏ. Các dòng `_NNN` không có bản tương ứng thực sự được giữ lại, vì chúng là bản duy nhất.
- **Không mất tin trực tiếp.** Các tin nhắn mà bridge trực tiếp đã chuyển nhưng Zalo PC chưa từng lưu, hoặc đến trong lúc một chat đang được dựng lại, được phát lại từ các sự kiện Matrix của phòng cũ ở đúng vị trí gốc trước khi chuyển sang phòng mới.
- **Im lặng.** Tin nhắn được nhập được gửi với `send_notification: false`, đánh dấu đã đọc cho bạn, và gắn thẻ để bridge trực tiếp không bao giờ gửi chúng ngược lại Zalo.
- **Giữ ánh xạ.** Trả lời, biểu cảm (reaction), thu hồi và đã xem (read receipt) vẫn hoạt động trên tin nhắn đã nhập. Chạy lại sẽ bỏ qua các tin nhắn đã được nhập.

## Giới hạn

- Bình chọn (poll) được nhập dưới dạng thông báo văn bản, không phải poll Matrix có thể bình chọn tương tác (tính năng nhập poll nguyên bản được lên kế hoạch cho giai đoạn sau).
- Chỉ nhập được những gì Zalo PC đang giữ local. Zalo PC có càng nhiều lịch sử thì Beeper nhận được càng nhiều.
- Cơ sở dữ liệu tin nhắn trong file sao lưu không thêm lịch sử nào nếu Zalo PC chính là máy đã tạo file sao lưu: nó chứa cùng các dòng đó.
- API batch-send của Beeper chỉ chèn được trước sự kiện cũ nhất hoặc sau sự kiện mới nhất của một phòng, không bao giờ chèn vào giữa. Đó là lý do các script dựng lại mỗi chat thành một phòng mới.

## Riêng tư

Khi cổng debug đang mở, bất kỳ chương trình local nào cũng đọc được tin nhắn của bạn qua đó. File sao lưu đã giải nén và media đã chuẩn bị chứa toàn bộ lịch sử của bạn ở dạng văn bản rõ. Xem [Bảo mật](../security#history-import) để biết cần xoá gì sau đó.
