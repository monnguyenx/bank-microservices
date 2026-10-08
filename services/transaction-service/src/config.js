/**
 * Cấu hình cho transaction-service
 * Bắt buộc các biến môi trường: DB_USER, DB_PASSWORD, JWT_SECRET, INTERNAL_API_KEY, ACCOUNT_SERVICE_URL.
 * Thiếu thì throw lỗi và dừng ngay lập tức.
 * Tuyệt đối không có giá trị mặc định cho bất kỳ secret nào.
 */

const requiredVars = [
  'DB_USER',
  'DB_PASSWORD',
  'JWT_SECRET',
  'INTERNAL_API_KEY',
  'ACCOUNT_SERVICE_URL',
];

for (const key of requiredVars) {
  if (!process.env[key]) {
    throw new Error(`Biến môi trường bắt buộc ${key} chưa được thiết lập`);
  }
}

module.exports = {
  // Cổng lắng nghe HTTP server, mặc định 8080 theo quy ước OpenShift
  port: parseInt(process.env.PORT, 10) || 8080,

  // Cấu hình kết nối PostgreSQL
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 5432,
    database: process.env.DB_NAME || 'mb_core_db',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    max: 5, // Giới hạn tối đa 5 kết nối pool để tiết kiệm tài nguyên Sandbox
  },

  // Khóa bí mật ký và xác thực JWT
  jwtSecret: process.env.JWT_SECRET,

  // Khóa API nội bộ để gọi sang account-service
  internalApiKey: process.env.INTERNAL_API_KEY,

  // Địa chỉ gọi nội bộ của account-service
  accountServiceUrl: process.env.ACCOUNT_SERVICE_URL,

  // Các hạn mức giao dịch (đọc từ biến môi trường, có giá trị mặc định)
  txnMinAmount: parseInt(process.env.TXN_MIN_AMOUNT, 10) || 1000,
  txnMaxAmount: parseInt(process.env.TXN_MAX_AMOUNT, 10) || 50000000,
  dailyDebitLimit: parseInt(process.env.DAILY_DEBIT_LIMIT, 10) || 200000000,

  // Cấp độ ghi log: 'info', 'warn', 'error', 'debug'
  logLevel: process.env.LOG_LEVEL || 'info',

  // Cấu hình khởi tạo dữ liệu mẫu
  seedDemoData: process.env.SEED_DEMO_DATA === 'true',
};
