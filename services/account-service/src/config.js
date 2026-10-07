/**
 * Cấu hình cho account-service
 * Chỉ đọc từ biến môi trường, không hard-code thông tin nhạy cảm.
 */

module.exports = {
  // Cổng lắng nghe HTTP server, mặc định 8080 theo quy ước OpenShift
  port: parseInt(process.env.PORT, 10) || 8080,

  // Cấu hình kết nối PostgreSQL
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'mb_core_db',
    user: process.env.DB_USER || 'mbadmin',
    password: process.env.DB_PASSWORD || '',
    max: 5, // Giới hạn tối đa 5 kết nối pool để tiết kiệm tài nguyên Sandbox
  },

  // Khóa bí mật ký và xác thực JWT (dùng chung giữa các service)
  jwtSecret: process.env.JWT_SECRET || 'mini-bank-super-secret-jwt-key-2026-min-32-chars',

  // Khóa API nội bộ để xác thực gọi service-to-service
  internalApiKey: process.env.INTERNAL_API_KEY || 'mini-bank-internal-api-secret-key-2026',

  // Cấp độ ghi log: 'info', 'warn', 'error', 'debug'
  logLevel: process.env.LOG_LEVEL || 'info',

  // Cấu hình khởi tạo dữ liệu mẫu
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',
  seedPassword: process.env.SEED_PASSWORD || 'Demo@123456',
};
