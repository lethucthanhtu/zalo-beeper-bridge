# zalo-beeper-bridge là gì?

zalo-beeper-bridge là một [Matrix application service](https://spec.matrix.org/latest/application-service-api/) tự host, kết nối một tài khoản **Zalo** cá nhân vào **[Beeper](https://www.beeper.com/)**. Nó cũng chạy được với bất kỳ Matrix homeserver nào khác. Sau khi đăng nhập một lần bằng mã QR, các DM và nhóm Zalo của bạn hiện thành chat Beeper, và những gì bạn gõ trong Beeper được gửi sang Zalo.

Dự án được xây dựng bằng:

- [Node.js](https://nodejs.org/) 22.18+ và TypeScript, chạy trực tiếp bằng Node, không cần bước build
- [zca-js](https://github.com/RFS-ADRENO/zca-js), một client không chính thức cho Zalo Web API
- [matrix-appservice-bridge](https://github.com/matrix-org/matrix-appservice-bridge) cho phía Matrix
- [bbctl](https://github.com/beeper/bridge-manager) (Beeper Bridge Manager), kết nối bridge tự host với máy chủ Beeper
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) để lưu ánh xạ giữa id Zalo và id Matrix

## Bạn nhận được gì

- **Bridge trực tiếp hai chiều.** Tin nhắn, media, biểu cảm, trả lời, nhắc tên, đã xem và đang soạn tin. Xem [Tính năng](./features).
- **Tin nhắn bạn gửi từ điện thoại cũng hiện trong Beeper**, ở phía của bạn trong cuộc trò chuyện (double-puppeting).
- **Tên và ảnh đại diện thật** cho mọi liên hệ Zalo, dưới dạng ghost user của Matrix.
- **Công cụ nhập lịch sử** chuyển toàn bộ lịch sử Zalo vào Beeper từ Zalo PC và file sao lưu mã hoá của nó. Xem [Nhập lịch sử](../history-import/).
- **Lấy lại tin nhắn sau khi gián đoạn.** Zalo không gửi lại những gì đến khi bridge offline, nên bridge tự lấy khoảng trống đó sau mỗi lần kết nối lại.

## Không phải là gì

- **Không chính thức.** Không có API chính thức cho nhắn tin Zalo cá nhân. zca-js dịch ngược Zalo Web, vi phạm điều khoản sử dụng của Zalo. Zalo có thể khoá hoặc cấm tài khoản bị nghi ngờ. Hãy dùng tài khoản phụ nếu không muốn đánh cược tài khoản chính.
- **Không hỗ trợ nhiều người dùng.** Một bridge phục vụ một người dùng Beeper (`owner` trong config) và một tài khoản Zalo tại một thời điểm. Để bridge tài khoản Zalo thứ hai, hãy chạy một bridge thứ hai. Xem [Nhiều tài khoản](./multiple-accounts).
- **Không hỗ trợ backfill tin nhắn cũ.** Zalo Web không đọc được tin nhắn từ trước lúc phiên bắt đầu. Hãy dùng [công cụ nhập lịch sử](../history-import/) cho các chat cũ.
- **Không có mã hoá đầu cuối.** Chat Zalo đã bật E2EE không giải mã được. Bridge đăng một thông báo thay vào đó.

## Các mảnh ghép ăn khớp thế nào

```
Zalo servers ──(zca-js websocket)──► bridge (appservice, port 29350)
                                           │
                                     bbctl proxy ──(websocket)──► Beeper ──► your Beeper apps
```

Bridge lắng nghe trên một cổng local. `bbctl proxy` mở một websocket đi ra Beeper và chuyển tiếp traffic appservice của Beeper vào cổng đó, nên không cổng nào cần mở ra internet. Xem [Cách hoạt động](./how-it-works) và [Kiến trúc](../reference/architecture) để biết chi tiết.

## Bước tiếp theo

- [Bắt đầu](./getting-started): cài đặt, đăng ký với Beeper, đăng nhập Zalo.
- [Triển khai bằng container](../deployment/container): cách khuyên dùng để chạy 24/7.
- [Xử lý sự cố](../troubleshooting): khi có gì đó không đến nơi.
