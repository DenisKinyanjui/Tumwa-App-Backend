const express = require('express');
const router = express.Router();
const favoriteController = require('../controllers/favoriteController');
const { protect, restrictTo } = require('../middleware/authMiddleware');

router.use(protect, restrictTo('customer'));

router.get('/runners', favoriteController.getFavoriteRunners);
router.post('/runners/:runnerId', favoriteController.addFavoriteRunner);
router.delete('/runners/:runnerId', favoriteController.removeFavoriteRunner);

module.exports = router;
