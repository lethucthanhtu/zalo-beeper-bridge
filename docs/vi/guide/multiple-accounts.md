# Nhiều tài khoản Zalo

Một bridge phục vụ một tài khoản Zalo. Để bridge tài khoản thứ hai, hãy chạy **một bridge thứ hai** bên cạnh bridge đầu tiên, với registration, cấu hình và dữ liệu riêng. Việc một bridge phục vụ nhiều tài khoản đang được chuẩn bị: cơ sở dữ liệu đã ghi lại tài khoản nào sở hữu từng portal và tin nhắn (xem [Schema cơ sở dữ liệu](../reference/database)).

## Các bước (container)

1. Đăng ký bridge thứ hai dưới một tên khác. Bot, ghost và namespace đều theo tên này: `sh-zalo2` cho bot `@sh-zalo2bot` và ghost `@sh-zalo2_<uid>`. Bridge đọc chúng từ registration.

   ```bash
   bbctl register -o registration.yaml sh-zalo2
   ```

   Đặt `url: http://localhost:29350` trong file đó như với bridge đầu tiên. Mỗi container có loopback riêng, nên cả hai có thể dùng cùng một cổng.

2. Tạo `container-config-2/` chứa `registration.yaml` đó, một `config.yaml` và `bbctl-config.json`, như mô tả trong [Triển khai bằng container](../deployment/container#_1-inputs-container-config-gitignored).

3. Thêm một service thứ hai với volume dữ liệu riêng vào `compose.yaml`:

   ```yaml
   services:
     # zalo-bridge: … (the first bridge, unchanged)
     zalo-bridge-2:
       image: localhost/zalo-beeper-bridge:latest
       container_name: zalo-beeper-bridge-2
       restart: unless-stopped
       init: false
       volumes:
         - ./container-config-2:/config:ro
         - zalo-data-2:/data

   volumes:
     zalo-data:
     zalo-data-2:
   ```

4. Khởi động và đăng nhập:

   ```bash
   podman compose up -d        # or: docker compose up -d
   ```

   Sau đó gửi `login` tới `@sh-zalo2bot:beeper.local`.

Beeper hiển thị bridge thứ hai như một mạng riêng. Một liên hệ mà bạn có ở cả hai tài khoản sẽ có một ghost cho mỗi bridge.

::: warning
Đừng bao giờ chạy hai bridge với **cùng một** registration. Beeper sẽ ngắt kết nối bridge đầu tiên.
:::

::: info Trạng thái
Việc chạy hai bridge song song chưa được kiểm chứng đầu-cuối với hai tài khoản thật.
:::

## Lệnh `accounts`

[`accounts`](./bot-commands#accounts) liệt kê mọi tài khoản Zalo mà một bridge đã đăng nhập. Nếu bạn `logout` rồi `login` bằng tài khoản khác trên cùng một bridge, cả hai đều được liệt kê, nhưng chỉ tài khoản đang đăng nhập được bridge.
