const mongoose = require('mongoose');

// One document per time an announcement was shown to a user — drives both
// the frequency rules (once_ever / once_per_version / once_per_session /
// until_dismissed) and the admin analytics (views, dismissals, clicks, CTR).

const announcementViewSchema = new mongoose.Schema(
  {
    announcement: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Announcement',
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    viewedAt: { type: Date, default: Date.now },
    dismissed: { type: Boolean, default: false },
    dismissedAt: { type: Date, default: null },
    clicked: { type: Boolean, default: false },
    clickedAt: { type: Date, default: null },
    clickedButton: { type: String, enum: ['primary', 'secondary', null], default: null },
    // App version / session id as reported by the client at view time — used
    // to evaluate once_per_version / once_per_session frequency rules.
    appVersion: { type: String, default: null },
    sessionId: { type: String, default: null },
    // Free-text (not enum-constrained) — records which lifecycle event
    // actually caused this showing, including internal markers like
    // 'socket_push' that aren't valid Announcement.triggers values.
    trigger: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// Frequency-rule lookups: "has this user seen this announcement before"
announcementViewSchema.index({ announcement: 1, user: 1, viewedAt: -1 });
announcementViewSchema.index({ announcement: 1, user: 1, appVersion: 1 });
announcementViewSchema.index({ announcement: 1, user: 1, sessionId: 1 });
// Analytics aggregation
announcementViewSchema.index({ announcement: 1, dismissed: 1 });
announcementViewSchema.index({ announcement: 1, clicked: 1 });

module.exports = mongoose.model('AnnouncementView', announcementViewSchema);
