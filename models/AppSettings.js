const mongoose = require('mongoose');

// Singleton document (by convention, like LegalContent — no unique/_id
// constraint enforced; the service layer always finds-or-creates a single
// doc). Holds admin-editable app-wide configuration.
const appSettingsSchema = new mongoose.Schema(
  {
    workingCapital: {
      // Starting limit for a brand-new runner.
      defaultLimit: { type: Number, default: 500, min: [0, 'Default limit cannot be negative'] },
      // Absolute ceiling no runner's limit can exceed.
      maxLimit: { type: Number, default: 50000, min: [0, 'Max limit cannot be negative'] },
      // Amount the limit steps up/down on a qualifying event.
      increaseStep: { type: Number, default: 500, min: [0, 'Increase step cannot be negative'] },
      decreaseStep: { type: Number, default: 1000, min: [0, 'Decrease step cannot be negative'] },
      // Only check for an increase every N completed errands.
      increaseCheckInterval: { type: Number, default: 5, min: [1, 'Must check at least every 1 errand'] },
      minRatingForIncrease: { type: Number, default: 4.5, min: 0, max: 5 },
      maxDisputeRateForIncrease: { type: Number, default: 0.05, min: 0, max: 1 },
    },
    general: {
      platformName: { type: String, default: 'Tumwa' },
      supportEmail: { type: String, default: 'support@tumwa.app' },
      supportPhone: { type: String, default: '' },
      country: { type: String, default: 'Kenya' },
      timezone: { type: String, default: 'Africa/Nairobi' },
    },
    platform: {
      runnerRegistrationOpen: { type: Boolean, default: true },
      identityVerificationRequired: { type: Boolean, default: true },
      phoneVerificationRequired: { type: Boolean, default: true },
      platformCommission: { type: Number, default: 10, min: 0, max: 100 },
    },
    errandSettings: {
      maxErrandValue: { type: Number, default: 50000, min: 0 },
      minErrandValue: { type: Number, default: 100, min: 0 },
      runnerAcceptanceTimeoutMin: { type: Number, default: 5, min: 1 },
      customerConfirmationTimeoutHrs: { type: Number, default: 24, min: 1 },
    },
    wallets: {
      customerWalletEnabled: { type: Boolean, default: true },
      customerWalletMaxBalance: { type: Number, default: 100000, min: 0 },
      escrowEnabled: { type: Boolean, default: true },
      escrowAutoReleaseHrs: { type: Number, default: 72, min: 1 },
      runnerEarningsEnabled: { type: Boolean, default: true },
      runnerEarningsMinWithdrawal: { type: Number, default: 500, min: 0 },
    },
    notifications: {
      pushEnabled: { type: Boolean, default: true },
      smsEnabled: { type: Boolean, default: true },
      emailEnabled: { type: Boolean, default: false },
    },
    authentication: {
      requirePhoneVerification: { type: Boolean, default: true },
      requireIdentityVerification: { type: Boolean, default: true },
      adminTwoFactorEnabled: { type: Boolean, default: false },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

module.exports = mongoose.model('AppSettings', appSettingsSchema);
