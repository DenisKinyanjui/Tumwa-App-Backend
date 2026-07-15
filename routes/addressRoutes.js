const express = require('express');
const router = express.Router();
const addressController = require('../controllers/addressController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { validate, schemas } = require('../middlewares/validator');

router.use(protect, restrictTo('customer'));

router.get('/', addressController.getAddresses);
router.post('/', validate(schemas.createAddress), addressController.createAddress);
router.patch('/:id', validate(schemas.updateAddress), addressController.updateAddress);
router.delete('/:id', addressController.deleteAddress);
router.patch('/:id/set-default', addressController.setDefaultAddress);

module.exports = router;
