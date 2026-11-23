# Phát triển

Trang này hướng dẫn cách làm việc với mã nguồn. Để biết các quy tắc đóng góp (quyền riêng tư, quy ước, pull request và release), vui lòng đọc [CONTRIBUTING.md](https://github.com/lethucthanhtu/zalo-beeper-bridge/blob/main/CONTRIBUTING.md).

## Cài đặt

Yêu cầu: Node.js 22.18 trở lên (chạy TypeScript trực tiếp không cần bước build) và npm.

```bash
git clone https://github.com/lethucthanhtu/zalo-beeper-bridge.git
cd zalo-beeper-bridge
npm ci
```

## Kiểm tra

```bash
npm run typecheck   # tsc strict (+ noUncheckedIndexedAccess, noUnused*, noImplicitReturns/Override), không emit
npm run lint        # ESLint flat config, type-aware: không promise nổi hoặc dùng sai
npm test            # vitest
npm run format      # prettier --write .
```

CI chạy cùng các lệnh này, và tất cả phải vượt qua trước khi một pull request được merge. Các bài test mock phía Zalo và Matrix, không bao giờ gọi tới dịch vụ thật.

## Chạy trực tiếp

Bạn cần một tài khoản Beeper, `bbctl` và một tài khoản Zalo mà bạn chấp nhận rủi ro được. Thiết lập đơn giản nhất là dùng [container](../deployment/container): build lại image sau mỗi thay đổi. Để chạy từ mã nguồn, hãy làm theo [Bắt đầu](../guide/getting-started) và khởi chạy bridge bằng `npm run dev` bên cạnh `bbctl proxy`.

## Cấu trúc mã nguồn

Xem [Kiến trúc](../reference/architecture) để biết từng module.

- `src/zalo/`: mọi thứ liên quan đến zca-js. Chỉ `zalo-client.ts` import nó khi chạy.
- `src/bridge/`: portal, ghost, kho ánh xạ SQLite, trình xử lý đến và đi, media, sync và catch-up.
- `src/matrix/`: thiết lập appservice, thương hiệu mạng, Beeper account state và các lệnh bot.
- `src/tools/`: công cụ nhập lịch sử, chạy bên trong container.
- `scripts/zalo-pc/`: các công cụ máy tính đọc Zalo PC và bản sao lưu của nó. Xem [Các bước thủ công](../history-import/manual#tools-in-scripts-zalo-pc).

## Thêm một kiểu tin nhắn Zalo {#adding-a-zalo-message-type}

Khi Zalo gửi một kiểu tin nhắn mà bridge chưa biết, log sẽ hiển thị `[bridge] unsupported Zalo msgType <type> (content keys: …)`, chỉ liệt kê **tên** các trường. Hãy thêm một case vào `normalizeContent` trong `src/zalo/event-normalizer.ts` và một bài test kèm fixture đã được ẩn danh hoá. Các payload dạng card thường khác nhau ở trường `action` (`rtf` rich text, `recommened.link`, `recommened.user`, call actions), vì vậy hãy kiểm tra trường đó trước.

Fixture không bao giờ được chứa dữ liệu thật: dùng các id như `1111111111111111111`, tên như `Nguyễn Văn A`, số điện thoại như `0900000000`, và địa danh công cộng cho toạ độ.

## Thay đổi cơ sở dữ liệu

Thêm một migration vào `MappingStore.migrate()` trong `src/bridge/mapping-store.ts` và tăng phiên bản. Giữ migrations luôn có tính bổ sung (bảng, cột hoặc index mới) để mã cũ vẫn chạy được trên cơ sở dữ liệu mới và rollback không cần khôi phục dữ liệu. Xem [Schema cơ sở dữ liệu](../reference/database#migrations).

## Nâng cấp zca-js

Các thay đổi của Zalo Web có thể làm hỏng zca-js. Khi bạn nâng phiên bản đã ghim:

1. Chạy `npm test`. Các fixture chuẩn hoá sẽ bắt được thay đổi payload.
2. Chạy smoke test thủ công: gửi và nhận văn bản cùng ảnh trong DM và nhóm.

Mọi mã dùng zca-js đều nằm trong `src/zalo/zalo-client.ts`, vì vậy nâng cấp hay thay thế chỉ tác động tới đúng file đó.

## Lockfile trên Windows

`npm install` trên Windows sẽ bỏ các mục dành riêng cho Linux khỏi `package-lock.json`, khiến `npm ci` của image bị lỗi. Sau khi đổi dependency, hãy tạo lại lockfile trong container Linux:

```bash
podman run --rm -v "$PWD:/w" -w /w docker.io/library/node:24-bookworm-slim npm install --package-lock-only --ignore-scripts
```

Trong Git Bash, thêm tiền tố `MSYS_NO_PATHCONV=1` và dùng `$(pwd -W)` thay cho `$PWD`.

## Tài liệu

Trang tài liệu này được xây dựng bằng [VitePress](https://vitepress.dev/) từ thư mục `docs/`:

```bash
npm run docs:dev       # xem trước trực tiếp tại http://localhost:5173
npm run docs:build     # build trang tĩnh trong docs/.vitepress/dist; kiểm tra link nghiêm ngặt
npm run docs:preview   # chạy thử trang đã build
```

Cập nhật tài liệu trong cùng pull request bất cứ khi nào hành vi, cấu hình hoặc các lệnh thay đổi.
