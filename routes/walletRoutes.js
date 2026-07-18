const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { getWallet, getTransactions, withdrawEarnings } = require('../controllers/walletController');

const router = express.Router();

router.use(protect);

// Runners see working capital + earnings; customers see their wallet credit.
router.get('/', restrictTo('runner', 'customer'), getWallet);
router.get('/transactions', restrictTo('runner', 'customer'), getTransactions);
// Withdrawal draws from earnings only — runner-only.
router.post('/withdraw', restrictTo('runner'), withdrawEarnings);

module.exports = router;
