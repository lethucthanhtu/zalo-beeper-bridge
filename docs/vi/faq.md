# Câu hỏi thường gặp

## Đây có phải bridge Zalo hoặc Beeper chính thức không?

Không. Đây là một dự án cộng đồng, không liên kết với Zalo/VNG hay Beeper. Dự án giao tiếp với Zalo qua [zca-js](https://github.com/RFS-ADRENO/zca-js), một client không chính thức của giao thức Zalo Web.

## Tài khoản Zalo của tôi có thể bị khoá hoặc cấm không?

Có thể. Zalo không cho phép client bên thứ ba, và việc dùng một client như vậy vi phạm điều khoản sử dụng. Bridge điều tiết tốc độ request và giới hạn tốc độ gửi, nhưng không thể loại trừ hoàn toàn khả năng bị khoá. Nếu không thể chấp nhận rủi ro với tài khoản chính, hãy dùng tài khoản phụ. Xem [Bảo mật và riêng tư](./security#risk-to-your-zalo-account).

## Có dùng được với Matrix homeserver khác ngoài Beeper không?

Bridge là một Matrix application service tiêu chuẩn, nhưng chỉ được xây dựng và kiểm thử với Beeper, qua `bbctl`. Một số phần đặc thù cho Beeper: trạng thái tài khoản, thương hiệu mạng và double-puppeting qua token appservice. Các homeserver khác chưa được kiểm thử.

## Tôi có dùng Zalo trên điện thoại và Zalo PC song song được không?

Được. App điện thoại và Zalo PC chạy song song với bridge, và tin nhắn bạn gửi từ đó hiện trong Beeper như của bạn. **Zalo Web trên trình duyệt** là ngoại lệ: Zalo chỉ cho phép một phiên web, nên trình duyệt và bridge cứ đá nhau liên tục.

## Vì sao tôi không thấy tin nhắn cũ?

Zalo Web chỉ gửi tin nhắn đến sau lúc đăng nhập, cộng thêm một đợt lấy lại ngắn sau khi kết nối lại. Để đưa lịch sử cũ hơn vào Beeper, hãy dùng [nhập lịch sử](./history-import/), công cụ đọc lịch sử từ Zalo PC.

## Chuyện gì xảy ra với tin nhắn đến khi bridge đang ngừng hoạt động?

Sau khi listener kết nối lại, bridge lấy những gì đã lỡ và đăng chúng lên, tối đa khoảng 500 tin nhắn mỗi loại (DM và nhóm). Xem [Xử lý sự cố](./troubleshooting#messages-missing-after-the-pc-slept-or-the-container-was-down).

## Chỉnh sửa và thu hồi từ Zalo có được bridge không?

Chưa. Tin nhắn ai đó thu hồi trên Zalo vẫn còn trong Beeper, và chỉnh sửa không được đồng bộ. Chiều ngược lại thì có: bạn thu hồi được tin nhắn của chính mình từ Beeper. Tin nhắn bạn xoá "ở phía tôi" trên thiết bị khác cũng bị xoá trong Beeper. Danh sách đầy đủ nằm ở trang [Tính năng](./guide/features).

## Còn các chat Zalo mã hoá đầu cuối thì sao?

Bridge không giải mã được chúng. Với các tin nhắn như vậy, bridge đăng một thông báo thay cho nội dung.

## Bridge có lưu tin nhắn của tôi không?

Không. Cơ sở dữ liệu chỉ giữ id và ánh xạ: phòng, ghost và sự kiện nào thuộc về chat, người dùng và tin nhắn Zalo nào. Văn bản và media đi qua mà không được lưu lại. Xem [Schema cơ sở dữ liệu](./reference/database).

## Một bridge có phục vụ được nhiều tài khoản Zalo không?

Một bridge phục vụ một tài khoản Zalo tại một thời điểm. Để có tài khoản thứ hai, hãy chạy một bridge thứ hai với registration riêng. Xem [Nhiều tài khoản](./guide/multiple-accounts).

## Có chạy được trên Windows không?

Có, trong container với Docker hoặc Podman. Xem [Triển khai bằng container](./deployment/container). Không dùng container, bridge chạy trên macOS và Linux với Node.js 22.18 trở lên.

## Vì sao Beeper hiện mạng là "sh-zalo", hoặc huy hiệu chung trên avatar chat?

Beeper lấy nhãn mạng cấp cao nhất từ tên đăng ký `bbctl`, và chỉ vẽ huy hiệu nhỏ cho các loại bridge mà nó biết. Bridge đã đặt mọi thứ mà một bridge tự host có thể đặt: tên "Zalo" và logo trên bot và trên mọi chat. Xem [Xử lý sự cố](./troubleshooting#network-name-still-shows-sh-zalo).

## Đang soạn tin và đã xem không đến được Zalo

Bridge chuyển tiếp chúng đúng lúc Beeper gửi. Nếu bạn tắt thông báo đang soạn tin hoặc đã xem trong cài đặt Beeper, Beeper sẽ ngừng gửi chúng, nên bridge không có gì để chuyển tiếp.

## Một tin nhắn hiện `[Zalo message type not supported by bridge: …]`

Zalo đã gửi một kiểu tin nhắn mà bridge chưa biết. Vui lòng [mở một issue](https://github.com/lethucthanhtu/zalo-beeper-bridge/issues) kèm kiểu tin nhắn và tên các trường từ dòng log, nhưng không bao giờ kèm nội dung. Xem [Xử lý sự cố](./troubleshooting#unknown-zalo-message-type).
