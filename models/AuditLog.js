const mongoose = require('mongoose');

// Immutable record of an administrative action, written by
// services/auditLogService.js and never updated/deleted through the app —
// the compliance value of an audit trail depends on it being append-only.
const MODULES = [
  'Users',
  'Runners',
  'Errands',
  'Transactions',
  'Withdrawals',
  'Verification',
  'Working Capital',
  'Customer Wallet',
  'Escrow',
  'Disputes',
  'Notifications',
  'Announcements',
  'Locations',
  'Reports',
  'Analytics',
  'Promo Codes',
  'Settings',
  'Admin Users',
];

const ACTIONS = [
  'Created',
  'Updated',
  'Deleted',
  'Approved',
  'Rejected',
  'Suspended',
  'Activated',
  'Refunded',
  'Login',
  'Logout',
  'Password Reset',
  'Settings Changed',
];

const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];

const auditLogSchema = new mongoose.Schema(
  {
    // Actor fields are duplicated (not just a ref) so the trail still reads
    // correctly if the admin account is later renamed or deleted.
    actor: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
      name: { type: String, required: true },
      email: { type: String, default: null },
      role: { type: String, required: true },
    },
    action: { type: String, enum: ACTIONS, required: true },
    module: { type: String, enum: MODULES, required: true },
    severity: { type: String, enum: SEVERITIES, default: 'Low' },
    target: {
      type: { type: String, default: null }, // e.g. 'User', 'Errand', 'Dispute'
      id: { type: mongoose.Schema.Types.Mixed, default: null },
      label: { type: String, default: null }, // human-readable, e.g. a name or title
    },
    changes: {
      before: { type: mongoose.Schema.Types.Mixed, default: null },
      after: { type: mongoose.Schema.Types.Mixed, default: null },
    },
    reason: { type: String, default: null },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
    device: {
      browser: { type: String, default: null },
      os: { type: String, default: null },
      device: { type: String, default: null },
      userAgent: { type: String, default: null },
    },
    sessionId: { type: String, default: null },
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    errorMessage: { type: String, default: null },
  },
  { timestamps: true },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ 'actor.id': 1, createdAt: -1 });
auditLogSchema.index({ module: 1, createdAt: -1 });
auditLogSchema.index({ action: 1, createdAt: -1 });
auditLogSchema.index({ severity: 1, createdAt: -1 });
auditLogSchema.index({ 'target.id': 1, createdAt: -1 });
auditLogSchema.index({ requestId: 1 });

auditLogSchema.statics.MODULES = MODULES;
auditLogSchema.statics.ACTIONS = ACTIONS;
auditLogSchema.statics.SEVERITIES = SEVERITIES;

module.exports = mongoose.model('AuditLog', auditLogSchema);
