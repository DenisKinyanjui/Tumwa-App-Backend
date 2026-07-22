// Admin-facing support endpoints — GET/PATCH /conversations..., mounted under
// /api/support alongside the customer/runner endpoints in supportController.js.
const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const SupportInternalNote = require('../models/SupportInternalNote');
const User = require('../models/User');
const r2Service = require('../services/r2Service');
const notify = require('../services/notifyService');
const supportService = require('../services/supportService');
const { uploadAttachmentMiddleware } = require('./supportController');
const {
  emitSupportMessage,
  emitSupportConversationUpdated,
  emitSupportMessageRead,
} = require('../socket/socketManager');

exports.uploadAttachmentMiddleware = uploadAttachmentMiddleware;

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

const buildRequesterInfo = async (conversation) => {
  const requester = await User.findById(conversation.requesterId)
    .select('name phone photoKey verificationStatus isActive')
    .lean();
  if (!requester) return null;

  return {
    id: requester._id,
    name: requester.name,
    phone: requester.phone,
    role: conversation.requesterRole,
    isActive: requester.isActive,
    verificationStatus: requester.verificationStatus,
    photoUrl: requester.photoKey ? await r2Service.getSignedDownloadUrl(requester.photoKey, 3600) : null,
  };
};

// GET /api/support/conversations?status=&channel=&category=&assignedAdmin=&archived=&search=
exports.listConversations = async (req, res) => {
  const { status, channel, category, assignedAdmin, archived, search } = req.query;
  const query = {};

  if (status) query.status = status;
  if (channel) query.channel = channel;
  if (category) query.category = category;
  if (assignedAdmin) query.assignedAdmin = assignedAdmin;

  // Only superadmins may look at archived conversations.
  if (archived === 'true' && supportService.canViewArchived(req.user)) {
    query.archived = true;
  } else {
    query.archived = false;
  }

  if (search && search.trim()) {
    const matchingUsers = await User.find({ name: { $regex: search.trim(), $options: 'i' } })
      .select('_id')
      .lean();
    query.$or = [
      { requesterId: { $in: matchingUsers.map((u) => u._id) } },
      { lastMessage: { $regex: search.trim(), $options: 'i' } },
    ];
  }

  const conversations = await SupportConversation.find(query).sort({ lastActivity: -1 }).lean();

  const withRequesters = await Promise.all(
    conversations.map(async (c) => ({ ...c, requester: await buildRequesterInfo(c) }))
  );

  res.status(200).json({ status: 'success', data: { conversations: withRequesters } });
};

// GET /api/support/conversations/:id
exports.getConversation = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id).lean();
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (conversation.archived && !supportService.canViewArchived(req.user)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const requester = await buildRequesterInfo(conversation);
  const assignedAdmin = conversation.assignedAdmin
    ? await User.findById(conversation.assignedAdmin).select('name').lean()
    : null;

  res.status(200).json({ status: 'success', data: { conversation, requester, assignedAdmin } });
};

// GET /api/support/conversations/:id/messages?before=&limit=
exports.getMessages = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const query = { conversationId: conversation._id };
  if (req.query.before) query.createdAt = { $lt: new Date(req.query.before) };

  const messages = await SupportMessage.find(query).sort({ createdAt: -1 }).limit(limit).lean();
  messages.reverse();
  await attachAttachmentUrls(messages);

  res.status(200).json({ status: 'success', data: { messages } });
};

// POST /api/support/conversations/:id/messages  { text }
exports.sendMessage = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ status: 'fail', message: 'text is required' });

  const message = await supportService.addMessage({ conversation, sender: req.user, text: text.trim() });

  emitSupportMessage(conversation, message);
  emitSupportConversationUpdated(conversation);
  await notify.send({
    userId: conversation.requesterId,
    title: 'Tumwa Support',
    message: message.message,
    type: 'support',
    relatedId: conversation._id,
    relatedModel: 'SupportConversation',
    eventName: 'support:message-alert',
    eventData: { conversationId: conversation._id, messageId: message._id },
  });

  res.status(201).json({ status: 'success', data: { message } });
};

// POST /api/support/conversations/:id/attachments (multipart, field "attachment")
exports.sendAttachment = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
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
  await notify.send({
    userId: conversation.requesterId,
    title: 'Tumwa Support',
    message: messageType === 'pdf' ? '📄 Sent a document' : '📷 Sent a photo',
    type: 'support',
    relatedId: conversation._id,
    relatedModel: 'SupportConversation',
    eventName: 'support:message-alert',
    eventData: { conversationId: conversation._id, messageId: message._id },
  });

  const plain = message.toObject();
  plain.attachment.url = await r2Service.getSignedDownloadUrl(key, 3600);

  res.status(201).json({ status: 'success', data: { message: plain } });
};

// PATCH /api/support/conversations/:id  { priority?, category? }
exports.updateConversation = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const { priority, category } = req.body;
  if (priority) conversation.priority = priority;
  if (category) conversation.category = category;
  await conversation.save();

  emitSupportConversationUpdated(conversation);
  res.status(200).json({ status: 'success', data: { conversation } });
};

// PATCH /api/support/conversations/:id/assign  { adminId }
exports.assignConversation = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  if (!supportService.canReassign(req.user, conversation)) {
    return res.status(403).json({ status: 'fail', message: 'Only a superadmin can reassign this conversation' });
  }

  const { adminId } = req.body;
  if (!adminId) return res.status(400).json({ status: 'fail', message: 'adminId is required' });

  const admin = await User.findOne({ _id: adminId, role: { $in: ['admin', 'superadmin'] } }).select('_id');
  if (!admin) return res.status(400).json({ status: 'fail', message: 'Invalid admin' });

  conversation.assignedAdmin = adminId;
  if (!conversation.participants.some((p) => p.toString() === adminId)) {
    conversation.participants.push(adminId);
  }
  await conversation.save();

  emitSupportConversationUpdated(conversation);
  res.status(200).json({ status: 'success', data: { conversation } });
};

// PATCH /api/support/conversations/:id/status  { status }
exports.updateStatus = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const { status } = req.body;
  const valid = ['open', 'waiting_user', 'waiting_admin', 'resolved', 'closed'];
  if (!valid.includes(status)) return res.status(400).json({ status: 'fail', message: 'Invalid status' });

  conversation.status = status;
  if (status === 'resolved') {
    conversation.resolvedAt = new Date();
    conversation.resolvedBy = req.user._id;
  } else if (status === 'closed') {
    conversation.closedAt = new Date();
    conversation.closedBy = req.user._id;
  }
  await conversation.save();

  emitSupportConversationUpdated(conversation);
  res.status(200).json({ status: 'success', data: { conversation } });
};

// PATCH /api/support/conversations/:id/archive
exports.archiveConversation = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  conversation.archived = true;
  conversation.archivedAt = new Date();
  conversation.archivedBy = req.user._id;
  await conversation.save();

  emitSupportConversationUpdated(conversation);
  res.status(200).json({ status: 'success', data: { conversation } });
};

// DELETE /api/support/conversations/:id — superadmin only (also enforced at route level)
exports.deleteConversation = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  await Promise.all([
    SupportMessage.deleteMany({ conversationId: conversation._id }),
    SupportInternalNote.deleteMany({ conversationId: conversation._id }),
    conversation.deleteOne(),
  ]);

  res.status(200).json({ status: 'success', message: 'Conversation deleted' });
};

// PATCH /api/support/conversations/:id/read
exports.markRead = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id);
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const readAt = await supportService.markRead(conversation, req.user);
  emitSupportMessageRead(conversation, { readerId: req.user._id, readAt, readerIsStaff: true });

  res.status(200).json({ status: 'success', data: { readAt } });
};

// POST /api/support/conversations/:id/notes  { note }
exports.addNote = async (req, res) => {
  const conversation = await SupportConversation.findById(req.params.id).select('_id');
  if (!conversation) return res.status(404).json({ status: 'fail', message: 'Conversation not found' });

  const { note } = req.body;
  if (!note || !note.trim()) return res.status(400).json({ status: 'fail', message: 'note is required' });

  const created = await SupportInternalNote.create({
    conversationId: conversation._id,
    adminId: req.user._id,
    note: note.trim(),
  });

  res.status(201).json({ status: 'success', data: { note: created } });
};

// GET /api/support/conversations/:id/notes
exports.listNotes = async (req, res) => {
  const notes = await SupportInternalNote.find({ conversationId: req.params.id })
    .sort({ createdAt: -1 })
    .populate('adminId', 'name')
    .lean();

  res.status(200).json({ status: 'success', data: { notes } });
};

// GET /api/support/dashboard
exports.dashboard = async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const [open, waitingAdmin, waitingUser, resolvedToday, channelCounts] = await Promise.all([
    SupportConversation.countDocuments({ status: 'open', archived: false }),
    SupportConversation.countDocuments({ status: 'waiting_admin', archived: false }),
    SupportConversation.countDocuments({ status: 'waiting_user', archived: false }),
    SupportConversation.countDocuments({ status: 'resolved', resolvedAt: { $gte: startOfToday }, archived: false }),
    SupportConversation.aggregate([
      { $match: { archived: false } },
      { $group: { _id: '$channel', count: { $sum: 1 } } },
    ]),
  ]);

  const channels = { live_chat: 0, whatsapp: 0, email: 0, call: 0 };
  channelCounts.forEach((c) => {
    if (c._id in channels) channels[c._id] = c.count;
  });

  res.status(200).json({
    status: 'success',
    data: {
      summary: { open, waitingAdmin, waitingUser, resolvedToday },
      channels,
    },
  });
};
