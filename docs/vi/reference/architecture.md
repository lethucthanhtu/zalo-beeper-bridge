# Kiến trúc

Bridge là một tiến trình Node.js duy nhất viết bằng TypeScript (Node 22.18+ chạy trực tiếp, không có bước build). Đây là một Matrix **application service**: máy chủ của Beeper gửi cho nó các sự kiện của những phòng thuộc về nó, và nó hoạt động trong Matrix với vai trò một bot, một ghost cho mỗi contact Zalo, và chính bạn.

[![Tổng quan kiến trúc: máy chủ Zalo và Zalo CDN giao tiếp với ZaloClient, nơi cấp dữ liệu cho bridge core, appservice và bbctl proxy bên trong một container, kết nối với Beeper. Công cụ nhập lịch sử đọc bản export của Zalo PC và ghi vào Beeper và bridge.db.](/images/architecture.svg)](/images/architecture.svg)

_Nhấp vào sơ đồ để mở ở kích thước đầy đủ._

`bbctl proxy` giữ websocket tới Beeper và chuyển tiếp lưu lượng appservice tới cổng HTTP local của bridge, nên bridge không cần địa chỉ công khai.

## Các tầng

### `src/zalo/`: phía Zalo

[zca-js](https://github.com/RFS-ADRENO/zca-js) nói chuyện bằng giao thức của Zalo Web. Chỉ `zalo-client.ts` import nó, nên việc nâng cấp hay thay thế zca-js chỉ động tới một file.

| Module                | Vai trò                                                                                               |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `zalo-client.ts`      | Facade bọc zca-js: vòng đời đăng nhập, listener, chuẩn hoá dữ liệu, gửi có giới hạn tốc độ            |
| `listener-manager.ts` | Kết nối lại listener với exponential backoff; chuyển sang trạng thái "dead" khi phiên đã kết thúc     |
| `frame-tap.ts`        | Tap các frame websocket; chuyển hướng các push DM E2EE mới hơn của Zalo (cmd 551) sang trình xử lý DM |
| `event-normalizer.ts` | Payload thô của zca-js → `ZaloMessage`. Mọi điểm kỳ quặc của payload đều nằm ở đây                    |
| `types.ts`            | Mô hình sự kiện đã chuẩn hoá, là các hình dạng duy nhất mà tầng bridge nhìn thấy                      |
| `credential-store.ts` | Lưu phiên đã mã hoá bằng AES-256-GCM; khoá nằm trong một file `0600` riêng                            |
| `rate-limiter.ts`     | Token bucket cho tin nhắn gửi đi: burst đi qua ngay, gửi liên tục thì được điều tiết nhịp độ          |
| `reaction-map.ts`     | Emoji Unicode ↔ mã reaction của Zalo                                                                  |
| `call-message.ts`     | Dựng các bong bóng log cuộc gọi                                                                       |

### `src/bridge/`: phần chuyển đổi

| Module                | Vai trò                                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `inbound-handler.ts`  | Tin nhắn Zalo → chống trùng → ghost → portal → sự kiện Matrix. Mỗi chat một promise chain để giữ đúng thứ tự           |
| `outbound-handler.ts` | Sự kiện Beeper của bạn → Zalo: văn bản, trả lời, chỉnh sửa, media, reaction, thu hồi                                   |
| `presence-handler.ts` | Đã xem, đang soạn tin và reaction theo cả hai chiều                                                                    |
| `portal-manager.ts`   | Tạo một phòng Matrix cho mỗi chat Zalo ở tin nhắn đầu tiên; việc tạo được tuần tự hoá theo từng chat                   |
| `puppet-registry.ts`  | Zalo uid → ghost `@sh-zalo_<uid>`, kèm đồng bộ tên và avatar                                                           |
| `mapping-store.ts`    | Kho SQLite, xem [Schema cơ sở dữ liệu](./database)                                                                     |
| `echo-suppressor.ts`  | Nhận ra bản echo của chính các tin bạn gửi để chúng không bị đăng hai lần                                              |
| `media-handler.ts`    | Tải có kiểm soát từ Zalo CDN; tải có xác thực media Matrix cho các lần gửi đi                                          |
| `media-content.ts`    | Dựng `m.image` / `m.video` / `m.file` / `m.audio` / `m.sticker` và link preview, cho cả tin nhắn trực tiếp lẫn đã nhập |
| `animated-sticker.ts` | Mã hoá sticker Zalo cổ điển từ sprite strip thành WebP động                                                            |
| `audio-remux.ts`      | Bọc voice note AAC ADTS thô của Zalo trong một container mà mọi trình phát đều hiểu                                    |
| `mentions.ts`         | @nhắc tên hai chiều (Zalo uid + vị trí ↔ pill của Matrix)                                                              |
| `sync-manager.ts`     | Lệnh `sync` và catch-up sau mỗi lần kết nối lại                                                                        |
| `owner-intent.ts`     | Hành động với tư cách bạn (double-puppeting)                                                                           |
| `history-import.ts`   | Dòng export của Zalo PC → nội dung Matrix, dành cho công cụ nhập                                                       |

### `src/matrix/`: phía Beeper

| Module                   | Vai trò                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `appservice.ts`          | Thiết lập `matrix-appservice-bridge` và định tuyến sự kiện        |
| `bot-commands.ts`        | Các [lệnh của bot](../guide/bot-commands), chỉ chấp nhận từ owner |
| `beeper-bridge-state.ts` | Đăng remote-account state mà Beeper cần để hiển thị mạng          |
| `network-branding.ts`    | Tên mạng "Zalo" và logo trên bot cùng mọi portal                  |

### Khác

- `src/index.ts`: điểm vào, nối mọi thứ lại với nhau.
- `src/config.ts`: nạp và kiểm tra `config.yaml` bằng Zod (xem [Cấu hình](../guide/configuration)).
- `src/tools/import-zalo-export.ts`: [công cụ nhập lịch sử](../history-import/importer-cli).
- `scripts/zalo-pc/`: các công cụ phía host đọc Zalo PC và các bản sao lưu của nó.

## Khởi động

1. Nạp và kiểm tra config cùng registration. Thiếu giá trị sẽ dừng tiến trình kèm thông báo rõ ràng.
2. Mở cơ sở dữ liệu và chạy [migration](./database#migrations).
3. Khởi động appservice. Nó phải lắng nghe **trước** khi Zalo listener bắt đầu, vì Zalo phát lại các tin nhắn gần đây ngay sau khi kết nối.
4. Đặt danh tính mạng của bot, thêm branding cho các portal cũ hơn, xoá các portal bị lỗi cấu trúc và cho bạn tham gia vào những portal còn ở trạng thái "invite".
5. Đăng nhập Zalo bằng phiên đã lưu. Nếu chưa có phiên, bridge chờ lệnh `login`.
6. Khởi động listener. Ở mỗi lần kết nối lại, bridge đăng account state, chạy catch-up và, mỗi tiến trình một lần, sửa các ghost thiếu tên hoặc avatar.

## Luồng tin nhắn

**Zalo → Beeper.** Listener chuyển giao một tin nhắn thô; `event-normalizer` biến nó thành `ZaloMessage`. `inbound-handler` loại bỏ bản trùng (theo Zalo message id), tìm hoặc tạo ghost và portal, dựng nội dung, gửi dưới danh nghĩa ghost và lưu ánh xạ. Những tin nhắn bạn gửi từ app Zalo được đăng với tư cách **bạn**, nên chúng xuất hiện ở phía của bạn trong chat.

**Beeper → Zalo.** Sự kiện trong một phòng portal đi tới `outbound-handler`; sự kiện ở các phòng khác đi tới các lệnh của bot. Trình xử lý bỏ qua những sự kiện do chính bridge đăng, gửi tới Zalo qua rate limiter và lưu ánh xạ. Khi Zalo echo tin nhắn quay lại listener, `echo-suppressor` khớp nó (theo message id, có dự phòng theo nội dung) và loại bỏ.

## Ghi chú thiết kế

- **Mapping store.** Mỗi tin nhắn được bridge đều được khoá theo Zalo message id của nó. Client message id, dữ liệu trích dẫn, hướng và người gửi cũng được lưu, vì Zalo cần chúng cho reaction, thu hồi và read receipt.
- **Account state.** Beeper chỉ liệt kê các chat của một bridge khi remote-account state của nó đang được đăng. Bridge đăng nó ở mỗi thay đổi của listener (`CONNECTED`, `TRANSIENT_DISCONNECT`, `BAD_CREDENTIALS`, `LOGGED_OUT`) và lại đăng mỗi phút, vì việc `bbctl proxy` kết nối lại có thể xoá nó. `bbctl whoami --raw` hiển thị nó dưới `remoteState`.
- **Network branding.** Hồ sơ bot (`com.beeper.bridge.*`) và state `m.bridge` / `uk.half-shot.bridge` của từng portal (khoá `<domain>/<registration id>`, kèm `com.beeper.room_type.v2` và `fi.mau.receiver`) khiến Beeper xếp các chat dưới một mạng tên "Zalo". Huy hiệu nhỏ trên avatar chat vẫn là huy hiệu chung: Beeper chỉ vẽ nó cho các loại bridge mà nó biết, và bridge tự host đăng ký dưới loại chung `bridgev2`.
- **Provisioning probe.** Ở mỗi lần proxy kết nối, Beeper hỏi `/_matrix/provision/v3/capabilities`. Bridge trả lời rằng nó không cung cấp tính năng bắt đầu chat hay tạo nhóm. Các đường dẫn khác được log dưới dạng `[appservice] unhandled …`.
- **Double-puppeting.** Trên máy chủ đơn người dùng (single-tenant) của Beeper, token appservice có thể hành động thay owner, nhờ đó các tin nhắn và reaction Zalo của chính bạn hiện ra như của bạn.
- **Nền tảng cho nhiều tài khoản.** Từ schema v7, mỗi portal và mỗi tin nhắn đều ghi lại tài khoản Zalo mà nó thuộc về, và portal mang nó dưới dạng `fi.mau.receiver`. Một bridge vẫn chỉ phục vụ một tài khoản tại một thời điểm (xem [Nhiều tài khoản](../guide/multiple-accounts)).
- **Riêng tư trong log.** Log chứa id và số đếm, không bao giờ chứa nội dung tin nhắn (xem [Log](./logs)).
