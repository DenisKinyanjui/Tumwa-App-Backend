const mongoose = require('mongoose');

/**
 * One Payment document per M-Pesa transaction.
 *
 * type = 'errand_payment'  → customer pays before errand is created (STK push)
 *                            errandData holds form details; errand is created in the callback
 *        'float_deposit'   → runner tops up float balance (STK push)
 *        'withdrawal'      → runner withdraws available balance (B2C)
 *        'dispute_refund'  → customer refund paid out after dispute resolution (B2C)
 */
const paymentSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: {
        values: ['errand_payment', 'float_deposit', 'withdrawal', 'dispute_refund'],
        message: 'Invalid payment type',
      },
      required: true,
    },

    // ── errand_payment fields ─────────────────────────────────────────────────
    errand: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Errand',
      default: null,
    },
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── float_deposit + withdrawal fields ─────────────────────────────────────
    runner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // ── common fields ────────────────────────────────────────────────────────
    amount: {
      type: Number,
      required: [true, 'Payment amount is required'],
      min: [1, 'Amount must be at least 1'],
    },
    phoneNumber: {
      type: String,
      required: [true, 'Phone number is required'],
      trim: true,
    },
    status: {
      type: String,
      enum: {
        values: ['pending', 'completed', 'failed', 'cancelled'],
        message: 'Invalid payment status',
      },
      default: 'pending',
    },

    // ── M-Pesa identifiers ───────────────────────────────────────────────────
    mpesa: {
      // STK push identifiers
      checkoutRequestId: { type: String, default: null },
      merchantRequestId: { type: String, default: null },

      // B2C identifiers
      conversationId: { type: String, default: null },
      originatorConversationId: { type: String, default: null },

      // Populated by callback
      receiptNumber: { type: String, default: null },   // M-Pesa transaction ID
      resultCode: { type: Number, default: null },
      resultDesc: { type: String, default: null },
    },

    // ── Pending errand data (errand_payment only — stored pre-creation) ─────────
    errandData: {
      title:       { type: String, default: null },
      description: { type: String, default: null },
      location: {
        address:  { type: String, default: null },
        pickup: {
          lat: { type: Number, default: null },
          lng: { type: Number, default: null },
        },
        delivery: {
          lat: { type: Number, default: null },
          lng: { type: Number, default: null },
        },
      },
      amount: { type: Number, default: null },
    },

    failureReason: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
    completedAt: { type: Date, default: null },

    // Requests expire after 5 minutes — used by status endpoint to detect timeouts
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 5 * 60 * 1000),
    },
  },
  {
    timestamps: true,
  }
);

// Fast lookups by M-Pesa callback identifiers
paymentSchema.index({ 'mpesa.checkoutRequestId': 1 }, { sparse: true });
paymentSchema.index({ 'mpesa.conversationId': 1 }, { sparse: true });
paymentSchema.index({ errand: 1 });
paymentSchema.index({ runner: 1 });

module.exports = mongoose.model('Payment', paymentSchema);
