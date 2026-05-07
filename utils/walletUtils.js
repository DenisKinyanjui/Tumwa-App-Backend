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
 *   trustHeld           = 1075   (totalCustomerPays - platformCustomerFee upfront)
 *
 * Wallet schema (User.wallet):
 *   floatBalance  — runner's total working capital
 *   heldFloat     — portion locked for active errands
 *   earnings      — runner's withdrawable earnings
 *   trustBalance  — customer funds held in escrow
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

// ── Float checks ──────────────────────────────────────────────────────────────

/**
 * Check if a runner has enough usable balance for an errand amount.
 * Usable balance = availableFloat + earnings (earnings are interchangeable with float)
 */
const hasEnoughFloat = (runner, amount) => {
  const available = (runner.wallet.floatBalance - runner.wallet.heldFloat) + runner.wallet.earnings;
  return available >= amount;
};

// ── Accept errand ─────────────────────────────────────────────────────────────

/**
 * Called when a runner accepts an errand.
 *
 * Usable pool = (floatBalance - heldFloat) + earnings.
 * - If usable pool ≥ errand.amount  → floatUsed = true; auto-convert earnings → floatBalance if needed
 * - Otherwise                       → ownMoneyUsed = true (runner fronts cash)
 * - Lock errand.amount in heldFloat and add trustHeld to trustBalance.
 * - Returns { floatUsed, ownMoneyUsed }
 */
const acceptErrandWallet = async (runnerId, errand, session) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  const availableFloat = runner.wallet.floatBalance - runner.wallet.heldFloat;
  const totalUsable    = availableFloat + runner.wallet.earnings;
  const floatUsed      = totalUsable >= errand.amount;
  const ownMoneyUsed   = !floatUsed;

  const inc = { 'wallet.trustBalance': errand.trustHeld };
  if (floatUsed) {
    // If pure availableFloat is insufficient, move earnings into floatBalance first
    const earningsNeeded = Math.max(0, errand.amount - availableFloat);
    if (earningsNeeded > 0) {
      inc['wallet.earnings']     = -earningsNeeded;
      inc['wallet.floatBalance'] =  earningsNeeded;
    }
    inc['wallet.heldFloat'] = errand.amount;
  }

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });

  return { floatUsed, ownMoneyUsed };
};

// ── Complete errand (customer confirms delivery) ───────────────────────────────

/**
 * Called after customer confirms delivery.
 *
 * Float mode:   unlock runner's held float, clear escrow, credit earnings.
 * Own-money:    clear escrow, credit earnings (no float to unlock).
 */
const completeErrandWallet = async (runnerId, errand, session) => {
  const runner = await User.findById(runnerId).session(session);
  if (!runner) throw new Error('Runner not found');

  // Float mode:     runner only earns the net commission (float is unlocked separately)
  // Own-money mode: runner gets back their fronted capital PLUS net commission
  const earningsCredit = errand.ownMoneyUsed
    ? errand.amount + errand.runnerReceives
    : errand.runnerReceives;

  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
    'wallet.earnings':      earningsCredit,
  };

  if (errand.floatUsed) {
    inc['wallet.heldFloat'] = -errand.amount;
  }

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });

  return User.findById(runnerId).session(session);
};

// ── Cancel errand ─────────────────────────────────────────────────────────────

/**
 * Called when an errand is cancelled after being accepted.
 * Reverses acceptErrandWallet — releases held amounts, removes customer funds from float.
 */
const cancelErrandWallet = async (runnerId, errand, session) => {
  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
  };

  if (errand.floatUsed) {
    inc['wallet.heldFloat'] = -errand.amount;
  }

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { session, runValidators: true });
};

// ── Dispute penalty ───────────────────────────────────────────────────────────

/**
 * Penalise runner after a lost dispute:
 * Release the held trust but deduct it from floatBalance (funds are forfeited).
 */
const penalizeErrandWallet = async (runnerId, errand, penaltyAmount, session) => {
  const inc = {
    'wallet.trustBalance': -errand.trustHeld,
    'wallet.earnings':     -penaltyAmount,
  };

  if (errand.floatUsed) {
    inc['wallet.heldFloat']    = -errand.amount;
    inc['wallet.floatBalance'] = -penaltyAmount;
  }

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
 * Refund an amount to a customer's withdrawable earnings.
 * Used after a dispute is resolved in the customer's favour.
 * The customer can then withdraw this via the normal wallet withdrawal flow.
 */
const refundToCustomer = async (customerId, amount, session) => {
  const opts = session ? { session, runValidators: true } : { runValidators: true };
  await User.findByIdAndUpdate(customerId, { $inc: { 'wallet.earnings': amount } }, opts);
};

/**
 * Credit directly to floatBalance — used when an STK float deposit succeeds.
 */
const creditFloat = async (runnerId, amount) => {
  await User.findByIdAndUpdate(runnerId, {
    $inc: { 'wallet.floatBalance': amount },
  }, { runValidators: true });
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
 * Debit for withdrawal from the combined usable pool (earnings + availableFloat).
 * Drains earnings first, then floatBalance.
 */
const debitEarnings = async (runnerId, amount) => {
  const runner = await User.findById(runnerId);
  if (!runner) throw new Error('Runner not found');

  const { floatBalance, heldFloat, earnings } = runner.wallet;
  const availableFloat = Math.max(0, floatBalance - heldFloat);
  const withdrawable   = availableFloat + earnings;

  if (amount > withdrawable) {
    throw new Error(`Insufficient balance. Withdrawable: ${withdrawable.toFixed(2)}`);
  }

  const fromEarnings = Math.min(amount, earnings);
  const fromFloat    = amount - fromEarnings;

  const inc = {};
  if (fromEarnings > 0) inc['wallet.earnings']     = -fromEarnings;
  if (fromFloat    > 0) inc['wallet.floatBalance'] = -fromFloat;

  await User.findByIdAndUpdate(runnerId, { $inc: inc }, { runValidators: true });
};

module.exports = {
  calcFees,
  hasEnoughFloat,
  acceptErrandWallet,
  completeErrandWallet,
  cancelErrandWallet,
  penalizeErrandWallet,
  refundToCustomer,
  creditTrust,
  debitEarnings,
  creditFloat,
  creditEarnings,
};
