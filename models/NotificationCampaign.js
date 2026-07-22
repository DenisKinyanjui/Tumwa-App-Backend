const mongoose = require('mongoose');

const notificationCampaignSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    message: {
      type: String,
      required: [true, 'Message is required'],
      trim: true,
      maxlength: [500, 'Message cannot exceed 500 characters'],
    },
    // Cloudflare R2 object key for the optional banner image — resolved to a
    // short-lived signed URL on read (see attachBannerUrl in the controller).
    bannerImageKey: {
      type: String,
      default: null,
    },
    audience: {
      type: String,
      enum: ['all', 'customers', 'runners', 'specific'],
      required: true,
    },
    // Only populated when audience === 'specific'
    specificUserIds: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    }],
    type: {
      type: String,
      enum: ['system', 'promotion', 'announcement', 'reminder'],
      required: true,
    },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sent', 'failed'],
      default: 'draft',
    },
    scheduledAt: {
      type: Date,
      default: null,
    },
    sentAt: {
      type: Date,
      default: null,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Snapshot counts taken at send time — audience membership can drift
    // after the fact, so these reflect who was actually targeted/reached.
    recipients: { type: Number, default: 0 },
    delivered: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    failureReason: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// List/filter (status tabs) and the scheduler sweep
notificationCampaignSchema.index({ status: 1, updatedAt: -1 });
notificationCampaignSchema.index({ status: 1, scheduledAt: 1 });

module.exports = mongoose.model('NotificationCampaign', notificationCampaignSchema);
