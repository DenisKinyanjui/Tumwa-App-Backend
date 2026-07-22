const mongoose = require('mongoose');

// A generated report file — the row-level data comes from the same
// aggregations backing /api/admin/reports/* (see reportGenerationService),
// rendered to a file and stored in R2. This model is just the metadata index
// the admin panel's Reports page lists/downloads/deletes against.
const REPORT_TYPES = [
  'revenue',
  'finance',
  'transactions',
  'customer_activity',
  'runner_performance',
  'errands',
  'verification',
  'withdrawals',
  'disputes',
  'locations',
  'promo_codes', // no backing data yet — generation rejects this type
  'audit_logs',
];

const reportSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    type: {
      type: String,
      enum: REPORT_TYPES,
      required: true,
    },
    filters: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    // R2 object key — null until generation completes successfully.
    filePath: {
      type: String,
      default: null,
    },
    fileFormat: {
      type: String,
      enum: ['pdf', 'xlsx', 'csv'],
      required: true,
    },
    status: {
      type: String,
      enum: ['generating', 'completed', 'failed'],
      default: 'generating',
    },
    errorMessage: {
      type: String,
      default: null,
    },
  },
  { timestamps: true }
);

reportSchema.index({ type: 1, createdAt: -1 });
reportSchema.index({ generatedBy: 1, createdAt: -1 });

reportSchema.statics.TYPES = REPORT_TYPES;

module.exports = mongoose.model('Report', reportSchema);
