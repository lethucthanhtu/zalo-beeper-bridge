# Tính năng

## Ma trận hỗ trợ

| Hạng mục                              |                         Zalo → Beeper                          |                   Beeper → Zalo                   |
| ------------------------------------- | :------------------------------------------------------------: | :-----------------------------------------------: |
| Văn bản (DM + nhóm)                   |                      ✅ (kể cả rich text)                      |                        ✅                         |
| @nhắc tên                             |                         ✅ (dạng pill)                         |                        ✅                         |
| Trả lời / trích dẫn                   |                               ✅                               |                        ✅                         |
| Ảnh                                   |                               ✅                               |                        ✅                         |
| Sticker                               |      ✅ động (`m.sticker`, WebP dựng từ sprite của Zalo)       |                         —                         |
| GIF                                   |                               ✅                               |                         —                         |
| Video                                 |                         ✅ (`m.video`)                         |                        ✅                         |
| File                                  |                         ✅ (`m.file`)                          |                        ✅                         |
| Tin nhắn thoại                        |                 ✅ (`m.audio` dạng voice note)                 | ✅ voice note (ogg/opus được mã hoá lại sang AAC) |
| Thẻ liên kết                          |              ✅ văn bản + link preview của Beeper              |        ✅ Zalo tự tạo thẻ liên kết của nó         |
| Vị trí                                | ✅ `m.location` (xem trước bản đồ, mở app bản đồ của thiết bị) |                         —                         |
| Danh thiếp                            |        ✅ mã QR + tên, số điện thoại và link `zalo.me`         |                         —                         |
| Thẻ web (`chat.webcontent`)           |                  ✅ văn bản (tiêu đề + mô tả)                  |                         —                         |
| Nhật ký cuộc gọi (thoại / video, nhỡ) |     ✅ ô cuộc gọi của Beeper (`com.beeper.action_message`)     |                         —                         |
| Tin nhắn được ghim                    |          ✅ ghim trong phòng (`m.room.pinned_events`)          |                         —                         |
| Bình chọn (poll, chỉ trong nhóm)      |         ✅ poll MSC3381, phản chiếu các lượt bình chọn         |            ✅ tạo, bình chọn, kết thúc            |
| Dòng hệ thống (vào / rời nhóm, ...)   |                 ✅ thông báo từ bot của bridge                 |                         —                         |
| Biểu cảm (reaction)                   |                               ✅                               |                        ✅                         |
| Thu hồi tin nhắn                      |                  ✅ cũng bị xoá trong Beeper                   |                        ✅                         |
| "Xoá ở phía tôi" trên thiết bị khác   |                  ✅ cũng bị xoá trong Beeper                   |                         —                         |
| Đã xem (read receipt)                 |                               ✅                               |     ✅ (theo cài đặt read receipt của Beeper)     |
| Đang soạn tin (typing)                |                               ✅                               |        ✅ (theo cài đặt typing của Beeper)        |
| Tin bạn gửi từ điện thoại             |                     ✅ (double-puppeting)                      |                        n/a                        |
| Chat Zalo mã hoá đầu cuối             |            chỉ hiện thông báo (không giải mã được)             |                         —                         |

Ngoài ra còn có:

- Ghost user với tên và ảnh đại diện Zalo thật, được làm mới ở nền.
- Phòng portal được tạo tự động khi có tin nhắn đầu tiên của một cuộc trò chuyện.
- Lệnh [`sync`](./bot-commands#sync) cho các chat được ghim và nhóm.
- Thương hiệu mạng Zalo (tên và logo) trong Beeper.
- Tự động kết nối lại listener và lấy lại các tin nhắn bị lỡ. Xem [Cách hoạt động](./how-it-works).
- Giới hạn tốc độ gửi tin đi để bảo vệ tài khoản. Xem [Cấu hình](./configuration#zalo).
- Lưu trữ thông tin đăng nhập ở dạng mã hoá. Xem [Bảo mật](../security).
- [Công cụ nhập lịch sử](../history-import/).

## Chi tiết

### Ảnh và chú thích

Ảnh không có chú thích thì không hiện chú thích ở cả hai chiều; tên file không bao giờ được dùng làm chú thích. Ảnh gửi từ Beeper iOS (không gửi `filename`) đến Zalo không có chú thích. Ảnh lớn hơn [`bridge.mediaMaxBytes`](./configuration#bridge) không được bridge.

### Video, file và tin nhắn thoại

Video và file đến 100 MB được bridge. Tin nhắn thoại Zalo đến dưới dạng voice note M4A phát được: bridge đóng gói lại luồng AAC thô của Zalo mà không mã hoá lại. Theo chiều ngược lại, voice note AAC (Beeper iOS) được gửi nguyên trạng, còn ogg/opus (Beeper Android) được mã hoá lại sang AAC bằng `ffmpeg`.

Link CDN của Zalo cho ảnh, video, file và tin nhắn thoại hết hạn khoảng 14 ngày sau khi gửi. Bridge chỉ tải media từ các host CDN của Zalo, qua HTTPS, và kiểm tra mọi lần chuyển hướng (redirect). Khi tải về thất bại, phòng nhận một thông báo kèm link Zalo thay thế.

### Link

Tin nhắn Beeper có chứa link (và không có trả lời hay nhắc tên) được gửi bằng API link của Zalo, để Zalo hiển thị thẻ xem trước của riêng nó. Nếu Zalo không phân tích được link, tin nhắn được gửi dưới dạng văn bản thuần. Tin nhắn link của Zalo hiện trong Beeper là đoạn văn người gửi đã gõ. Tiêu đề, mô tả và ảnh thu nhỏ mà Zalo phân giải được sẽ trở thành link preview của Beeper.

### Rich text

In đậm, màu sắc và các định dạng khác từ Zalo đến dưới dạng văn bản thuần, kèm phần nhắc tên; phần định dạng bị bỏ.

### Đang soạn tin và đã xem

Hai thông tin này được gửi tới Zalo đúng lúc Beeper gửi. Nếu bạn tắt thông báo typing hoặc read receipt trong cài đặt của Beeper, sẽ không có gì được chuyển sang Zalo. Khi đó Beeper không gửi sự kiện typing và chỉ gửi receipt riêng tư, còn bridge bỏ qua loại receipt này.

### Danh thiếp

Danh thiếp Zalo hiển thị mã QR của liên hệ kèm tên và số điện thoại. Link `zalo.me/<phone>` mở app Zalo trên điện thoại. Khi liên hệ ẩn số thì không có link; hãy quét mã QR thay thế.

### Nhật ký cuộc gọi

Cuộc gọi thoại, video và cuộc gọi nhỡ của Zalo hiện thành ô cuộc gọi của Beeper, với chiều gọi và thời lượng làm văn bản ("Cuộc gọi video đến · 1:05"). Không thể gọi hoặc nghe cuộc gọi từ Beeper.

Trên Beeper di động, chạm vào ô cuộc gọi hiện "Couldn't open Self-hosted" thay vì mở Zalo. App Beeper chọn app cần mở dựa trên loại bridge, và nó chỉ biết các mạng chính thức. Bridge không thay đổi được điều này: đã thử đặt `external_url` (`https://zalo.me`, `zalo://`) trên sự kiện nhưng không có tác dụng. Hãy tự mở Zalo để gọi lại.

### Bình chọn (poll)

Bình chọn chỉ hoạt động trong chat nhóm (Zalo không có bình chọn trong DM).

- **Zalo sang Beeper.** Một bình chọn tạo trên Zalo hiện thành poll Matrix (MSC3381) từ người tạo. Mỗi lượt bình chọn được phản chiếu thành một poll response từ người bình chọn, và bình chọn bị khoá hoặc xoá trên Zalo sẽ kết thúc trong Beeper. Với bình chọn ẩn danh, Zalo không cho biết ai đã bình chọn, nên bot của bridge đăng số phiếu hiện tại dưới dạng thông báo thay thế.
- **Beeper sang Zalo.** Một bình chọn bạn tạo trong chat nhóm được tạo trên Zalo với cùng câu hỏi và các lựa chọn (tuỳ chọn "cho phép chọn nhiều đáp án" được giữ nguyên). Các lượt bình chọn của bạn (bình chọn rỗng sẽ gỡ phiếu) và việc kết thúc bình chọn cũng được gửi sang Zalo. Trong DM, bridge trả lời bằng một thông báo và không gửi gì.
- **Phòng mã hoá.** Sự kiện poll được mã hoá giống như tin nhắn, nên poll hoạt động trong các phòng mã hoá end-to-bridge.
- **Giới hạn.** Các tuỳ chọn phía Zalo như "thêm lựa chọn" hay "ghim bình chọn" không được phản chiếu, và bình chọn không sửa được sau khi tạo. Chỉ các bình chọn của chính chủ tài khoản mới kết thúc được trên Zalo.

### Tin nhắn được ghim và dòng hệ thống

Khi ai đó ghim hoặc bỏ ghim một tin nhắn trên Zalo, bridge ghim hoặc bỏ ghim đúng tin nhắn đó trong phòng (state `m.room.pinned_events` của phòng), dưới danh nghĩa người đã thực hiện. Các ghim khác trong phòng được giữ nguyên. Nếu tin nhắn được ghim chưa từng được bridge (ví dụ nó cũ hơn bridge), phòng nhận một thông báo ngắn từ bot của bridge thay thế.

Các dòng hệ thống khác từ Zalo (ai đó vào hoặc rời nhóm, và tương tự) được đăng dưới dạng thông báo từ bot của bridge, để chúng không bao giờ trông như do một người viết. Một DM được tạo trước khi có mã hoá không có bot trong phòng. Bridge sẽ mời bot. Nếu việc này thất bại, bridge đăng dòng đó dưới danh nghĩa ghost của người kia, vì đây là thành viên duy nhất còn lại có thể nhắn trong phòng.

Ghim hoặc bỏ ghim trong Beeper không thay đổi các ghim trên Zalo.

### Thu hồi

Chỉ những tin nhắn bạn gửi từ Beeper mới thu hồi được trên Zalo, và chỉ trong khoảng thời gian thu hồi của Zalo. Zalo chỉ cho phép thu hồi tin nhắn của chính mình.

Tin nhắn bị thu hồi trên Zalo (bởi người gửi, hoặc bởi bạn trên thiết bị khác) cũng bị xoá trong Beeper. Các tin nhắn mà bridge chưa từng bridge thì được bỏ qua.

### Kiểu tin nhắn không xác định

Kiểu tin nhắn Zalo mà bridge không biết hiển thị là `[Zalo message type not supported by bridge: <type>]`. Log ghi lại **tên** các trường của payload (không bao giờ ghi giá trị) để có thể bổ sung kiểu đó. Xem [Xử lý sự cố](../troubleshooting#unknown-zalo-message-type).

## Chưa hỗ trợ

- Đồng bộ chỉnh sửa từ Zalo sang Beeper.
- Chat Zalo mã hoá đầu cuối (không giải mã được).
- Backfill trực tiếp lịch sử từ máy chủ Zalo. Zalo Web không trả về gì từ trước lúc đăng nhập. Hãy dùng [công cụ nhập lịch sử](../history-import/).
- Nhiều tài khoản Zalo trên một bridge. Chạy một bridge cho mỗi tài khoản; xem [Nhiều tài khoản](./multiple-accounts).
