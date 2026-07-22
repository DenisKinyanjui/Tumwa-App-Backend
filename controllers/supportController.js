// Customer/runner-facing support endpoints — GET /my-conversations, POST
// /start, and the /:id/... message endpoints. Admin-facing endpoints live in
// supportAdminController.js; both share supportService for persistence.
const multer = require('multer');
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const r2Service = require('../services/r2Service');
const notify = require('../services/notifyService');
const supportService = require('../services/supportService');
const {
  emitSupportMessage,
  emitSupportConversationUpdated,
  emitSupportNewConversation,
  emitSupportMessageRead,
  getIO,
} = require('../socket/socketManager');

const isParticipant = (conversation, userId) => conversation.requesterId.toString() === userId.toString();

const attachAttachmentUrls = async (messages) => {
  await Promise.all(
    messages.map(async (m) => {
      if (m.attachment?.key) {
        m.attachment.url = await r2Service.getSignedDownloadUrl(m.attachment.key, 3600);
      }
    })
  );
  return messages;
};

// Any admin/superadmin currently connected — drives the mobile WhatsApp
// fallback ("No support agents are currently available").
const agentsAvailable = () => {
  try {
    const room = getIO().sockets.adapter.rooms.get('admins');
    return !!(room && room.size > 0);
  } catch {
    return false;
  }
};

// GET /api/support/my-conversations
exports.getMyConversations = async (req, res) => {
  const conversations = await SupportConversation.find({ requesterId: req.user._id })
    .sort({ lastActivity: -1 })
    .lean();

  res.status(200).json({ status: 'success', data: { conversations } });
};

// POST /api/support/start
exports.startConversation = async (req, res) => {
  const existingCount = await SupportConversation.countDocuments({
    requesterId: req.user._id,
    archived: false,
  });

  const conversation = await supportService.findOrCreateConversation(req.user);

  if (existingCount === 0) {
    emitSupportNewConversation(conversation);
    notify.sendToRole({
      role: 'admin',
      title: 'New support conversation',
      message: `${req.user.name} started a new support chat`,
      type: 'support',
      relatedId: conversation._id,
      relatedModel: 'SupportConversation',
      eventName: 'support:new-conversation',
      eventData: { conversationId: conversation._id },
    });
  }

  res.status(200).json({
    status: 'success',
    data: { conversation, agentsAvailable: agentsAvailable() },
  });
};

// GET /api/support/:id/messages?before=&limit=
exports.getMessages = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const query = { conversationId: conversation._id };
  if (req.query.before) query.createdAt = { $lt: new Date(req.query.before) };

  const messages = await SupportMessage.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  messages.reverse();
  await attachAttachmentUrls(messages);

  res.status(200).json({ status: 'success', data: { messages } });
};

// POST /api/support/:id/messages  { text }
exports.sendMessage = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }
  if (conversation.status === 'closed') {
    return res.status(400).json({ status: 'fail', message: 'This conversation is closed' });
  }

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ status: 'fail', message: 'text is required' });

  const message = await supportService.addMessage({ conversation, sender: req.user, text: text.trim() });

  emitSupportMessage(conversation, message);
  emitSupportConversationUpdated(conversation);
  await notifyAdmins(conversation, req.user, message);

  res.status(201).json({ status: 'success', data: { message } });
};

// Single optional attachment (image or PDF) for POST /:id/attachments
const supportAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (_req, file, cb) => {
    const ok = file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf';
    cb(ok ? null : new Error('Only images and PDF files are allowed'), ok);
  },
});
exports.uploadAttachmentMiddleware = supportAttachmentUpload.single('attachment');

// POST /api/support/:id/attachments (multipart, field name "attachment")
exports.sendAttachment = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }
  if (conversation.status === 'closed') {
    return res.status(400).json({ status: 'fail', message: 'This conversation is closed' });
  }
  if (!req.file) return res.status(400).json({ status: 'fail', message: 'attachment is required' });

  const messageType = req.file.mimetype === 'application/pdf' ? 'pdf' : 'image';
  const key = await r2Service.uploadFile(req.file.buffer, `support/${conversation._id}`, messageType, req.file.mimetype);

  const message = await supportService.addMessage({
    conversation,
    sender: req.user,
    messageType,
    attachment: { key, mimeType: req.file.mimetype, fileName: req.file.originalname, size: req.file.size },
  });

  emitSupportMessage(conversation, message);
  emitSupportConversationUpdated(conversation);
  await notifyAdmins(conversation, req.user, message);

  const plain = message.toObject();
  plain.attachment.url = await r2Service.getSignedDownloadUrl(key, 3600);

  res.status(201).json({ status: 'success', data: { message: plain } });
};

// PATCH /api/support/:id/read
exports.markRead = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const readAt = await supportService.markRead(conversation, req.user);
  emitSupportMessageRead(conversation, { readerId: req.user._id, readAt, readerIsStaff: false });

  res.status(200).json({ status: 'success', data: { readAt } });
};

// Shared by sendMessage/sendAttachment: notify the assigned admin, or all
// admins if the conversation hasn't been claimed yet.
//
// eventName is deliberately NOT 'support:new-message' — that event already
// carries the full message object via emitSupportMessage (socketManager.js),
// and notifyService's socket emit uses a different payload shape
// ({conversationId, messageId, notificationId}, no `message` key). Reusing
// the same event name would deliver two differently-shaped payloads under
// one listener and crash whichever client code assumes `message` exists.
async function notifyAdmins(conversation, sender, message) {
  const base = {
    title: sender.name,
    message: message.messageType === 'text' ? message.message : message.messageType === 'pdf' ? '📄 Sent a document' : '📷 Sent a photo',
    type: 'support',
    relatedId: conversation._id,
    relatedModel: 'SupportConversation',
    eventName: 'support:message-alert',
    eventData: { conversationId: conversation._id, messageId: message._id },
  };

  if (conversation.assignedAdmin) {
    await notify.send({ userId: conversation.assignedAdmin, ...base });
  } else {
    await notify.sendToRole({ role: 'admin', ...base });
  }
}
