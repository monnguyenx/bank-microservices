/**
 * Router xử lý giao dịch (/api/transactions)
 * Quản lý nạp tiền, rút tiền, chuyển khoản, lịch sử và chi tiết giao dịch.
 * Tuân thủ nghiêm ngặt các quy tắc nghiệp vụ:
 * - BR-04: Giới hạn số tiền [TXN_MIN_AMOUNT, TXN_MAX_AMOUNT]
 * - BR-06: Hạn mức ngày 200.000.000 VND (chống race condition bằng pg_advisory_xact_lock)
 * - BR-07: Không chuyển khoản cho chính mình (SAME_ACCOUNT)
 * - BR-08: Kiểm tra trạng thái FROZEN / CLOSED
 * - BR-09: Khách hàng chỉ thao tác trên tài khoản của mình
 * - BR-10: Chỉ ADMIN được nạp tiền
 * - BR-11: Idempotency-Key xử lý đầy đủ 4 trường hợp (xung đột, lặp lại, gọi lại khi PENDING)
 */

const express = require('express');
const config = require('../config');
const { pool } = require('../db');
const logger = require('../logger');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

const UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ACCOUNT_REGEX = /^\d{12}$/;

// Mọi route public của transaction-service đều yêu cầu Bearer JWT
router.use(authMiddleware);

function formatTransaction(t) {
  return {
    id: t.id,
    type: t.type,
    fromAccount: t.from_account,
    toAccount: t.to_account,
    amount: Number(t.amount),
    description: t.description,
    status: t.status,
    failureCode: t.failure_code,
    idempotencyKey: t.idempotency_key,
    createdBy: t.created_by,
    createdAt: t.created_at,
    completedAt: t.completed_at,
  };
}

// Hàm gọi API nội bộ account-service để lấy thông tin tài khoản
async function getAccountInfo(accountNumber, requestId) {
  const url = `${config.accountServiceUrl}/internal/accounts/${accountNumber}`;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'X-Internal-Key': config.internalApiKey,
        'X-Request-Id': requestId,
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.status === 404) {
      const err = new Error(`Tài khoản ${accountNumber} không tồn tại`);
      err.status = 404;
      err.code = 'ACCOUNT_NOT_FOUND';
      throw err;
    }

    if (!res.ok) {
      const err = new Error('account-service trả về lỗi');
      err.status = res.status;
      err.code = 'ACCOUNT_SERVICE_ERROR';
      throw err;
    }

    return await res.json();
  } catch (err) {
    if (err.status) throw err;
    logger.error('Lỗi kết nối khi gọi getAccountInfo sang account-service', {
      accountNumber,
      requestId,
      error: err.message,
    });
    const connErr = new Error('account-service không phản hồi hoặc đang bảo trì');
    connErr.status = 503;
    connErr.code = 'SERVICE_UNAVAILABLE';
    throw connErr;
  }
}

// Hàm hạch toán sang account-service (/internal/postings)
async function executePostings(transaction, entries, requestId) {
  const url = `${config.accountServiceUrl}/internal/postings`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': config.internalApiKey,
        'X-Request-Id': requestId,
      },
      body: JSON.stringify({
        transactionId: transaction.id,
        // Dùng idempotencyKey = transaction.id (UUID) để các user không bao giờ đụng nhau tại account-service
        idempotencyKey: transaction.id,
        description: transaction.description,
        entries,
      }),
      signal: AbortSignal.timeout(5000),
    });

    const data = await res.json().catch(() => null);

    if (res.ok) {
      return { success: true, data };
    }

    // Nếu là lỗi 4xx nghiệp vụ từ account-service (ví dụ INSUFFICIENT_FUNDS, ACCOUNT_NOT_ACTIVE)
    if (res.status >= 400 && res.status < 500) {
      return {
        success: false,
        status: res.status,
        code: (data && data.error && data.error.code) || 'BUSINESS_ERROR',
        message: (data && data.error && data.error.message) || 'Hạch toán không thành công',
      };
    }

    // Lỗi 5xx từ account-service
    return {
      success: false,
      isTransient: true,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'account-service gặp sự cố nội bộ',
    };
  } catch (fetchErr) {
    logger.error('Lỗi khi gọi /internal/postings sang account-service', {
      transactionId: transaction.id,
      requestId,
      error: fetchErr.message,
    });
    return {
      success: false,
      isTransient: true,
      status: 503,
      code: 'SERVICE_UNAVAILABLE',
      message: 'account-service không phản hồi hoặc timeout',
    };
  }
}

// Kiểm tra Idempotency-Key đã tồn tại chưa và xử lý theo 4 trường hợp
async function checkExistingIdempotency(idempotencyKey, reqType, fromAccount, toAccount, amount, userId) {
  const result = await pool.query(
    'SELECT * FROM txn_svc.transactions WHERE idempotency_key = $1',
    [idempotencyKey]
  );

  if (result.rows.length === 0) {
    return { exists: false };
  }

  const existing = result.rows[0];

  // Trường hợp 1: Thuộc user khác -> 409 IDEMPOTENCY_KEY_CONFLICT (không lộ dữ liệu)
  if (existing.created_by !== userId) {
    const err = new Error('Idempotency-Key đã được sử dụng bởi người dùng khác');
    err.status = 409;
    err.code = 'IDEMPOTENCY_KEY_CONFLICT';
    throw err;
  }

  // Trường hợp 2: Cùng user nhưng khác type, tài khoản hoặc số tiền -> 409 IDEMPOTENCY_KEY_CONFLICT
  const isSameParams = (
    existing.type === reqType &&
    (existing.from_account || null) === (fromAccount || null) &&
    (existing.to_account || null) === (toAccount || null) &&
    BigInt(existing.amount) === BigInt(amount)
  );

  if (!isSameParams) {
    const err = new Error('Idempotency-Key đã được sử dụng với thông tin giao dịch khác');
    err.status = 409;
    err.code = 'IDEMPOTENCY_KEY_CONFLICT';
    throw err;
  }

  // Trường hợp 3 & 4: Giống hệt
  return {
    exists: true,
    transaction: existing,
    isCompletedOrFailed: existing.status === 'COMPLETED' || existing.status === 'FAILED',
    isPending: existing.status === 'PENDING',
  };
}

/**
 * POST /api/transactions/deposit
 * Nạp tiền vào tài khoản (Chỉ ADMIN thực hiện - BR-10)
 * Body: { toAccount, amount, description }
 */
router.post('/deposit', async (req, res, next) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 100) {
      return res.status(400).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Header Idempotency-Key là bắt buộc (độ dài 1-100 ký tự)',
        },
      });
    }

    // BR-10: Chỉ vai trò ADMIN được nạp tiền
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Chỉ quản trị viên mới có quyền thực hiện nạp tiền',
        },
      });
    }

    const { toAccount, amount, description } = req.body;

    // BR-04: Kiểm tra số tiền
    if (!Number.isSafeInteger(amount) || amount < config.txnMinAmount || amount > config.txnMaxAmount) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: `Số tiền giao dịch phải là số nguyên từ ${config.txnMinAmount.toLocaleString('vi-VN')} đến ${config.txnMaxAmount.toLocaleString('vi-VN')} VND`,
        },
      });
    }

    if (!toAccount || !ACCOUNT_REGEX.test(String(toAccount).trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ACCOUNT_NUMBER',
          message: 'Số tài khoản nhận tiền phải gồm đúng 12 chữ số',
        },
      });
    }

    const cleanToAccount = String(toAccount).trim();
    const cleanIdempotencyKey = idempotencyKey.trim();

    // 1. Kiểm tra Idempotency
    const idempCheck = await checkExistingIdempotency(
      cleanIdempotencyKey,
      'DEPOSIT',
      null,
      cleanToAccount,
      amount,
      req.user.id
    );

    let transaction = null;

    if (idempCheck.exists) {
      if (idempCheck.isCompletedOrFailed) {
        return res.status(200).json(formatTransaction(idempCheck.transaction));
      }
      // Đang kẹt ở PENDING -> gọi lại bước hạch toán
      transaction = idempCheck.transaction;
    } else {
      // 2. Kiểm tra tài khoản đích bên account-service
      const toAccInfo = await getAccountInfo(cleanToAccount, req.requestId);
      if (toAccInfo.status === 'CLOSED') {
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản nhận tiền ${cleanToAccount} đã bị đóng (CLOSED)`,
          },
        });
      }

      // 3. Ghi nhận giao dịch trạng thái PENDING
      const insertRes = await pool.query(
        `INSERT INTO txn_svc.transactions (
          type, from_account, to_account, amount, description, status, idempotency_key, created_by
        ) VALUES ('DEPOSIT', NULL, $1, $2, $3, 'PENDING', $4, $5)
        RETURNING *`,
        [cleanToAccount, amount, description || null, cleanIdempotencyKey, req.user.id]
      );
      transaction = insertRes.rows[0];
    }

    // 4. Hạch toán sang account-service
    const entries = [{ accountNumber: cleanToAccount, amount: amount }];
    const postingResult = await executePostings(transaction, entries, req.requestId);

    if (postingResult.success) {
      // Cập nhật giao dịch COMPLETED
      const updateRes = await pool.query(
        `UPDATE txn_svc.transactions
         SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1
         RETURNING *`,
        [transaction.id]
      );
      return res.status(200).json(formatTransaction(updateRes.rows[0]));
    }

    if (postingResult.isTransient) {
      // Giữ PENDING và trả 503
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: postingResult.message,
        },
      });
    }

    // Lỗi nghiệp vụ (4xx) -> Cập nhật FAILED kèm failure_code
    await pool.query(
      `UPDATE txn_svc.transactions
       SET status = 'FAILED', failure_code = $1, completed_at = now()
       WHERE id = $2`,
      [postingResult.code, transaction.id]
    );

    return res.status(postingResult.status).json({
      error: {
        code: postingResult.code,
        message: postingResult.message,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/transactions/withdraw
 * Rút tiền khỏi tài khoản (Chủ tài khoản nguồn - BR-09, ADMIN không được rút hộ)
 * Body: { fromAccount, amount, description }
 */
router.post('/withdraw', async (req, res, next) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 100) {
      return res.status(400).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Header Idempotency-Key là bắt buộc (độ dài 1-100 ký tự)',
        },
      });
    }

    // ADMIN không được rút hộ
    if (req.user.role === 'ADMIN') {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Quản trị viên không được phép rút tiền từ tài khoản khách hàng',
        },
      });
    }

    const { fromAccount, amount, description } = req.body;

    // BR-04: Kiểm tra số tiền
    if (!Number.isSafeInteger(amount) || amount < config.txnMinAmount || amount > config.txnMaxAmount) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: `Số tiền giao dịch phải là số nguyên từ ${config.txnMinAmount.toLocaleString('vi-VN')} đến ${config.txnMaxAmount.toLocaleString('vi-VN')} VND`,
        },
      });
    }

    if (!fromAccount || !ACCOUNT_REGEX.test(String(fromAccount).trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ACCOUNT_NUMBER',
          message: 'Số tài khoản nguồn phải gồm đúng 12 chữ số',
        },
      });
    }

    const cleanFromAccount = String(fromAccount).trim();
    const cleanIdempotencyKey = idempotencyKey.trim();

    // 1. Kiểm tra Idempotency
    const idempCheck = await checkExistingIdempotency(
      cleanIdempotencyKey,
      'WITHDRAW',
      cleanFromAccount,
      null,
      amount,
      req.user.id
    );

    let transaction = null;

    if (idempCheck.exists) {
      if (idempCheck.isCompletedOrFailed) {
        return res.status(200).json(formatTransaction(idempCheck.transaction));
      }
      transaction = idempCheck.transaction;
    } else {
      // 2. Kiểm tra chủ tài khoản & trạng thái tài khoản nguồn
      const fromAccInfo = await getAccountInfo(cleanFromAccount, req.requestId);

      // BR-09: Khách hàng chỉ thao tác trên tài khoản của mình
      if (fromAccInfo.customerId !== req.user.customerId) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Bạn không phải chủ sở hữu tài khoản nguồn',
          },
        });
      }

      // BR-08: Kiểm tra trạng thái tài khoản
      if (fromAccInfo.status === 'FROZEN' || fromAccInfo.status === 'CLOSED') {
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản nguồn đang ở trạng thái ${fromAccInfo.status}, không thể rút tiền`,
          },
        });
      }

      // 3. BR-06: Kiểm tra hạn mức ngày và INSERT PENDING trong một database transaction
      // Sử dụng pg_advisory_xact_lock(hashtext(from_account)) để chống race condition
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cleanFromAccount]);

        // Tính tổng tiền rút và chuyển đi trong ngày (từ 00:00 theo giờ Asia/Ho_Chi_Minh)
        const limitRes = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS daily_total
           FROM txn_svc.transactions
           WHERE from_account = $1
             AND type IN ('WITHDRAW', 'TRANSFER')
             AND status IN ('COMPLETED', 'PENDING')
             AND created_at >= (timezone('Asia/Ho_Chi_Minh', now())::date AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
          [cleanFromAccount]
        );

        const dailyTotal = BigInt(limitRes.rows[0].daily_total);
        if (dailyTotal + BigInt(amount) > BigInt(config.dailyDebitLimit)) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: {
              code: 'DAILY_LIMIT_EXCEEDED',
              message: `Tổng số tiền rút và chuyển trong ngày vượt quá hạn mức ${config.dailyDebitLimit.toLocaleString('vi-VN')} VND`,
            },
          });
        }

        const insertRes = await client.query(
          `INSERT INTO txn_svc.transactions (
            type, from_account, to_account, amount, description, status, idempotency_key, created_by
          ) VALUES ('WITHDRAW', $1, NULL, $2, $3, 'PENDING', $4, $5)
          RETURNING *`,
          [cleanFromAccount, amount, description || null, cleanIdempotencyKey, req.user.id]
        );

        transaction = insertRes.rows[0];
        await client.query('COMMIT');
      } catch (txnErr) {
        await client.query('ROLLBACK');
        throw txnErr;
      } finally {
        client.release();
      }
    }

    // 4. Hạch toán sang account-service
    const entries = [{ accountNumber: cleanFromAccount, amount: -amount }];
    const postingResult = await executePostings(transaction, entries, req.requestId);

    if (postingResult.success) {
      const updateRes = await pool.query(
        `UPDATE txn_svc.transactions
         SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1
         RETURNING *`,
        [transaction.id]
      );
      return res.status(200).json(formatTransaction(updateRes.rows[0]));
    }

    if (postingResult.isTransient) {
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: postingResult.message,
        },
      });
    }

    await pool.query(
      `UPDATE txn_svc.transactions
       SET status = 'FAILED', failure_code = $1, completed_at = now()
       WHERE id = $2`,
      [postingResult.code, transaction.id]
    );

    return res.status(postingResult.status).json({
      error: {
        code: postingResult.code,
        message: postingResult.message,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/transactions/transfer
 * Chuyển tiền nội bộ (Chủ tài khoản nguồn - BR-09, ADMIN không được chuyển hộ)
 * Body: { fromAccount, toAccount, amount, description }
 */
router.post('/transfer', async (req, res, next) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0 || idempotencyKey.length > 100) {
      return res.status(400).json({
        error: {
          code: 'IDEMPOTENCY_KEY_REQUIRED',
          message: 'Header Idempotency-Key là bắt buộc (độ dài 1-100 ký tự)',
        },
      });
    }

    // ADMIN không được chuyển hộ
    if (req.user.role === 'ADMIN') {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Quản trị viên không được phép chuyển tiền hộ khách hàng',
        },
      });
    }

    const { fromAccount, toAccount, amount, description } = req.body;

    // BR-04: Kiểm tra số tiền
    if (!Number.isSafeInteger(amount) || amount < config.txnMinAmount || amount > config.txnMaxAmount) {
      return res.status(400).json({
        error: {
          code: 'INVALID_AMOUNT',
          message: `Số tiền giao dịch phải là số nguyên từ ${config.txnMinAmount.toLocaleString('vi-VN')} đến ${config.txnMaxAmount.toLocaleString('vi-VN')} VND`,
        },
      });
    }

    if (!fromAccount || !ACCOUNT_REGEX.test(String(fromAccount).trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ACCOUNT_NUMBER',
          message: 'Số tài khoản nguồn phải gồm đúng 12 chữ số',
        },
      });
    }

    if (!toAccount || !ACCOUNT_REGEX.test(String(toAccount).trim())) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ACCOUNT_NUMBER',
          message: 'Số tài khoản đích phải gồm đúng 12 chữ số',
        },
      });
    }

    const cleanFromAccount = String(fromAccount).trim();
    const cleanToAccount = String(toAccount).trim();
    const cleanIdempotencyKey = idempotencyKey.trim();

    // BR-07: Không chuyển khoản cho chính tài khoản nguồn
    if (cleanFromAccount === cleanToAccount) {
      return res.status(400).json({
        error: {
          code: 'SAME_ACCOUNT',
          message: 'Không thể chuyển tiền tới chính tài khoản nguồn',
        },
      });
    }

    // 1. Kiểm tra Idempotency
    const idempCheck = await checkExistingIdempotency(
      cleanIdempotencyKey,
      'TRANSFER',
      cleanFromAccount,
      cleanToAccount,
      amount,
      req.user.id
    );

    let transaction = null;

    if (idempCheck.exists) {
      if (idempCheck.isCompletedOrFailed) {
        return res.status(200).json(formatTransaction(idempCheck.transaction));
      }
      transaction = idempCheck.transaction;
    } else {
      // 2. Kiểm tra tài khoản nguồn
      const fromAccInfo = await getAccountInfo(cleanFromAccount, req.requestId);

      // BR-09: Khách hàng chỉ thao tác trên tài khoản của mình
      if (fromAccInfo.customerId !== req.user.customerId) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Bạn không phải chủ sở hữu tài khoản nguồn',
          },
        });
      }

      // BR-08: Trạng thái tài khoản nguồn
      if (fromAccInfo.status === 'FROZEN' || fromAccInfo.status === 'CLOSED') {
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản nguồn đang ở trạng thái ${fromAccInfo.status}, không thể chuyển tiền`,
          },
        });
      }

      // Kiểm tra tài khoản đích
      const toAccInfo = await getAccountInfo(cleanToAccount, req.requestId);
      if (toAccInfo.status === 'CLOSED') {
        return res.status(422).json({
          error: {
            code: 'ACCOUNT_NOT_ACTIVE',
            message: `Tài khoản thụ hưởng ${cleanToAccount} đã bị đóng (CLOSED)`,
          },
        });
      }

      // 3. BR-06: Kiểm tra hạn mức ngày và INSERT PENDING trong một database transaction
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [cleanFromAccount]);

        const limitRes = await client.query(
          `SELECT COALESCE(SUM(amount), 0) AS daily_total
           FROM txn_svc.transactions
           WHERE from_account = $1
             AND type IN ('WITHDRAW', 'TRANSFER')
             AND status IN ('COMPLETED', 'PENDING')
             AND created_at >= (timezone('Asia/Ho_Chi_Minh', now())::date AT TIME ZONE 'Asia/Ho_Chi_Minh')`,
          [cleanFromAccount]
        );

        const dailyTotal = BigInt(limitRes.rows[0].daily_total);
        if (dailyTotal + BigInt(amount) > BigInt(config.dailyDebitLimit)) {
          await client.query('ROLLBACK');
          return res.status(422).json({
            error: {
              code: 'DAILY_LIMIT_EXCEEDED',
              message: `Tổng số tiền rút và chuyển trong ngày vượt quá hạn mức ${config.dailyDebitLimit.toLocaleString('vi-VN')} VND`,
            },
          });
        }

        const insertRes = await client.query(
          `INSERT INTO txn_svc.transactions (
            type, from_account, to_account, amount, description, status, idempotency_key, created_by
          ) VALUES ('TRANSFER', $1, $2, $3, $4, 'PENDING', $5, $6)
          RETURNING *`,
          [cleanFromAccount, cleanToAccount, amount, description || null, cleanIdempotencyKey, req.user.id]
        );

        transaction = insertRes.rows[0];
        await client.query('COMMIT');
      } catch (txnErr) {
        await client.query('ROLLBACK');
        throw txnErr;
      } finally {
        client.release();
      }
    }

    // 4. Hạch toán sang account-service
    const entries = [
      { accountNumber: cleanFromAccount, amount: -amount },
      { accountNumber: cleanToAccount, amount: amount },
    ];
    const postingResult = await executePostings(transaction, entries, req.requestId);

    if (postingResult.success) {
      const updateRes = await pool.query(
        `UPDATE txn_svc.transactions
         SET status = 'COMPLETED', completed_at = now()
         WHERE id = $1
         RETURNING *`,
        [transaction.id]
      );
      return res.status(200).json(formatTransaction(updateRes.rows[0]));
    }

    if (postingResult.isTransient) {
      return res.status(503).json({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: postingResult.message,
        },
      });
    }

    await pool.query(
      `UPDATE txn_svc.transactions
       SET status = 'FAILED', failure_code = $1, completed_at = now()
       WHERE id = $2`,
      [postingResult.code, transaction.id]
    );

    return res.status(postingResult.status).json({
      error: {
        code: postingResult.code,
        message: postingResult.message,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/transactions
 * Xem lịch sử giao dịch của một tài khoản (?account=&page=&size=)
 * Quyền: Chủ tài khoản hoặc ADMIN
 */
router.get('/', async (req, res, next) => {
  try {
    const { account } = req.query;
    const { role, customerId } = req.user;

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.min(100, Math.max(1, parseInt(req.query.size, 10) || 20));
    const offset = (page - 1) * size;

    if (account) {
      if (!ACCOUNT_REGEX.test(String(account).trim())) {
        return res.status(400).json({
          error: {
            code: 'INVALID_ACCOUNT_NUMBER',
            message: 'Số tài khoản phải gồm đúng 12 chữ số',
          },
        });
      }

      const cleanAccount = String(account).trim();

      // Nếu không phải ADMIN, kiểm tra xem người gọi có phải chủ tài khoản không
      if (role !== 'ADMIN') {
        const accInfo = await getAccountInfo(cleanAccount, req.requestId);
        if (accInfo.customerId !== customerId) {
          return res.status(403).json({
            error: {
              code: 'FORBIDDEN',
              message: 'Bạn không có quyền xem lịch sử giao dịch của tài khoản này',
            },
          });
        }
      }

      const countRes = await pool.query(
        'SELECT COUNT(*) FROM txn_svc.transactions WHERE (from_account = $1 OR to_account = $1)',
        [cleanAccount]
      );
      const total = parseInt(countRes.rows[0].count, 10);

      const itemsRes = await pool.query(
        `SELECT * FROM txn_svc.transactions
         WHERE (from_account = $1 OR to_account = $1)
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [cleanAccount, size, offset]
      );

      return res.status(200).json({
        items: itemsRes.rows.map(formatTransaction),
        total,
        page,
        size,
        totalPages: Math.ceil(total / size) || 0,
      });
    }

    // Nếu không chỉ định account: Chỉ ADMIN mới được xem toàn bộ
    if (role !== 'ADMIN') {
      return res.status(400).json({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Vui lòng cung cấp tham số account để xem lịch sử giao dịch',
        },
      });
    }

    const countRes = await pool.query('SELECT COUNT(*) FROM txn_svc.transactions');
    const total = parseInt(countRes.rows[0].count, 10);

    const itemsRes = await pool.query(
      `SELECT * FROM txn_svc.transactions
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [size, offset]
    );

    return res.status(200).json({
      items: itemsRes.rows.map(formatTransaction),
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
 * GET /api/transactions/:id
 * Xem chi tiết một giao dịch
 * Quyền: Người tạo, ADMIN, hoặc chủ của from_account / to_account
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id || !UUID_REGEX.test(id)) {
      return res.status(400).json({
        error: {
          code: 'INVALID_ID',
          message: 'Định dạng ID giao dịch không hợp lệ',
        },
      });
    }

    const result = await pool.query(
      'SELECT * FROM txn_svc.transactions WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: {
          code: 'TRANSACTION_NOT_FOUND',
          message: 'Giao dịch không tồn tại',
        },
      });
    }

    const txn = result.rows[0];
    const { role, id: userId, customerId } = req.user;

    // 1. ADMIN được xem tất cả
    if (role === 'ADMIN') {
      return res.status(200).json(formatTransaction(txn));
    }

    // 2. Người tạo giao dịch được xem
    if (txn.created_by === userId) {
      return res.status(200).json(formatTransaction(txn));
    }

    // 3. Kiểm tra xem người gọi có phải chủ của from_account hoặc to_account không
    let isOwner = false;
    if (customerId) {
      if (txn.from_account) {
        try {
          const fromAccInfo = await getAccountInfo(txn.from_account, req.requestId);
          if (fromAccInfo.customerId === customerId) isOwner = true;
        } catch (_) {}
      }

      if (!isOwner && txn.to_account) {
        try {
          const toAccInfo = await getAccountInfo(txn.to_account, req.requestId);
          if (toAccInfo.customerId === customerId) isOwner = true;
        } catch (_) {}
      }
    }

    if (!isOwner) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'Bạn không có quyền xem chi tiết giao dịch này',
        },
      });
    }

    return res.status(200).json(formatTransaction(txn));
  } catch (err) {
    next(err);
  }
});

module.exports = router;
