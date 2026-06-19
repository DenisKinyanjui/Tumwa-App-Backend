const mongoose = require('mongoose');

/**
 * Status lifecycle:
 *   pending → assigned → in_progress → completed → confirmed
 *          ↘ marketplace → assigned   ↘ cancelled
 *                      ↘ cancelled             ↘ disputed
 *
 *   pending     — matching system is actively searching for a runner
 *   marketplace — matching exhausted; errand visible in runner browse screen
 */
const errandSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'Errand must belong to a customer'],
    },
    runner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    title: {
      type: String,
      required: [true, 'Errand title is required'],
      trim: true,
      maxlength: [100, 'Title cannot exceed 100 characters'],
    },
    description: {
      type: String,
      required: [true, 'Errand description is required'],
      trim: true,
      maxlength: [1000, 'Description cannot exceed 1000 characters'],
    },
    location: {
      address: { type: String, required: [true, 'Location address is required'] },
      coordinates: {
        lat: { type: Number },
        lng: { type: Number },
      },
    },
    // ── Pricing ──────────────────────────────────────────────────────────────
    amount: {
      type: Number,
      required: [true, 'Payment amount is required'],
      min: [1, 'Amount must be at least 1'],
    },
    // Derived fee fields — calculated and stored on creation for audit trail
    runnerCommission:      { type: Number, default: 0 }, // 10% of amount → runner earns this
    platformCustomerFee:   { type: Number, default: 0 }, // 2.5% of amount → billed to customer
    platformRunnerFee:     { type: Number, default: 0 }, // 2.5% of amount → deducted from runner
    totalCustomerPays:     { type: Number, default: 0 }, // amount + runnerCommission + platformCustomerFee
    runnerReceives:        { type: Number, default: 0 }, // runnerCommission - platformRunnerFee
    platformEarns:         { type: Number, default: 0 }, // platformCustomerFee + platformRunnerFee
    trustHeld:             { type: Number, default: 0 }, // amount held in escrow (totalCustomerPays - platformCustomerFee upfront)

    // ── Float tracking ────────────────────────────────────────────────────────
    floatUsed:    { type: Boolean, default: false }, // runner used float wallet
    ownMoneyUsed: { type: Boolean, default: false }, // runner used own money (float = 0)
    floatReleased:{ type: Boolean, default: false }, // trust released after completion

    status: {
      type: String,
      enum: {
        values: ['pending', 'marketplace', 'assigned', 'in_progress', 'completed', 'confirmed', 'cancelled', 'disputed'],
        message: 'Invalid errand status',
      },
      default: 'pending',
    },
    proofOfCompletion: { type: String, default: null },
    assignedAt:   { type: Date, default: null },
    startedAt:    { type: Date, default: null },
    completedAt:  { type: Date, default: null },
    confirmedAt:  { type: Date, default: null },
    cancelledAt:  { type: Date, default: null },
    disputedAt:   { type: Date, default: null },
    disputeReason:{ type: String, default: null },
    isPaid:       { type: Boolean, default: false },
    paidAt:       { type: Date, default: null },

    // ── Matching state ────────────────────────────────────────────────────
    // Tracks the lifecycle of the automated runner-matching process.
    // Separate from `status` (errand lifecycle) — this only concerns matching.
    matchingState: {
      // idle         → created, matching not yet started
      // searching    → actively querying eligible runners
      // offered      → offer sent to a specific runner, awaiting response
      // no_runner    → exhausted all candidates; customer must retry or cancel
      status: {
        type: String,
        enum: ['idle', 'searching', 'offered', 'no_runner'],
        default: 'idle',
      },
      // Runners already offered this errand (prevents re-offering on same cycle)
      offeredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      // The single runner currently holding an active offer
      currentOffer: {
        runnerId:  { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
        offeredAt: { type: Date, default: null },
        expiresAt: { type: Date, default: null },
      },
      // Total offer attempts across all cycles (guards against infinite loops)
      attempts:     { type: Number, default: 0 },
      lastSearchAt: { type: Date, default: null },
    },

    // Who triggered the most recent cancellation (customer cancel stays cancelled;
    // runner cancel resets errand back to pending for re-matching)
    cancelledBy:  { type: String, enum: ['customer', 'runner', 'admin', null], default: null },
    cancelReason: { type: String, default: null },
  },
  {
    timestamps: true,
  }
);

// ── Indexes for query performance ─────────────────────────────────────────────
errandSchema.index({ customer: 1, createdAt: -1 });      // customer history
errandSchema.index({ runner: 1, createdAt: -1 });         // runner history
errandSchema.index({ status: 1, createdAt: -1 });         // admin filters
errandSchema.index({ runner: 1, status: 1 });             // runner active errands
errandSchema.index({ customer: 1, status: 1 });           // customer active errands
errandSchema.index({ createdAt: -1 });                    // analytics time series
errandSchema.index({ isPaid: 1, status: 1 });             // payment status checks

module.exports = mongoose.model('Errand', errandSchema);
