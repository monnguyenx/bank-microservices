/**
 * Khởi động server transaction-service
 * Tuân thủ đầy đủ các quy ước kỹ thuật:
 * - Express, JSON body parsing
 * - X-Request-Id middleware
 * - Structured JSON logging ra stdout (bỏ qua /health)
 * - Tự tạo schema lúc khởi động với cơ chế retry 5 lần
 * - Lắng nghe cổng PORT (mặc định 8080)
 * - Xử lý SIGTERM graceful shutdown trong 10 giây
 */

const express = require('express');
const config = require('./config');
const logger = require('./logger');
const { initDb, pool } = require('./db');

const requestIdMiddleware = require('./middleware/requestId');
const errorHandler = require('./middleware/errorHandler');

const healthRoutes = require('./routes/health');
const transactionsRoutes = require('./routes/transactions');

const app = express();

// Parse request body dạng JSON
app.use(express.json());

// Gán và chuyển tiếp X-Request-Id
app.use(requestIdMiddleware);

// Middleware ghi log request vào/ra theo chuẩn JSON (bỏ qua /health)
app.use((req, res, next) => {
  if (req.path.startsWith('/health')) {
    return next();
  }
  const start = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info('HTTP Request', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs,
    });
  });
  next();
});

// Định tuyến các nhóm API
app.use('/health', healthRoutes);
app.use('/api/transactions', transactionsRoutes);

// Xử lý 404 cho các route không tồn tại
app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Đường dẫn ${req.method} ${req.originalUrl} không tồn tại`,
    },
  });
});

// Middleware xử lý lỗi tập trung
app.use(errorHandler);

let server = null;

// Hàm khởi động dịch vụ
async function startServer() {
  try {
    // Khởi tạo schema và bảng database (có retry 5 lần, mỗi lần cách 3s)
    await initDb();

    server = app.listen(config.port, () => {
      logger.info(`transaction-service đã khởi động thành công trên cổng ${config.port}`, {
        port: config.port,
        nodeEnv: process.env.NODE_ENV || 'development',
        minAmount: config.txnMinAmount,
        maxAmount: config.txnMaxAmount,
        dailyLimit: config.dailyDebitLimit,
      });
    });
  } catch (err) {
    logger.error('Không thể khởi động transaction-service', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
}

// Xử lý tắt dịch vụ an toàn (Graceful Shutdown) khi nhận SIGTERM / SIGINT
function gracefulShutdown(signal) {
  logger.info(`Nhận tín hiệu ${signal}, bắt đầu tắt máy an toàn (Graceful Shutdown)...`);

  const forceExitTimeout = setTimeout(() => {
    logger.error('Quá thời gian chờ 10 giây tắt máy, bắt buộc thoát tiến trình!');
    process.exit(1);
  }, 10000);
  forceExitTimeout.unref();

  if (server) {
    server.close(async () => {
      logger.info('Đã ngừng nhận request mới. Đang đóng kết nối database pool...');
      try {
        await pool.end();
        logger.info('Đã đóng kết nối database thành công. Hoàn tất tắt máy!');
        process.exit(0);
      } catch (err) {
        logger.error('Lỗi khi đóng database pool', { error: err.message });
        process.exit(1);
      }
    });
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
