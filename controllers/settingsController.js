const { getSettings, updateSettings } = require('../services/settingsService');

const ALLOWED_WORKING_CAPITAL_FIELDS = [
  'defaultLimit',
  'maxLimit',
  'increaseStep',
  'decreaseStep',
  'increaseCheckInterval',
  'minRatingForIncrease',
  'maxDisputeRateForIncrease',
];

// GET /api/admin/settings
exports.getSettings = async (req, res) => {
  const settings = await getSettings();
  res.status(200).json({
    status: 'success',
    data: { workingCapital: settings.workingCapital, updatedAt: settings.updatedAt },
  });
};

// PATCH /api/admin/settings
exports.updateSettings = async (req, res) => {
  const { workingCapital } = req.body;

  if (!workingCapital || typeof workingCapital !== 'object') {
    return res.status(400).json({ status: 'fail', message: 'workingCapital object is required' });
  }

  const patch = {};
  ALLOWED_WORKING_CAPITAL_FIELDS.forEach((field) => {
    if (workingCapital[field] !== undefined) {
      const value = Number(workingCapital[field]);
      if (isNaN(value) || value < 0) {
        return;
      }
      patch[`workingCapital.${field}`] = value;
    }
  });

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ status: 'fail', message: 'No valid settings fields to update' });
  }

  const settings = await updateSettings(patch, req.user._id);

  res.status(200).json({
    status: 'success',
    data: { workingCapital: settings.workingCapital, updatedAt: settings.updatedAt },
  });
};
