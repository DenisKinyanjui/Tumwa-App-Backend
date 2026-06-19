const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [100, 'Name cannot exceed 100 characters'],
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      sparse: true,
      match: [/^\S+@\S+\.\S+$/, 'Please provide a valid email address'],
    },
    phone: {
      type: String,
      required: [true, 'Phone number is required'],
      unique: true,
      trim: true,
      match: [/^\+?[1-9]\d{6,14}$/, 'Please provide a valid phone number'],
    },
    password: {
      type: String,
      required: [true, 'Password is required'],
      minlength: [6, 'Password must be at least 6 characters'],
      select: false,
    },
    role: {
      type: String,
      enum: {
        values: ['customer', 'runner', 'admin'],
        message: 'Role must be customer, runner, or admin',
      },
      default: 'customer',
    },
    wallet: {
      // Runner float — working capital used to fund errands
      floatBalance: { type: Number, default: 0, min: [0, 'Float cannot be negative'] },
      // Portion of float currently locked for active errands
      heldFloat:    { type: Number, default: 0, min: [0, 'Held float cannot be negative'] },
      // Runner earnings ready to withdraw (post-completion, post-commission)
      earnings:     { type: Number, default: 0, min: [0, 'Earnings cannot be negative'] },
      // Customer funds held in platform escrow until delivery confirmed
      trustBalance: { type: Number, default: 0, min: [0, 'Trust balance cannot be negative'] },
    },
    level: {
      type: Number,
      default: 1,
      min: [1, 'Level cannot be less than 1'],
    },
    rating: {
      type: Number,
      default: 0,
      min: [0, 'Rating cannot be negative'],
      max: [5, 'Rating cannot exceed 5'],
    },
    completedErrands: {
      type: Number,
      default: 0,
      min: [0, 'Completed errands count cannot be negative'],
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: [0, 'Rating count cannot be negative'],
    },
    disputesAgainst: {
      type: Number,
      default: 0,
      min: [0, 'Disputes count cannot be negative'],
    },
    isActive: {
      type: Boolean,
      default: true,
    },

    // ── Runner availability (runners only) ─────────────────────────────────
    availability: {
      // offline       → not accepting errands (app closed / manually offline)
      // available     → ready to receive matching offers
      // receiving_request → an offer has been sent, waiting for response
      // busy          → currently assigned to an errand
      status: {
        type: String,
        enum: ['offline', 'available', 'busy', 'receiving_request'],
        default: 'offline',
      },
      latitude:  { type: Number, default: null },
      longitude: { type: Number, default: null },
      lastSeen:  { type: Date,   default: null },
    },

    // ── Anti-abuse (runners only) ──────────────────────────────────────────
    // Number of times runner cancelled after accepting an errand
    cancelCount: { type: Number, default: 0, min: 0 },
    // Block runner from accepting new errands until this timestamp
    cooldownUntil: { type: Date, default: null },
    // Deprioritise runner in matching algorithm until this timestamp
    matchingPenaltyUntil: { type: Date, default: null },

    fcmToken: {
      type: String,
      default: null,
      select: false,
    },

    // ── Auth security fields ────────────────────────────────────────────────
    // Refresh token: stored as a bcrypt hash so a stolen DB dump can't be used.
    refreshTokenHash: {
      type: String,
      default: null,
      select: false,
    },
    refreshTokenExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
    // Set on password change — tokens issued before this date are rejected.
    passwordChangedAt: {
      type: Date,
      default: null,
      select: false,
    },
    // Set on logout — access tokens issued before this date are rejected.
    // Lightweight alternative to a token blacklist.
    lastLogoutAt: {
      type: Date,
      default: null,
      select: false,
    },

    // ── Phone verification (runners only) ──────────────────────────────────
    phoneVerified: {
      type: Boolean,
      default: false,
    },
    verificationStatus: {
      type: String,
      enum: ['none', 'pending', 'approved', 'rejected'],
      default: 'none',
    },
    // Termii pinId stored here while OTP is in-flight; cleared on verify.
    otpPinId: {
      type: String,
      default: null,
      select: false,
    },
    otpPinExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// ── Indexes for query performance ─────────────────────────────────────────────
userSchema.index({ role: 1, isActive: 1 });           // getUsers filter
userSchema.index({ role: 1, createdAt: -1 });          // analytics / reports
userSchema.index({ role: 1, completedErrands: -1, rating: -1 }); // top runners
userSchema.index({ role: 1, 'trustWallet.total': -1 }); // wallet queries
// Matching eligibility — role + availability status + float balance
userSchema.index({ role: 1, 'availability.status': 1, 'wallet.floatBalance': -1 });
// Cooldown expiry queries
userSchema.index({ cooldownUntil: 1 }, { sparse: true });

// Float not currently locked = what the runner can use for new errands
userSchema.virtual('availableFloat').get(function () {
  return this.wallet.floatBalance - this.wallet.heldFloat;
});

userSchema.virtual('disputeRate').get(function () {
  if (this.completedErrands === 0) return 0;
  return this.disputesAgainst / this.completedErrands;
});

userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.model('User', userSchema);
