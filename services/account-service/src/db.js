/**
 * Kết nối PostgreSQL và khởi tạo Schema cho account-service
 * Schema: account_svc
 * Sử dụng pool tối đa 5 kết nối theo đặc tả.
 */

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.error('Lỗi kết nối cơ sở dữ liệu ngoài dự kiến', { error: err.message });
});

// UUID cố định của 2 khách hàng mẫu để đồng bộ giữa auth-service và account-service
const DEMO_CUSTOMERS = [
  {
    id: 'a0000000-0000-0000-0000-000000000001',
    fullName: 'Nguyễn Văn A',
    idNumber: '001200000001',
    phone: '0901234567',
    email: 'nguyenvana@example.com',
    accountId: 'b0000000-0000-0000-0000-000000000001',
    accountNumber: '100000000001',
    initialBalance: 10000000,
    postingId: 'c0000000-0000-0000-0000-000000000001',
    transactionId: 'd0000000-0000-0000-0000-000000000001',
  },
  {
    id: 'a0000000-0000-0000-0000-000000000002',
    fullName: 'Trần Thị B',
    idNumber: '001200000002',
    phone: '0907654321',
    email: 'tranthib@example.com',
    accountId: 'b0000000-0000-0000-0000-000000000002',
    accountNumber: '100000000002',
    initialBalance: 10000000,
    postingId: 'c0000000-0000-0000-0000-000000000002',
    transactionId: 'd0000000-0000-0000-0000-000000000002',
  },
];

async function seedDemoData(client) {
  logger.info('Bắt đầu khởi tạo dữ liệu mẫu (Seed Demo Data)...');

  for (const c of DEMO_CUSTOMERS) {
    // 1. Thêm khách hàng mẫu (ON CONFLICT id DO NOTHING)
    await client.query(
      `INSERT INTO account_svc.customers (id, full_name, id_number, phone, email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [c.id, c.fullName, c.idNumber, c.phone, c.email]
    );

    // 2. Thêm tài khoản thanh toán mẫu với số dư 10.000.000 VND
    const insertAccRes = await client.query(
      `INSERT INTO account_svc.accounts (id, account_number, customer_id, currency, balance, status)
       VALUES ($1, $2, $3, 'VND', $4, 'ACTIVE')
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [c.accountId, c.accountNumber, c.id, c.initialBalance]
    );

    // 3. Nếu tài khoản vừa được tạo mới, ghi nhận bút toán đầu tiên vào sổ cái (postings)
    if (insertAccRes.rows.length > 0) {
      await client.query(
        `INSERT INTO account_svc.postings (id, account_id, amount, balance_after, transaction_id, description)
         VALUES ($1, $2, $3, $4, $5, 'Nạp tiền ban đầu (Dữ liệu mẫu)')
         ON CONFLICT (id) DO NOTHING`,
        [c.postingId, c.accountId, c.initialBalance, c.initialBalance, c.transactionId]
      );
    }
  }

  logger.info('Khởi tạo dữ liệu mẫu thành công.');
}

async function initDb() {
  const client = await pool.connect();
  try {
    logger.info('Bắt đầu kiểm tra và tạo Schema/Bảng cho account_svc...');

    // Tạo schema riêng cho account-service
    await client.query('CREATE SCHEMA IF NOT EXISTS account_svc;');

    // 1. Bảng khách hàng (customers)
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_svc.customers (
        id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        full_name  VARCHAR(100) NOT NULL,
        id_number  CHAR(12) UNIQUE NOT NULL,   -- số CCCD (BR-14)
        phone      VARCHAR(15),
        email      VARCHAR(100),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 2. Bảng tài khoản (accounts)
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_svc.accounts (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_number CHAR(12) UNIQUE NOT NULL,
        customer_id    UUID NOT NULL REFERENCES account_svc.customers(id),
        currency       CHAR(3) NOT NULL DEFAULT 'VND',
        balance        BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0), -- BR-05: số dư không bao giờ âm
        status         VARCHAR(10) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','FROZEN','CLOSED')),
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 3. Sổ cái (postings): Mỗi dòng là một lần số dư thay đổi. Không bao giờ UPDATE hay DELETE.
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_svc.postings (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id      UUID NOT NULL REFERENCES account_svc.accounts(id),
        amount          BIGINT NOT NULL CHECK (amount <> 0),  -- dương = cộng, âm = trừ
        balance_after   BIGINT NOT NULL,
        transaction_id  UUID NOT NULL,                        -- ID bên txn_svc
        description     VARCHAR(200),
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    // 4. Bảng xử lý Idempotency (processed_requests)
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_svc.processed_requests (
        idempotency_key VARCHAR(100) PRIMARY KEY,
        response        JSONB NOT NULL,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    logger.info('Khởi tạo Schema và các bảng account_svc hoàn tất.');

    if (config.seedDemoData) {
      await seedDemoData(client);
    }
  } catch (err) {
    logger.error('Lỗi khi khởi tạo database', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb,
  DEMO_CUSTOMERS,
};
