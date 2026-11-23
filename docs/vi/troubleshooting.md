# Xử lý sự cố

Bắt đầu với các bước kiểm tra nhanh sau:

::: code-group

```bash [Container]
podman ps --filter name=zalo-beeper-bridge   # STATUS should show (healthy)
podman logs --since 1h zalo-beeper-bridge
```

```bash [macOS launchd]
launchctl list | grep beeper-zalo            # both jobs should show exit code 0
tail -f ~/zalo-beeper-bridge/logs/bridge.log
```

:::

Sau đó gửi `status` cho bot trong Beeper: nó cho biết Zalo đã đăng nhập chưa và trạng thái listener. [Tham khảo log](./reference/logs) giải thích từng dòng log.

## Tin nhắn ngừng chạy / listener không kết nối {#messages-stop-flowing-listener-not-connected}

Log hiển thị `listener reconnecting` hoặc `listener DEAD`.

- **Bạn đã mở Zalo Web trong trình duyệt.** Zalo chỉ cho phép một phiên web, và trình duyệt đã đá bridge ra. Hãy đóng Zalo Web và listener sẽ tự kết nối lại (backoff tối đa 5 phút). Dùng app điện thoại và Zalo PC song song với bridge thì không sao; Zalo Web thì không.
- **Mất mạng.** Bridge tiếp tục thử lại, tối đa 5 phút một lần, cho đến khi có mạng trở lại. Không cần làm gì.
- **Phiên đã hết hạn, hoặc log hiển thị `[zalo] listener DEAD`.** Phiên không dùng được nữa. Hãy gửi `login` cho bot và quét lại mã QR.

## Tài khoản bị khoá hoặc gửi tin liên tục thất bại

Nếu Zalo hạn chế hoặc khoá tài khoản, việc gửi sẽ thất bại và log hiển thị lỗi lặp đi lặp lại. Hãy dừng bridge (`podman compose stop`, hoặc `launchctl unload …` trên macOS). Sau đó mở Zalo trên điện thoại và xử lý mọi yêu cầu bảo mật trước khi khởi động lại bridge. Nếu lại xảy ra, hãy giảm `zalo.messagesPerMinute` và `zalo.burst` trong `config.yaml` (xem [Cấu hình](./guide/configuration)).

## Bridge không khởi động

- **Container:** `podman ps -a` cho thấy container đã thoát hoặc đang restart liên tục. `podman logs zalo-beeper-bridge` cho biết lý do.
- **macOS launchd:** `launchctl list | grep beeper-zalo` hiển thị exit code khác 0. `logs/bridge.log` chứa stack trace.

Các nguyên nhân thường gặp:

- `config.yaml` bị thiếu hoặc không hợp lệ. Lỗi sẽ nêu tên trường sai. Hãy sao chép `config.yaml.example` và so sánh.
- Thiếu `registration.yaml`. Chạy `bbctl register sh-zalo`.
- Chỉ với launchd: đường dẫn Node trong plist sai, ví dụ sau khi nâng cấp nvm.
- Một bridge hoặc `bbctl proxy` khác đang chạy với cùng registration.

## Beeper Desktop hiện mạng Zalo nhưng không có chat {#beeper-desktop-shows-the-zalo-network-but-no-chats}

Beeper ẩn mọi chat của một bridge nếu thiếu remote-account state của nó, kể cả khi bridge hiển thị là đang chạy.

- Kiểm tra bên trong container: `podman exec zalo-beeper-bridge sh -c 'bbctl -c "$BBCTL_CONFIG" whoami --raw' | grep -A3 remoteState`. Bình thường sẽ có một mục cho Zalo uid của bạn với `"state_event": "CONNECTED"`.
- Việc `bbctl proxy` kết nối lại có thể xoá state đó. Điều này xảy ra ở mỗi lần khởi động lại và khoảng mỗi giờ một lần. Bridge gửi lại nó mỗi phút, nên các chat quay lại trong vòng một phút. Nếu chúng vẫn không quay lại sau đó, hãy tìm `[beeper] remote state … rejected` hoặc `failed` trong log.
- `BAD_CREDENTIALS` hoặc `LOGGED_OUT`: phiên Zalo đã kết thúc hoặc bạn đã gửi `logout`. Hãy gửi `login` cho bot.

## Thiếu tin nhắn sau khi PC ngủ hoặc container ngừng hoạt động {#messages-missing-after-the-pc-slept-or-the-container-was-down}

Zalo không gửi lại các tin nhắn bị lỡ, nên bridge tự lấy chúng sau mỗi lần kết nối lại. Hãy tìm `[zalo] listener connected` theo sau là `[sync] catch-up user: N page(s)`, `[sync] catch-up group: N page(s)` và `[sync] catch-up: N missed message(s) to bridge`.

- `(stopped at the page limit)`: hơn khoảng 500 tin nhắn cùng loại đã đến khi bridge tạm dừng, và những tin mới nhất trong số đó không được lấy về. Hãy khởi động lại bridge để chạy thêm một lần lấy lại từ điểm đó.
- Không có dòng catch-up: listener chưa thực sự kết nối lại (khoá phiên không bao giờ đến). Hãy khởi động lại bridge.
- Việc lấy lại bị bỏ qua trong lúc `sync` đang chạy, vì cả hai đọc cùng một luồng dữ liệu.

## Ảnh / media không gửi được

- Chat hiển thị thông báo `⚠ Failed to send <type> to Zalo: <reason>` kèm lỗi của Zalo.
- Media lớn hơn `bridge.mediaMaxBytes` (mặc định 10 MB) bị từ chối. Hãy tăng giới hạn hoặc gửi file nhỏ hơn.
- Tin nhắn thoại được gửi tới Zalo dưới dạng voice message. AAC (Beeper iOS) được gửi nguyên trạng. Các codec khác (ogg/opus từ Beeper Android) được mã hoá lại sang AAC bằng `ffmpeg`. Nếu một voice note vẫn đến dưới dạng file, log có `[audio] voice transcode to AAC failed: …`. Nguyên nhân thường gặp là `ffmpeg` không có trong PATH khi bridge chạy ngoài container.
- **Lỗi đã biết (đang mở):** voice note gửi từ Beeper phát được trong Zalo PC nhưng không phát được trong app Zalo iOS/Android, nơi hiện "chưa có trên cloud". Bridge tải lên endpoint voice của Zalo (`/api/{message|group}/voice/upload`, endpoint mà Zalo PC dùng). Máy chủ chấp nhận bản tải lên và trả về một `fileId`, nhưng không có control `file_done` nào kèm các URL `aac`/`amr` đến được bridge, nên sau 60 giây nó chuyển sang CDN file. Khi đó log hiển thị `voice upload response fields: finished,clientFileId,chunkId,fileId` theo sau là `native voice upload failed, sending via the file CDN: voice upload timed out after 60s`.

## Thông báo `[Zalo video / file could not be bridged: …]`

Thông báo này giữ lại link Zalo. Dòng log `[media] download from <host> failed: <reason>` cho biết lý do:

- `refusing media host outside Zalo CDN (<host>)`: Zalo đã chuyển media sang một domain CDN mới. Kiểm tra chuỗi redirect bằng `curl -sI <link>`. Nếu domain mới thuộc về Zalo, hãy thêm nó vào `ALLOWED_HOST_SUFFIXES` trong `src/bridge/media-handler.ts`. Vào 2026-10, Zalo đã chuyển `dlmd.me` sang `mdchat.me` và `dlfl.vn` sang `flchat.vn`.
- `HTTP 403/404` hoặc `error page`: link đã hết hạn. Link CDN Zalo tồn tại khoảng 14 ngày.
- `media exceeds size cap`: video và file bị giới hạn ở 100 MB, ảnh ở `bridge.mediaMaxBytes`.
- Timeout: video và file có 180 giây, ảnh có 30 giây.

## Ảnh bị treo ở trạng thái "đang tải" trong Beeper (chủ yếu là ảnh cũ)

Đây không phải lỗi của bridge, vì bridge đã tải chúng lên bình thường. Beeper phục vụ media bằng cách chuyển hướng tới object storage: các bản tải lên gần đây tới Cloudflare R2, bản cũ hơn tới Wasabi S3 (`s3.eu-central-1.wasabisys.com`). Từ một số mạng (đã gặp trên VNPT, Việt Nam) đường đi tới Wasabi bị mất gói tin. Khi đó TLS mất 1–15 giây hoặc hết thời gian chờ, và client cứ quay mãi.

- Xác nhận: mở Beeper trên một mạng khác (4G, Cloudflare WARP hoặc VPN). Khi đó các ảnh cũ sẽ tải được.
- Đo: `curl -s -o /dev/null -w '%{time_appconnect}s\n' https://s3.eu-central-1.wasabisys.com/`. Kết quả bình thường là thấp hơn 1 giây khá nhiều.
- Khắc phục: chỉ Beeper mới thay đổi được nơi lưu media. Hãy báo "media redirect to Wasabi eu-central-1 times out from &lt;ISP/country&gt;" cho bộ phận hỗ trợ Beeper. Những ảnh đã tải được một lần sẽ được cache trong client.

## `[Zalo message type not supported by bridge: <type>]` {#unknown-zalo-message-type}

Log có `[bridge] unsupported Zalo msgType <type> (content keys: …)` chỉ kèm **tên** các trường của payload. Vui lòng [mở một issue](https://github.com/lethucthanhtu/zalo-beeper-bridge/issues) kèm kiểu tin nhắn và các khoá. Để tự thêm kiểu này, xem [Thêm một kiểu tin nhắn Zalo](./contributing/development#adding-a-zalo-message-type).

## Thu hồi không đến được Zalo

Chỉ những tin nhắn **bạn gửi từ Beeper** mới thu hồi được, vì Zalo chỉ cho bạn thu hồi tin nhắn của chính mình, và chỉ trong khoảng thời gian thu hồi của Zalo. Khi bạn xoá tin nhắn của người khác, bridge đăng thông báo "Zalo only allows recalling your own messages".

## Quá ít (hoặc quá nhiều) dòng log

`logging.level` trong `config.yaml` đặt mức log của matrix-appservice-bridge (phía Matrix):

- `warn` (mặc định) giữ lại các lỗi và cảnh báo của nó.
- `info` còn log mọi HTTP request, kể cả lần kiểm tra `/health` mỗi 30 giây.
- `debug` log mọi thứ.

Các dòng `[zalo]`, `[bridge]` và `[beeper]` của chính bridge luôn được ghi. Để trace websocket, đặt `ZALO_WS_TRACE=1`.

## Huy hiệu mạng trên avatar chat là huy hiệu chung

Điều này là bình thường với bridge tự host. App Beeper chỉ vẽ huy hiệu đó cho các loại bridge mà chúng biết, và `bbctl` đăng ký bridge tự host dưới loại chung `bridgev2`. Một bridge mautrix Teams tự host cũng hiện huy hiệu y như vậy. Bridge đã đặt mọi thứ mà một bridge có thể đặt: avatar của bot và `protocol.avatar_url` trong `m.bridge`. **Tên** mạng "Zalo" đến từ những thứ đó.

## Tên mạng vẫn hiện "sh-zalo" {#network-name-still-shows-sh-zalo}

Hồ sơ bot là "Zalo" và các portal mang thương hiệu mạng. Tuy nhiên, nhãn mạng cấp cao nhất bị cố định theo tên đăng ký `bbctl`, và một appservice tuỳ chỉnh không đổi tên được nó.

## Nhập lịch sử {#history-import}

- **`Zalo main window not found`**: Zalo PC không chạy với `--remote-debugging-port=9229`, hoặc nó vẫn đang khởi động.
- **`bad tar header — wrong UIN`**: khoá không thuộc về file sao lưu này. Hãy đọc nó từ phiên Zalo PC của tài khoản đã tạo file sao lưu.
- **Một chat kết thúc với `FAIL`**: phòng cũ của nó không bị động đến, và mọi phòng dựng dở đều tự động bị xoá. Kiểm tra `run.log` rồi chạy lại script. Script bỏ qua các chat đã hoàn tất OK.
- **`Beeper asked to slow down (ENHANCE_YOUR_CALM), retry N in Ns`**: Beeper đã ngắt một request vì công cụ nhập gửi quá nhiều, quá nhanh. Công cụ nhập chờ 30 giây, rồi 1, 2 và 4 phút, và gửi lại đúng request đó; chat chỉ thất bại khi lần thử thứ năm cũng bị ngắt. Nếu vậy, hãy để Beeper nghỉ 30–60 phút rồi mới chạy lại, và mỗi lần chỉ chạy một tiến trình nhập.
- **`WARNING … live message(s) could not be carried over`**: không đọc được sự kiện Matrix của một tin nhắn chỉ có ở bridge trực tiếp. Trong trường hợp đó phòng cũ không bị xoá.
- **Ảnh hoặc video hiện thành dòng văn bản**: bản trên CDN đã hết hạn và file sao lưu không có bản sao, nên không còn nơi nào giữ file nữa.

Xem [Nhập lịch sử](./history-import/) để biết toàn bộ quy trình.

## Rollback một lần triển khai

Xem [Vận hành → Rollback](./deployment/operations#rollback).
