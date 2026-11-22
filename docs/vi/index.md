---
layout: home

hero:
  name: zalo-beeper-bridge
  text: Cuộc trò chuyện Zalo ngay trong Beeper
  tagline: Matrix bridge tự host cho tài khoản Zalo cá nhân, kèm công cụ nhập lịch sử đưa toàn bộ chat cũ của bạn sang.
  actions:
    - theme: brand
      text: Bắt đầu
      link: /vi/guide/getting-started
    - theme: alt
      text: Đây là gì?
      link: /vi/guide/what-is-it
    - theme: alt
      text: GitHub
      link: https://github.com/lethucthanhtu/zalo-beeper-bridge

features:
  - title: Nhắn tin hai chiều
    details: Văn bản, nhắc tên, trả lời, ảnh, video, file, tin nhắn thoại, sticker, biểu cảm, đã xem và đang soạn tin, cho cả DM và nhóm.
  - title: Nhập toàn bộ lịch sử
    details: Dựng lại từng cuộc trò chuyện từ Zalo PC và file sao lưu mã hoá của nó, với thời gian gốc, media thật, trả lời và nhắc tên.
  - title: Tự chạy trên máy của bạn
    details: Một container chạy cả appservice và bbctl proxy. Thông tin đăng nhập được mã hoá khi lưu và log không bao giờ chứa nội dung tin nhắn.
  - title: Bền bỉ
    details: Listener tự động kết nối lại khi mất mạng và lấy lại các tin nhắn bị lỡ sau mỗi lần kết nối lại.
---

::: warning Không chính thức, tự chịu rủi ro
Bridge giao tiếp với Zalo Web qua [zca-js](https://github.com/RFS-ADRENO/zca-js), một thư viện dịch ngược. Việc này vi phạm điều khoản sử dụng của Zalo và **có thể khiến tài khoản bị khoá hoặc cấm**. Hãy dùng một tài khoản mà bạn có thể chấp nhận rủi ro. Dự án không liên kết với Zalo/VNG hay Beeper.
:::
