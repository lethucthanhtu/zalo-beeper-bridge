# Dịch tài liệu

Tài liệu của `zalo-beeper-bridge` là song ngữ:

- **Tiếng Anh** (`en-US`): Được phục vụ tại đường dẫn gốc (`/`).
- **Tiếng Việt** (`vi-VN`): Được phục vụ dưới đường dẫn `/vi/`.

## Giữ bản dịch luôn đồng bộ

Bất cứ khi nào bạn cập nhật một trang tài liệu tiếng Anh trong `docs/`, bạn phải cập nhật trang tiếng Việt tương ứng dưới `docs/vi/` trong cùng pull request hoặc commit.

- **Ngoại lệ Changelog:** `docs/changelog.md` chỉ được duy trì bằng tiếng Anh. Thanh điều hướng tiếng Việt liên kết trực tiếp tới `/changelog`.
- **Thuật ngữ:** Sử dụng `README.vi.md` làm tài liệu tham chiếu chuẩn cho các thuật ngữ kỹ thuật tiếng Việt (ví dụ: _application service tự host_, _ghost user_, _portal room_, _double-puppeting_, _read receipt_, _typing_, _catch-up sync_).
- **Mã nguồn và định danh:** Giữ nguyên vẹn các khối code, lệnh CLI, khoá cấu hình, đường dẫn file và tên riêng (`Zalo`, `Beeper`, `Matrix`, `bbctl`, `Podman`, `Docker`).
- **Liên kết nội bộ:** Đảm bảo các liên kết tương đối trong các trang tiếng Việt trỏ đúng tới các trang đích `/vi/...`, và giữ lại các anchor tag tuỳ chỉnh (ví dụ `{#custom-anchor}`) để các liên kết anchor tiếp tục hoạt động.

## Kiểm tra tính tương đồng (Parity check)

Một bài test nhẹ (`src/__tests__/docs-i18n-parity.test.ts`) chạy trong quy trình CI để đảm bảo rằng mọi trang tiếng Anh được xuất bản trong `docs/` đều có trang tiếng Việt tương ứng trong `docs/vi/`.

Bạn có thể chạy kiểm tra cục bộ bằng:

```bash
npx vitest run src/__tests__/docs-i18n-parity.test.ts
```
