/**
 * Error Handler Middleware
 * Định dạng chuẩn: { "error": { "code": "...", "message": "..." } }
 */

const logger = require('../logger');

module.exports = function errorHandler(err, req, res, next) {
  const statusCode = err.status || err.statusCode || 500;
  const errorCode = err.code || 'INTERNAL_SERVER_ERROR';
  const errorMessage = err.message || 'Lỗi xử lý yêu cầu trên máy chủ';

  logger.error('Lỗi khi xử lý request', {
    requestId: req.requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    errorCode,
    error: err.message,
    stack: err.stack,
  });

  res.status(statusCode).json({
    error: {
      code: errorCode,
      message: errorMessage,
    },
  });
};
