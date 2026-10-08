/**
 * JWT Authentication Middleware
 * Xác thực token từ header Authorization: Bearer <JWT>
 * Chỉ chấp nhận thuật toán HS256, lấy ra sub (user id), role, customerId gắn vào req.user
 */

const jwt = require('jsonwebtoken');
const config = require('../config');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Thiếu hoặc sai định dạng header Authorization',
      },
    });
  }

  const token = authHeader.substring(7).trim();
  try {
    const decoded = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'],
    });
    req.user = {
      id: decoded.sub,
      role: decoded.role,
      customerId: decoded.customerId,
    };
    next();
  } catch (err) {
    return res.status(401).json({
      error: {
        code: 'UNAUTHORIZED',
        message: 'JWT token không hợp lệ hoặc đã hết hạn',
      },
    });
  }
};
