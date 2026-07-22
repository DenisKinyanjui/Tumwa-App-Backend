const mongoose = require('mongoose');

/**
 * One conversation per support requester (customer or runner), independent
 * of any errand. A requester has at most one non-archived conversation at a
 * time (see the partial unique index below) — new messages reopen it rather
 * than spawning a duplicate thread, mirroring how Conversation.js is unique
 * per active errand.
 */
const supportConversationSchema = new mongoose.Schema(
  {
    // Requester + assignedAdmin once assigned — kept in sync with the two
    // fields below on every write so a single $in query can answer
    // "which conversations can this user see" without branching on role.
    participants: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    ],
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Conversation must have a requester'],
    },
    // Denormalized so the admin inbox can render the Customer/Runner badge
    // without populating requesterId on every list row.
    requesterRole: {
      type: String,
      enum: ['customer', 'runner'],
      required: true,
    },
    assignedAdmin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    status: {
      type: String,
      enum: {
        values: ['open', 'waiting_user', 'waiting_admin', 'resolved', 'closed'],
        message: 'Invalid conversation status',
      },
      default: 'open',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'critical'],
      default: 'medium',
    },
    category: {
      type: String,
      enum: [
        'payments',
        'verification',
        'withdrawals',
        'errands',
        'technical_issue',
        'account',
        'refund',
        'general_inquiry',
        'other',
      ],
      default: 'general_inquiry',
    },
    channel: {
      type: String,
      enum: ['live_chat', 'whatsapp', 'email', 'call'],
      default: 'live_chat',
    },
    lastMessage: { type: String, default: null, maxlength: 200 },
    lastActivity: { type: Date, default: Date.now },
    unreadCounts: {
      customer: { type: Number, default: 0, min: 0 }, // unread from the requester's perspective (also used for runner requesters)
      admin: { type: Number, default: 0, min: 0 },
    },
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  {
    timestamps: true,
  }
);

// At most one active (non-archived) conversation per requester.
supportConversationSchema.index(
  { requesterId: 1 },
  { unique: true, partialFilterExpression: { archived: false } }
);
supportConversationSchema.index({ status: 1, lastActivity: -1 });
supportConversationSchema.index({ assignedAdmin: 1, status: 1 });
supportConversationSchema.index({ channel: 1 });
supportConversationSchema.index({ archived: 1, lastActivity: -1 });

module.exports = mongoose.model('SupportConversation', supportConversationSchema);
