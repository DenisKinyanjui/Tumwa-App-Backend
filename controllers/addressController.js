const SavedAddress = require('../models/SavedAddress');

// ── GET /api/addresses ────────────────────────────────────────────────────────

exports.getAddresses = async (req, res) => {
  const addresses = await SavedAddress.find({ user: req.user._id }).sort('-isDefault -createdAt');
  res.status(200).json({ status: 'success', data: addresses });
};

// ── POST /api/addresses ───────────────────────────────────────────────────────

exports.createAddress = async (req, res) => {
  const { label, address, coordinates, tag } = req.body;

  const existingCount = await SavedAddress.countDocuments({ user: req.user._id });

  const saved = await SavedAddress.create({
    user: req.user._id,
    label,
    address,
    coordinates,
    tag,
    isDefault: existingCount === 0, // first saved address becomes default
  });

  res.status(201).json({ status: 'success', data: saved });
};

// ── PATCH /api/addresses/:id ──────────────────────────────────────────────────

exports.updateAddress = async (req, res) => {
  const saved = await SavedAddress.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    req.body,
    { new: true, runValidators: true }
  );
  if (!saved) {
    return res.status(404).json({ status: 'fail', message: 'Address not found' });
  }
  res.status(200).json({ status: 'success', data: saved });
};

// ── DELETE /api/addresses/:id ─────────────────────────────────────────────────

exports.deleteAddress = async (req, res) => {
  const saved = await SavedAddress.findOneAndDelete({ _id: req.params.id, user: req.user._id });
  if (!saved) {
    return res.status(404).json({ status: 'fail', message: 'Address not found' });
  }
  res.status(200).json({ status: 'success', message: 'Address deleted' });
};

// ── PATCH /api/addresses/:id/set-default ──────────────────────────────────────

exports.setDefaultAddress = async (req, res) => {
  const target = await SavedAddress.findOne({ _id: req.params.id, user: req.user._id });
  if (!target) {
    return res.status(404).json({ status: 'fail', message: 'Address not found' });
  }

  await SavedAddress.updateMany({ user: req.user._id }, { isDefault: false });
  target.isDefault = true;
  await target.save();

  res.status(200).json({ status: 'success', data: target });
};
