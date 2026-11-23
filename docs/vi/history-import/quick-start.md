# Bắt đầu nhanh

Chỉ một lệnh duy nhất để nhập lịch sử trò chuyện của bạn theo từng chat.

## Yêu cầu

- Bridge đang chạy trong container (Podman hoặc Docker), đã đăng nhập vào Zalo.
- Zalo PC đã được cài đặt và đăng nhập vào cùng tài khoản đó.
- Node.js 22.18+ trên máy host.
- **Windows:** PowerShell 7 và Git for Windows (script chạy một helper bằng Bash).
- **macOS:** Zalo PC trong `/Applications`, hoặc đặt `ZALO_APP=/path/to/Zalo.app`.

## Chạy lệnh

::: code-group

```powershell [Windows]
pwsh scripts/zalo-pc/import.ps1
```

```bash [macOS]
scripts/zalo-pc/import.sh
```

:::

Script sẽ:

1. kiểm tra container của bridge, Beeper, `node` (và Git Bash trên Windows);
2. khởi động (lại) Zalo PC với cổng debug local. Script **sẽ hỏi trước khi đóng** Zalo PC đang chạy;
3. liệt kê các cuộc trò chuyện của bạn **theo tên** (các chat được ghim trước, sau đó theo số lượng tin nhắn) và cho phép bạn chọn: `1,3,5-8`, `groups`, `dms` hoặc `all`;
4. nhập từng chat đã chọn kèm tiến trình hiển thị trực tiếp (xem [Export và import](./manual#step-3-export-and-import)) và in bảng tổng kết OK / FAIL.

::: tip
Hãy bắt đầu với một chat (`-Chats` / `-c`) để kiểm tra mọi thứ hoạt động trơn tru trước khi bạn nhập toàn bộ.
:::

Chạy lại script sẽ tự động bỏ qua các chat đã hoàn tất. Các bản export, `run.log` và `done.txt` được ghi vào `work/`, thư mục này đã nằm trong gitignore vì chứa tin nhắn của bạn.

## Các tuỳ chọn

| Tuỳ chọn              | Windows (`import.ps1`)                    | macOS (`import.sh`)     |
| --------------------- | ----------------------------------------- | ----------------------- |
| Chat, không mở menu   | `-Chats g123,4567`                        | `-c g123,4567`          |
| Media từ bản sao lưu  | `-MediaDir /data/import-media`            | `-m /data/import-media` |
| Uid Zalo của bạn      | `-OwnUid <uid>` (mặc định: từ log bridge) | `-u <uid>`              |
| Tên container         | `-Container <name>`                       | `-n <name>`             |
| Docker thay vì Podman | `-ContainerCli docker`                    | `-r docker`             |
| Thư mục làm việc      | `-WorkDir <dir>`                          | `-w <dir>`              |
| Cổng debug Zalo PC    | `-CdpPort <port>` (mặc định `9229`)       | `-p <port>`             |

Một chat key có dạng `g<groupId>` đối với nhóm hoặc uid của đối phương đối với DM.

Để đính kèm ảnh và video cũ có liên kết CDN đã hết hạn, trước tiên hãy [chuẩn bị media từ bản sao lưu](./manual#step-2-optional-prepare-media-from-a-zalo-pc-backup) rồi truyền thư mục đó qua `-MediaDir` / `-m`.

## Khi hoàn tất

Khởi động lại Zalo PC bình thường để đóng cổng debug, và xoá thư mục `work/`. Xem [Bảo mật](../security#history-import).

Nếu gặp sự cố, xem [Xử lý sự cố](../troubleshooting#history-import).
