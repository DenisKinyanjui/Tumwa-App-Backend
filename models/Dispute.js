const mongoose = require('mongoose');

/**
 * Resolution outcome semantics:
 *
 *  runner_at_fault   → runner's collateral penalized; customer credited errand.amount
 *  customer_at_fault → runner's collateral unlocked (no penalty); no customer credit
 *  no_action         → runner's collateral unlocked; no penalty, no credit
 *  partial           → runner partially penalized (penaltyAmount); customer optionally credited
 */
const disputeSchema = new mongoose.Schema(
  {
    errand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Errand',
      required: [true, 'Dispute must reference an errand'],
    },
    raisedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Dispute must have a raiser'],
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Dispute must reference the errand customer'],
    },
    runner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Dispute must reference the errand runner'],
    },
    reason: {
      type: String,
      required: [true, 'Dispute reason is required'],
      trim: true,
      maxlength: [200, 'Reason cannot exceed 200 characters'],
    },
    description: {
      type: String,
      required: [true, 'Dispute description is required'],
      trim: true,
      maxlength: [2000, 'Description cannot exceed 2000 characters'],
    },
    evidence: {
      type: [String], // array of image/file URLs
      default: [],
      validate: {
        validator: (arr) => arr.length <= 10,
        message: 'Evidence cannot exceed 10 files',
      },
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'under_review', 'resolved', 'rejected'],
        message: 'Invalid dispute status',
      },
      default: 'pending',
    },
    // Whether runner collateral was still locked when dispute was raised.
    // Determines if wallet ops are needed during resolution.
    fundsLockedAtDispute: {
      type: Boolean,
      required: true,
    },
    resolution: {
      outcome: {
        type: String,
        enum: ['runner_at_fault', 'customer_at_fault', 'no_action', 'partial'],
        default: null,
      },
      notes: { type: String, default: null, maxlength: 2000 },
      penaltyAmount: { type: Number, default: null }, // used when outcome = 'partial'
      refundAmount: { type: Number, default: null },  // actual amount credited to customer
      resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      resolvedAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
  }
);

// ── Indexes for query performance ─────────────────────────────────────────────
disputeSchema.index({ status: 1, createdAt: -1 });
disputeSchema.index({ runner: 1, createdAt: -1 });
disputeSchema.index({ customer: 1, createdAt: -1 });

// Prevent duplicate open disputes for the same errand
disputeSchema.index(
  { errand: 1 },
  {
    unique: true,
    partialFilterExpression: { status: 'pending' },
  }
);

module.exports = mongoose.model('Dispute', disputeSchema);
