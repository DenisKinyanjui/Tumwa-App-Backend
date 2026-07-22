const mongoose = require('mongoose');

// Admin-only annotations on a support conversation. Never exposed on any
// customer/runner-facing endpoint.
const supportInternalNoteSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportConversation',
      required: [true, 'Note must belong to a conversation'],
    },
    adminId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Note must have an author'],
    },
    note: {
      type: String,
      trim: true,
      required: [true, 'Note text is required'],
      maxlength: [1000, 'Note cannot exceed 1000 characters'],
    },
  },
  {
    timestamps: true,
  }
);

supportInternalNoteSchema.index({ conversationId: 1, createdAt: -1 });

module.exports = mongoose.model('SupportInternalNote', supportInternalNoteSchema);
