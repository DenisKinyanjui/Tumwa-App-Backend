const Notification = require('../models/Notification');
const User = require('../models/User');
const { emitToUser, emitToRoom } = require('../socket/socketManager');
const { sendPush } = require('./pushNotificationService');

/**
 * Send a notification to a single user.
 *
 * Execution order:
 *   1. Save Notification to DB (awaited — guaranteed persistence)
 *   2. Emit socket event  (sync, in-memory)
 *   3. Send FCM push      (fire-and-forget — does not block response)
 *
 * Never throws — notification failures must not break the caller's flow.
 *
 * @param {object} params
 * @param {string|ObjectId} params.userId
 * @param {string} params.title
 * @param {string} params.message
 * @param {'errand'|'payment'|'dispute'|'rating'|'admin'|'system'} params.type
 * @param {string|ObjectId} [params.relatedId]
 * @param {'Errand'|'Payment'|'Dispute'|'User'} [params.relatedModel]
 * @param {string} params.eventName       - socket event name
 * @param {object} [params.eventData]     - additional socket payload (merged with notificationId)
 * @returns {Promise<object|null>} the saved Notification document, or null on failure
 */
const send = async ({
  userId,
  title,
  message,
  type,
  relatedId = null,
  relatedModel = null,
  eventName,
  eventData = {},
}) => {
  try {
    // 1. Persist to DB
    const notification = await Notification.create({
      user: userId,
      title,
      message,
      type,
      relatedId,
      relatedModel,
    });

    // 2. Emit socket event — include notificationId so client can mark-read on tap
    emitToUser(userId, eventName, { ...eventData, notificationId: notification._id });

    // 3. FCM push — fire-and-forget
    User.findById(userId)
      .select('fcmToken')
      .lean()
      .then((user) => {
        if (user?.fcmToken) {
          sendPush({
            token: user.fcmToken,
            title,
            body: message,
            data: {
              type,
              eventName,
              notificationId: String(notification._id),
              relatedId: relatedId ? String(relatedId) : '',
              relatedModel: relatedModel || '',
            },
          });
        }
      })
      .catch((err) => console.error('[Notify] FCM lookup failed:', err.message));

    return notification;
  } catch (err) {
    console.error(`[Notify] send failed (${eventName} → ${userId}):`, err.message);
    return null;
  }
};

/**
 * Send a notification to every active user with a given role.
 * Also emits a socket broadcast to the role room.
 *
 * Use for admin alerts (small group). Do NOT use for runner broadcasts —
 * use emitToNearbyRunners for that (socket-only, no DB records).
 *
 * @param {object} params
 * @param {'admin'|'customer'|'runner'} params.role
 * @param {string} params.title
 * @param {string} params.message
 * @param {'errand'|'payment'|'dispute'|'rating'|'admin'|'system'} params.type
 * @param {string|ObjectId} [params.relatedId]
 * @param {'Errand'|'Payment'|'Dispute'|'User'} [params.relatedModel]
 * @param {string} params.eventName
 * @param {object} [params.eventData]
 */
const sendToRole = async ({
  role,
  title,
  message,
  type,
  relatedId = null,
  relatedModel = null,
  eventName,
  eventData = {},
}) => {
  try {
    // Broadcast socket event to the role room immediately (reaches online users)
    emitToRoom(`${role}s`, eventName, { ...eventData });

    // Persist a notification record for each user in the role
    const users = await User.find({ role, isActive: true }).select('_id fcmToken').lean();
    if (!users.length) return;

    // Bulk-insert notification documents
    const docs = users.map((u) => ({
      user: u._id,
      title,
      message,
      type,
      relatedId,
      relatedModel,
    }));

    const inserted = await Notification.insertMany(docs, { ordered: false });

    // Fire-and-forget FCM pushes to each user in the role
    users.forEach((u, i) => {
      if (u.fcmToken) {
        sendPush({
          token: u.fcmToken,
          title,
          body: message,
          data: {
            type,
            eventName,
            notificationId: inserted[i] ? String(inserted[i]._id) : '',
            relatedId: relatedId ? String(relatedId) : '',
            relatedModel: relatedModel || '',
          },
        });
      }
    });
  } catch (err) {
    console.error(`[Notify] sendToRole failed (${eventName} → ${role}s):`, err.message);
  }
};

module.exports = { send, sendToRole };
