const Conversation = require('../models/Conversation');
const logger = require('../utils/logger');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Find (or create) the active/readonly conversation for an errand.
 * Never throws — failure to create a conversation must never block
 * errand assignment, which is the caller in every case.
 * @param {object} errand - populated or plain Errand doc, must have customer/runner
 * @returns {Promise<object|null>}
 */
const getOrCreateForErrand = async (errand) => {
  try {
    const existing = await Conversation.findOne({
      errand: errand._id,
      status: { $ne: 'archived' },
    });
    if (existing) return existing;

    return await Conversation.create({
      errand: errand._id,
      customer: errand.customer._id || errand.customer,
      runner: errand.runner._id || errand.runner,
    });
  } catch (err) {
    logger.error('[ConversationService] getOrCreateForErrand failed', {
      errandId: errand?._id,
      error: err.message,
    });
    return null;
  }
};

/**
 * Archive the current non-archived conversation for an errand (if any).
 * Used when a runner is unassigned (runner-cancel or admin reassignment)
 * so a newly-assigned runner never sees the previous runner's messages.
 */
const archiveForErrand = async (errandId) => {
  try {
    await Conversation.findOneAndUpdate(
      { errand: errandId, status: { $ne: 'archived' } },
      { status: 'archived' }
    );
  } catch (err) {
    logger.error('[ConversationService] archiveForErrand failed', {
      errandId,
      error: err.message,
    });
  }
};

/**
 * Mark the current conversation for an errand read-only.
 * @param {string|ObjectId} errandId
 * @param {object} opts
 * @param {'cancelled'|'completed'} opts.reason
 * @param {Date|null} [opts.until] - informational for 'completed' (null = permanent);
 *   enforced by sweepExpiredReadonly for 'cancelled'.
 */
const setReadonly = async (errandId, { reason, until = null }) => {
  try {
    await Conversation.findOneAndUpdate(
      { errand: errandId, status: { $ne: 'archived' } },
      { status: 'readonly', readonlyReason: reason, readonlyUntil: until }
    );
  } catch (err) {
    logger.error('[ConversationService] setReadonly failed', {
      errandId,
      reason,
      error: err.message,
    });
  }
};

/** Convenience helper: 30 days from now, for cancellation read-only windows. */
const thirtyDaysFromNow = () => new Date(Date.now() + THIRTY_DAYS_MS);

/**
 * Archive any cancelled conversations whose 30-day read-only window has
 * elapsed. Intended to run on a recurring interval (see index.js).
 */
const sweepExpiredReadonly = async () => {
  try {
    const result = await Conversation.updateMany(
      {
        status: 'readonly',
        readonlyReason: 'cancelled',
        readonlyUntil: { $lte: new Date() },
      },
      { status: 'archived' }
    );
    if (result.modifiedCount > 0) {
      logger.info('[ConversationService] sweepExpiredReadonly archived conversations', {
        count: result.modifiedCount,
      });
    }
  } catch (err) {
    logger.error('[ConversationService] sweepExpiredReadonly failed', { error: err.message });
  }
};

module.exports = {
  getOrCreateForErrand,
  archiveForErrand,
  setReadonly,
  sweepExpiredReadonly,
  thirtyDaysFromNow,
};
