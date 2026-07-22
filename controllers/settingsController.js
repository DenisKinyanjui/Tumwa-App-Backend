const { getSettings, updateSettings } = require('../services/settingsService');
const auditLogService = require('../services/auditLogService');

// Field types per settings group — drives both the PATCH whitelist/coercion
// and which groups get echoed back on GET. Only workingCapital is currently
// read anywhere else in the app (see workingCapitalService); the rest are
// admin-editable but not yet consumed by any business logic.
const GROUP_FIELDS = {
  workingCapital: {
    defaultLimit: 'number',
    maxLimit: 'number',
    increaseStep: 'number',
    decreaseStep: 'number',
    increaseCheckInterval: 'number',
    minRatingForIncrease: 'number',
    maxDisputeRateForIncrease: 'number',
  },
  general: {
    platformName: 'string',
    supportEmail: 'string',
    supportPhone: 'string',
    country: 'string',
    timezone: 'string',
  },
  platform: {
    runnerRegistrationOpen: 'boolean',
    identityVerificationRequired: 'boolean',
    phoneVerificationRequired: 'boolean',
    platformCommission: 'number',
  },
  errandSettings: {
    maxErrandValue: 'number',
    minErrandValue: 'number',
    runnerAcceptanceTimeoutMin: 'number',
    customerConfirmationTimeoutHrs: 'number',
  },
  wallets: {
    customerWalletEnabled: 'boolean',
    customerWalletMaxBalance: 'number',
    escrowEnabled: 'boolean',
    escrowAutoReleaseHrs: 'number',
    runnerEarningsEnabled: 'boolean',
    runnerEarningsMinWithdrawal: 'number',
  },
  notifications: {
    pushEnabled: 'boolean',
    smsEnabled: 'boolean',
    emailEnabled: 'boolean',
  },
  authentication: {
    requirePhoneVerification: 'boolean',
    requireIdentityVerification: 'boolean',
    adminTwoFactorEnabled: 'boolean',
  },
};

const serialize = (settings) => {
  const data = { updatedAt: settings.updatedAt };
  Object.keys(GROUP_FIELDS).forEach((group) => { data[group] = settings[group]; });
  return data;
};

// GET /api/admin/settings
exports.getSettings = async (req, res) => {
  const settings = await getSettings();
  res.status(200).json({ status: 'success', data: serialize(settings) });
};

// PATCH /api/admin/settings
// Body may include any subset of the groups above, e.g. { workingCapital: {...} }
// or { general: {...}, platform: {...} } — only recognised, valid fields are applied.
exports.updateSettings = async (req, res) => {
  const patch = {};

  Object.entries(GROUP_FIELDS).forEach(([group, fields]) => {
    const body = req.body[group];
    if (!body || typeof body !== 'object') return;

    Object.entries(fields).forEach(([field, type]) => {
      if (body[field] === undefined) return;

      let value = body[field];
      if (type === 'number') {
        value = Number(value);
        if (isNaN(value) || value < 0) return;
      } else if (type === 'boolean') {
        value = Boolean(value);
      } else {
        value = String(value);
      }
      patch[`${group}.${field}`] = value;
    });
  });

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ status: 'fail', message: 'No valid settings fields to update' });
  }

  const before = await getSettings();
  const beforeSnapshot = Object.fromEntries(Object.keys(patch).map((path) => [path, before.get(path)]));

  const settings = await updateSettings(patch, req.user._id);

  const commissionChanged = Object.keys(patch).some((path) => path.includes('platformCommission'));
  auditLogService.record({
    req, action: 'Settings Changed', module: 'Settings',
    severity: commissionChanged ? 'High' : 'Medium',
    target: { type: 'Settings', id: settings._id, label: 'App Settings' },
    changes: { before: beforeSnapshot, after: patch },
    reason: commissionChanged ? 'Platform commission rate changed' : null,
  });

  res.status(200).json({ status: 'success', data: serialize(settings) });
};
