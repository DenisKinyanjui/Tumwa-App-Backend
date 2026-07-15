const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: [true, 'Message must belong to a conversation'],
    },
    // Denormalized for cheap access checks without an extra lookup.
    errand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Errand',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Message must have a sender'],
    },
    type: {
      type: String,
      enum: {
        values: ['text', 'image', 'system'],
        message: 'Invalid message type',
      },
      default: 'text',
    },
    text: {
      type: String,
      trim: true,
      maxlength: [2000, 'Message cannot exceed 2000 characters'],
      default: null,
    },
    // R2 object key for image messages — resolved to a signed URL on read.
    imageKey: { type: String, default: null },
    // Which canned quick-reply chip was used, if any (analytics only).
    quickReply: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
