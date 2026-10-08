/**
 * Request ID Middleware
 * Nhận hoặc sinh header X-Request-Id, gắn vào req.requestId và response header
 */

const crypto = require('crypto');

module.exports = function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  const requestId = incomingId || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
};
