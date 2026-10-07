/**
 * Kết nối PostgreSQL và khởi tạo Schema cho auth-service
 * Schema: auth_svc
 * Sử dụng pool tối đa 5 kết nối theo đặc tả.
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const config = require('./config');
const logger = require('./logger');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  logger.error('Lỗi kết nối cơ sở dữ liệu ngoài dự kiến', { error: err.message });
});

// UUID cố định của khách hàng mẫu để khớp chính xác với account-service
const DEMO_USERS = [
  {
    id: 'f0000000-0000-0000-0000-000000000000',
    username: 'admin',
    role: 'ADMIN',
    customerId: null,
  },
  {
    id: 'f0000000-0000-0000-0000-000000000001',
    username: 'user_a',
    role: 'CUSTOMER',
    customerId: 'a0000000-0000-0000-0000-000000000001',
  },
  {
    id: 'f0000000-0000-0000-0000-000000000002',
    username: 'user_b',
    role: 'CUSTOMER',
    customerId: 'a0000000-0000-0000-0000-000000000002',
  },
];

async function seedDemoData(client) {
  logger.info('Bắt đầu khởi tạo dữ liệu mẫu (Seed Demo Data) cho auth-service...');

  const passwordHash = await bcrypt.hash(config.seedPassword, 10);

  for (const u of DEMO_USERS) {
    await client.query(
      `INSERT INTO auth_svc.users (id, username, password_hash, role, customer_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (username) DO NOTHING`,
      [u.id, u.username, passwordHash, u.role, u.customerId]
    );
  }

  logger.info('Khởi tạo dữ liệu mẫu cho auth-service thành công.');
}

async function initDb() {
  const client = await pool.connect();
  try {
    logger.info('Bắt đầu kiểm tra và tạo Schema/Bảng cho auth_svc...');

    // Tạo schema riêng cho auth-service
    await client.query('CREATE SCHEMA IF NOT EXISTS auth_svc;');

    // Tạo bảng người dùng (users)
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_svc.users (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username      VARCHAR(50) UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role          VARCHAR(10) NOT NULL CHECK (role IN ('CUSTOMER','ADMIN')),
        customer_id   UUID,              -- ID khách hàng bên account_svc; NULL với ADMIN
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    logger.info('Khởi tạo Schema và bảng auth_svc.users hoàn tất.');

    if (config.seedDemoData) {
      await seedDemoData(client);
    }
  } catch (err) {
    logger.error('Lỗi khi khởi tạo database cho auth-service', { error: err.message, stack: err.stack });
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  initDb,
  DEMO_USERS,
};
