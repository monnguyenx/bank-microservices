/**
 * Structured JSON Logger
 * Mỗi dòng một JSON ra stdout: level, msg, service, requestId...
 * Tuyệt đối không bao giờ log mật khẩu hay token.
 */

const config = require('./config');

const SERVICE_NAME = 'account-service';

const LOG_LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevelThreshold = LOG_LEVELS[config.logLevel.toLowerCase()] || LOG_LEVELS.info;

function cleanMeta(meta) {
  if (!meta || typeof meta !== 'object') return {};
  const cleaned = { ...meta };

  // Loại bỏ các trường nhạy cảm
  const sensitiveFields = ['password', 'passwordHash', 'token', 'authorization', 'jwt', 'secret'];
  for (const field of sensitiveFields) {
    if (field in cleaned) {
      cleaned[field] = '[REDACTED]';
    }
  }
  return cleaned;
}

function writeLog(level, msg, meta = {}) {
  const levelValue = LOG_LEVELS[level] || LOG_LEVELS.info;
  if (levelValue < currentLevelThreshold) {
    return;
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    msg,
    ...cleanMeta(meta),
  };

  process.stdout.write(JSON.stringify(logEntry) + '\n');
}

module.exports = {
  debug: (msg, meta) => writeLog('debug', msg, meta),
  info: (msg, meta) => writeLog('info', msg, meta),
  warn: (msg, meta) => writeLog('warn', msg, meta),
  error: (msg, meta) => writeLog('error', msg, meta),
};
