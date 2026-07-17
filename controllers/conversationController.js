const multer = require('multer');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const User = require('../models/User');
const r2Service = require('../services/r2Service');
const notify = require('../services/notifyService');
const { emitChatMessage, emitChatRead } = require('../socket/socketManager');

// The global xssSanitize middleware (middlewares/security.js) HTML-escapes
// every request-body string so it's safe to reflect into HTML contexts (e.g.
// the admin dashboard). Chat text is only ever rendered as plain text in the
// mobile app, so storing it escaped just corrupts apostrophes/quotes for
// every reader (bubbles, push notifications, previews) — undo it here, at
// the one boundary where the escaping doesn't apply, before persisting.
const unescapeHtml = (str) =>
  str
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');

// conversation.customer/runner may be a raw ObjectId or a populated User
// document (getConversationForErrand/getConversation populate them for the
// header response) — normalize to the id string either way.
const idOf = (ref) => (ref?._id ?? ref).toString();

const isParticipant = (conversation, userId) =>
  idOf(conversation.customer) === userId.toString() ||
  idOf(conversation.runner) === userId.toString();

// Resolves the counterpart's display info for the chat header: name, phone,
// profile picture (User.photoKey, signed on demand), and (runner only) a
// verified badge. photoKey is fetched out-of-band rather than added to
// populateConversation's select, so the raw R2 key never appears in the
// `conversation` object also returned alongside this in the response.
const buildOtherParticipant = async (conversation, viewerId) => {
  const isViewerCustomer = conversation.customer._id.toString() === viewerId.toString();
  const other = isViewerCustomer ? conversation.runner : conversation.customer;

  const otherUser = await User.findById(other._id).select('photoKey').lean();

  return {
    id: other._id,
    name: other.name,
    phone: other.phone,
    role: isViewerCustomer ? 'runner' : 'customer',
    verified: isViewerCustomer ? other.verificationStatus === 'approved' : false,
    photoUrl: otherUser?.photoKey
      ? await r2Service.getSignedDownloadUrl(otherUser.photoKey, 3600)
      : null,
  };
};

const attachImageUrls = async (messages) => {
  await Promise.all(
    messages.map(async (m) => {
      if (m.imageKey) {
        m.imageUrl = await r2Service.getSignedDownloadUrl(m.imageKey, 3600);
      }
    })
  );
  return messages;
};

const populateConversation = (query) =>
  query
    .populate('customer', 'name phone verificationStatus')
    .populate('runner', 'name phone verificationStatus')
    .populate('errand', 'title status location amount');

// GET /api/conversations/errand/:errandId
exports.getConversationForErrand = async (req, res) => {
  const conversation = await populateConversation(
    Conversation.findOne({ errand: req.params.errandId, status: { $ne: 'archived' } })
  );
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'No conversation found for this errand' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const otherParticipant = await buildOtherParticipant(conversation, req.user._id);

  res.status(200).json({
    status: 'success',
    data: {
      conversation,
      otherParticipant,
      errand: conversation.errand,
    },
  });
};

// GET /api/conversations/:id
exports.getConversation = async (req, res) => {
  const conversation = await populateConversation(Conversation.findById(req.params.id));
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const otherParticipant = await buildOtherParticipant(conversation, req.user._id);

  res.status(200).json({
    status: 'success',
    data: {
      conversation,
      otherParticipant,
      errand: conversation.errand,
    },
  });
};

// GET /api/conversations/:id/messages?before=<ISO date>&limit=30
exports.listMessages = async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 100);
  const query = { conversation: conversation._id };
  if (req.query.before) {
    query.createdAt = { $lt: new Date(req.query.before) };
  }

  const messages = await Message.find(query)
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('sender', 'name')
    .lean();

  messages.reverse();
  await attachImageUrls(messages);

  res.status(200).json({ status: 'success', data: { messages } });
};

// POST /api/conversations/:id/messages  { text, quickReply? }
exports.sendMessage = async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }
  if (conversation.status !== 'active') {
    return res.status(400).json({ status: 'fail', message: 'This chat is read-only' });
  }

  const { text, quickReply } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ status: 'fail', message: 'text is required' });
  }

  const message = await Message.create({
    conversation: conversation._id,
    errand: conversation.errand,
    sender: req.user._id,
    type: 'text',
    text: unescapeHtml(text.trim()),
    quickReply: quickReply ? unescapeHtml(quickReply) : null,
  });

  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessagePreview = message.text.slice(0, 200);
  await conversation.save();

  await notifyNewMessage(conversation, message, req.user);

  res.status(201).json({ status: 'success', data: { message } });
};

// Single optional image upload for POST /conversations/:id/messages/image
const chatImageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});
exports.uploadChatImage = chatImageUpload.single('image');

// POST /api/conversations/:id/messages/image  (multipart, field name "image")
exports.sendImageMessage = async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }
  if (conversation.status !== 'active') {
    return res.status(400).json({ status: 'fail', message: 'This chat is read-only' });
  }
  if (!req.file) {
    return res.status(400).json({ status: 'fail', message: 'image is required' });
  }

  const imageKey = await r2Service.uploadFile(
    req.file.buffer,
    `chat/${conversation._id}`,
    'image',
    req.file.mimetype
  );

  const caption = req.body.caption && req.body.caption.trim()
    ? unescapeHtml(req.body.caption.trim())
    : null;

  const message = await Message.create({
    conversation: conversation._id,
    errand: conversation.errand,
    sender: req.user._id,
    type: 'image',
    imageKey,
    text: caption,
  });

  conversation.lastMessageAt = message.createdAt;
  conversation.lastMessagePreview = caption ? `📷 ${caption}` : '📷 Photo';
  await conversation.save();

  await notifyNewMessage(conversation, message, req.user);

  const plain = message.toObject();
  plain.imageUrl = await r2Service.getSignedDownloadUrl(imageKey, 3600);

  res.status(201).json({ status: 'success', data: { message: plain } });
};

// PATCH /api/conversations/:id/read
exports.markRead = async (req, res) => {
  const conversation = await Conversation.findById(req.params.id);
  if (!conversation) {
    return res.status(404).json({ status: 'fail', message: 'Conversation not found' });
  }
  if (!isParticipant(conversation, req.user._id)) {
    return res.status(403).json({ status: 'fail', message: 'Access denied' });
  }

  const isCustomer = conversation.customer.toString() === req.user._id.toString();
  const readAt = new Date();
  conversation[isCustomer ? 'customerLastReadAt' : 'runnerLastReadAt'] = readAt;
  await conversation.save();

  emitChatRead(conversation, { readerId: req.user._id, readAt });

  res.status(200).json({ status: 'success', data: { readAt } });
};

// Shared by sendMessage/sendImageMessage: real-time delivery + offline notification.
async function notifyNewMessage(conversation, message, sender) {
  emitChatMessage(conversation, message);

  const isSenderCustomer = conversation.customer.toString() === sender._id.toString();
  const recipientId = isSenderCustomer ? conversation.runner : conversation.customer;

  notify.send({
    userId: recipientId,
    title: sender.name,
    message: message.type === 'image' ? '📷 Sent a photo' : message.text,
    type: 'message',
    relatedId: conversation._id,
    relatedModel: 'Conversation',
    eventName: 'chat:message',
    eventData: {
      conversationId: conversation._id,
      errandId: conversation.errand,
      messageId: message._id,
    },
  });
}
