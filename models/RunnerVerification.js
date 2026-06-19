const mongoose = require('mongoose');

const runnerVerificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    nationalId: {
      type: String,
      required: [true, 'National ID is required'],
      trim: true,
      minlength: [5, 'National ID must be at least 5 characters'],
      maxlength: [20, 'National ID cannot exceed 20 characters'],
    },
    idFrontUrl: {
      type: String,
      required: [true, 'ID front photo is required'],
    },
    idBackUrl: {
      type: String,
      required: [true, 'ID back photo is required'],
    },
    selfieUrl: {
      type: String,
      required: [true, 'Selfie photo is required'],
    },
    meansOfTransport: {
      type: String,
      required: [true, 'Means of transport is required'],
      enum: {
        values: ['motorbike', 'bicycle', 'car', 'on_foot', 'public_transport'],
        message: 'Invalid means of transport',
      },
    },
    areasOfOperation: {
      type: [String],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'At least one area of operation is required',
      },
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
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
