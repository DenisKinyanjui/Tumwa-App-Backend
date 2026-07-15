const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Conversation = require('../models/Conversation');
const logger = require('../utils/logger');
const { isWithinRadius } = require('../utils/distanceCalculator');

let io;

/**
 * Room naming convention:
 *   user:{userId}   — personal room, targeted 1-to-1 messages
 *   runners         — all connected runners (new-errand broadcasts)
 *   admins          — all connected admins (disputes, failures)
 *   customers       — all connected customers
 *
 * Events emitted by the server:
 *   errand:new      → runners room    (new paid errand available)
 *   errand:accepted → user:{customerId}  (runner accepted their errand)
 *   errand:update   → user:{customerId} + user:{runnerId}  (any status change)
 *   wallet:update   → user:{runnerId}   (balance changed — client should refetch)
 *   payment:success → user:{customerId} (STK confirmed, errand created)
 *   payment:failed  → user:{customerId} (STK failed)
 *   chat:message    → user:{customerId} + user:{runnerId}  (new message in their conversation)
 *   chat:read       → user:{otherParticipantId}  (their message was read)
 *   chat:typing     → errand:{errandId} room  (broadcast, ephemeral)
 *   chat:presence   → user:{otherParticipantId} (join/leave online-state changes)
 */

const initSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CLIENT_ORIGIN || '*',
      methods: ['GET', 'POST'],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // ── Auth middleware ────────────────────────────────────────────────────────
  // Client must connect with: io(URL, { auth: { token: '<jwt>' } })
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) {
      return next(new Error('AUTH_REQUIRED: provide a JWT in socket.handshake.auth.token'));
    }

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return next(
        new Error(
          err.name === 'TokenExpiredError'
            ? 'AUTH_EXPIRED: token has expired'
            : 'AUTH_INVALID: invalid token',
        ),
      );
    }

    const user = await User.findById(decoded.id).select('name role isActive');
    if (!user) return next(new Error('AUTH_INVALID: user not found'));
    if (!user.isActive) return next(new Error('AUTH_FORBIDDEN: account is deactivated'));

    socket.user = user;
    next();
  });

  // ── Connection handler ─────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const { _id, name, role } = socket.user;

    socket.join(`user:${_id}`);
    socket.join(`${role}s`); // 'runners', 'admins', 'customers'

    logger.info(`[Socket] connected  | ${name} (${role}) | socketId: ${socket.id}`);

    // Runner sets availability status + location.
    // Persists to DB so the matching service can query even for offline runners.
    // Payload: { status: 'available'|'busy'|'offline', lat?: number, lng?: number }
    socket.on('runner:availability', async ({ status, lat, lng }) => {
      if (role !== 'runner') return;

      const validStatuses = ['available', 'busy', 'offline'];
      if (!validStatuses.includes(status)) return;

      const update = {
        'availability.status':  status,
        'availability.lastSeen': new Date(),
      };

      if (typeof lat === 'number' && typeof lng === 'number') {
        update['availability.latitude']  = lat;
        update['availability.longitude'] = lng;
        socket.location = { lat, lng }; // keep in-memory copy in sync
      }

      try {
        await User.findByIdAndUpdate(_id, update);
        logger.info(`[Socket] runner:availability → ${status}`, { userId: _id });
      } catch (err) {
        logger.error('[Socket] runner:availability DB update failed', { error: err.message });
      }
    });

    // Runner optionally reports location for proximity-filtered errand broadcasts.
    // Also updates the persistent availability record.
    socket.on('runner:location', ({ lat, lng }) => {
      if (role !== 'runner') return;
      if (typeof lat !== 'number' || typeof lng !== 'number') return;
      socket.location = { lat, lng };
      // Persist coordinates without changing status
      User.findByIdAndUpdate(_id, {
        'availability.latitude':  lat,
        'availability.longitude': lng,
        'availability.lastSeen':  new Date(),
      }).catch((err) =>
        logger.error('[Socket] runner:location persist failed', { error: err.message }),
      );
    });

    // Runner sends live GPS update for an active errand
    // → relayed to everyone watching that errand (errand:{errandId} room)
    socket.on('runner:location:update', ({ errandId, latitude, longitude }) => {
      if (role !== 'runner') return;
      if (!errandId || typeof latitude !== 'number' || typeof longitude !== 'number') return;

      // Keep socket.location in sync for proximity filtering
      socket.location = { lat: latitude, lng: longitude };

      io.to(`errand:${errandId}`).emit('runner:location:live', {
        errandId,
        latitude,
        longitude,
      });
    });

    // Customer joins errand room to receive live runner location
    socket.on('errand:watch', ({ errandId }) => {
      if (!errandId) return;
      socket.join(`errand:${errandId}`);
      logger.info(`[Socket] ${name} (${role}) watching errand:${errandId}`);
    });

    // Customer leaves errand room (map screen unmounted)
    socket.on('errand:unwatch', ({ errandId }) => {
      if (!errandId) return;
      socket.leave(`errand:${errandId}`);
    });

    // ── Chat ──────────────────────────────────────────────────────────────────
    // Joins the same errand:{id} room used for GPS tracking, but kept as a
    // separate event pair so chat-only behavior (typing/presence) doesn't
    // get tangled with the tracking code path above.
    socket.on('chat:watch', async ({ errandId }) => {
      if (!errandId) return;
      try {
        const conversation = await Conversation.findOne({
          errand: errandId,
          status: { $ne: 'archived' },
        }).select('customer runner');
        if (!conversation) return;

        const isParticipant =
          conversation.customer.toString() === _id.toString() ||
          conversation.runner.toString() === _id.toString();
        if (!isParticipant) return;

        socket.join(`errand:${errandId}`);
        socket.data.watchingChatFor = errandId;

        const otherId = (
          conversation.customer.toString() === _id.toString()
            ? conversation.runner
            : conversation.customer
        ).toString();
        const otherRoom = io.sockets.adapter.rooms.get(`user:${otherId}`);
        socket.emit('chat:presence', { userId: otherId, online: !!(otherRoom && otherRoom.size > 0) });
      } catch (err) {
        logger.error('[Socket] chat:watch failed', { error: err.message });
      }
    });

    socket.on('chat:unwatch', ({ errandId }) => {
      if (!errandId) return;
      socket.leave(`errand:${errandId}`);
      if (socket.data.watchingChatFor === errandId) socket.data.watchingChatFor = null;
    });

    // Ephemeral only — no persistence, no offline-delivery guarantee needed.
    socket.on('chat:typing', ({ errandId, isTyping }) => {
      if (!errandId) return;
      socket.to(`errand:${errandId}`).emit('chat:typing', {
        errandId,
        userId: _id,
        isTyping: !!isTyping,
      });
    });

    socket.on('disconnect', (reason) => {
      logger.info(`[Socket] disconnected | ${name} (${role}) | reason: ${reason}`);
      // Mark runner offline so they are excluded from future matching queries
      if (role === 'runner') {
        User.findByIdAndUpdate(_id, {
          'availability.status':  'offline',
          'availability.lastSeen': new Date(),
        }).catch((err) =>
          logger.error('[Socket] disconnect: runner offline update failed', { error: err.message }),
        );
      }

      // Tell the other chat participant we've gone offline (single-instance only —
      // presence is derived from live connection state, not persisted).
      if (socket.data.watchingChatFor) {
        Conversation.findOne({
          errand: socket.data.watchingChatFor,
          status: { $ne: 'archived' },
        })
          .select('customer runner')
          .then((conversation) => {
            if (!conversation) return;
            const otherId = (
              conversation.customer.toString() === _id.toString()
                ? conversation.runner
                : conversation.customer
            ).toString();
            emitToUser(otherId, 'chat:presence', {
              userId: _id.toString(),
              online: false,
              lastSeenAt: new Date(),
            });
          })
          .catch((err) =>
            logger.error('[Socket] disconnect: chat presence update failed', { error: err.message }),
          );
      }
    });

    socket.on('error', (err) => {
      logger.error(`[Socket] error | ${name} (${role})`, { error: err.message });
    });
  });

  logger.info('[Socket] Socket.io initialized');
  return io;
};

// ── Low-level helpers ─────────────────────────────────────────────────────────

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized. Call initSocket first.');
  return io;
};

const emitToUser = (userId, event, data) => {
  try {
    getIO().to(`user:${userId}`).emit(event, data);
  } catch (err) {
    logger.error(`[Socket] emitToUser failed (${event} → ${userId})`, { error: err.message });
  }
};

const emitToRoom = (room, event, data) => {
  try {
    getIO().to(room).emit(event, data);
  } catch (err) {
    logger.error(`[Socket] emitToRoom failed (${event} → ${room})`, { error: err.message });
  }
};

// ── Domain helpers ────────────────────────────────────────────────────────────

/**
 * Emit errand:update to all relevant parties (customer + runner).
 * Either userId may be null/undefined — those are silently skipped.
 */
const emitErrandUpdate = (errand, ...userIds) => {
  const payload = { errand };
  userIds.forEach((id) => {
    if (id) emitToUser(id.toString(), 'errand:update', payload);
  });
};

/**
 * Signal that a user's wallet has changed — client should re-fetch balance.
 */
const emitWalletUpdate = (userId, type = 'update') => {
  emitToUser(userId.toString(), 'wallet:update', { type });
};

/**
 * Emit a payment lifecycle event to a specific user.
 */
const emitPaymentEvent = (userId, event, data) => {
  emitToUser(userId.toString(), event, data);
};

/**
 * Broadcast a new errand to nearby runners.
 * Falls back to all runners if no runner has reported a location.
 * Emits the standardised 'errand:new' event.
 */
const emitToNearbyRunners = (errand) => {
  try {
    const currentIO = getIO();
    const { lat: eLat, lng: eLng } = errand.location?.coordinates || {};
    const radiusKm = parseFloat(process.env.RUNNER_NOTIFY_RADIUS_KM) || 10;

    const runnersRoom = currentIO.sockets.adapter.rooms.get('runners');
    if (!runnersRoom || runnersRoom.size === 0) return;

    let notified = 0;
    runnersRoom.forEach((socketId) => {
      const socket = currentIO.sockets.sockets.get(socketId);
      if (!socket) return;

      if (!eLat || !eLng || !socket.location) {
        socket.emit('errand:new', { errand });
        notified++;
        return;
      }

      if (isWithinRadius(socket.location, { lat: eLat, lng: eLng }, radiusKm)) {
        socket.emit('errand:new', { errand });
        notified++;
      }
    });

    logger.info(`[Socket] errand:new emitted to ${notified} runner(s)`, { errandId: errand._id });
  } catch (err) {
    logger.error('[Socket] emitToNearbyRunners failed', { error: err.message });
  }
};

// isWithinRadius imported from utils/distanceCalculator at the top of this file.

// ── Matching-specific emit helpers ────────────────────────────────────────────

/**
 * Send a matching offer to a runner.
 * Payload shape must match what the app's errand:request handler expects.
 */
const emitErrandRequest = (runnerId, payload) => {
  emitToUser(runnerId.toString(), 'errand:request', payload);
};

/**
 * Tell a runner their offer has expired (errand accepted by someone else or timed out).
 */
const emitErrandExpired = (runnerId, errandId, reason = 'timeout') => {
  emitToUser(runnerId.toString(), 'errand:expired', { errandId, reason });
};

/**
 * Tell the customer we are actively searching for a runner.
 */
const emitSearching = (customerId, errandId) => {
  emitToUser(customerId.toString(), 'errand:searching', {
    errandId,
    message: 'Finding a runner near you…',
  });
};

/**
 * Tell the customer no runner was found.
 */
const emitNoRunner = (customerId, errandId) => {
  emitToUser(customerId.toString(), 'errand:no_runner', {
    errandId,
    message: 'No runner available. You can retry or cancel for a refund.',
  });
};

/**
 * Tell the customer an offer has been sent to a specific runner.
 */
const emitRunnerOffered = (customerId, errandId) => {
  emitToUser(customerId.toString(), 'errand:offered', {
    errandId,
    message: 'A runner is reviewing your errand…',
  });
};

/**
 * Notify the customer the errand moved to marketplace, and broadcast it to
 * all runners so their browse list updates in real-time.
 */
const emitMarketplaceFallback = (customerId, errand) => {
  emitToUser(customerId.toString(), 'errand:marketplace', {
    errandId: errand._id,
    message:  'No runners found nearby. Your errand is now visible to all runners.',
  });
  emitToRoom('runners', 'errand:marketplace', { errand });
};

// ── Dispute helpers ───────────────────────────────────────────────────────────

/**
 * Emit dispute:created to both the customer and runner.
 */
const emitDisputeCreated = (customerId, runnerId, payload) => {
  const data = { event: 'dispute:created', ...payload };
  if (customerId) emitToUser(customerId.toString(), 'dispute:created', data);
  if (runnerId)   emitToUser(runnerId.toString(),  'dispute:created', data);
};

/**
 * Emit dispute:update (status change, e.g. under_review) to both parties.
 */
const emitDisputeUpdate = (customerId, runnerId, payload) => {
  const data = { event: 'dispute:update', ...payload };
  if (customerId) emitToUser(customerId.toString(), 'dispute:update', data);
  if (runnerId)   emitToUser(runnerId.toString(),  'dispute:update', data);
};

/**
 * Emit dispute:resolved to both the customer and runner.
 */
const emitDisputeResolved = (customerId, runnerId, payload) => {
  const data = { event: 'dispute:resolved', ...payload };
  if (customerId) emitToUser(customerId.toString(), 'dispute:resolved', data);
  if (runnerId)   emitToUser(runnerId.toString(),  'dispute:resolved', data);
};

// ── Chat helpers ──────────────────────────────────────────────────────────────

/**
 * Emit a new chat message to both participants' personal rooms — targeted
 * (not room-broadcast) so delivery works even if the recipient hasn't
 * opened the Chat screen.
 */
const emitChatMessage = (conversation, message) => {
  const payload = { conversationId: conversation._id, errandId: conversation.errand, message };
  emitToUser(conversation.customer.toString(), 'chat:message', payload);
  emitToUser(conversation.runner.toString(), 'chat:message', payload);
};

/**
 * Emit a read receipt to the participant who did NOT just mark messages read.
 */
const emitChatRead = (conversation, { readerId, readAt }) => {
  const isReaderCustomer = conversation.customer.toString() === readerId.toString();
  const otherId = isReaderCustomer ? conversation.runner : conversation.customer;
  emitToUser(otherId.toString(), 'chat:read', { conversationId: conversation._id, readerId, readAt });
};

module.exports = {
  initSocket,
  getIO,
  emitToUser,
  emitToRoom,
  emitErrandUpdate,
  emitWalletUpdate,
  emitPaymentEvent,
  emitToNearbyRunners,
  emitErrandRequest,
  emitErrandExpired,
  emitSearching,
  emitNoRunner,
  emitRunnerOffered,
  emitMarketplaceFallback,
  emitDisputeCreated,
  emitDisputeUpdate,
  emitDisputeResolved,
  emitChatMessage,
  emitChatRead,
};
