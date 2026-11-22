# CLI của công cụ nhập

`src/tools/import-zalo-export.ts` chạy song song với bridge đang sống, dùng chung config, registration và `bridge.db`. Nó chỉ thiết lập các appservice intent: không bao giờ lắng nghe Zalo và không gọi bất kỳ API Zalo nào, nên bridge đang chạy và `bbctl proxy` không bị ảnh hưởng. Tên hiển thị lấy từ bản export.

Chạy nó bên trong container từ `/data`:

```bash
podman exec -u node -w /data zalo-beeper-bridge \
  node /app/src/tools/import-zalo-export.ts <exportDir> [options]
```

`<exportDir>` chứa mỗi chat một file `<chat key>.ndjson`, do `scripts/zalo-pc/export-cdp.mjs` ghi ra. Chat có reaction còn có thêm file kèm `<chat key>.reactions.json` (xem [Reaction](#reactions)).

## Các tuỳ chọn

| Tuỳ chọn                     | Ý nghĩa                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--only k1,k2`               | Giới hạn chỉ các chat key này. Bắt buộc với `--rebuild`.                                                                                      |
| `--dry-run [--probe]`        | In số lượng theo loại cho từng chat. `--probe` còn thử tải mọi file (không upload).                                                           |
| `--rebuild`                  | Dựng một phòng mới cho chat với toàn bộ lịch sử theo đúng thứ tự, mang theo các tin nhắn chỉ có ở bản sống, rồi trỏ chat vào đó.              |
| `--remove-old`               | Dùng cùng `--rebuild`: xác minh và kiểm toán phòng mới, sau đó xoá phòng cũ mà nó thay thế. Cần `--baseline-db`.                              |
| `--include-encrypted`        | Dùng cùng `--rebuild`: vẫn dựng lại chat có portal đã được mã hoá (xem [Phòng mã hoá](#encrypted-rooms)).                                     |
| `--carry-from !r1,!r2`       | Dùng cùng `--rebuild`: còn giữ lại các tin nhắn chỉ có ở bản sống từ những phòng cũ hơn trước đó của chat (có thể lặp lại cờ này).            |
| `--reactions-only`           | Dùng cùng `--only`: chỉ đăng các [reaction](#reactions) trong bản export vào phòng hiện tại của chat.                                         |
| `--verify`                   | Kiểm tra chỉ đọc: mọi tin nhắn đã export được ánh xạ vào phòng của chat, và mọi tin nhắn đã ánh xạ là một sự kiện thật trong timeline Beeper. |
| `--retire !old1,!old2`       | Xác minh và kiểm toán đúng một chat theo `--only`, sau đó xoá các phòng đã bị thay thế này. Cần `--baseline-db`.                              |
| `--audit !old1,!old2`        | [Kiểm toán độ đầy đủ](#completeness-audit) chỉ đọc cho một chat `--only` so với các phòng cũ này (`--audit ''`: chỉ so với baseline).         |
| `--baseline-db FILE`         | File `bridge.db` từ trước khi chuyển đổi: mọi tin nhắn chat có trong đó đều phải được giải trình.                                             |
| `--accept-missing id1,id2`   | Các id tin nhắn Zalo bạn xác nhận được phép thiếu (ví dụ đã xoá trên Zalo trước khi có kiểm toán).                                            |
| `--media-dir DIR`            | Media sao lưu đã được chuẩn bị bởi `backup-media.mjs`.                                                                                        |
| `--own-uid UID`              | Uid Zalo của bạn, để các lượt nhắc tới bạn trở thành pill cho tài khoản của bạn.                                                              |
| `--batch N` / `--delay-ms N` | Kích thước batch (mặc định `100`) và độ trễ giữa các batch (mặc định `1500` ms).                                                              |
| `--media-days N`             | Chỉ thử các link CDN sắp hết hạn cho tin nhắn mới hơn N ngày (mặc định `16`).                                                                 |

## Các chế độ

**Prepend (mặc định).** Khi không có `--rebuild`, công cụ nhập chỉ thêm vào lịch sử cũ hơn tin nhắn đầu tiên đã được bridge của phòng, theo từng khối mới nhất trước, để tin nhắn sống vẫn nằm ở dưới cùng. API batch-send của Beeper chỉ chèn được trước sự kiện cũ nhất hoặc sau sự kiện mới nhất, không bao giờ chèn ở giữa.

**Rebuild.** Dùng `--rebuild` bất cứ khi nào thiếu tin nhắn giữa các tin đã có trong Beeper. Phòng mới nhận toàn bộ lịch sử theo thứ tự cũ-trước. Những tin nhắn mà bridge đang chạy đã đăng nhưng bản export không có (Zalo PC bị lỡ, hoặc chúng đến trong lúc đang chạy) được phát lại từ các sự kiện của phòng cũ theo đúng thứ tự thời gian. Khi media của một tin nhắn không còn trong `--media-dir` lẫn trên CDN của Zalo (link đã hết hạn), công cụ nhập lấy media từ sự kiện của tin đó trong phòng cũ, tức bản bridge đã tải lên khi tin được bridge lần đầu, thay vì đăng tin dưới dạng chữ; các tin này hiện là `<kind>:old-room` trong thống kê. Nếu một lần rebuild trước đã chuyển chat sang phòng khác, sự kiện còn được tìm trong phòng mà `--baseline-db` ghi cho tin đó. Tin mà bản export ghi là thẻ liên kết nhưng phòng cũ giữ dưới dạng media (ảnh hoặc video gửi kèm link) được dựng lại thành media đó và tính là `link:old-room`. Tin nhắn mà bridge đang chạy chưa hiển thị được lúc nó đến (sự kiện của nó là thông báo "[Zalo message type not supported by bridge: …]") được dựng lại từ payload Zalo mà bridge đã lưu, nên phòng mới nhận ảnh, sticker, tệp, vị trí hoặc cuộc gọi thay cho thông báo đó; các tin này hiện là `rerendered:<kind>`. Thông báo 🔒 của tin nhắn Zalo mã hoá đầu cuối không bao giờ được dựng lại, và tin nhắn vẫn chưa hiển thị được thì giữ nguyên thông báo. Phòng cũ được giữ nguyên cho đến khi `--remove-old` (hoặc một lần `--retire` sau đó) đã xác minh và kiểm toán phòng mới.

## Phòng mã hoá {#encrypted-rooms}

Khi bật `encryption.enabled` trong config, công cụ nhập tạo phòng mới ở dạng mã hoá và mã hoá mọi thứ nó gửi vào một phòng mã hoá, kể cả media. Nó dùng một crypto device riêng (store `<storePath>-import`, tên hiển thị "Zalo bridge (history import)"), không bao giờ dùng của bridge đang chạy, nên có thể chạy song song với bridge.

Vì vậy `--rebuild` là cách chuyển một chat thường đang có sang mã hoá: phòng mới được mã hoá, nhận toàn bộ lịch sử theo đúng thứ tự, và chat được trỏ sang phòng đó. Chat nào có portal đã được mã hoá sẽ bị bỏ qua với thông báo "already encrypted", nên một lần chuyển đổi nhiều chat có thể chạy lại sau khi bị lỗi. Portal được bật mã hoá ngay trong phòng cũ vẫn giữ lịch sử cũ ở dạng không mã hoá; thêm `--include-encrypted` để dựng lại cả portal đó. Thiết bị của công cụ nhập không đọc được các sự kiện đã mã hoá trong phòng cũ; chúng bị bỏ lại và được tính vào cảnh báo "could not be carried over".

## Reaction {#reactions}

`export-cdp.mjs` đọc bảng reaction của Zalo PC và ghi `<chat key>.reactions.json` cạnh file `.ndjson` của chat (chỉ khi chat có reaction): với mỗi tin nhắn được thả reaction là các id của tin và ai đã thả loại reaction nào. Sau khi đã nhập xong tin nhắn của một chat, công cụ nhập đăng từng reaction lên tin tương ứng dưới dạng `m.reaction`, từ ghost của người thả, hoặc từ chính tài khoản của bạn (double puppet) với reaction của bạn, có mã hoá khi phòng được mã hoá. Reaction đã có trong phòng thì bỏ qua, còn reaction trên tin nhắn không có trong phòng thì được đếm và bỏ ra. Dòng log `[import] <key>: N reactions posted, S already there or skipped, U on messages not in the room` tóm tắt kết quả.

Chat đã được dựng lại trước khi có tính năng nhập reaction thì đã mất reaction cùng phòng cũ. Để thêm lại, export chat đó lần nữa rồi chạy công cụ nhập với `--only <key> --reactions-only`: nó chỉ đăng reaction vào phòng hiện tại của chat và không thay đổi gì khác.

## Ví dụ

```bash
# Những gì sẽ được nhập cho hai chat, và media của chúng còn tải được không?
… import-zalo-export.ts /data/import-export --only g1111111111,2222222222 --dry-run --probe

# Dựng lại một nhóm kèm media sao lưu và xoá phòng cũ sau khi xác minh
… import-zalo-export.ts /data/import-export --only g1111111111 --rebuild --remove-old \
    --media-dir /data/import-media --own-uid 1111111111111111111

# Kiểm tra một chat đã nhập
… import-zalo-export.ts /data/import-export --only g1111111111 --verify
```

## Kiểm toán độ đầy đủ {#completeness-audit}

Trước khi xoá một phòng cũ, `--retire` và `--remove-old` chạy một lần kiểm toán, còn `--audit` chỉ chạy kiểm toán mà không xoá gì. Mọi tin nhắn của chat trong `--baseline-db` và mọi dòng còn ánh xạ vào phòng cũ đều nhận một kết luận:

| Kết luận   | Ý nghĩa                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `carried`  | Là một sự kiện thật trong timeline của phòng mới.                                             |
| `redacted` | Đã bị xoá hoặc thu hồi trong phòng cũ; thông tin redaction (ai, lý do, lúc nào) được đọc lại. |
| `marker`   | Dòng chưa từng có sự kiện: một lần xoá hoặc thu hồi mà bridge đã ghi lại.                     |
| `accepted` | Có trong `--accept-missing`.                                                                  |
| `missing`  | Mọi trường hợp còn lại. Chỉ cần một tin thiếu là việc xoá bị chặn.                            |

Tin nhắn còn phải giữ đúng loại: khi sự kiện cũ là media (ảnh, video, âm thanh, tệp hoặc sticker) mà sự kiện mới không phải, tin đó là `missing` ("m.image became m.text in the new room") trừ khi có trong `--accept-missing`. Ngoại lệ là tin nhắn mà bản export ghi là đã thu hồi hoặc đã xoá trên Zalo: bridge live đã bỏ lỡ lần thu hồi, nên phòng cũ vẫn hiện media còn phòng mới có dòng "[Tin nhắn đã thu hồi]", khớp với Zalo. Tin đó được tính là `redacted` ("recalled on Zalo (export)"). Sự kiện mã hoá được giải mã bằng thiết bị của công cụ nhập; sự kiện mới nào không đọc được thì được tính là không phải media, nên phép kiểm tra nghiêng về an toàn.

Chiều ngược lại cũng vậy. Khi lần rebuild đăng một tin media thành chữ vì cả `--media-dir` lẫn CDN đều không có tệp, mà công cụ nhập cũng không giải mã được sự kiện của tin đó trong phòng cũ, thì nó không biết phòng cũ có còn giữ media hay không. Tin đó được tính là `old-room:undecryptable` trong thống kê, lần chạy ghi một dòng WARNING, và kiểm toán đánh dấu nó là `missing` ("media became text; the old-room event could not be decrypted") cho đến khi tệp được cung cấp qua `--media-dir` và chat được rebuild lại, hoặc tin được liệt kê trong `--accept-missing`.

Lần rebuild chuyển các dòng trong store của phòng cũ sang phòng mới, nên sau đó không còn gì ánh xạ vào phòng cũ. Trước khi chuyển, nó ghi `import-evidence/<threadId>-rebuild.json` (phòng mới, các dòng đã chuyển dưới dạng metadata, và các tin nói trên). `--remove-old`, cũng như một lần `--retire` hoặc `--audit` sau đó cho phòng mới này, đọc tệp đó và kiểm toán các dòng đã chuyển như dòng của phòng cũ, kể cả loại media. Vì vậy chat không có trong `--baseline-db` cũng được kiểm toán.

Bằng chứng (chỉ metadata: id, thời gian, chiều, kết luận; không có nội dung tin nhắn) được ghi vào `import-evidence/<threadId>-<time>.json`, và một dòng `[audit]` tóm tắt kết quả. Bằng chứng còn liệt kê trong `stillUnsupported` các tin đã chuyển sang mà sự kiện vẫn là thông báo "not supported" dù payload đã lưu nay hiển thị được; chúng không chặn việc xoá phòng, và một lần `--rebuild` mới sẽ thay chúng bằng tin nhắn thật.

```bash
# Kiểm toán phòng hiện tại của một chat so với database trước khi chuyển đổi, không xoá gì
… import-zalo-export.ts /data/import-export --only 2222222222 --audit '' \
    --baseline-db /data/bridge.db.bak-pre-e2ee
```

Các dòng log của nó bắt đầu bằng `[import]` (`[audit]` cho kiểm toán, `[retire]` khi phòng bị xoá). Xem [Log](../reference/logs).
