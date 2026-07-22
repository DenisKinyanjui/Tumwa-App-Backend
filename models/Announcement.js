const mongoose = require('mongoose');

// Kept separate from NotificationCampaign/Notification on purpose — these are
// in-app overlays (modal/banner/bottom-sheet) shown while a user is actively
// using the app, not push/inbox notifications. See services/announcementService.js.

const TARGET_AUDIENCES = [
  'everyone', 'customers', 'runners',
  'verified_runners', 'unverified_runners',
  'active_runners', 'suspended_runners',
  'selected_locations', 'selected_users',
];

const TRIGGERS = [
  'app_launch', 'login_success', 'dashboard_open', 'first_login',
  'errand_accepted', 'errand_completed', 'verification_approved', 'withdrawal_approved',
  'manual_trigger', 'custom_event',
];

const BUTTON_ACTIONS = ['close', 'external_url', 'internal_screen', 'contact_support'];

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    subtitle: {
      type: String,
      trim: true,
      maxlength: [150, 'Subtitle cannot exceed 150 characters'],
      default: null,
    },
    description: {
      type: String,
      required: [true, 'Description is required'],
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    // R2 object key — resolved to a short-lived signed URL on read.
    image: {
      type: String,
      default: null,
    },
    type: {
      type: String,
      enum: { values: ['modal', 'top_banner', 'bottom_sheet'], message: 'Invalid announcement type' },
      required: true,
    },

    targetAudience: {
      type: String,
      enum: { values: TARGET_AUDIENCES, message: 'Invalid target audience' },
      required: true,
    },
    // Only relevant when targetAudience === 'selected_users'
    selectedUsers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    // Only relevant when targetAudience === 'selected_locations' — matched
    // against a runner's RunnerVerification.areasOfOperation (see service).
    selectedLocations: [{ type: mongoose.Schema.Types.ObjectId, ref: 'ServiceArea' }],

    // Which lifecycle events proactively check for this announcement. Admins
    // may select multiple (e.g. app_launch + dashboard_open).
    triggers: {
      type: [{ type: String, enum: TRIGGERS }],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: 'At least one trigger is required',
      },
    },
    // Only relevant when triggers includes 'custom_event' — the app-defined
    // event name a screen fires (e.g. checkTrigger('custom_event', 'promo_seen')).
    customEventName: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },

    primaryButtonText: { type: String, trim: true, maxlength: 40, default: null },
    secondaryButtonText: { type: String, trim: true, maxlength: 40, default: null },

    primaryAction: {
      type: String,
      enum: { values: BUTTON_ACTIONS, message: 'Invalid button action' },
      default: 'close',
    },
    // URL for external_url, a route name (see mobile navigation catalog) for
    // internal_screen, unused for close/contact_support. Left as a bare
    // string (not enum-constrained) so new action types can reuse this
    // column without a schema migration.
    actionTarget: { type: String, trim: true, default: null },

    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'critical'],
      default: 'normal',
    },
    displayFrequency: {
      type: String,
      enum: ['once_ever', 'once_per_version', 'once_per_session', 'every_trigger', 'until_dismissed'],
      default: 'once_ever',
    },

    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },

    // The admin on/off switch (Activate/Deactivate). `status` below is
    // derived from this + the schedule rather than stored redundantly, so it
    // can never drift out of sync with the dates — see the virtual below.
    active: { type: Boolean, default: false },

    // Set once a live-while-online push has been emitted for the current
    // activation window, so the scheduler sweep doesn't re-emit every pass.
    // Reset whenever the schedule/active state changes (see controller).
    activationNotified: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Derived display status — Draft (never activated) / Scheduled (active, not
// yet started) / Active (active, within window) / Expired (past endDate,
// regardless of the active flag). Computed on every read so it's always
// consistent with startDate/endDate — no sweep can leave it stale.
//
// Single source of truth for both the `status` virtual (full Mongoose docs)
// and lean() query results — Mongoose's core lean() does NOT apply virtuals
// just because `{ virtuals: true }` is passed (that requires the separate
// mongoose-lean-virtuals plugin, which isn't installed here), so any
// controller reading lean() results must call `Announcement.computeStatus`
// explicitly. See controllers/announcementController.js.
const computeStatus = (doc, now = Date.now()) => {
  if (doc.endDate && doc.endDate.getTime() < now) return 'expired';
  if (!doc.active) return 'draft';
  if (doc.startDate && doc.startDate.getTime() > now) return 'scheduled';
  return 'active';
};

announcementSchema.virtual('status').get(function status() {
  return computeStatus(this);
});

announcementSchema.statics.computeStatus = computeStatus;

// List/filter (admin table) and the eligibility engine's core query
announcementSchema.index({ active: 1, startDate: 1, endDate: 1 });
announcementSchema.index({ targetAudience: 1 });
announcementSchema.index({ triggers: 1 });
announcementSchema.index({ updatedAt: -1 });
// Activation sweep — finds newly-due scheduled announcements
announcementSchema.index({ active: 1, activationNotified: 1, startDate: 1 });

announcementSchema.statics.TARGET_AUDIENCES = TARGET_AUDIENCES;
announcementSchema.statics.TRIGGERS = TRIGGERS;
announcementSchema.statics.BUTTON_ACTIONS = BUTTON_ACTIONS;

module.exports = mongoose.model('Announcement', announcementSchema);
