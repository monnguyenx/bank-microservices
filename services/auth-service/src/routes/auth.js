/**
 * Router xác thực (/api/auth)
 * Cung cấp các API:
 * - POST /api/auth/register (Công khai): Tạo khách hàng qua account-service rồi tạo user CUSTOMER
 * - POST /api/auth/login (Công khai): Trả { token, user } với JWT HS256 hết hạn 1 giờ
 * - GET /api/auth/me (Bearer JWT): Thông tin người dùng hiện tại
 * Tuân thủ quy tắc nghiệp vụ: BR-13, BR-14
 */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const config = require('../config');
const { pool } = require('../db');
const logger = require('../logger');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);

/**
 * POST /api/auth/register
 * Tạo khách hàng mới rồi tạo tài khoản người dùng CUSTOMER
 * Body: { username, password, fullName, idNumber, phone, email }
 *
 * Yêu cầu:
 * - Kiểm tra username đã tồn tại và mật khẩu hợp lệ TRƯỚC khi gọi account-service để tránh tạo khách hàng thừa.
 * - Gọi POST {ACCOUNT_SERVICE_URL}/internal/customers kèm header X-Internal-Key và X-Request-Id, timeout 5 giây.
 * - account-service lỗi (5xx) hoặc timeout thì trả 503 SERVICE_UNAVAILABLE.
 * - Lỗi 400/409 từ account-service (INVALID_ID_NUMBER, ID_NUMBER_TAKEN) thì trả nguyên mã lỗi đó.
 */
router.post('/register', async (req, res, next) => {
  try {
    const { username, password, phone, email } = req.body;
    const fullName = req.body.fullName || req.body.full_name;
    const idNumber = req.body.idNumber || req.body.id_number;

    // 1. Kiểm tra tính hợp lệ cơ bản của dữ liệu đầu vào
    const cleanUsername = typeof username === 'string' ? username.trim() : '';
    if (!/^[a-zA-Z0-9_.]{3,50}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_USERNAME',
          message: 'Tên đăng nhập 3-50 ký tự, chỉ gồm chữ không dấu, số, dấu chấm, gạch dưới',
        },
      });
    }

    // BR-13: Mật khẩu tối thiểu 8 ký tự
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({
        error: {
          code: 'WEAK_PASSWORD',
          message: 'Mật khẩu phải có tối thiểu 8 ký tự',
        },
      });
    }

    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Họ và tên không được để trống',
        },
      });
    }

    // BR-14: Số CCCD gồm 12 chữ số
    if (!idNumber || !/^\d{12}$/.test(String(idNumber).trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ID_NUMBER',
          message: 'Số CCCD của khách hàng phải gồm đúng 12 chữ số',
        },
      });
    }

    const cleanIdNumber = String(idNumber).trim();

    // 2. BR-13: Kiểm tra tên đăng nhập duy nhất trong auth_svc.users TRƯỚC KHI gọi account-service
    const existingUserRes = await pool.query(
      'SELECT id FROM auth_svc.users WHERE username = $1',
      [cleanUsername]
    );

    if (existingUserRes.rows.length > 0) {
      return res.status(409).json({
        error: {
          code: 'USERNAME_TAKEN',
          message: 'Tên đăng nhập đã được sử dụng',
        },
      });
    }

    // 3. Sau khi xác thực hợp lệ toàn bộ thông tin nội bộ, mới gọi sang account-service để tạo khách hàng
    let customerId = null;
    try {
      const accountServiceRes = await fetch(`${config.accountServiceUrl}/internal/customers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Key': config.internalApiKey,
          'X-Request-Id': req.requestId,
        },
        body: JSON.stringify({
          fullName: fullName.trim(),
          idNumber: cleanIdNumber,
          phone: phone ? String(phone).trim() : null,
          email: email ? String(email).trim() : null,
        }),
        signal: AbortSignal.timeout(5000), // Timeout 5 giây
      });

      const accountData = await accountServiceRes.json().catch(() => null);

      if (!accountServiceRes.ok) {
        // Lỗi 400/409 từ account-service (ví dụ INVALID_ID_NUMBER, ID_NUMBER_TAKEN) thì trả nguyên mã lỗi đó
        if (accountServiceRes.status === 400 || accountServiceRes.status === 409) {
          if (accountData && accountData.error) {
            return res.status(accountServiceRes.status).json(accountData);
          }
        }

        // Các lỗi khác của account-service (5xx hoặc lỗi bất ngờ) -> trả 503 SERVICE_UNAVAILABLE
        return res.status(503).json({
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'account-service không phản hồi hoặc gặp lỗi',
          },
        });
      }

      customerId = accountData.customerId || (accountData.customer && accountData.customer.id);
      if (!customerId) {
        throw new Error('account-service không trả về customerId');
      }
    } catch (fetchErr) {
      logger.error('Lỗi khi gọi sang account-service', {
        requestId: req.requestId,
        error: fetchErr.message,
      });

      // Nếu timeout hoặc mất kết nối: trả 503 SERVICE_UNAVAILABLE
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'account-service không phản hồi hoặc đang bảo trì',
        },
      });
    }

    // 4. BR-13: Mã hóa mật khẩu bằng bcrypt
    const passwordHash = await bcrypt.hash(password, 10);

    // 5. Lưu thông tin người dùng vào auth_svc.users với vai trò CUSTOMER
    // Bọc trong try/catch để thực hiện Giao dịch bù trừ (Saga pattern) nếu có lỗi
    let newUser;
    try {
      const insertUserRes = await pool.query(
        `INSERT INTO auth_svc.users (username, password_hash, role, customer_id)
         VALUES ($1, $2, 'CUSTOMER', $3)
         RETURNING id, username, role, customer_id, created_at`,
        [cleanUsername, passwordHash, customerId]
      );
      newUser = insertUserRes.rows[0];
    } catch (insertErr) {
      logger.warn('INSERT user thất bại, bắt đầu giao dịch bù trừ (xóa khách hàng tại account-service)', {
        requestId: req.requestId,
        customerId,
        error: insertErr.message,
      });

      // Giao dịch bù trừ: Gọi account-service xóa khách hàng mồ côi vừa tạo
      try {
        const compensateRes = await fetch(`${config.accountServiceUrl}/internal/customers/${customerId}`, {
          method: 'DELETE',
          headers: {
            'X-Internal-Key': config.internalApiKey,
            'X-Request-Id': req.requestId,
          },
          signal: AbortSignal.timeout(5000),
        });

        if (!compensateRes.ok) {
          logger.error('Giao dịch bù trừ thất bại tại account-service! Cần can thiệp thủ công', {
            requestId: req.requestId,
            customerId,
            status: compensateRes.status,
          });
        } else {
          logger.info('Giao dịch bù trừ thành công: Đã xóa khách hàng tại account-service', {
            requestId: req.requestId,
            customerId,
          });
        }
      } catch (compensateErr) {
        logger.error('Lỗi kết nối khi thực hiện giao dịch bù trừ sang account-service! Cần can thiệp thủ công', {
          requestId: req.requestId,
          customerId,
          error: compensateErr.message,
        });
      }

      // Trả lỗi cho client như cũ: 409 nếu trùng username (race condition), 500 nếu lỗi khác
      if (insertErr.code === '23505') {
        return res.status(409).json({
          error: {
            code: 'USERNAME_TAKEN',
            message: 'Tên đăng nhập đã được sử dụng',
          },
        });
      }

      throw insertErr;
    }

    logger.info('Đăng ký người dùng mới thành công', {
      requestId: req.requestId,
      userId: newUser.id,
      username: newUser.username,
      customerId: newUser.customer_id,
    });

    return res.status(201).json({
      id: newUser.id,
      username: newUser.username,
      role: newUser.role,
      customerId: newUser.customer_id,
      createdAt: newUser.created_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Đăng nhập người dùng, trả token JWT và thông tin user
 * Body: { username, password }
 *
 * Yêu cầu:
 * - Sai username hoặc sai mật khẩu đều trả cùng một lỗi 401 INVALID_CREDENTIALS để không lộ username nào tồn tại.
 * - JWT ký bằng HS256, hết hạn 1 giờ, payload gồm sub, role, customerId.
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Vui lòng cung cấp đầy đủ tên đăng nhập và mật khẩu',
        },
      });
    }

    const userRes = await pool.query(
      'SELECT id, username, password_hash, role, customer_id FROM auth_svc.users WHERE username = $1',
      [username.trim()]
    );
    const user = userRes.rows[0];

    const isPasswordValid = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);

    if (!user || !isPasswordValid) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        },
      });
    }

    // Tạo JWT token: thời hạn 1 giờ, thuật toán HS256, payload gồm sub, role, customerId
    const token = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        customerId: user.customer_id,
      },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        expiresIn: '1h',
      }
    );

    logger.info('Người dùng đăng nhập thành công', {
      requestId: req.requestId,
      userId: user.id,
      username: user.username,
      role: user.role,
    });

    return res.status(200).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        customerId: user.customer_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me
 * Lấy thông tin tài khoản của người dùng hiện tại (yêu cầu JWT)
 * Kiểm tra định dạng UUID trước khi truy vấn, sai định dạng trả 400.
 */
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;

    // Kiểm tra định dạng UUID trước khi truy vấn DB
    if (!userId || !UUID_REGEX.test(userId)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ID',
          message: 'Định dạng ID người dùng không hợp lệ',
        },
      });
    }

    const userRes = await pool.query(
      'SELECT id, username, role, customer_id, created_at FROM auth_svc.users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'USER_NOT_FOUND',
          message: 'Không tìm thấy thông tin người dùng',
        },
      });
    }

    const user = userRes.rows[0];

    return res.status(200).json({
      id: user.id,
      username: user.username,
      role: user.role,
      customerId: user.customer_id,
      createdAt: user.created_at,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
