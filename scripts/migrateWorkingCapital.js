// One-time migration: replaces the deposited Float Wallet with the Working
// Capital Limit model. Seeds every existing runner's workingCapital.limit/used.
// Does NOT touch wallet.floatBalance/heldFloat (left as harmless orphan data)
// or customerWallet.balance (a new field with a schema default of 0 that
// Mongoose already applies in memory for any document that doesn't have it
// stored — no explicit backfill needed).
//
// Run with: node scripts/migrateWorkingCapital.js
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Errand = require('../models/Errand');
const { computeLevel } = require('../utils/levelUtils');
const { getDefaultLimit, getMaxLimit } = require('../services/workingCapitalService');

async function run() {
  await mongoose.connect(process.env.MONGO_URI);

  const DEFAULT_LIMIT = await getDefaultLimit();
  const MAX_LIMIT = await getMaxLimit();

  // ── Runners: seed workingCapital.limit from level (or default) ─────────────
  const runners = await User.find({ role: 'runner' }).select(
    'completedErrands rating ratingCount disputesAgainst workingCapital',
  );

  // Reconcile `used` from currently in-flight errands, rather than assuming 0 —
  // the matching cycle may not be paused during migration.
  const inFlightByRunner = await Errand.aggregate([
    { $match: { runner: { $ne: null }, status: { $in: ['assigned', 'in_progress'] } } },
    { $group: { _id: '$runner', total: { $sum: '$amount' } } },
  ]);
  const usedByRunner = new Map(inFlightByRunner.map((r) => [r._id.toString(), r.total]));

  let updated = 0;
  for (const runner of runners) {
    const level = computeLevel(runner);
    const ceiling = level.walletLimit == null ? MAX_LIMIT : Math.min(level.walletLimit, MAX_LIMIT);
    const limit = Math.max(DEFAULT_LIMIT, Math.min(ceiling, MAX_LIMIT));
    const used = usedByRunner.get(runner._id.toString()) || 0;

    await User.findByIdAndUpdate(runner._id, {
      $set: { 'workingCapital.limit': limit, 'workingCapital.used': used },
    });
    updated += 1;
  }
  console.log(`Seeded workingCapital.limit/used for ${updated} runner(s)`);

  await mongoose.connection.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
