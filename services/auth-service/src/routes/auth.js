/**
 * Router xác thực (/api/auth)
 * Cung cấp các API:
 * - POST /api/auth/register (Công khai): Tạo khách hàng qua account-service rồi tạo user CUSTOMER
 * - POST /api/auth/login (Công khai): Trả { token, user } với JWT hết hạn 1 giờ
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

/**
 * POST /api/auth/register
 * Tạo khách hàng mới rồi tạo tài khoản người dùng CUSTOMER
 * Body: { username, password, fullName, idNumber, phone, email }
 */
router.post('/register', async (req, res, next) => {
  try {
    const { username, password, phone, email } = req.body;
    const fullName = req.body.fullName || req.body.full_name;
    const idNumber = req.body.idNumber || req.body.id_number;

    // 1. Kiểm tra tính hợp lệ cơ bản của dữ liệu đầu vào
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Tên đăng nhập không được để trống',
        },
      });
    }

    const cleanUsername = username.trim();

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

    // 2. BR-13: Kiểm tra tên đăng nhập duy nhất trong auth_svc.users
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

    // 3. Gọi sang account-service để tạo khách hàng (Internal API)
    // Dùng native fetch của Node 20 với timeout 5 giây
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
        signal: AbortSignal.timeout(5000),
      });

      const accountData = await accountServiceRes.json().catch(() => null);

      if (!accountServiceRes.ok) {
        // Nếu account-service trả lỗi (ví dụ 409 ID_NUMBER_TAKEN), forward lại cho client
        if (accountData && accountData.error) {
          return res.status(accountServiceRes.status).json(accountData);
        }
        return res.status(accountServiceRes.status).json({
          error: {
            code: 'ACCOUNT_SERVICE_ERROR',
            message: 'Tạo thông tin khách hàng tại account-service thất bại',
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

      // Nếu timeout hoặc mất kết nối: trả 503
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
    const insertUserRes = await pool.query(
      `INSERT INTO auth_svc.users (username, password_hash, role, customer_id)
       VALUES ($1, $2, 'CUSTOMER', $3)
       RETURNING id, username, role, customer_id, created_at`,
      [cleanUsername, passwordHash, customerId]
    );

    const newUser = insertUserRes.rows[0];

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
    if (err.code === '23505') {
      return res.status(409).json({
        error: {
          code: 'USERNAME_TAKEN',
          message: 'Tên đăng nhập đã được sử dụng',
        },
      });
    }
    next(err);
  }
});

/**
 * POST /api/auth/login
 * Đăng nhập người dùng, trả token JWT và thông tin user
 * Body: { username, password }
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Vui lòng cung cấp đầy đủ tên đăng nhập và mật khẩu',
        },
      });
    }

    // Tìm kiếm người dùng theo username
    const userRes = await pool.query(
      'SELECT id, username, password_hash, role, customer_id FROM auth_svc.users WHERE username = $1',
      [username.trim()]
    );

    if (userRes.rows.length === 0) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        },
      });
    }

    const user = userRes.rows[0];

    // So khớp mật khẩu đã hash với bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid) {
      return res.status(401).json({
        error: {
          code: 'INVALID_CREDENTIALS',
          message: 'Tên đăng nhập hoặc mật khẩu không chính xác',
        },
      });
    }

    // Tạo JWT token: thời hạn 1 giờ, chứa sub, role, customerId
    const token = jwt.sign(
      {
        sub: user.id,
        role: user.role,
        customerId: user.customer_id,
      },
      config.jwtSecret,
      { expiresIn: '1h' }
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
 */
router.get('/me', authMiddleware, async (req, res, next) => {
  try {
    const userId = req.user.id;

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
