# Mini Bank (Microservices)

Hệ thống ngân hàng thu nhỏ gồm 3 microservices backend và 1 frontend, phục vụ học tập và triển khai trên OpenShift Developer Sandbox.

## Kiến trúc hệ thống
- **account-service**: Quản lý khách hàng, tài khoản, số dư, và sổ cái (`postings`). Nơi DUY NHẤT thay đổi số dư.
- **auth-service**: Đăng ký, đăng nhập, phát JWT, quản lý người dùng và phân quyền (CUSTOMER / ADMIN).
- **transaction-service**: Nhận yêu cầu nạp/rút/chuyển, kiểm tra hạn mức, ghi lịch sử giao dịch và gọi `account-service` hạch toán.
- **bank-web**: Giao diện HTML/JS thuần gọi API qua route OpenShift.

## Cấu trúc thư mục
```
bank-microservices/
├── README.md
├── docs/
│   └── dac-ta.md              # Tài liệu đặc tả hệ thống
├── services/
│   ├── account-service/       # Microservice quản lý tài khoản & số dư
│   ├── auth-service/          # Microservice xác thực & phân quyền
│   └── transaction-service/   # Microservice xử lý giao dịch
├── web/                       # Frontend HTML/JS tĩnh
└── k8s/                       # Kubernetes / OpenShift manifests
```

## Công nghệ sử dụng
- Node.js 20 LTS (CommonJS)
- Express, pg, jsonwebtoken, bcryptjs
- PostgreSQL (chung database `bank-db`, phân chia schema độc lập)
- OpenShift S2I (Source-to-Image)
