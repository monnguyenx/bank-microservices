# Đặc tả hệ thống Mini Bank (microservices)

Oct 7, 2026 · @Mon

## Mục đích và phạm vi

Mini Bank là hệ thống ngân hàng thu nhỏ gồm 3 microservice và 1 frontend, dùng để học triển khai trên OpenShift Developer Sandbox. Tài liệu này là đầu vào để AI sinh toàn bộ mã nguồn; AI phải làm đúng những gì ghi ở đây và không tự thêm tính năng.

**Trong phạm vi:**

- Đăng ký, đăng nhập (JWT)
- Mở tài khoản thanh toán, xem số dư và sao kê
- Nạp tiền (do nhân viên thực hiện), rút tiền, chuyển khoản nội bộ
- Lịch sử giao dịch
- Giao diện web đơn giản cho các chức năng trên

**Ngoài phạm vi (không làm):** chuyển khoản liên ngân hàng, nhiều loại tiền tệ, lãi suất, OTP/2FA, KYC thật, thông báo email/SMS, message queue (Kafka), service mesh.

Các giả định: backend viết bằng Node.js; mọi service dùng chung một PostgreSQL (`bank-db`) nhưng mỗi service có schema riêng, để vừa đúng tinh thần microservices vừa vừa tài nguyên Sandbox.

## Kiến trúc tổng quan

&#91;embedded content: kiến trúc Mini Bank · 4 thành phần, 1 route, 1 database\]

Mọi request từ Internet đi qua một route duy nhất và được chia theo đường dẫn; `auth-service` và `transaction-service` muốn đụng tới khách hàng hay số dư thì phải gọi API nội bộ của `account-service`.

## Danh sách service

Mỗi service sở hữu dữ liệu riêng và chỉ được đọc/ghi schema của mình. Service khác muốn dữ liệu đó phải gọi API, không được truy vấn thẳng vào bảng của service khác.

| Service | Trách nhiệm | Schema | Đường dẫn public |
| --- | --- | --- | --- |
| `auth-service` | Đăng ký, đăng nhập, phát JWT, quản lý người dùng và vai trò | `auth_svc` | `/api/auth` |
| `account-service` | Khách hàng, tài khoản, số dư, sổ cái (postings). Là nơi DUY NHẤT được thay đổi số dư | `account_svc` | `/api/accounts` |
| `transaction-service` | Nhận yêu cầu nạp/rút/chuyển, kiểm tra hạn mức, ghi lịch sử giao dịch, gọi `account-service` để hạch toán | `txn_svc` | `/api/transactions` |
| `bank-web` | Giao diện HTML/JS tĩnh, gọi các API qua cùng tên miền | không có | `/` |

`account-service` là nơi duy nhất giữ số dư, nên tiền chỉ biến động trong một database transaction tại đây. Cách này tránh được bài toán giao dịch phân tán (saga) vốn quá khó cho giai đoạn đầu.

## Quy tắc nghiệp vụ

Tiền là số nguyên VND, lưu kiểu `BIGINT`; tuyệt đối không dùng số thực (float) cho tiền. Mỗi quy tắc có mã lỗi riêng để API trả về khi vi phạm.

| Mã | Quy tắc | Mã lỗi khi vi phạm |
| --- | --- | --- |
| BR-01 | Mỗi khách hàng có tối đa 3 tài khoản đang hoạt động | `ACCOUNT_LIMIT_REACHED` |
| BR-02 | Số tài khoản gồm 12 chữ số, sinh ngẫu nhiên, không trùng | — |
| BR-03 | Tài khoản mới có số dư 0, trạng thái `ACTIVE`, tiền tệ `VND` | — |
| BR-04 | Số tiền mỗi giao dịch từ 1.000 đến 50.000.000 VND | `INVALID_AMOUNT` |
| BR-05 | Số dư không bao giờ âm | `INSUFFICIENT_FUNDS` |
| BR-06 | Tổng tiền rút + chuyển đi của một tài khoản trong một ngày (giờ Việt Nam) không quá 200.000.000 VND | `DAILY_LIMIT_EXCEEDED` |
| BR-07 | Không chuyển khoản cho chính tài khoản nguồn | `SAME_ACCOUNT` |
| BR-08 | Tài khoản `FROZEN` vẫn nhận tiền nhưng không được rút/chuyển đi; tài khoản `CLOSED` không giao dịch gì | `ACCOUNT_NOT_ACTIVE` |
| BR-09 | Khách hàng chỉ xem và giao dịch trên tài khoản của mình; được chuyển tới tài khoản bất kỳ | `FORBIDDEN` |
| BR-10 | Chỉ vai trò `ADMIN` được nạp tiền (mô phỏng nạp tại quầy) và đóng băng/mở băng tài khoản | `FORBIDDEN` |
| BR-11 | Mỗi yêu cầu nạp/rút/chuyển có header `Idempotency-Key`; gửi lại cùng key thì trả kết quả cũ, không trừ tiền lần hai | `IDEMPOTENCY_KEY_REQUIRED` |
| BR-12 | Mỗi biến động số dư sinh ít nhất một posting; với chuyển khoản, tổng các posting bằng 0 (bên này trừ bao nhiêu, bên kia cộng bấy nhiêu) | `UNBALANCED_POSTING` |
| BR-13 | Tên đăng nhập duy nhất; mật khẩu tối thiểu 8 ký tự, lưu dạng bcrypt | `USERNAME_TAKEN`, `WEAK_PASSWORD` |
| BR-14 | Số CCCD của khách hàng gồm 12 chữ số và không trùng | `INVALID_ID_NUMBER`, `ID_NUMBER_TAKEN` |

Các con số hạn mức là giá trị mẫu, đọc từ biến môi trường để đổi được mà không sửa code (xem mục cấu hình).

## Mô hình dữ liệu

Mỗi service tự tạo schema và bảng của mình lúc khởi động (`CREATE ... IF NOT EXISTS`). Khóa chính là UUID; thời gian là `TIMESTAMPTZ`; liên kết giữa các schema chỉ là giá trị ID, không có foreign key xuyên schema.

### Schema `auth_svc`

```sql
CREATE TABLE auth_svc.users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          VARCHAR(10) NOT NULL CHECK (role IN ('CUSTOMER','ADMIN')),
  customer_id   UUID,              -- ID khách hàng bên account_svc; NULL với ADMIN
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Schema `account_svc`

```sql
CREATE TABLE account_svc.customers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name  VARCHAR(100) NOT NULL,
  id_number  CHAR(12) UNIQUE NOT NULL,   -- số CCCD
  phone      VARCHAR(15),
  email      VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_svc.accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number CHAR(12) UNIQUE NOT NULL,
  customer_id    UUID NOT NULL REFERENCES account_svc.customers(id),
  currency       CHAR(3) NOT NULL DEFAULT 'VND',
  balance        BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  status         VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sổ cái: mỗi dòng là một lần số dư thay đổi. Không bao giờ UPDATE hay DELETE.
CREATE TABLE account_svc.postings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES account_svc.accounts(id),
  amount          BIGINT NOT NULL CHECK (amount <> 0),  -- dương = cộng, âm = trừ
  balance_after   BIGINT NOT NULL,
  transaction_id  UUID NOT NULL,                        -- ID bên txn_svc
  description     VARCHAR(200),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE account_svc.processed_requests (
  idempotency_key VARCHAR(100) PRIMARY KEY,
  response        JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Schema `txn_svc`

```sql
CREATE TABLE txn_svc.transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type            VARCHAR(10) NOT NULL CHECK (type IN ('DEPOSIT','WITHDRAW','TRANSFER')),
  from_account    CHAR(12),        -- NULL với DEPOSIT
  to_account      CHAR(12),        -- NULL với WITHDRAW
  amount          BIGINT NOT NULL CHECK (amount > 0),
  description     VARCHAR(200),
  status          VARCHAR(10) NOT NULL CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  failure_code    VARCHAR(50),
  idempotency_key VARCHAR(100) UNIQUE NOT NULL,
  created_by      UUID NOT NULL,   -- user id từ JWT
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
```

## API

API public (`/api/...`) yêu cầu header `Authorization: Bearer <JWT>`, trừ đăng ký và đăng nhập. API nội bộ (`/internal/...`) chỉ dành cho service gọi service, yêu cầu header `X-Internal-Key` và không bao giờ được đưa ra route.

### auth-service

| Method | Đường dẫn | Ai gọi | Mô tả |
| --- | --- | --- | --- |
| POST | `/api/auth/register` | Công khai | Tạo khách hàng (gọi `account-service` `/internal/customers`) rồi tạo user `CUSTOMER`. Body: `username, password, fullName, idNumber, phone, email` |
| POST | `/api/auth/login` | Công khai | Trả `{ token, user }`. JWT chứa `sub` (user id), `role`, `customerId`, hết hạn 1 giờ |
| GET | `/api/auth/me` | Đã đăng nhập | Thông tin người dùng hiện tại |

### account-service

| Method | Đường dẫn | Ai gọi | Mô tả |
| --- | --- | --- | --- |
| GET | `/api/accounts` | CUSTOMER | Danh sách tài khoản của mình. ADMIN: tất cả, hỗ trợ `?customerId=` |
| POST | `/api/accounts` | CUSTOMER | Mở tài khoản mới (BR-01, BR-02, BR-03) |
| GET | `/api/accounts/{accountNumber}` | Chủ TK hoặc ADMIN | Chi tiết và số dư |
| GET | `/api/accounts/{accountNumber}/postings?page=&size=` | Chủ TK hoặc ADMIN | Sao kê, mới nhất trước, mặc định 20 dòng/trang |
| PATCH | `/api/accounts/{accountNumber}/status` | ADMIN | Đổi trạng thái `ACTIVE`/`FROZEN`/`CLOSED` |
| POST | `/internal/customers` | auth-service | Tạo khách hàng, trả `customerId` (BR-14) |
| GET | `/internal/accounts/{accountNumber}` | transaction-service | Trả chủ sở hữu, trạng thái, số dư |
| POST | `/internal/postings` | transaction-service | Hạch toán. Body: `{ transactionId, idempotencyKey, description, entries: [{ accountNumber, amount }] }`. Thực hiện trong MỘT database transaction (xem luồng chuyển khoản) |

### transaction-service

| Method | Đường dẫn | Ai gọi | Mô tả |
| --- | --- | --- | --- |
| POST | `/api/transactions/deposit` | ADMIN | Body: `{ toAccount, amount, description }` |
| POST | `/api/transactions/withdraw` | Chủ TK | Body: `{ fromAccount, amount, description }` |
| POST | `/api/transactions/transfer` | Chủ TK nguồn | Body: `{ fromAccount, toAccount, amount, description }` |
| GET | `/api/transactions?account=&page=&size=` | Chủ TK hoặc ADMIN | Lịch sử giao dịch của một tài khoản |
| GET | `/api/transactions/{id}` | Người tạo hoặc ADMIN | Chi tiết một giao dịch |

Ba API nạp/rút/chuyển đều bắt buộc header `Idempotency-Key` (BR-11) và trả về giao dịch kèm `status`.

### Định dạng lỗi chung

```json
{ "error": { "code": "INSUFFICIENT_FUNDS", "message": "Số dư không đủ" } }
```

| HTTP | Khi nào |
| --- | --- |
| 400 | Dữ liệu không hợp lệ (`INVALID_AMOUNT`, `WEAK_PASSWORD`...) |
| 401 | Thiếu hoặc sai JWT / `X-Internal-Key` |
| 403 | Không có quyền (`FORBIDDEN`) |
| 404 | Không tìm thấy tài khoản, giao dịch |
| 409 | Xung đột dữ liệu (`USERNAME_TAKEN`, `ACCOUNT_LIMIT_REACHED`) |
| 422 | Vi phạm nghiệp vụ (`INSUFFICIENT_FUNDS`, `DAILY_LIMIT_EXCEEDED`, `ACCOUNT_NOT_ACTIVE`) |
| 503 | Service phụ thuộc không phản hồi |

## Luồng chuyển khoản

Tiền chỉ được trừ và cộng trong bước 6, bên trong một database transaction của `account-service`; mọi bước trước đó chỉ là kiểm tra. Nạp và rút đi theo cùng luồng, chỉ khác là có một posting thay vì hai.

1. `bank-web` gửi `POST /api/transactions/transfer` kèm JWT và `Idempotency-Key` (UUID sinh ở trình duyệt).
2. `transaction-service` kiểm tra JWT, số tiền (BR-04) và hai tài khoản khác nhau (BR-07).
3. Nếu `Idempotency-Key` đã có trong `txn_svc.transactions`: trả ngay giao dịch cũ, dừng.
4. Gọi `GET /internal/accounts/{fromAccount}`: kiểm tra người gọi là chủ tài khoản (BR-09). Cộng tổng tiền rút/chuyển đi trong ngày từ `txn_svc.transactions` để kiểm tra hạn mức (BR-06).
5. Ghi giao dịch trạng thái `PENDING`.
6. Gọi `POST /internal/postings` với `entries = [{from, -amount}, {to, +amount}]`. Trong `account-service`, một database transaction làm lần lượt:
   1. Kiểm tra `idempotencyKey` trong `processed_requests`; có rồi thì trả kết quả cũ.
   2. Kiểm tra tổng `amount` bằng 0 (BR-12).
   3. Khóa các dòng tài khoản bằng `SELECT ... FOR UPDATE`, theo thứ tự `account_number` tăng dần để tránh deadlock khi hai người chuyển chéo cho nhau.
   4. Kiểm tra trạng thái (BR-08) và số dư sau trừ không âm (BR-05).
   5. Cập nhật `balance`, ghi `postings`, ghi `processed_requests`, COMMIT.
7. Thành công: cập nhật giao dịch thành `COMPLETED`. Lỗi nghiệp vụ (422): `FAILED` kèm `failure_code`. Lỗi mạng/timeout: giữ `PENDING` và trả 503.
8. Trả giao dịch về cho `bank-web`.

Trường hợp giao dịch kẹt ở `PENDING` (bước 7): người dùng gửi lại cùng `Idempotency-Key`, `transaction-service` gọi lại bước 6, và nhờ `processed_requests` nên tiền không bị trừ hai lần.

## Quy ước kỹ thuật chung

Mọi service phải chạy được bằng S2I của OpenShift mà không cần Dockerfile, và nhẹ để vừa giới hạn Sandbox.

| Hạng mục | Quy ước |
| --- | --- |
| Ngôn ngữ | Node.js 20 LTS, JavaScript (CommonJS), không TypeScript |
| Thư viện | `express`, `pg`, `jsonwebtoken`, `bcryptjs`. Không ORM, viết SQL trực tiếp với tham số `$1, $2` |
| Gọi service khác | `fetch` có sẵn của Node 20, timeout 5 giây |
| Khởi động | `package.json` có `"start": "node src/index.js"` và `"engines": { "node": ">=20" }` |
| Cổng | Đọc `PORT`, mặc định `8080` |
| Cấu hình | Chỉ đọc từ biến môi trường; không hard-code mật khẩu, không commit file `.env` |
| Database | Tự tạo schema và bảng khi khởi động; kết nối qua pool tối đa 5 kết nối |
| Health check | `GET /health/live` luôn trả 200 khi process còn chạy; `GET /health/ready` trả 200 khi kết nối được database, ngược lại 503 |
| Log | Mỗi dòng một JSON ra stdout (`level`, `msg`, `service`, `requestId`); không ghi file; không bao giờ log mật khẩu hay token |
| Request ID | Nhận hoặc sinh header `X-Request-Id`, truyền tiếp khi gọi service khác |
| Tắt máy | Bắt `SIGTERM`: ngừng nhận request, đóng pool database, thoát trong 10 giây |
| Bảo mật | Chạy được với user bất kỳ không phải root (OpenShift gán UID ngẫu nhiên); không ghi vào thư mục của app |
| Dữ liệu mẫu | Khi `SEED_DEMO_DATA=true`: tạo user `admin` (ADMIN) và 2 khách hàng mẫu, mỗi người 1 tài khoản 10.000.000 VND; mật khẩu lấy từ biến `SEED_PASSWORD` |

### Biến môi trường

| Biến | Dùng bởi | Nguồn trên OpenShift | Ví dụ |
| --- | --- | --- | --- |
| `DB_HOST`, `DB_PORT`, `DB_NAME` | cả 3 | ConfigMap `bank-common-config` | `bank-db`, `5432`, `mb_core_db` |
| `DB_USER`, `DB_PASSWORD` | cả 3 | Secret `bank-db-credentials` | `mbadmin` |
| `JWT_SECRET` | cả 3 | Secret `bank-app-secrets` | chuỗi ngẫu nhiên ≥ 32 ký tự |
| `INTERNAL_API_KEY` | cả 3 | Secret `bank-app-secrets` | chuỗi ngẫu nhiên |
| `ACCOUNT_SERVICE_URL` | auth, transaction | ConfigMap `bank-common-config` | `http://account-service:8080` |
| `TXN_MIN_AMOUNT`, `TXN_MAX_AMOUNT`, `DAILY_DEBIT_LIMIT` | transaction | ConfigMap `bank-common-config` | `1000`, `50000000`, `200000000` |
| `LOG_LEVEL` | cả 3 | ConfigMap `bank-common-config` | `info` |
| `SEED_DEMO_DATA`, `SEED_PASSWORD` | auth, account | ConfigMap / Secret | `true` |

## Cấu trúc repo và triển khai

Một repo GitHub duy nhất (monorepo), mỗi service một thư mục; OpenShift build từng thư mục bằng `--context-dir`.

```
bank-microservices/
├── README.md
├── docs/
│   └── dac-ta.md              # bản sao tài liệu này
├── services/
│   ├── auth-service/
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js       # khởi động server, SIGTERM
│   │       ├── config.js      # đọc biến môi trường
│   │       ├── db.js          # pool + tạo schema
│   │       ├── routes/
│   │       └── middleware/    # JWT, internal key, request id, lỗi
│   ├── account-service/       # cùng cấu trúc
│   └── transaction-service/   # cùng cấu trúc
├── web/
│   ├── index.html             # đăng nhập, tài khoản, chuyển khoản, lịch sử
│   ├── app.js
│   └── style.css
└── k8s/                        # viết ở giai đoạn 5, để trống lúc đầu
```

### Tài nguyên trên OpenShift

| Tài nguyên | Tên | Ghi chú |
| --- | --- | --- |
| PostgreSQL | `bank-db` | Template `postgresql-persistent`, 1Gi |
| ConfigMap | `bank-common-config` | Các biến không nhạy cảm |
| Secret | `bank-db-credentials`, `bank-app-secrets` | Mật khẩu DB, JWT, internal key |
| Deployment + Service | `auth-service`, `account-service`, `transaction-service`, `bank-web` | Build bằng S2I, cổng 8080 |
| Route | `bank` | Một tên miền, TLS edge, chia theo đường dẫn (bảng dưới) |

| Đường dẫn | Service |
| --- | --- |
| `/api/auth` | `auth-service` |
| `/api/accounts` | `account-service` |
| `/api/transactions` | `transaction-service` |
| `/` | `bank-web` |

Vì frontend và API cùng một tên miền, `bank-web` gọi API bằng đường dẫn tương đối (`/api/...`) và không cần xử lý CORS. Đường dẫn `/internal` không có route nên bên ngoài không gọi tới được.

Lệnh build mẫu cho một service:

```bash
oc new-app nodejs:20-ubi9~https://github.com/<bạn>/bank-microservices \
  --context-dir=services/account-service --name=account-service
```

Tag `nodejs:20-ubi9` cần kiểm tra bằng `oc get is nodejs -n openshift` vì tag có sẵn trên cluster có thể khác.

## Hướng dẫn cho AI sinh code

Sinh code theo từng service, mỗi lần một service, theo thứ tự `account-service` → `auth-service` → `transaction-service` → `bank-web`, vì service sau gọi service trước. Sinh xong service nào thì deploy và kiểm tra service đó trước khi làm tiếp.

### Prompt mẫu

```
Dựa vào tài liệu đặc tả đính kèm, hãy sinh toàn bộ mã nguồn cho <tên-service>.
Yêu cầu:
- Tuân thủ đúng mục "Quy ước kỹ thuật chung" và cấu trúc thư mục trong tài liệu.
- Cài đặt đủ mọi API, quy tắc nghiệp vụ (BR-xx) và mã lỗi liên quan tới service này.
- Không thêm thư viện, tính năng hay biến môi trường ngoài tài liệu.
- Ghi chú ngắn bằng tiếng Việt ở những chỗ quan trọng (transaction, khóa dòng, idempotency).
- Cuối cùng liệt kê các lệnh curl để kiểm tra từng API.
```

### Lưu ý riêng cho từng phần

- **Dữ liệu mẫu:** hai khách hàng mẫu dùng UUID cố định ghi trong code, để `auth-service` (user) và `account-service` (khách hàng, tài khoản) tự seed độc lập mà vẫn khớp nhau. Seed phải chạy lại nhiều lần không lỗi.
- **bank-web:** HTML + JavaScript thuần, không framework, không bước build. Lưu JWT trong `sessionStorage`. Build bằng S2I image `nginx` của OpenShift (`oc new-app nginx~<repo> --context-dir=web`).
- **Tiền:** `pg` trả `BIGINT` dưới dạng chuỗi; giữ dạng chuỗi trong JSON trả về hoặc chuyển sang `Number` sau khi kiểm tra nằm trong giới hạn an toàn.

### Tiêu chí nghiệm thu

- [ ] Cả 3 service build bằng S2I thành công, pod `Running` và `/health/ready` trả 200
- [ ] Đăng ký, đăng nhập, mở tài khoản qua giao diện web
- [ ] ADMIN nạp tiền, khách hàng chuyển khoản; số dư hai bên đúng
- [ ] Chuyển quá số dư trả 422 `INSUFFICIENT_FUNDS`, số dư không đổi
- [ ] Gửi lại cùng `Idempotency-Key` không trừ tiền lần hai
- [ ] Tổng số dư mọi tài khoản = tổng tiền đã nạp − tổng tiền đã rút (kiểm tra bằng SQL)
- [ ] Khách hàng A không xem được tài khoản của khách hàng B (403)
- [ ] Gọi `/internal/...` từ bên ngoài qua route không được
- [ ] Xóa pod bất kỳ, hệ thống tự phục hồi và dữ liệu còn nguyên
- [ ] Log của một giao dịch có cùng `requestId` ở cả `transaction-service` và `account-service`
