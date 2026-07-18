/**
 * Wallet utility functions.
 *
 * Commission rules (all percentages of errand `amount`):
 *   runnerCommission    = 10%   → paid TO the runner on top of amount
 *   platformCustomerFee = 2.5%  → billed FROM the customer
 *   platformRunnerFee   = 2.5%  → deducted FROM the runner's commission
 *
 * Example — amount = 1000:
 *   runnerCommission    = 100
 *   platformCustomerFee = 25
 *   platformRunnerFee   = 25
 *   totalCustomerPays   = 1125   (1000 + 100 + 25)
 *   runnerReceives      = 75     (100 - 25)
 *   platformEarns       = 50     (25 + 25)
 *   trustHeld           = 1100   (totalCustomerPays - platformCustomerFee upfront)
 *
 * Wallet schema (User.wallet / User.workingCapital / User.customerWallet):
 *   wallet.earnings        — runner's withdrawable earnings (reimbursements + commissions)
 *   wallet.trustBalance    — customer funds held in escrow while this runner's errand is active
 *   workingCapital.limit   — runner's risk/trust ceiling (NOT money, not withdrawable)
 *   workingCapital.used    — value of the runner's currently active errands
 *   customerWallet.balance — customer's reusable credit (refunds land here)
 *
 * Runners never deposit money into the app — they always use their own cash to
 * shop, and are reimbursed (amount) plus paid commission (runnerReceives) into
 * their earnings wallet once the customer confirms delivery.
 */

const User = require('../models/User');

// ── Fee calculation ───────────────────────────────────────────────────────────

const RUNNER_COMMISSION_RATE  = 0.10;
const PLATFORM_FEE_RATE       = 0.025; // applied to both customer and runner sides

/**
 * Calculate all fees for a given errand base amount.
 * Returns the full breakdown stored on the Errand document.
 */
const calcFees = (amount) => {
  const runnerCommission    = Math.round(amount * RUNNER_COMMISSION_RATE * 100) / 100;
  const platformCustomerFee = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;
  const platformRunnerFee   = Math.round(amount * PLATFORM_FEE_RATE * 100) / 100;
  const totalCustomerPays   = amount + runnerCommission + platformCustomerFee;
  const runnerReceives      = runnerCommission - platformRunnerFee;
  const platformEarns       = platformCustomerFee + platformRunnerFee;
  const trustHeld           = totalCustomerPays - platformCustomerFee; // escrow excludes upfront platform fee

  return {
    runnerCommission,
    platformCustomerFee,
    platformRunnerFee,
    totalCustomerPays,
    runnerReceives,
    platformEarns,
    trustHeld,
  };
};

// ── Working capital checks ─────────────────────────────────────────────────────

/**
 * Check if a runner has enough remaining working capital to accept this errand.
 * Capacity is a risk limit, not money — earnings/trust play no part in this check.
 */
const hasEnoughCapacity = (runner, amount) => {
  const available = runner.workingCapital.limit - runner.workingCapital.used;
  return available >= amount;
};

// ── Accept errand ─────────────────────────────────────────────────────────────

/**
 * Called when a runner accepts an errand.
 *
 * Locks errand.amount against the runner's working capital (workingCapital.used)
 * and adds trustHeld to trustBalance (escrow exposure while this errand is active).
 * The runner always fronts their own cash for the shopping — there is no float
 * pool to draw from.
 *
 * Runners can hold several concurrent errands — this only flips the runner to
 * 'busy' (excluded from auto-matching) once their remaining capacity can't
 * cover another errand. Otherwise they're set back to 'available' so they keep
 * receiving offers within their remaining capacity/range.
 */
const acceptErrandCapacity = async (runnerId, errand, session) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  const inc = {
    'wallet.trustBalance':  errand.trustHeld,
    'workingCapital.used':  errand.amount,
  };

  const opts = session ? { session, runValidators: true } : { runValidators: true };
  await User.findByIdAndUpdate(runnerId, { $inc: inc }, opts);

  const remainingCapacity = runner.workingCapital.limit - (runner.workingCapital.used + errand.amount);
  await User.findByIdAndUpdate(
    runnerId,
    { 'availability.status': remainingCapacity > 0 ? 'available' : 'busy' },
    opts,
  );
};

// ── Complete errand (customer confirms delivery) ───────────────────────────────

/**
 * Called after customer confirms delivery.
 *
 * Releases escrow (trustBalance), frees the runner's working capital, and
 * credits earnings with the errand-cost reimbursement PLUS net commission —
 * the runner always fronted their own money, so they're always reimbursed.
 */
const completeErrandCapacity = async (runnerId, errand, session) => {
  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
    'wallet.earnings':      errand.amount + errand.runnerReceives,
    'workingCapital.used': -errand.amount,
  };

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });

  return User.findById(runnerId).session(session);
};

// ── Cancel errand ─────────────────────────────────────────────────────────────

/**
 * Called when an errand is cancelled after being accepted.
 * Reverses acceptErrandCapacity — releases escrow and frees working capital.
 * Does NOT decide whether this affects the runner's limit — that's the working
 * capital service's job (see services/workingCapitalService.js), keyed on
 * errand.cancelledBy / errand.excusedCancellation.
 */
const cancelErrandCapacity = async (runnerId, errand, session) => {
  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
    'workingCapital.used': -errand.amount,
  };

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });
};

// ── Dispute penalty ───────────────────────────────────────────────────────────

/**
 * Penalise runner after a lost dispute:
 * Release the held trust (escrow goes to the customer instead, via refundToCustomer)
 * and deduct the penalty from earnings — the runner already spent their own cash
 * on this errand and forfeits reimbursement for it.
 */
const penalizeRunnerCapacity = async (runnerId, errand, penaltyAmount, session) => {
  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
    'wallet.earnings':     -penaltyAmount,
    'workingCapital.used': -errand.amount,
  };

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });
};

/**
 * Credit funds to a user's trust balance (e.g. customer refund on dispute).
 */
const creditTrust = async (userId, amount) => {
  await User.findByIdAndUpdate(userId, {
    $inc: { 'wallet.trustBalance': amount },
  }, { runValidators: true });
};

/**
 * Refund an amount to a customer's reusable wallet credit.
 * Used after a cancellation or a dispute resolved in the customer's favour.
 * The customer can spend this credit before their next STK push.
 */
const refundToCustomer = async (customerId, amount, session) => {
  const opts = session ? { session, runValidators: true } : { runValidators: true };
  await User.findByIdAndUpdate(customerId, { $inc: { 'customerWallet.balance': amount } }, opts);
};

/**
 * Credit directly to earnings — used to reverse a failed B2C withdrawal.
 */
const creditEarnings = async (runnerId, amount) => {
  await User.findByIdAndUpdate(runnerId, {
    $inc: { 'wallet.earnings': amount },
  }, { runValidators: true });
};

/**
 * Debit for withdrawal. Earnings is the only withdrawable pool — working
 * capital is a risk limit, not money, and is never part of this calculation.
 */
const debitEarnings = async (runnerId, amount) => {
  const runner = await User.findById(runnerId);
  if (!runner) throw new Error('Runner not found');

  const { earnings } = runner.wallet;

  if (amount > earnings) {
    throw new Error(`Insufficient balance. Withdrawable: ${earnings.toFixed(2)}`);
  }

  await User.findByIdAndUpdate(runnerId, { $inc: { 'wallet.earnings': -amount } }, { runValidators: true });
};

module.exports = {
  calcFees,
  hasEnoughCapacity,
  acceptErrandCapacity,
  completeErrandCapacity,
  cancelErrandCapacity,
  penalizeRunnerCapacity,
  refundToCustomer,
  creditTrust,
  debitEarnings,
  creditEarnings,
};
