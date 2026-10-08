/**
 * Error Handler Middleware
 * Định dạng chuẩn: { "error": { "code": "...", "message": "..." } }
 * Không làm lộ chi tiết lỗi nội bộ hoặc mã lỗi SQL của PostgreSQL cho client.
 */

const logger = require('../logger');

module.exports = function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;

  // Ghi log chi tiết lỗi nội bộ ra stdout phục vụ truy vết và debug
  logger.error('Lỗi khi xử lý request', {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    pgCode: err.code,
    error: err.message,
    stack: err.stack,
  });

  if (statusCode === 503) {
    return res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Dịch vụ tạm thời không khả dụng, vui lòng thử lại sau',
      },
    });
  }

  // Với lỗi 500 / lỗi hệ thống nội bộ: trả về thông báo chung chung, ẩn mã lỗi SQL
  if (statusCode >= 500) {
    return res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Đã có lỗi xảy ra trên hệ thống, vui lòng thử lại sau',
      },
    });
  }

  // Với các lỗi 4xx nghiệp vụ có mã rõ ràng
  res.status(statusCode).json({
    error: {
      code: err.code || 'BAD_REQUEST',
      message: err.message || 'Yêu cầu không hợp lệ',
    },
  });
};
