/**
 * Cấu hình cho auth-service
 * Chỉ đọc từ biến môi trường, bắt buộc cấu hình các secret nhạy cảm, không dùng fallback mặc định.
 */

if (!process.env.JWT_SECRET) {
  throw new Error('Biến môi trường bắt buộc JWT_SECRET chưa được thiết lập');
}

if (!process.env.INTERNAL_API_KEY) {
  throw new Error('Biến môi trường bắt buộc INTERNAL_API_KEY chưa được thiết lập');
}

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

  // Khóa bí mật ký và xác thực JWT
  jwtSecret: process.env.JWT_SECRET,

  // Khóa API nội bộ để gọi sang account-service
  internalApiKey: process.env.INTERNAL_API_KEY,

  // Địa chỉ gọi nội bộ của account-service
  accountServiceUrl: process.env.ACCOUNT_SERVICE_URL || 'http://account-service:8080',

  // Cấp độ ghi log: 'info', 'warn', 'error', 'debug'
  logLevel: process.env.LOG_LEVEL || 'info',

  // Cấu hình khởi tạo dữ liệu mẫu
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',
  seedPassword: process.env.SEED_PASSWORD || 'Demo@123456',
};
