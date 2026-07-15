const mongoose = require('mongoose');

const favoriteRunnerSchema = new mongoose.Schema(
  {
    customer: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    runner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
  },
  { timestamps: true }
);

favoriteRunnerSchema.index({ customer: 1, runner: 1 }, { unique: true });

module.exports = mongoose.model('FavoriteRunner', favoriteRunnerSchema);
