/**
 * Health check routes
 * GET /health/live: Liveness probe (200 khi process đang chạy)
 * GET /health/ready: Readiness probe (200 khi kết nối được DB, 503 khi mất kết nối)
 */

const express = require('express');
const { pool } = require('../db');

const router = express.Router();

router.get('/live', (req, res) => {
  res.status(200).json({ status: 'UP' });
});

router.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'UP', database: 'CONNECTED' });
  } catch (err) {
    res.status(503).json({
      status: 'DOWN',
      database: 'DISCONNECTED',
      error: err.message,
    });
  }
});

module.exports = router;
