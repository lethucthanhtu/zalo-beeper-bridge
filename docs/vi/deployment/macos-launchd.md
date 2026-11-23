# macOS (launchd)

Bridge chạy dưới dạng hai launchd user agent để nó tự khởi động khi đăng nhập, tự chạy lại khi crash và vẫn sống khi bạn đóng terminal:

- `dev.beeper-zalo.bridge` — appservice (`node src/index.ts`)
- `dev.beeper-zalo.proxy` — `bbctl proxy` (websocket Beeper ⇄ cổng local 29350)

Cả hai **phải** chạy cùng nhau. Bridge chỉ hỗ trợ một người dùng và một listener duy nhất: đừng bao giờ chạy một bản thứ hai (ví dụ `npm run dev`) khi các agent đang nạp, nếu không hai listener Zalo sẽ liên tục đá nhau ra.

## Cài đặt

Các plist mẫu nằm trong `deploy/launchd/`. Chúng dùng đường dẫn tuyệt đối (launchd có môi trường tối thiểu): hãy thay `YOUR_USER`, đường dẫn repo và phiên bản Node (`vXX`, xem `which node`) trước khi cài, và thay lại nếu bạn chuyển repo hoặc đổi phiên bản Node.

```bash
cp deploy/launchd/dev.beeper-zalo.bridge.plist ~/Library/LaunchAgents/
cp deploy/launchd/dev.beeper-zalo.proxy.plist  ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/dev.beeper-zalo.bridge.plist
launchctl load ~/Library/LaunchAgents/dev.beeper-zalo.proxy.plist
```

## Giữ Mac luôn thức khi cắm điện

Bridge chỉ hoạt động khi Mac đang bật và không ngủ. Hãy tắt chế độ ngủ khi cắm điện (cần sudo, tự bạn chạy lệnh):

```bash
sudo pmset -c sleep 0        # never sleep on AC power
```

## Quản lý

```bash
# status (PID + last exit code; exit 0 = healthy)
launchctl list | grep beeper-zalo

# live logs
tail -f ~/zalo-beeper-bridge/logs/bridge.log   # paths set in the plists
tail -f ~/zalo-beeper-bridge/logs/proxy.log

# restart after a code change / config edit
launchctl kickstart -k gui/$(id -u)/dev.beeper-zalo.bridge

# stop / start
launchctl unload ~/Library/LaunchAgents/dev.beeper-zalo.bridge.plist
launchctl load   ~/Library/LaunchAgents/dev.beeper-zalo.bridge.plist
```

Sau khi sửa một file `.plist`, hãy sao chép nó vào `~/Library/LaunchAgents/` lần nữa rồi `unload` + `load` để thay đổi có hiệu lực.

## Lệnh của bot (trong chat quản lý trên Beeper)

`ping` · `status` · `login` (QR) · `logout` · `sync` (chat được ghim + mọi nhóm) · `accounts` (các tài khoản Zalo bridge này đã thấy). Xem [Lệnh của bot](../guide/bot-commands).

## Xử lý sự cố

Xem [Xử lý sự cố](../troubleshooting). Về sao lưu, nâng cấp và rollback, xem [Vận hành](./operations): các bước tương tự áp dụng, nhưng file cơ sở dữ liệu và file phiên nằm trong thư mục repo thay vì volume.
