const express = require('express');
const router = express.Router();
const runnerController = require('../controllers/runnerController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect);

// Any authenticated user can view a runner's rating and level
router.get('/:id/rating', runnerController.getRunnerRating);
router.get('/:id/level', runnerController.getRunnerLevel);

// Only customers can rate a runner
router.post('/:id/rate', restrictTo('customer'), runnerController.rateRunner);

module.exports = router;
