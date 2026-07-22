const mongoose = require('mongoose');

const supportMessageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SupportConversation',
      required: [true, 'Message must belong to a conversation'],
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Message must have a sender'],
    },
    senderRole: {
      type: String,
      enum: ['customer', 'runner', 'admin', 'superadmin', 'system'],
      required: true,
    },
    message: {
      type: String,
      trim: true,
      maxlength: [2000, 'Message cannot exceed 2000 characters'],
      default: null,
    },
    messageType: {
      type: String,
      enum: ['text', 'image', 'pdf', 'system'],
      default: 'text',
    },
    // R2 object key + metadata — resolved to a signed URL on read, same
    // pattern as Message.imageKey.
    attachment: {
      key: { type: String, default: null },
      mimeType: { type: String, default: null },
      fileName: { type: String, default: null },
      size: { type: Number, default: null },
    },
    readBy: [
      {
        user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        readAt: { type: Date, default: Date.now },
      },
    ],
    delivered: { type: Boolean, default: true },
  },
  {
    timestamps: true,
  }
);

supportMessageSchema.index({ conversationId: 1, createdAt: 1 });

module.exports = mongoose.model('SupportMessage', supportMessageSchema);
