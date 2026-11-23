# Bắt đầu

Trang này đưa bạn từ con số không đến một bridge hoạt động được. Mất khoảng 15 phút.

::: tip Khuyên dùng: chạy trong container
Để có một bridge chạy 24/7, hãy làm theo [Triển khai bằng container](../deployment/container) sau bước 2. Container chạy cả hai tiến trình giúp bạn, giữ trạng thái trên volume và tự khởi động lại khi lỗi. Các bước dưới đây cho thấy cách cài Node thuần, cũng là cách dùng để phát triển.
:::

## Yêu cầu

- macOS hoặc Linux. Trên Windows, dùng [container](../deployment/container) với Docker hoặc Podman.
- [Node.js](https://nodejs.org/) **22.18 trở lên**. Node chạy trực tiếp mã nguồn TypeScript, nên không cần bước build. Image container đi kèm Node 24.
- Một tài khoản [Beeper](https://www.beeper.com/) và [bbctl](https://github.com/beeper/bridge-manager).
- `ffmpeg`, dùng để mã hoá lại tin nhắn thoại gửi từ Beeper. bbctl cũng cần Python 3.
- Một tài khoản Zalo mà bạn đăng nhập được bằng cách quét mã QR bằng app Zalo trên điện thoại.

::: danger Rủi ro tài khoản
zca-js dịch ngược Zalo Web. Zalo có thể khoá hoặc cấm tài khoản dùng nó. Hãy cân nhắc dùng tài khoản phụ.
:::

## 1. Cài bbctl và đăng ký bridge

```bash
# Cài bbctl (ví dụ macOS arm64; chọn bản phù hợp nền tảng của bạn từ trang releases)
curl -sL -o ~/.local/bin/bbctl \
  https://github.com/beeper/bridge-manager/releases/latest/download/bbctl-macos-arm64
chmod +x ~/.local/bin/bbctl

bbctl login                                # đăng nhập vào tài khoản Beeper của bạn
bbctl register -o registration.yaml sh-zalo
```

`sh-zalo` là tên bridge. Beeper suy ra mọi thứ khác từ đó: bot là `@sh-zalobot:beeper.local` và liên hệ Zalo thành ghost tên `@sh-zalo_<zalo uid>:beeper.local`. Bridge đọc các tên này từ `registration.yaml`, nên một tên khác cũng dùng được.

Mở `registration.yaml` vừa tạo và đặt `url` thành cổng mà bridge sẽ lắng nghe:

```yaml
url: http://localhost:29350
```

::: warning Giữ các file này riêng tư
`registration.yaml` chứa token của appservice. Đừng bao giờ commit hay chia sẻ nó. File này đã có sẵn trong `.gitignore`.
:::

## 2. Cấu hình bridge

```bash
git clone https://github.com/lethucthanhtu/zalo-beeper-bridge.git
cd zalo-beeper-bridge
npm ci
cp config.yaml.example config.yaml
```

Điền vào `config.yaml` các giá trị mà `bbctl register` đã in ra:

```yaml
matrix:
  homeserverUrl: https://matrix.beeper.com/_hungryserv/<your-beeper-username>
  domain: beeper.local
  registrationPath: registration.yaml
  port: 29350 # phải khớp với cổng trong url của registration.yaml
  owner: '@<your-beeper-username>:beeper.com' # người dùng duy nhất được phép gửi lệnh cho bot
```

Các phần khác là tuỳ chọn. [Cấu hình](./configuration) liệt kê mọi tuỳ chọn.

## 3. Chạy bridge và proxy

Appservice và `bbctl proxy` phải chạy cùng lúc. Dùng hai terminal hoặc một process manager:

```bash
npm run dev                         # appservice tại localhost:29350
bbctl proxy -r registration.yaml    # kết nối Beeper với appservice qua websocket
```

Khởi động thành công sẽ log `Appservice listening on localhost:29350` và, ở lần chạy đầu tiên, `[zalo] no valid saved credentials — send 'login'`.

::: warning Một instance cho mỗi registration
Đừng bao giờ chạy hai bridge hoặc hai proxy với cùng một registration (ví dụ `npm run dev` trong khi một container đang chạy). Instance thứ hai sẽ đá instance đầu tiên ra, và hai listener Zalo cứ đá nhau liên tục.
:::

## 4. Đăng nhập Zalo

1. Trong Beeper, mở chat với `@sh-zalobot:beeper.local`. Bot sẽ vào khi bạn mời và trả lời bằng danh sách lệnh của nó.
2. Gửi `login`.
3. Bot đăng một mã QR. Quét nó bằng app Zalo trên điện thoại và xác nhận đăng nhập ở đó.
4. Bot trả lời `✓ Logged in to Zalo (uid …), listener started.`

Bây giờ hãy nhắn tin cho tài khoản từ một người dùng Zalo khác: chat sẽ hiện trong Beeper. Phiên được lưu ở dạng mã hoá, nên khởi động lại sẽ tự đăng nhập lại mà không cần quét QR mới.

## 5. Tạo phòng cho các chat đã có

Phòng mới được tạo tự động khi có tin nhắn đến. Để tạo phòng cho các chat được ghim và mọi nhóm ngay lập tức, hãy gửi `sync` cho bot. Xem [Lệnh của bot](./bot-commands#sync).

::: info Chỉ một phiên Zalo Web
Zalo chỉ cho phép một phiên web cho mỗi tài khoản. Nếu bạn mở Zalo Web trên trình duyệt trong khi bridge đang chạy, bridge sẽ bị đá ra. Bạn vẫn dùng được app điện thoại và Zalo PC bình thường.
:::

## Bước tiếp theo

- Chạy 24/7: [Container](../deployment/container) hoặc [macOS launchd](../deployment/macos-launchd).
- Chuyển các tin nhắn cũ sang: [Nhập lịch sử](../history-import/).
- Tìm hiểu những gì được bridge và những gì không: [Tính năng](./features).
