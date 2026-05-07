const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const User = require('../models/User');
const { JWT, COOKIE } = require('../config/security');
const logger = require('../utils/logger');

// ── Token helpers ─────────────────────────────────────────────────────────────

const signAccessToken = (userId, role) =>
  jwt.sign({ id: userId, role }, JWT.ACCESS_SECRET, {
    expiresIn: JWT.ACCESS_EXPIRES_IN,
  });

const signRefreshToken = (userId) =>
  jwt.sign({ id: userId }, JWT.REFRESH_SECRET, {
    expiresIn: JWT.REFRESH_EXPIRES_IN,
  });

/**
 * Issue a new refresh token, hash it, and persist the hash.
 * Returns the raw token (to be set as cookie) — never stored plain.
 */
const issueRefreshToken = async (user) => {
  const token = signRefreshToken(user._id);
  const hash = await bcrypt.hash(token, 10);

  const expiresAt = new Date(Date.now() + COOKIE.OPTIONS.maxAge);
  await User.findByIdAndUpdate(user._id, {
    refreshTokenHash: hash,
    refreshTokenExpiresAt: expiresAt,
  });

  return token;
};

const setRefreshCookie = (res, token) => {
  res.cookie(COOKIE.REFRESH_NAME, token, COOKIE.OPTIONS);
};

const clearRefreshCookie = (res) => {
  res.clearCookie(COOKIE.REFRESH_NAME, {
    httpOnly: true,
    secure: COOKIE.OPTIONS.secure,
    sameSite: COOKIE.OPTIONS.sameSite,
    path: COOKIE.OPTIONS.path,
  });
};

const sendAuthResponse = (res, statusCode, user, accessToken) => {
  res.status(statusCode).json({
    status: 'success',
    accessToken,
    data: {
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        wallet: user.wallet,
        level: user.level,
        rating: user.rating,
      },
    },
  });
};

// ── POST /api/auth/register ───────────────────────────────────────────────────

exports.register = async (req, res) => {
  // Body already validated + stripped by Joi middleware
  const { name, phone, password, role } = req.body;

  const allowedRoles = ['customer', 'runner'];
  const assignedRole = allowedRoles.includes(role) ? role : 'customer';

  const existingUser = await User.findOne({ phone });
  if (existingUser) {
    return res.status(409).json({
      status: 'fail',
      message: 'An account with this phone number already exists',
    });
  }

  const user = await User.create({ name, phone, password, role: assignedRole });
  const accessToken = signAccessToken(user._id, user.role);
  const refreshToken = await issueRefreshToken(user);

  setRefreshCookie(res, refreshToken);

  logger.auth.info('User registered', { userId: user._id, role: user.role, ip: req.ip });
  sendAuthResponse(res, 201, user, accessToken);
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────

exports.login = async (req, res) => {
  const { phone, password } = req.body;

  const user = await User.findOne({ phone }).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    logger.auth.warn('Failed login attempt', { phone, ip: req.ip });
    return res.status(401).json({
      status: 'fail',
      message: 'Invalid phone number or password',
    });
  }

  if (!user.isActive) {
    return res.status(403).json({
      status: 'fail',
      message: 'Your account has been deactivated. Contact support.',
    });
  }

  const accessToken = signAccessToken(user._id, user.role);
  const refreshToken = await issueRefreshToken(user);

  setRefreshCookie(res, refreshToken);

  logger.auth.info('User logged in', { userId: user._id, role: user.role, ip: req.ip });
  sendAuthResponse(res, 200, user, accessToken);
};

// ── POST /api/auth/refresh ────────────────────────────────────────────────────
// Rotate: invalidate old refresh token, issue new access + refresh token pair.
// Protected by verifyRefreshToken middleware (req.user already set).

exports.refresh = async (req, res) => {
  const user = req.user;

  const accessToken = signAccessToken(user._id, user.role);
  const newRefreshToken = await issueRefreshToken(user); // rotates hash in DB

  setRefreshCookie(res, newRefreshToken);

  logger.auth.info('Token refreshed', { userId: user._id, ip: req.ip });

  res.status(200).json({
    status: 'success',
    accessToken,
  });
};

// ── POST /api/auth/logout ─────────────────────────────────────────────────────
// Invalidates the refresh token and stamps lastLogoutAt so any live access
// tokens issued before now are rejected by protect().

exports.logout = async (req, res) => {
  const userId = req.user?._id;

  if (userId) {
    await User.findByIdAndUpdate(userId, {
      refreshTokenHash: null,
      refreshTokenExpiresAt: null,
      lastLogoutAt: new Date(),
    });
    logger.auth.info('User logged out', { userId, ip: req.ip });
  }

  clearRefreshCookie(res);
  res.status(200).json({ status: 'success', message: 'Logged out successfully' });
};

// ── PATCH /api/auth/change-password ──────────────────────────────────────────
// Requires current password verification.
// Rotates refresh token and stamps passwordChangedAt to invalidate all
// existing access tokens issued before this moment.

exports.changePassword = async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  const user = await User.findById(req.user._id).select('+password');
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'User not found' });
  }

  const isCorrect = await user.comparePassword(currentPassword);
  if (!isCorrect) {
    return res.status(401).json({
      status: 'fail',
      message: 'Current password is incorrect',
    });
  }

  if (currentPassword === newPassword) {
    return res.status(400).json({
      status: 'fail',
      message: 'New password must be different from your current password',
    });
  }

  user.password = newPassword; // pre-save hook hashes it
  user.passwordChangedAt = new Date();
  user.refreshTokenHash = null;
  user.refreshTokenExpiresAt = null;
  user.lastLogoutAt = new Date();
  await user.save();

  // Issue fresh tokens so the user doesn't need to re-login
  const accessToken = signAccessToken(user._id, user.role);
  const refreshToken = await issueRefreshToken(user);

  setRefreshCookie(res, refreshToken);

  logger.auth.info('Password changed', { userId: user._id, ip: req.ip });

  res.status(200).json({
    status: 'success',
    message: 'Password changed successfully',
    accessToken,
  });
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

exports.getMe = async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: req.user._id,
        name: req.user.name,
        phone: req.user.phone,
        role: req.user.role,
        wallet: req.user.wallet,
        level: req.user.level,
        rating: req.user.rating,
        completedErrands: req.user.completedErrands,
        isActive: req.user.isActive,
      },
    },
  });
};
