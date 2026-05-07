const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT } = require('../config/security');
const logger = require('../utils/logger');

// ── protect ───────────────────────────────────────────────────────────────────
// Verifies the access token in the Authorization header.
// Rejects tokens that were issued before the user logged out or changed password.

exports.protect = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      status: 'fail',
      message: 'Authentication required. Please log in.',
    });
  }

  const token = authHeader.split(' ')[1];

  let decoded;
  try {
    decoded = jwt.verify(token, JWT.ACCESS_SECRET);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Your session has expired. Please log in again.'
        : 'Invalid token. Please log in again.';
    return res.status(401).json({ status: 'fail', message });
  }

  // Fetch only the fields needed for validation (+security fields)
  const user = await User.findById(decoded.id).select(
    '+passwordChangedAt +lastLogoutAt'
  );

  if (!user) {
    return res.status(401).json({
      status: 'fail',
      message: 'The user belonging to this token no longer exists.',
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      status: 'fail',
      message: 'Your account has been deactivated.',
    });
  }

  // Reject token if password was changed after it was issued
  if (user.passwordChangedAt) {
    const changedAt = Math.floor(user.passwordChangedAt.getTime() / 1000);
    if (decoded.iat < changedAt) {
      return res.status(401).json({
        status: 'fail',
        message: 'Password was recently changed. Please log in again.',
      });
    }
  }

  // Reject token if user logged out after it was issued
  if (user.lastLogoutAt) {
    const loggedOutAt = Math.floor(user.lastLogoutAt.getTime() / 1000);
    if (decoded.iat < loggedOutAt) {
      return res.status(401).json({
        status: 'fail',
        message: 'You have been logged out. Please log in again.',
      });
    }
  }

  req.user = user;
  next();
};

// ── restrictTo ────────────────────────────────────────────────────────────────

exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        message: `Access denied. This route is restricted to: ${roles.join(', ')}.`,
      });
    }
    next();
  };
};

// ── verifyRefreshToken ────────────────────────────────────────────────────────
// Used exclusively on POST /api/auth/refresh.
// Reads the refresh token from the httpOnly cookie, verifies its signature,
// then checks the hash stored in the DB matches (prevents reuse after rotation).

exports.verifyRefreshToken = async (req, res, next) => {
  const { COOKIE } = require('../config/security');
  const bcrypt = require('bcryptjs');

  const token = req.cookies?.[COOKIE.REFRESH_NAME];
  if (!token) {
    return res.status(401).json({
      status: 'fail',
      message: 'No refresh token. Please log in.',
    });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT.REFRESH_SECRET);
  } catch (err) {
    const message =
      err.name === 'TokenExpiredError'
        ? 'Refresh token expired. Please log in again.'
        : 'Invalid refresh token. Please log in again.';
    return res.status(401).json({ status: 'fail', message });
  }

  const user = await User.findById(decoded.id).select(
    '+refreshTokenHash +refreshTokenExpiresAt +lastLogoutAt'
  );

  if (!user || !user.refreshTokenHash || !user.refreshTokenExpiresAt) {
    return res.status(401).json({
      status: 'fail',
      message: 'Refresh token is no longer valid. Please log in again.',
    });
  }

  // Check token has not expired in DB (belt-and-suspenders alongside JWT exp)
  if (user.refreshTokenExpiresAt < new Date()) {
    return res.status(401).json({
      status: 'fail',
      message: 'Refresh token expired. Please log in again.',
    });
  }

  // Constant-time hash comparison to prevent timing attacks
  const isValid = await bcrypt.compare(token, user.refreshTokenHash);
  if (!isValid) {
    // Hash mismatch — token was already rotated; possible reuse attack
    logger.auth.warn('Refresh token reuse detected — clearing session', {
      userId: user._id,
      ip: req.ip,
    });
    // Invalidate session entirely
    user.refreshTokenHash = null;
    user.refreshTokenExpiresAt = null;
    await user.save({ validateBeforeSave: false });

    return res.status(401).json({
      status: 'fail',
      message: 'Refresh token reuse detected. Please log in again.',
    });
  }

  if (!user.isActive) {
    return res.status(403).json({ status: 'fail', message: 'Account deactivated.' });
  }

  req.user = user;
  next();
};
