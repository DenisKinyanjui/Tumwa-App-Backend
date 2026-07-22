const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Notification must belong to a user'],
    },
    title: {
      type: String,
      required: [true, 'Notification title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    message: {
      type: String,
      required: [true, 'Notification message is required'],
      trim: true,
      maxlength: [500, 'Message cannot exceed 500 characters'],
    },
    type: {
      type: String,
      enum: {
        values: [
          'errand', 'payment', 'dispute', 'rating', 'admin', 'system', 'message',
          // Admin-composed broadcast campaign types (see NotificationCampaign)
          'promotion', 'announcement', 'reminder',
        ],
        message: 'Invalid notification type',
      },
      required: true,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
    // Generic reference to the triggering resource
    relatedId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    relatedModel: {
      type: String,
      enum: ['Errand', 'Payment', 'Dispute', 'User', 'Conversation', null],
      default: null,
    },
    // The notifyService eventName that produced this notification (e.g.
    // 'payment-confirmed', 'dispute-resolved') — powers the admin "System
    // Notifications" tab, which aggregates real delivery counts per event.
    // Left null for notifications fanned out from an admin campaign.
    event: {
      type: String,
      default: null,
    },
    // Set when this notification was fanned out from an admin-composed
    // broadcast (see NotificationCampaign) rather than a domain event.
    campaign: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NotificationCampaign',
      default: null,
    },
    // Denormalized from the campaign's banner at send time (rather than
    // populating `campaign` on every read) so the customer/runner apps can
    // render it without an extra lookup.
    bannerImageKey: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Primary query patterns: user's unread feed, user's full history
notificationSchema.index({ user: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ user: 1, createdAt: -1 });
// Admin "System Notifications" tab — counts/last-triggered per event
notificationSchema.index({ event: 1, createdAt: -1 });
// Admin campaign detail — delivered/opened counts for a sent campaign
notificationSchema.index({ campaign: 1, isRead: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
