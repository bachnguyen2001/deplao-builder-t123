# Deplao Headless Multi-Channel Engine — Tài liệu Tích hợp & Đóng gói

Tài liệu này tổng hợp toàn bộ kiến trúc và quy trình biến **Deplao (`deplao-builder-t123`)** thành một **Headless Channel Engine** thuần túy (Zalo cá nhân, Facebook, Telegram) để tích hợp vào bất kỳ hệ thống SaaS / Multi-tenant nào (như Stayra, P-123, CRM, Chatbot Platform...).

---

## 1. Tư duy Kiến trúc (Separation of Concerns)

- **Deplao Engine (Headless):**
  - Chỉ làm nhiệm vụ duy trì phiên đăng nhập Social, nhận/gửi tin nhắn, tải danh bạ/nhóm, và bắn Webhook `message.received`.
  - **Không** lộ giao diện Deplao Web ra ngoài cho người dùng cuối.
  - Chỉ giao tiếp nội bộ với Backend chính qua REST API v1 (`/api/v1/...`) dùng `Authorization: Bearer <apiKey>`.
- **Hệ thống chính (Host App — Backend + Frontend):**
  - Quản lý **User / Workspace / Tenant** độc lập.
  - Tự động xin cấp `apiKey` cho từng Tenant qua `POST /api/browser/provision-key`.
  - Bọc luồng đăng nhập kênh (như **Zalo QR**) ngay trên giao diện của Host App; khi Deplao báo đăng nhập thành công (`account_id`), Backend chính **tự động gán `account_id` đó cho `TenantId` hiện tại**.
  - Lưu **Whitelist nhóm/chat (`AllowedThreadIds`)** cho từng kết nối để tránh bot tự trả lời nhầm vào tin nhắn cá nhân không liên quan.

---

## 2. Những điểm đã nâng cấp trong `deplao-builder-t123`

1. **Docker Headless (`docker/headless.Dockerfile`):**
   - Dùng `npm ci --ignore-scripts`, sau đó chạy `node node_modules/electron/install.js && npm run rebuild:native && npm run build:electron && npm run build:web`.
   - Cài đủ thư viện hệ thống cho Electron headless (`xvfb`, `xauth`, `libcairo2`, `libgtk-3-0`, `libpango-1.0-0`, `libnss3`, `libgbm1`, `libasound2`, ...).
   - Chạy thẳng `Xvfb :99 -ac` + `exec ./node_modules/.bin/electron dist-electron/electron/bootstrap.js --no-sandbox --disable-gpu --disable-dev-shm-usage` (tránh lỗi `xvfb-run` bị treo hoặc mất `SIGTERM`).
2. **Bind network & Auto-Provision Key (`electron/web/BrowserServer.ts`):**
   - Hỗ trợ `DEPLAO_WEB_HOST=0.0.0.0` để các container khác gọi được sang `http://deplao:27800`.
   - Endpoint `POST /api/browser/provision-key` (xác thực qua header `X-Deplao-Admin-Password`) tự động tạo API key với đủ quyền:
     `['accounts:read', 'accounts:manage', 'chat:read', 'chat:send', 'contacts:read', 'webhooks:manage']`.
3. **Allow Private Webhooks trong Docker (`src/services/api/settings.ts`):**
   - Hỗ trợ `DEPLAO_ALLOW_PRIVATE_URLS=1` để `netGuard` không chặn webhook trỏ tới địa chỉ nội bộ Docker (ví dụ `http://api:8080/...`).
4. **Native Multi-Channel Login & Session Management qua API v1 (`src/services/api/routes/accounts.ts`, `EventBroadcaster.ts`, `ZaloLoginHelper.ts`):**
   - **Zalo QR:**
     - `POST /api/v1/accounts/zalo/qr` → khởi tạo phiên QR, trả về `{ data: { temp_id } }`.
     - `GET /api/v1/accounts/zalo/qr/:tempId` → trả về `{ data: { temp_id, status, qr_data_url, message, account_id, account_name } }`.
     - `POST /api/v1/accounts/zalo/qr/:tempId/abort` → hủy phiên QR khi người dùng đóng modal.
   - **Facebook Messenger:**
     - `POST /api/v1/accounts/facebook/login` (`{ username, password, two_fa_secret? }`) → đăng nhập tài khoản Facebook Messenger.
   - **Telegram User & Bot:**
     - `POST /api/v1/accounts/telegram/send-code` (`{ phone_number }`) → gửi OTP.
     - `POST /api/v1/accounts/telegram/sign-in` (`{ phone_number, code, phone_code_hash }`) → xác nhận OTP.
     - `POST /api/v1/accounts/telegram/sign-in-2fa` (`{ password }`) → xác nhận 2FA (nếu có).
     - `POST /api/v1/accounts/telegram/bot` (`{ bot_token }`) → kết nối Telegram Bot.
   - **Xóa session & Healthcheck:**
     - `DELETE /api/v1/accounts/:accountId` → xóa tài khoản và phiên đăng nhập khỏi engine.
     - `GET /api/v1/health` → kiểm tra trạng thái engine (public, dùng cho Docker `HEALTHCHECK`).
5. **Chế độ Headless thuần túy (`electron/main.ts` & `docker-compose.headless.yml`):**
   - Khi bật `DEPLAO_CHANNELS_ONLY=1`, engine bỏ qua toàn bộ các module desktop/doanh nghiệp không cần thiết (CRM, ERP, Workflow, AI Assistant, Employee, Relay, LockScreen, Library, Cloudflare, Plugin).
   - Có sẵn [docker-compose.headless.yml](./docker-compose.headless.yml) để chạy độc lập chỉ với 1 lệnh: `docker compose -f docker-compose.headless.yml up -d --build`.

---

## 3. Cấu hình Docker Compose mẫu cho dự án mới

```yaml
services:
  deplao:
    build:
      context: ./deplao-builder-t123
      dockerfile: docker/headless.Dockerfile
    restart: unless-stopped
    environment:
      NODE_ENV: production
      DEPLAO_WEB: 1
      DEPLAO_CHANNELS_ONLY: 1
      DEPLAO_WEB_PASSWORD: ${DEPLAO_WEB_PASSWORD:-change-me-min-12-chars}
      DEPLAO_WEB_PORT: 27800
      DEPLAO_WEB_HOST: 0.0.0.0
      DEPLAO_WEB_SECURE: 0
      DEPLAO_ALLOW_PRIVATE_URLS: 1
    volumes:
      # QUAN TRỌNG: Tên thư mục trên Linux phân biệt hoa/thường — bắt buộc là /root/.config/Deplao
      - deplao_data:/root/.config/Deplao

volumes:
  deplao_data:
```

> **Lưu ý sống còn:**
> 1. `package.json` đặt `"name": "Deplao"` nên Electron lưu SQLite (`deplao-tool.db`) tại `/root/.config/Deplao` (**D viết hoa**). Nếu mount nhầm `/root/.config/deplao` thì mọi phiên đăng nhập và API key sẽ bị mất mỗi khi recreate container.
> 2. Không cần mở port `27800` ra ngoài Internet nếu chỉ dùng nội bộ giữa `api` và `deplao`.

---

## 4. Quy trình tích hợp chuẩn vào Backend mới

### Bước 1: Tự động cấp API Key & Webhook cho Tenant mới
1. Gọi `POST http://deplao:27800/api/browser/provision-key` với header `X-Deplao-Admin-Password: <DEPLAO_WEB_PASSWORD>` và body `{"tenantSlug": "<slug>"}`.
2. Lưu `apiKey` (mã hóa) vào DB của Tenant.
3. Gọi `POST http://deplao:27800/api/v1/webhooks` (với `Authorization: Bearer <apiKey>`) để đăng ký URL nhận sự kiện **nội bộ Docker**, ví dụ:
   `http://api:8080/api/webhooks/deplao/<tenantSlug>`
   - **Lưu ý:** Nếu gọi Deplao API nhận về `401` hoặc `403` (do volume reset hoặc thiếu scope), backend nên tự động xóa key cũ, gọi lại `provision-key` và retry 1 lần.

### Bước 2: Đăng nhập Zalo QR ngay trên Web chính
1. Frontend bấm **"Kết nối Zalo (Quét QR)"** → Backend gọi `POST /api/v1/accounts/zalo/qr` → trả `temp_id`.
2. Frontend poll `GET .../zalo/qr/:tempId` mỗi 1.5s:
   - `status = "waiting"` → hiển thị ảnh `<img src={qr_data_url} />`.
   - `status = "scanned"` → báo chờ xác nhận trên điện thoại.
   - `status = "success"` → Backend kiểm tra `account_id` chưa thuộc Tenant khác, rồi **lưu thẳng vào bảng `ChannelConnections(TenantId, Channel, AccountId, AccountName, AllowedThreadIds)`**.

### Bước 3: Lấy danh bạ & Nhóm để chọn Whitelist / Gửi test
- Gọi cả 2 endpoint và gộp theo `thread_id`:
  - `GET /api/v1/accounts/:accountId/conversations?limit=50` (hội thoại gần đây)
  - `GET /api/v1/accounts/:accountId/groups?limit=50` (danh sách nhóm Zalo)
- Lưu danh sách `AllowedThreadIds` cho từng `ChannelConnection`.

### Bước 4: Xử lý Webhook `message.received` an toàn
Khi Deplao POST tới webhook:
1. Verify HMAC-SHA256 (`X-Deplao-Signature: v1=...`, `X-Deplao-Timestamp`).
2. Bỏ qua nếu `data.message.is_self == true` (tin nhắn do chính tài khoản gửi ra) hoặc `msg_type == "system"`.
3. Kiểm tra `ChannelConnection` tương ứng:
   - Nếu `IsEnabled == false` → bỏ qua.
   - Nếu `AllowedThreadIds` có giá trị và `thread_id` không nằm trong danh sách → bỏ qua ngay (tránh bot tự trả lời tin nhắn cá nhân/nhóm ngoài luồng).
4. Đưa nội dung vào AI Agent / Inbox của Tenant và gửi phản hồi qua `POST /api/v1/accounts/:accountId/conversations/:threadId/messages`.

---

## 5. Porter (P-123)

### 5.1 Mô hình

- Porter giữ **một key engine** ("Tất cả tài khoản") cho mọi đơn vị / tòa. Ban quản lý không thấy Deplao.
- Cách ly nick giữa các tòa làm ở **Porter** (bảng nick ↔ tòa). Deplao giúp chiều tin vào: mỗi tòa một webhook có `account_ids` = nick chính của tòa.

### 5.2 Tạo key engine (một lần)

Một trong hai cách:

- `curl -X POST http://<deplao>:27800/api/browser/provision-key -H "X-Deplao-Admin-Password: <mật khẩu web>" -H "Content-Type: application/json" -d '{"tenantSlug":"porter"}'`
- hoặc UI Deplao → API → Tạo key, phạm vi **Tất cả tài khoản**.

Scope bắt buộc (8): `accounts:read, accounts:manage, chat:read, chat:send, contacts:read, media:read, media:write, webhooks:manage`.
Key này đặt vào `.env` của Porter là `DEPLAO_ENGINE_KEY` (spec 015). Lộ key = lộ mọi nick → thu hồi và tạo lại.

### 5.3 API Porter gọi

| Method + path | Dùng để |
| :--- | :--- |
| `GET /accounts` | Danh sách nick (thấy nick mới ngay sau khi quét QR) |
| `POST /accounts/zalo/qr` | Bắt đầu đăng nhập Zalo bằng QR, trả `temp_id` |
| `GET /accounts/zalo/qr/{temp_id}` | Trạng thái + ảnh QR |
| `POST /accounts/zalo/qr/{temp_id}/abort` | Huỷ lượt QR |
| `DELETE /accounts/{id}` | Gỡ nick Zalo (chỉ khi không còn tòa nào dùng) |
| `POST/PATCH/DELETE /webhooks` | Mỗi tòa một webhook, `account_ids` = nick chính của tòa |
| `/deliveries`, `/media`, `GET /accounts/{id}/users/…`, `…/groups/…` | Gửi tin, ảnh, danh bạ, nhóm (như trước) |

### 5.4 Trạng thái QR

`initializing` → `waiting` (có `qr_data_url`) → `scanned` → `success` (`account_id`, `account_name`) | `expired` | `declined` | `error`.
Phiên nằm trong RAM, xoá sau 15 phút không có sự kiện; khởi động lại Deplao → `404`. Hook QR tự đăng ký lại sau khi đổi workspace.

### 5.5 Lưu ý triển khai

- Không mở cổng 27800 ra Internet khi `DEPLAO_WEB_SECURE=0`: mật khẩu web (cũng là mật khẩu tạo key) đi qua HTTP thường.
- `DEPLAO_ALLOW_PRIVATE_URLS=1` tắt chặn webhook trỏ vào địa chỉ nội bộ cho **mọi** key — chỉ bật khi Porter gọi qua mạng Docker nội bộ.
- `DELETE /accounts/{id}` xoá được nick bất kỳ với key "mọi nick": chỉ Porter giữ key này.

### 5.6 Chạy trong compose của Porter trên VPS

- Service `deplao` trong `docker-compose.production.yml` của P-123 (profile `deplao`, `pull_policy: never`). Chỉ mở `127.0.0.1:27800`.
  Porter release (`scripts/deploy_release.sh`) không gọi tới service này. Chỉ `scripts/deploy_deplao.sh` (workflow
  "Deploy Deplao engine") mới thay container.
- Porter gọi `http://deplao:27800/api/v1`. Webhook của Porter: `http://backend:8000/integrations/deplao/events`. Cần
  `DEPLAO_ALLOW_PRIVATE_URLS=1`; compose đặt biến này, Dockerfile không đặt.
- Khi Deplao khởi động lại, mọi nick tự nối lại từ phiên đã lưu (`startupAllWorkspaces`), không cần quét QR. Tin tới trong lúc
  đứt có thể không sang Porter, vì Deplao không tự lấy lại tin bị lỡ.
- Dữ liệu nick ở `/opt/deplao-data`. Mất thư mục này thì mọi nick phải quét QR lại, nên cần sao lưu khi bảo trì.
