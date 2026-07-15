const FavoriteRunner = require('../models/FavoriteRunner');
const User = require('../models/User');

// ── GET /api/favorites/runners ────────────────────────────────────────────────

exports.getFavoriteRunners = async (req, res) => {
  const favorites = await FavoriteRunner.find({ customer: req.user._id })
    .sort('-createdAt')
    .populate('runner', 'name phone rating level completedErrands');

  res.status(200).json({
    status: 'success',
    data: favorites
      .filter((f) => f.runner)
      .map((f) => ({ id: f._id, runner: f.runner, createdAt: f.createdAt })),
  });
};

// ── POST /api/favorites/runners/:runnerId ─────────────────────────────────────

exports.addFavoriteRunner = async (req, res) => {
  const runner = await User.findOne({ _id: req.params.runnerId, role: 'runner' });
  if (!runner) {
    return res.status(404).json({ status: 'fail', message: 'Runner not found' });
  }

  const favorite = await FavoriteRunner.findOneAndUpdate(
    { customer: req.user._id, runner: runner._id },
    { customer: req.user._id, runner: runner._id },
    { upsert: true, new: true }
  );

  res.status(201).json({ status: 'success', data: favorite });
};

// ── DELETE /api/favorites/runners/:runnerId ───────────────────────────────────

exports.removeFavoriteRunner = async (req, res) => {
  await FavoriteRunner.findOneAndDelete({ customer: req.user._id, runner: req.params.runnerId });
  res.status(200).json({ status: 'success', message: 'Removed from favorites' });
};
