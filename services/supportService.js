const SupportConversation = require('../models/SupportConversation');
const SupportMessage = require('../models/SupportMessage');
const logger = require('../utils/logger');

const isStaff = (role) => role === 'admin' || role === 'superadmin';

/**
 * Find the requester's current non-archived conversation, or create one.
 * Mirrors conversationService.getOrCreateForErrand's shape but keyed on
 * requester instead of errand.
 * @param {object} requester - req.user (must have _id and role)
 */
const findOrCreateConversation = async (requester) => {
  const existing = await SupportConversation.findOne({
    requesterId: requester._id,
    archived: false,
  });
  if (existing) return existing;

  return SupportConversation.create({
    participants: [requester._id],
    requesterId: requester._id,
    requesterRole: requester.role,
    channel: 'live_chat',
    status: 'open',
  });
};

/**
 * Persist a message and update the parent conversation's denormalized
 * lastMessage/lastActivity/unreadCounts/status fields. Single source of
 * truth called by both the REST controllers and the support:send-message
 * socket handler so a message is never created twice.
 *
 * @param {object} params
 * @param {object} params.conversation - SupportConversation doc
 * @param {object} params.sender - req.user / socket.user (must have _id, role)
 * @param {string} [params.text]
 * @param {object} [params.attachment] - { key, mimeType, fileName, size }
 * @param {'text'|'image'|'pdf'} [params.messageType]
 */
const addMessage = async ({ conversation, sender, text = null, attachment = null, messageType = 'text' }) => {
  const senderIsStaff = isStaff(sender.role);

  const message = await SupportMessage.create({
    conversationId: conversation._id,
    senderId: sender._id,
    senderRole: sender.role,
    message: text,
    messageType,
    attachment: attachment || undefined,
    readBy: [{ user: sender._id, readAt: new Date() }],
  });

  const preview =
    messageType === 'image' ? '📷 Photo' : messageType === 'pdf' ? '📄 Document' : (text || '').slice(0, 200);

  conversation.lastMessage = preview;
  conversation.lastActivity = message.createdAt;

  // Track participants for room/access-control symmetry with Conversation.
  if (!conversation.participants.some((p) => p.toString() === sender._id.toString())) {
    conversation.participants.push(sender._id);
  }
  if (senderIsStaff && !conversation.assignedAdmin) {
    conversation.assignedAdmin = sender._id;
  }

  // Status ping-pongs based on who spoke last, unless the thread is already
  // resolved/closed (a stray message reopens it rather than silently
  // vanishing into a "resolved" thread).
  if (senderIsStaff) {
    conversation.status = 'waiting_user';
    conversation.unreadCounts.customer += 1;
  } else {
    conversation.status = conversation.status === 'closed' ? 'open' : 'waiting_admin';
    conversation.unreadCounts.admin += 1;
  }

  await conversation.save();

  return message;
};

/**
 * Reset the caller's side of unreadCounts and stamp readBy on messages
 * they haven't read yet.
 * @param {object} conversation - SupportConversation doc
 * @param {object} reader - req.user (must have _id, role)
 */
const markRead = async (conversation, reader) => {
  const readerIsStaff = isStaff(reader.role);
  const readAt = new Date();

  conversation.unreadCounts[readerIsStaff ? 'admin' : 'customer'] = 0;
  await conversation.save();

  await SupportMessage.updateMany(
    { conversationId: conversation._id, 'readBy.user': { $ne: reader._id } },
    { $push: { readBy: { user: reader._id, readAt } } }
  );

  return readAt;
};

// ── Permission helpers ────────────────────────────────────────────────────────
// Centralizes the "Super Admins can additionally..." rules from the spec so
// controllers never inline a role check.

const isSuperAdmin = (user) => user.role === 'superadmin';

const canDeleteConversation = (user) => isSuperAdmin(user);

const canViewArchived = (user) => isSuperAdmin(user);

// Regular admins may assign an unassigned conversation or reassign one
// already assigned to themselves; only superadmins may reassign a
// conversation currently owned by a different admin.
const canReassign = (user, conversation) =>
  isSuperAdmin(user) ||
  !conversation.assignedAdmin ||
  conversation.assignedAdmin.toString() === user._id.toString();

module.exports = {
  isStaff,
  findOrCreateConversation,
  addMessage,
  markRead,
  isSuperAdmin,
  canDeleteConversation,
  canViewArchived,
  canReassign,
};
