const User = require('../models/User');
const logger = require('../utils/logger');

// ── PATCH /api/profile/personal-info ──────────────────────────────────────────

exports.updatePersonalInfo = async (req, res) => {
  const { name, email, dateOfBirth, gender } = req.body;

  if (email) {
    const existing = await User.findOne({ email });
    if (existing && String(existing._id) !== String(req.user._id)) {
      return res.status(409).json({
        status: 'fail',
        message: 'An account with this email already exists',
      });
    }
  }

  const update = {};
  if (name !== undefined) update.name = name;
  if (email !== undefined) update.email = email;
  if (dateOfBirth !== undefined) update.dateOfBirth = dateOfBirth;
  if (gender !== undefined) update.gender = gender;

  const user = await User.findByIdAndUpdate(req.user._id, update, {
    new: true,
    runValidators: true,
  });

  logger.auth.info('Personal info updated', { userId: user._id });
  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        dateOfBirth: user.dateOfBirth,
        gender: user.gender,
      },
    },
  });
};

// ── PATCH /api/profile/vehicle-info ───────────────────────────────────────────

exports.updateVehicleInfo = async (req, res) => {
  const { vehicleInfo } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { vehicleInfo },
    { new: true, runValidators: true }
  );

  logger.auth.info('Vehicle info updated', { userId: user._id });
  res.status(200).json({ status: 'success', data: { vehicleInfo: user.vehicleInfo } });
};

// ── PATCH /api/profile/payout-details ─────────────────────────────────────────

exports.updatePayoutDetails = async (req, res) => {
  const { payoutDetails } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { payoutDetails },
    { new: true, runValidators: true }
  );

  logger.auth.info('Payout details updated', { userId: user._id });
  res.status(200).json({ status: 'success', data: { payoutDetails: user.payoutDetails } });
};

// ── PATCH /api/profile/payment-method ─────────────────────────────────────────

exports.updatePaymentMethod = async (req, res) => {
  const { mpesaNumber } = req.body;

  const user = await User.findByIdAndUpdate(
    req.user._id,
    { payoutMpesaNumber: mpesaNumber },
    { new: true, runValidators: true }
  );

  logger.auth.info('Payment method updated', { userId: user._id });
  res.status(200).json({ status: 'success', data: { payoutMpesaNumber: user.payoutMpesaNumber } });
};
