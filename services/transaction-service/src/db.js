/**
 * Kết nối PostgreSQL và khởi tạo Schema cho transaction-service
 * Schema: txn_svc
 * Sử dụng pool tối đa 5 kết nối, cơ chế retry 5 lần (mỗi lần cách 3 giây) khi khởi động.
 */

const { Pool } = require('pg');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.error('Lỗi kết nối cơ sở dữ liệu ngoài dự kiến', { error: err.message });
});

// 2 Giao dịch nạp tiền mẫu để khớp 100% với postings và tài khoản bên account-service
const DEMO_TRANSACTIONS = [
  {
    id: 'd0000000-0000-0000-0000-000000000001',
    type: 'DEPOSIT',
    fromAccount: null,
    toAccount: '100000000001',
    amount: 10000000,
    description: 'Nạp tiền ban đầu (Dữ liệu mẫu)',
    status: 'COMPLETED',
    idempotencyKey: 'seed-deposit-1',
    createdBy: 'f0000000-0000-0000-0000-000000000000',
  },
  {
    id: 'd0000000-0000-0000-0000-000000000002',
    type: 'DEPOSIT',
    fromAccount: null,
    toAccount: '100000000002',
    amount: 10000000,
    description: 'Nạp tiền ban đầu (Dữ liệu mẫu)',
    status: 'COMPLETED',
    idempotencyKey: 'seed-deposit-2',
    createdBy: 'f0000000-0000-0000-0000-000000000000',
  },
];

async function seedDemoData(client) {
  logger.info('Bắt đầu khởi tạo dữ liệu mẫu (Seed Demo Data) cho transaction-service...');

  for (const t of DEMO_TRANSACTIONS) {
    await client.query(
      `INSERT INTO txn_svc.transactions (
        id, type, from_account, to_account, amount, description, status, idempotency_key, created_by, completed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (id) DO NOTHING`,
      [
        t.id,
        t.type,
        t.fromAccount,
        t.toAccount,
        t.amount,
        t.description,
        t.status,
        t.idempotencyKey,
        t.createdBy,
      ]
    );
  }

  logger.info('Khởi tạo dữ liệu mẫu cho transaction-service thành công.');
}

// Thử kết nối database tối đa maxRetries lần, mỗi lần cách delayMs
async function connectWithRetry(maxRetries = 5, delayMs = 3000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`Đang thử kết nối database (lần ${attempt}/${maxRetries})...`);
      const client = await pool.connect();
      return client;
    } catch (err) {
      logger.warn(`Kết nối database lần ${attempt} thất bại: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error(`Đã thử kết nối database ${maxRetries} lần nhưng không thành công: ${err.message}`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function initDb() {
  const client = await connectWithRetry(5, 3000);
  try {
    logger.info('Bắt đầu kiểm tra và tạo Schema/Bảng cho txn_svc...');

    // Tạo schema riêng cho transaction-service
    await client.query('CREATE SCHEMA IF NOT EXISTS txn_svc;');

    // Tạo bảng giao dịch (transactions)
    await client.query(`
      CREATE TABLE IF NOT EXISTS txn_svc.transactions (
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
    `);

    logger.info('Khởi tạo Schema và bảng txn_svc.transactions hoàn tất.');

    if (config.seedDemoData) {
      await seedDemoData(client);
    }
  } catch (err) {
    logger.error('Lỗi khi khởi tạo database cho transaction-service', {
      error: err.message,
      stack: err.stack,
    });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb,
  DEMO_TRANSACTIONS,
};
