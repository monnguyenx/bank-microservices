/**
 * Router API nội bộ (/internal/...)
 * Yêu cầu header X-Internal-Key
 * Dành riêng cho auth-service và transaction-service gọi
 */

const express = require('express');
const { pool } = require('../db');
const internalKeyMiddleware = require('../middleware/internalKey');
const logger = require('../logger');

const router = express.Router();

router.use(internalKeyMiddleware);

/**
 * POST /internal/customers
 * auth-service gọi khi người dùng đăng ký
 * BR-14: Số CCCD gồm 12 chữ số và không trùng
 */
router.post('/customers', async (req, res, next) => {
  try {
    const fullName = req.body.fullName || req.body.full_name;
    const idNumber = req.body.idNumber || req.body.id_number;
    const phone = req.body.phone || null;
    const email = req.body.email || null;

    if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
      return res.status(400).json({
        error: {
          code: 'INVALID_INPUT',
          message: 'Họ và tên không được để trống',
        },
      });
    }

    // BR-14: Kiểm tra CCCD 12 chữ số
    if (!idNumber || !/^\d{12}$/.test(idNumber.trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ID_NUMBER',
          message: 'Số CCCD của khách hàng phải gồm đúng 12 chữ số',
        },
      });
    }

    const cleanIdNumber = idNumber.trim();

    // BR-14: Kiểm tra trùng lặp CCCD
    const existing = await pool.query(
      'SELECT id FROM account_svc.customers WHERE id_number = $1',
      [cleanIdNumber]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: {
          code: 'ID_NUMBER_TAKEN',
          message: 'Số CCCD đã tồn tại trong hệ thống',
        },
      });
    }

    const insertRes = await pool.query(
      `INSERT INTO account_svc.customers (full_name, id_number, phone, email)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, id_number, phone, email, created_at`,
      [fullName.trim(), cleanIdNumber, phone ? phone.trim() : null, email ? email.trim() : null]
    );

    const customer = insertRes.rows[0];

    logger.info('Tạo khách hàng mới thành công (internal)', {
      requestId: req.requestId,
      customerId: customer.id,
      idNumber: customer.id_number,
    });

    return res.status(201).json({
      customerId: customer.id,
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        idNumber: customer.id_number,
        phone: customer.phone,
        email: customer.email,
        createdAt: customer.created_at,
      },
    });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({
        error: {
          code: 'ID_NUMBER_TAKEN',
          message: 'Số CCCD đã tồn tại trong hệ thống',
        },
      });
    }
    next(err);
  }
});

/**
 * GET /internal/accounts/:accountNumber
 * transaction-service gọi để lấy thông tin chủ sở hữu, trạng thái, số dư
 */
router.get('/accounts/:accountNumber', async (req, res, next) => {
  try {
    const { accountNumber } = req.params;

    const result = await pool.query(
      `SELECT id, account_number, customer_id, currency, balance, status, created_at, updated_at
       FROM account_svc.accounts
       WHERE account_number = $1`,
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

    const row = result.rows[0];
    return res.status(200).json({
      id: row.id,
      accountNumber: row.account_number,
      customerId: row.customer_id,
      currency: row.currency,
      balance: Number(row.balance),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /internal/postings
 * transaction-service gọi để hạch toán số dư và ghi sổ cái
 * Body: { transactionId, idempotencyKey, description, entries: [{ accountNumber, amount }] }
 * THỰC HIỆN TRONG MỘT DATABASE TRANSACTION DUY NHẤT:
 * 1. Kiểm tra idempotencyKey trong processed_requests (BR-11)
 * 2. Kiểm tra tổng amount bằng 0 với chuyển khoản (BR-12)
 * 3. Khóa các dòng tài khoản bằng SELECT ... FOR UPDATE theo thứ tự account_number tăng dần để tránh deadlock
 * 4. Kiểm tra trạng thái tài khoản (BR-08) và số dư sau trừ không âm (BR-05)
 * 5. Cập nhật balance, ghi postings, ghi processed_requests, COMMIT
 */
router.post('/postings', async (req, res, next) => {
  const { transactionId, idempotencyKey, description, entries } = req.body;

  if (!idempotencyKey) {
    return res.status(400).json({
      error: {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Thiếu idempotencyKey trong yêu cầu hạch toán',
      },
    });
  }

  if (!transactionId) {
    return res.status(400).json({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Thiếu transactionId trong yêu cầu hạch toán',
      },
    });
  }

  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({
      error: {
        code: 'INVALID_ENTRIES',
        message: 'Danh sách entries không hợp lệ',
      },
    });
  }

  // Kiểm tra từng entry: accountNumber và amount (phải là số nguyên khác 0)
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.accountNumber) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ENTRIES',
          message: 'Mỗi bút toán phải có accountNumber hợp lệ',
        },
      });
    }

    if (entry.amount === undefined || entry.amount === null) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Số tiền bút toán không được để trống',
        },
      });
    }

    // Kiểm tra amount là số nguyên khác 0 (không nhận số 0, số lẻ, chuỗi linh tinh)
    const amountStr = String(entry.amount).trim();
    if (!/^-?[1-9]\d*$/.test(amountStr)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: 'Số tiền bút toán phải là số nguyên khác 0',
        },
      });
    }
  }

  let client;
  try {
    // Kết nối client riêng từ pool để thực thi Transaction
    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Kiểm tra Idempotency trong processed_requests
    // Nếu request này đã từng thực hiện thành công, trả ngay kết quả cũ
    const existingReqRes = await client.query(
      'SELECT response FROM account_svc.processed_requests WHERE idempotency_key = $1',
      [idempotencyKey]
    );

    if (existingReqRes.rows.length > 0) {
      await client.query('COMMIT');
      logger.info('Idempotency hit: Trả về kết quả hạch toán đã xử lý trước đó', {
        requestId: req.requestId,
        idempotencyKey,
      });
      return res.status(200).json(existingReqRes.rows[0].response);
    }

    // 2. BR-12: Với chuyển khoản (entries > 1), tổng các posting phải bằng 0
    if (entries.length > 1) {
      let sum = 0n;
      for (const entry of entries) {
        sum += BigInt(entry.amount);
      }
      if (sum !== 0n) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: {
            code: 'UNBALANCED_POSTING',
            message: 'Tổng số tiền các bút toán hạch toán phải bằng 0',
          },
        });
      }
    }

    // 3. Khóa các dòng tài khoản bằng SELECT ... FOR UPDATE theo thứ tự account_number tăng dần
    // Cơ chế chống deadlock: Dù người dùng chuyển tiền chéo A -> B và B -> A cùng lúc,
    // thứ tự khóa luôn là tài khoản có số nhỏ hơn khóa trước.
    const distinctAccountNumbers = [...new Set(entries.map((e) => e.accountNumber))].sort();

    const lockResult = await client.query(
      `SELECT id, account_number, customer_id, balance, status 
       FROM account_svc.accounts 
       WHERE account_number = ANY($1) 
       ORDER BY account_number ASC 
       FOR UPDATE`,
      [distinctAccountNumbers]
    );

    // Kiểm tra xem tất cả tài khoản trong danh sách có tồn tại hay không
    if (lockResult.rows.length !== distinctAccountNumbers.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: {
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Một hoặc nhiều tài khoản tham gia giao dịch không tồn tại',
        },
      });
    }

    // Đưa các tài khoản vào Map để tính toán
    const accountMap = new Map();
    for (const row of lockResult.rows) {
      accountMap.set(row.account_number, {
        id: row.id,
        accountNumber: row.account_number,
        customerId: row.customer_id,
        balance: BigInt(row.balance),
        status: row.status,
      });
    }

    // 4. Kiểm tra trạng thái tài khoản (BR-08) và số dư sau trừ không âm (BR-05)
    for (const entry of entries) {
      const acc = accountMap.get(entry.accountNumber);
      const entryAmount = BigInt(entry.amount);

      // BR-08: Tài khoản CLOSED không được thực hiện bất kỳ giao dịch nào
      if (acc.status === 'CLOSED') {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản ${acc.accountNumber} đã bị đóng (CLOSED)`,
          },
        });
      }

      // BR-08: Tài khoản FROZEN vẫn nhận tiền (amount > 0) nhưng không được rút/chuyển đi (amount < 0)
      if (acc.status === 'FROZEN' && entryAmount < 0n) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản ${acc.accountNumber} đang bị đóng băng (FROZEN), không thể trừ tiền`,
          },
        });
      }

      // BR-05: Số dư không bao giờ âm
      const newBalance = acc.balance + entryAmount;
      if (newBalance < 0n) {
        await client.query('ROLLBACK');
        return res.status(422).json({
          error: {
            code: 'INSUFFICIENT_FUNDS',
            message: `Số dư tài khoản ${acc.accountNumber} không đủ để thực hiện giao dịch`,
          },
        });
      }

      // Cập nhật số dư trong bộ nhớ Map để tiếp tục kiểm tra các entry tiếp theo (nếu có)
      acc.balance = newBalance;
    }

    // 5. Cập nhật balance của từng tài khoản vào cơ sở dữ liệu
    for (const acc of accountMap.values()) {
      await client.query(
        'UPDATE account_svc.accounts SET balance = $1, updated_at = now() WHERE id = $2',
        [acc.balance.toString(), acc.id]
      );
    }

    // 6. Ghi các bút toán vào sổ cái postings (chỉ INSERT, không bao giờ UPDATE/DELETE)
    const createdPostings = [];
    for (const entry of entries) {
      const acc = accountMap.get(entry.accountNumber);
      const postingRes = await client.query(
        `INSERT INTO account_svc.postings (account_id, amount, balance_after, transaction_id, description)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, account_id, amount, balance_after, transaction_id, description, created_at`,
        [acc.id, entry.amount.toString(), acc.balance.toString(), transactionId, description || null]
      );

      const p = postingRes.rows[0];
      createdPostings.push({
        id: p.id,
        accountId: p.account_id,
        accountNumber: entry.accountNumber,
        amount: Number(p.amount),
        balanceAfter: Number(p.balance_after),
        transactionId: p.transaction_id,
        description: p.description,
        createdAt: p.created_at,
      });
    }

    const responseData = {
      success: true,
      transactionId,
      postings: createdPostings,
    };

    // 7. Ghi nhận idempotency_key và response vào processed_requests
    await client.query(
      'INSERT INTO account_svc.processed_requests (idempotency_key, response) VALUES ($1, $2)',
      [idempotencyKey, JSON.stringify(responseData)]
    );

    // 8. Hoàn tất giao dịch (COMMIT)
    await client.query('COMMIT');

    logger.info('Hạch toán posting thành công', {
      requestId: req.requestId,
      transactionId,
      idempotencyKey,
      postingsCount: createdPostings.length,
    });

    return res.status(200).json(responseData);
  } catch (err) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        logger.error('Lỗi khi ROLLBACK transaction', { error: rollbackErr.message });
      }
    }
    logger.error('Lỗi trong quá trình hạch toán posting', {
      requestId: req.requestId,
      error: err.message,
      stack: err.stack,
    });
    next(err);
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
