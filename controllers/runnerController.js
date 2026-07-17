const User = require('../models/User');
const Errand = require('../models/Errand');
const Rating = require('../models/Rating');
const { checkAndUpdateLevel, getLevelProgress, getLevelConfig } = require('../utils/levelUtils');
const notify = require('../services/notifyService');

// ─── POST /api/runners/:id/rate ──────────────────────────────────────────────
// Only the customer of a completed errand may rate its runner, once.

exports.rateRunner = async (req, res) => {
  const { stars, comment, errandId } = req.body;

  if (!errandId) {
    return res.status(400).json({ status: 'fail', message: 'errandId is required' });
  }
  if (!stars || stars < 1 || stars > 5 || !Number.isInteger(Number(stars))) {
    return res.status(400).json({
      status: 'fail',
      message: 'stars must be a whole number between 1 and 5',
    });
  }

  const runnerId = req.params.id;
  const runner = await User.findById(runnerId);
  if (!runner) return res.status(404).json({ status: 'fail', message: 'Runner not found' });
  if (runner.role !== 'runner') {
    return res.status(400).json({ status: 'fail', message: 'Target user is not a runner' });
  }

  const errand = await Errand.findById(errandId);
  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  if (errand.status !== 'completed') {
    return res.status(400).json({
      status: 'fail',
      message: 'You can only rate a runner after the errand is completed',
    });
  }
  if (errand.customer.toString() !== req.user._id.toString()) {
    return res.status(403).json({
      status: 'fail',
      message: 'Only the customer of this errand can rate its runner',
    });
  }
  if (!errand.runner || errand.runner.toString() !== runnerId) {
    return res.status(400).json({
      status: 'fail',
      message: 'This runner was not assigned to the specified errand',
    });
  }

  // Prevent duplicate rating (unique index on errand in Rating model)
  const existing = await Rating.findOne({ errand: errandId });
  if (existing) {
    return res.status(409).json({
      status: 'fail',
      message: 'You have already rated the runner for this errand',
    });
  }

  // Persist the individual rating record
  const rating = await Rating.create({
    errand: errandId,
    runner: runnerId,
    customer: req.user._id,
    stars: Number(stars),
    comment: comment || null,
  });

  // Recalculate runner's rolling average rating
  const newRatingCount = runner.ratingCount + 1;
  const newRating = (runner.rating * runner.ratingCount + Number(stars)) / newRatingCount;
  runner.rating = parseFloat(newRating.toFixed(2));
  runner.ratingCount = newRatingCount;

  // Check and apply level-up if conditions are met
  const { leveledUp, newLevel, config } = checkAndUpdateLevel(runner);
  await runner.save();

  // Notify runner of the new rating
  notify.send({
    userId: runnerId,
    title: 'New Rating Received',
    message: `You received a ${stars}-star rating${comment ? `: "${comment}"` : '.'}`,
    type: 'rating',
    relatedId: errandId,
    relatedModel: 'Errand',
    eventName: 'runner-rated',
    eventData: {
      stars: Number(stars),
      comment: comment || null,
      newAverage: runner.rating,
      ratingCount: runner.ratingCount,
      errandId,
    },
  });

  // Notify runner of a level-up separately for clear UX
  if (leveledUp) {
    notify.send({
      userId: runnerId,
      title: `Level Up! You're now Level ${newLevel}`,
      message: `Congratulations! You've reached Level ${newLevel}: ${config.label}. New errand limit: KES ${config.maxErrandAmount ?? 'unlimited'}.`,
      type: 'rating',
      relatedId: runnerId,
      relatedModel: 'User',
      eventName: 'runner-leveled-up',
      eventData: {
        newLevel,
        label: config.label,
        maxErrandAmount: config.maxErrandAmount,
        walletLimit: config.walletLimit,
      },
    });
  }

  res.status(201).json({
    status: 'success',
    data: {
      rating: {
        id: rating._id,
        stars: rating.stars,
        comment: rating.comment,
      },
      runner: {
        id: runner._id,
        name: runner.name,
        rating: runner.rating,
        ratingCount: runner.ratingCount,
        level: runner.level,
      },
      leveledUp,
      ...(leveledUp && { newLevel, levelLabel: config.label }),
    },
  });
};

// ─── GET /api/runners/:id/rating ─────────────────────────────────────────────
// Any authenticated user can view a runner's rating profile.

exports.getRunnerRating = async (req, res) => {
  const runner = await User.findById(req.params.id).select(
    'name rating ratingCount level completedErrands disputesAgainst'
  );
  if (!runner) return res.status(404).json({ status: 'fail', message: 'Runner not found' });
  if (runner.role !== 'runner') {
    return res.status(400).json({ status: 'fail', message: 'Target user is not a runner' });
  }

  // Fetch last 10 individual ratings for display
  const recentRatings = await Rating.find({ runner: runner._id })
    .sort('-createdAt')
    .limit(10)
    .populate('customer', 'name')
    .populate('errand', 'title');

  // Star breakdown (1-5) for the ratings & reviews screen
  const distAgg = await Rating.aggregate([
    { $match: { runner: runner._id } },
    { $group: { _id: '$stars', count: { $sum: 1 } } },
  ]);
  const distCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  distAgg.forEach((d) => { distCounts[d._id] = d.count; });
  const totalRatings = Object.values(distCounts).reduce((a, b) => a + b, 0);
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: distCounts[stars],
    percentage: totalRatings ? Math.round((distCounts[stars] / totalRatings) * 100) : 0,
  }));

  const levelConfig = getLevelConfig(runner.level);

  res.status(200).json({
    status: 'success',
    data: {
      runner: {
        id: runner._id,
        name: runner.name,
        rating: runner.rating,
        ratingCount: runner.ratingCount,
        completedErrands: runner.completedErrands,
        level: runner.level,
        levelLabel: levelConfig.label,
      },
      recentRatings,
      distribution,
      totalRatings,
    },
  });
};

// ─── GET /api/runners/:id/level ──────────────────────────────────────────────
// Full level breakdown with progress toward the next level.

exports.getRunnerLevel = async (req, res) => {
  const runner = await User.findById(req.params.id).select(
    'name level rating ratingCount completedErrands disputesAgainst'
  );
  if (!runner) return res.status(404).json({ status: 'fail', message: 'Runner not found' });
  if (runner.role !== 'runner') {
    return res.status(400).json({ status: 'fail', message: 'Target user is not a runner' });
  }

  const progress = getLevelProgress(runner);

  res.status(200).json({
    status: 'success',
    data: {
      runner: {
        id: runner._id,
        name: runner.name,
        level: runner.level,
      },
      ...progress,
    },
  });
};

// ─── GET /api/runners/performance?range=week|month|year|overall ─────────────
// Runner-facing Performance screen (and Profile's Runner/Earnings Overview):
// stat grid + earnings sparkline for range. 'overall' covers all-time.

const rangeStart = (range) => {
  const now = new Date();
  if (range === 'overall') {
    return new Date(0);
  }
  if (range === 'year') {
    return new Date(now.getFullYear(), 0, 1);
  }
  if (range === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  // week — Monday 00:00 of the current week
  const day = now.getDay(); // 0 = Sunday
  const diffToMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
};

exports.getPerformance = async (req, res) => {
  const range = ['week', 'month', 'year', 'overall'].includes(req.query.range) ? req.query.range : 'week';
  const since = rangeStart(range);

  const [countsAgg, earningsAgg, sparklineAgg] = await Promise.all([
    Errand.aggregate([
      { $match: { runner: req.user._id, createdAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          completed: { $sum: { $cond: [{ $in: ['$status', ['completed', 'confirmed']] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ['$status', 'cancelled'] }, 1, 0] } },
        },
      },
    ]),
    Errand.aggregate([
      { $match: { runner: req.user._id, isPaid: true, paidAt: { $gte: since } } },
      {
        $group: {
          _id: null,
          total: { $sum: { $cond: ['$ownMoneyUsed', { $add: ['$amount', '$runnerReceives'] }, '$runnerReceives'] } },
        },
      },
    ]),
    Errand.aggregate([
      { $match: { runner: req.user._id, isPaid: true, paidAt: { $gte: since } } },
      {
        $group: {
          _id: range === 'year'
            ? { $month: '$paidAt' }
            // 'overall' can span multiple years — group by year+month (not
            // bare month) so the same calendar month in different years
            // doesn't get merged into one bucket, and by day for week/month.
            : range === 'overall'
              ? { $dateToString: { format: '%Y-%m', date: '$paidAt' } }
              : { $dateToString: { format: '%Y-%m-%d', date: '$paidAt' } },
          total: { $sum: { $cond: ['$ownMoneyUsed', { $add: ['$amount', '$runnerReceives'] }, '$runnerReceives'] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const total = countsAgg[0]?.total || 0;
  const completed = countsAgg[0]?.completed || 0;
  const cancelled = countsAgg[0]?.cancelled || 0;
  const completionRate = total ? Math.round((completed / total) * 100) : 0;
  const earnings = earningsAgg[0]?.total || 0;
  const sparkline = sparklineAgg.map((p) => p.total);

  res.status(200).json({
    status: 'success',
    data: {
      range,
      totalErrands: total,
      completed,
      cancelled,
      completionRate,
      earnings,
      rating: req.user.rating,
      sparkline: sparkline.length ? sparkline : [0, 0],
    },
  });
};
