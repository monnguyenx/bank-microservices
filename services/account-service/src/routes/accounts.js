/**
 * Router quản lý tài khoản (/api/accounts)
 * Yêu cầu Authorization: Bearer <JWT>
 * Nghiệp vụ: BR-01, BR-02, BR-03, BR-09, BR-10
 */

const express = require('express');
const { pool } = require('../db');
const authMiddleware = require('../middleware/auth');
const logger = require('../logger');

const router = express.Router();

// Tất cả các route public trong file này đều yêu cầu JWT
router.use(authMiddleware);

function formatAccount(row) {
  return {
    id: row.id,
    accountNumber: row.account_number,
    customerId: row.customer_id,
    currency: row.currency,
    balance: Number(row.balance),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// BR-02: Sinh ngẫu nhiên số tài khoản 12 chữ số
function generateRandomAccountNumber() {
  const firstDigit = Math.floor(Math.random() * 9) + 1; // 1-9
  let rest = '';
  for (let i = 0; i < 11; i++) {
    rest += Math.floor(Math.random() * 10);
  }
  return `${firstDigit}${rest}`;
}

/**
 * GET /api/accounts
 * CUSTOMER: Danh sách tài khoản của mình
 * ADMIN: Tất cả tài khoản, hỗ trợ query ?customerId=
 */
router.get('/', async (req, res, next) => {
  try {
    const { role, customerId } = req.user;

    let queryText = '';
    let params = [];

    if (role === 'ADMIN') {
      const filterCustomerId = req.query.customerId;
      if (filterCustomerId) {
        queryText = 'SELECT * FROM account_svc.accounts WHERE customer_id = $1 ORDER BY created_at DESC';
        params = [filterCustomerId];
      } else {
        queryText = 'SELECT * FROM account_svc.accounts ORDER BY created_at DESC';
        params = [];
      }
    } else {
      // Role CUSTOMER
      if (!customerId) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Tài khoản người dùng chưa được liên kết với khách hàng',
          },
        });
      }
      queryText = 'SELECT * FROM account_svc.accounts WHERE customer_id = $1 ORDER BY created_at DESC';
      params = [customerId];
    }

    const result = await pool.query(queryText, params);
    const accounts = result.rows.map(formatAccount);
    return res.status(200).json(accounts);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/accounts
 * CUSTOMER: Mở tài khoản mới
 * Tuân thủ BR-01, BR-02, BR-03
 */
router.post('/', async (req, res, next) => {
  try {
    const { role, customerId } = req.user;

    let targetCustomerId = customerId;
    if (role === 'ADMIN') {
      targetCustomerId = req.body.customerId || customerId;
    }

    if (!targetCustomerId) {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Không tìm thấy ID khách hàng để mở tài khoản',
        },
      });
    }

    // BR-01: Mỗi khách hàng có tối đa 3 tài khoản đang hoạt động (ACTIVE)
    const countRes = await pool.query(
      "SELECT COUNT(*) FROM account_svc.accounts WHERE customer_id = $1 AND status = 'ACTIVE'",
      [targetCustomerId]
    );
    const activeCount = parseInt(countRes.rows[0].count, 10);

    if (activeCount >= 3) {
      return res.status(409).json({
        error: {
          code: 'ACCOUNT_LIMIT_REACHED',
          message: 'Mỗi khách hàng có tối đa 3 tài khoản đang hoạt động',
        },
      });
    }

    // BR-02 & BR-03: Sinh số tài khoản 12 chữ số ngẫu nhiên không trùng, số dư ban đầu 0, ACTIVE, VND
    let newAccount = null;
    let attempts = 0;
    while (!newAccount && attempts < 5) {
      attempts++;
      const accountNumber = generateRandomAccountNumber();
      try {
        const insertRes = await pool.query(
          `INSERT INTO account_svc.accounts (account_number, customer_id, currency, balance, status)
           VALUES ($1, $2, 'VND', 0, 'ACTIVE')
           RETURNING *`,
          [accountNumber, targetCustomerId]
        );
        newAccount = insertRes.rows[0];
      } catch (insertErr) {
        // Nếu trùng account_number (mã 23505 trong postgres), thử lại
        if (insertErr.code === '23505') {
          continue;
        }
        throw insertErr;
      }
    }

    if (!newAccount) {
      return res.status(500).json({
        error: {
          code: 'ACCOUNT_GENERATION_FAILED',
          message: 'Không thể khởi tạo số tài khoản hợp lệ, vui lòng thử lại',
        },
      });
    }

    logger.info('Mở tài khoản mới thành công', {
      requestId: req.requestId,
      accountNumber: newAccount.account_number,
      customerId: targetCustomerId,
    });

    return res.status(201).json(formatAccount(newAccount));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/accounts/:accountNumber
 * Chủ tài khoản hoặc ADMIN xem chi tiết và số dư
 * BR-09: Khách hàng chỉ xem tài khoản của mình
 */
router.get('/:accountNumber', async (req, res, next) => {
  try {
    const { accountNumber } = req.params;
    const { role, customerId } = req.user;

    const result = await pool.query(
      'SELECT * FROM account_svc.accounts WHERE account_number = $1',
      [accountNumber]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Tài khoản không tồn tại',
        },
      });
    }

    const account = result.rows[0];

    // BR-09: Kiểm tra quyền sở hữu
    if (role !== 'ADMIN' && account.customer_id !== customerId) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Bạn không có quyền xem thông tin tài khoản này',
        },
      });
    }

    return res.status(200).json(formatAccount(account));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/accounts/:accountNumber/postings
 * Chủ tài khoản hoặc ADMIN xem sao kê
 * Mặc định 20 dòng/trang, mới nhất trước
 */
router.get('/:accountNumber/postings', async (req, res, next) => {
  try {
    const { accountNumber } = req.params;
    const { role, customerId } = req.user;

    const accResult = await pool.query(
      'SELECT * FROM account_svc.accounts WHERE account_number = $1',
      [accountNumber]
    );

    if (accResult.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Tài khoản không tồn tại',
        },
      });
    }

    const account = accResult.rows[0];

    // BR-09: Kiểm tra quyền sở hữu
    if (role !== 'ADMIN' && account.customer_id !== customerId) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Bạn không có quyền xem sao kê của tài khoản này',
        },
      });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
    const offset = (page - 1) * size;

    // Đếm tổng số bản ghi
    const countRes = await pool.query(
      'SELECT COUNT(*) FROM account_svc.postings WHERE account_id = $1',
      [account.id]
    );
    const total = parseInt(countRes.rows[0].count, 10);

    // Lấy dữ liệu phân trang mới nhất trước
    const postingsRes = await pool.query(
      `SELECT * FROM account_svc.postings 
       WHERE account_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [account.id, size, offset]
    );

    const items = postingsRes.rows.map((p) => ({
      id: p.id,
      accountId: p.account_id,
      accountNumber: account.account_number,
      amount: Number(p.amount),
      balanceAfter: Number(p.balance_after),
      transactionId: p.transaction_id,
      description: p.description,
      createdAt: p.created_at,
    }));

    return res.status(200).json({
      items,
      total,
      page,
      size,
      totalPages: Math.ceil(total / size) || 0,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/accounts/:accountNumber/status
 * ADMIN: Đổi trạng thái ACTIVE/FROZEN/CLOSED
 * BR-10: Chỉ vai trò ADMIN được đóng băng/mở băng tài khoản
 */
router.patch('/:accountNumber/status', async (req, res, next) => {
  try {
    const { accountNumber } = req.params;
    const { role } = req.user;
    const { status } = req.body;

    // BR-10: Chỉ ADMIN được thay đổi trạng thái
    if (role !== 'ADMIN') {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Chỉ quản trị viên mới có quyền đổi trạng thái tài khoản',
        },
      });
    }

    const validStatuses = ['ACTIVE', 'FROZEN', 'CLOSED'];
    if (!status || !validStatuses.includes(status)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_STATUS',
          message: 'Trạng thái không hợp lệ (phải là ACTIVE, FROZEN hoặc CLOSED)',
        },
      });
    }

    const updateRes = await pool.query(
      `UPDATE account_svc.accounts
       SET status = $1, updated_at = now()
       WHERE account_number = $2
       RETURNING *`,
      [status, accountNumber]
    );

    if (updateRes.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Tài khoản không tồn tại',
        },
      });
    }

    const updatedAccount = updateRes.rows[0];

    logger.info('Đổi trạng thái tài khoản thành công', {
      requestId: req.requestId,
      accountNumber,
      newStatus: status,
    });

    return res.status(200).json(formatAccount(updatedAccount));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
