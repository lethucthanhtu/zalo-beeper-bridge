# Bảo mật và riêng tư

## Dữ liệu của bạn đi đâu

Bridge chạy hoàn toàn trên máy của chính bạn. Nội dung tin nhắn chỉ được gửi tới Zalo và tới tài khoản Beeper của bạn. Không có telemetry và không có dịch vụ bên thứ ba nào khác.

## Mã hoá

Với `encryption.enabled`, các portal được mã hoá end-to-bridge: tin nhắn được mã hoá giữa các thiết bị Beeper của bạn và crypto device của bot bridge, nên máy chủ Beeper chỉ lưu ciphertext. Bản thân bridge giải mã chúng để nói chuyện với Zalo, và Zalo lưu tin nhắn theo cách riêng của nó, nên việc này không khiến chat được mã hoá đầu cuối (end-to-end) với người kia. Hãy giữ thư mục `crypto/` cùng với các bản sao lưu: nó chứa khoá của bot, và nếu thiếu nó bot sẽ bắt đầu lại như một thiết bị mới.

## Rủi ro với tài khoản Zalo {#risk-to-your-zalo-account}

Bridge dùng [zca-js](https://github.com/RFS-ADRENO/zca-js), một client **không chính thức** của giao thức Zalo Web. Zalo không hỗ trợ client bên thứ ba và có thể khoá hoặc cấm tài khoản dùng chúng. Bridge giảm rủi ro nhưng không loại bỏ được hoàn toàn:

- Tin nhắn gửi đi qua bộ giới hạn tốc độ token bucket (mặc định burst 30, sau đó 60 tin mỗi phút; xem [Cấu hình](./guide/configuration)).
- Bridge giữ phiên Zalo Web duy nhất của tài khoản. Đừng dùng Zalo Web trên trình duyệt cùng lúc: Zalo chỉ cho phép một listener web, nên bridge và trình duyệt sẽ liên tục đá nhau ra.
- Lệnh `sync` và việc cập nhật hồ sơ ghost được điều tiết tốc độ; nếu Zalo từ chối một lượt tra cứu hồ sơ, bridge sẽ chờ một giờ trước khi thử lại.

Chỉ dùng bridge với một tài khoản mà bạn chấp nhận được việc mất quyền truy cập một thời gian.

## Bí mật trên đĩa

| Gì                                    | Ở đâu                                           | Bảo vệ                                                     |
| ------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------- |
| Phiên Zalo (cookie, IMEI, user agent) | `zalo-creds.session.json`                       | AES-256-GCM; khoá nằm trong một file `0600` riêng bên cạnh |
| Token appservice                      | `registration.yaml`                             | Quyền file                                                 |
| Đăng nhập Beeper của `bbctl`          | `bbctl-config.json` / `/data/bbctl/config.json` | Quyền file (`0600` trong container)                        |
| Id phòng, ghost và tin nhắn           | `bridge.db`                                     | Quyền file                                                 |
| Khoá crypto và device token của bot   | `crypto/`, `crypto-import/`                     | Quyền file (thư mục `0700`, file thiết bị `0600`)          |

Tất cả đều nằm trong gitignore. Đừng bao giờ commit hay chia sẻ chúng, và hãy mã hoá mọi bản sao lưu của data volume. Bất kỳ ai có cả file phiên **lẫn** khoá của nó đều dùng được tài khoản Zalo của bạn.

Nếu một trong số chúng bị rò rỉ:

1. Đăng ký lại bridge (`bbctl register`) để lấy token appservice mới.
2. Gửi `logout` rồi `login` cho bot để lấy phiên Zalo mới.
3. Đăng xuất Beeper trên thiết bị đó rồi đăng nhập lại để xoay vòng đăng nhập `bbctl`.

## Phơi nhiễm mạng

- Appservice lắng nghe trên cổng `29350` tại loopback interface bên trong container. `bbctl proxy` kết nối ra ngoài tới Beeper, nên không cổng nào cần được publish. Đừng publish nó.
- Media chỉ được tải qua HTTPS từ các host CDN của Zalo (`zdn.vn`, `zadn.vn`, và CDN video/file `dlmd.me` / `mdchat.me`, `dlfl.vn` / `flchat.vn`). Host được kiểm tra lại ở mỗi lần chuyển hướng (redirect).

## Ai điều khiển được bridge

Chỉ owner đặt trong `config.yaml` (`matrix.owner`) mới dùng được lệnh của bot; mọi người khác bị bỏ qua. Chỉ tin nhắn của owner trong phòng portal mới được gửi sang Zalo.

## Log

Log mang id, số đếm, trạng thái và hostname. Chúng không bao giờ chứa văn bản tin nhắn hay link media đã ký. Xem [Log](./reference/logs).

## Nhập lịch sử {#history-import}

Nhập lịch sử đọc toàn bộ lịch sử tin nhắn của bạn, nên hãy coi mọi thứ nó tạo ra là riêng tư:

- **Cổng debug.** Cổng debug của Zalo PC chỉ lắng nghe trên `127.0.0.1`, nhưng trong lúc nó mở, **bất kỳ chương trình local nào cũng đọc được tin nhắn của bạn** qua đó. Hãy khởi động lại Zalo PC bình thường khi xong việc.
- **Khoá sao lưu.** Khoá mà `get-uin.mjs` in ra giải mã được mọi file sao lưu của tài khoản. Hãy giữ nó trong một file riêng tư và xoá sau khi dùng.
- **File làm việc.** Bản export, file sao lưu đã giải nén và media đã chuẩn bị chứa lịch sử và media của bạn ở dạng văn bản rõ. Khi nhập xong, hãy xoá `work/` trên máy host và các thư mục nhập trong container:

  ```bash
  rm -rf work/
  podman exec zalo-beeper-bridge rm -rf /data/import-export /data/import-media
  ```

## Dependencies

`npm audit` (2026-10-28, matrix-appservice-bridge 12.0.1) báo cáo 6 phát hiện. Không cái nào có thể khai thác được từ bridge này và không cái nào có bản vá upstream:

- `ip-address` (qua `ip-cidr`) chỉ được dùng bởi provisioning API của matrix-appservice-bridge, tính năng mà bridge không bật.
- `deepmerge` (qua `html-to-text`) chỉ được dùng bởi `sendHtmlText` / `replyHtmlText` của matrix-bot-sdk, các hàm mà bridge không gọi.

Chúng được kiểm tra lại sau khi nâng cấp một trong hai package.

## Báo cáo lỗ hổng

Vui lòng đừng mở issue công khai. Hãy báo cáo riêng tư qua GitHub: **Security → Report a vulnerability** ([tạo advisory mới](https://github.com/lethucthanhtu/zalo-beeper-bridge/security/advisories/new)). Xem [SECURITY.md](https://github.com/lethucthanhtu/zalo-beeper-bridge/blob/main/SECURITY.md) để biết phạm vi và thời gian phản hồi.
