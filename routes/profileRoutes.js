const express = require('express');
const router = express.Router();
const profileController = require('../controllers/profileController');
const { protect, restrictTo } = require('../middleware/authMiddleware');
const { validate, schemas } = require('../middlewares/validator');

router.use(protect);

router.patch(
  '/personal-info',
  validate(schemas.updatePersonalInfo),
  profileController.updatePersonalInfo
);
router.patch(
  '/vehicle-info',
  restrictTo('runner'),
  validate(schemas.updateVehicleInfo),
  profileController.updateVehicleInfo
);
router.patch(
  '/payout-details',
  restrictTo('runner'),
  validate(schemas.updatePayoutDetails),
  profileController.updatePayoutDetails
);
router.patch(
  '/payment-method',
  restrictTo('customer'),
  validate(schemas.updatePaymentMethod),
  profileController.updatePaymentMethod
);

module.exports = router;
