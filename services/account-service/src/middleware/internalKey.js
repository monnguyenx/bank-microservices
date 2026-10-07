/**
 * Internal Key Middleware
 * Xác thực API nội bộ service-to-service qua header X-Internal-Key
 */

const config = require('../config');

module.exports = function internalKeyMiddleware(req, res, next) {
  const internalKey = req.headers['x-internal-key'];
  if (!internalKey || internalKey !== config.internalApiKey) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Thiếu hoặc sai header X-Internal-Key',
      },
    });
  }
  next();
};
