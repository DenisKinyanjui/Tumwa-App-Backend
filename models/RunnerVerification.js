const mongoose = require('mongoose');

const runnerVerificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    // These fields are populated when a runner submits their documents
    // (see verificationController.submit, which enforces its own presence
    // checks). They're left optional at the schema level so an admin can
    // approve a runner who never submitted anything — see
    // adminController.approveVerification.
    nationalId: {
      type: String,
      trim: true,
      minlength: [5, 'National ID must be at least 5 characters'],
      maxlength: [20, 'National ID cannot exceed 20 characters'],
    },
    // R2 object keys — files are private; admin reads use a signed URL
    // generated on demand (see utils/verificationPresign.js).
    idFrontKey: {
      type: String,
      default: null,
    },
    idBackKey: {
      type: String,
      default: null,
    },
    selfieKey: {
      type: String,
      default: null,
    },
    meansOfTransport: {
      type: String,
      enum: {
        values: ['motorbike', 'bicycle', 'car', 'on_foot', 'public_transport'],
        message: 'Invalid means of transport',
      },
    },
    areasOfOperation: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'resubmission_requested'],
      default: 'pending',
    },
    adminNotes: {
      type: String,
      default: null,
    },
    submittedAt: {
      type: Date,
      default: Date.now,
    },
    reviewedAt: {
      type: Date,
      default: null,
    },
    // Who made the current decision (approve/reject/request-resubmission) —
    // distinct from the full audit trail below, so the UI can show "Approved
    // by X" without walking the history array.
    reviewedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      name: { type: String, default: null },
    },
    // Full audit trail — one entry per decision/lifecycle event (submitted,
    // approved, rejected, resubmission_requested, reopened). Appended to by
    // the Identity Verification review flow (adminController.js); never
    // rewritten, so it's a genuine history rather than a "last action" cache.
    history: {
      type: [
        {
          action: {
            type: String,
            enum: ['submitted', 'resubmitted', 'approved', 'rejected', 'resubmission_requested', 'reopened'],
            required: true,
          },
          adminId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
          adminName: { type: String, default: null },
          reason: { type: String, default: null },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

runnerVerificationSchema.index({ user: 1 });
runnerVerificationSchema.index({ status: 1, submittedAt: -1 });

module.exports = mongoose.model('RunnerVerification', runnerVerificationSchema);
