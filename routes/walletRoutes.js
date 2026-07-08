const express = require('express');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { getWallet, getTransactions, depositFloat, withdrawEarnings } = require('../controllers/walletController');

const router = express.Router();

// All wallet routes require a logged-in runner
router.use(protect, restrictTo('runner'));

router.get('/', getWallet);
router.get('/transactions', getTransactions);
router.post('/deposit-float', depositFloat);
router.post('/withdraw', withdrawEarnings);

module.exports = router;
