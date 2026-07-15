const mongoose = require('mongoose');

/**
 * One conversation per errand-assignment. When a runner cancels or is
 * reassigned, the current conversation is archived (never reused) and a
 * fresh one is created for the new runner, so a newly-assigned runner can
 * never see a previous runner's messages. The partial unique index below
 * allows multiple archived conversations to coexist for the same errand
 * while still guaranteeing at most one active/readonly conversation at a time.
 */
const conversationSchema = new mongoose.Schema(
  {
    errand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Errand',
      required: [true, 'Conversation must belong to an errand'],
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Conversation must have a customer'],
    },
    runner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Conversation must have a runner'],
    },
    status: {
      type: String,
      enum: {
        values: ['active', 'readonly', 'archived'],
        message: 'Invalid conversation status',
      },
      default: 'active',
    },
    readonlyReason: {
      type: String,
      enum: ['cancelled', 'completed', null],
      default: null,
    },
    // Informational for 'completed' (null = permanent); enforced by the
    // sweep job for 'cancelled' (auto-archives once this date passes).
    readonlyUntil: { type: Date, default: null },
    customerLastReadAt: { type: Date, default: null },
    runnerLastReadAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: null },
    lastMessagePreview: { type: String, default: null, maxlength: 200 },
  },
  {
    timestamps: true,
  }
);

conversationSchema.index(
  { errand: 1 },
  { unique: true, partialFilterExpression: { status: { $ne: 'archived' } } }
);
conversationSchema.index({ customer: 1, updatedAt: -1 });
conversationSchema.index({ runner: 1, updatedAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
