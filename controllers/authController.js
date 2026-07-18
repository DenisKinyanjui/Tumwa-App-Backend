const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const User = require('../models/User');
const termiiService = require('../services/termiiService');
const emailService = require('../services/emailService');
const r2Service = require('../services/r2Service');
const { JWT, COOKIE, GOOGLE } = require('../config/security');
const logger = require('../utils/logger');

const googleClient = new OAuth2Client();

// Profile pictures are stored as private R2 keys — resolve to a short-lived
// signed URL whenever a user object is sent to a client.
const resolvePhotoUrl = (photoKey) =>
  photoKey ? r2Service.getSignedDownloadUrl(photoKey, 3600) : Promise.resolve(null);

// The refresh token normally travels only as an httpOnly cookie (web/admin).
// React Native doesn't reliably persist/resend httpOnly cookies, so mobile
// clients flag themselves with this header to also receive it in the JSON
// body, which they store and send back explicitly on refresh.
const isMobileClient = (req) => req.headers['x-client-platform'] === 'mobile';

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

const sendAuthResponse = async (res, statusCode, user, accessToken, extra = {}) => {
  const photoUrl = await resolvePhotoUrl(user.photoKey);
  res.status(statusCode).json({
    status: 'success',
    accessToken,
    ...extra,
    data: {
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        wallet: user.wallet,
        workingCapital: user.workingCapital,
        customerWallet: user.customerWallet,
        level: user.level,
        rating: user.rating,
        photoUrl,
      },
    },
  });
};

// ── POST /api/auth/register ───────────────────────────────────────────────────

exports.register = async (req, res) => {
  // Body already validated + stripped by Joi middleware
  const { name, email, phone, password, role } = req.body;

  const allowedRoles = ['customer', 'runner'];
  const assignedRole = allowedRoles.includes(role) ? role : 'customer';

  const existingPhone = await User.findOne({ phone });
  if (existingPhone) {
    return res.status(409).json({
      status: 'fail',
      message: 'An account with this phone number already exists',
    });
  }

  if (email) {
    const existingEmail = await User.findOne({ email });
    if (existingEmail) {
      return res.status(409).json({
        status: 'fail',
        message: 'An account with this email already exists',
      });
    }
  }

  const userData = { name, phone, password, role: assignedRole };
  if (email) userData.email = email;

  const user = await User.create(userData);
  const accessToken = signAccessToken(user._id, user.role);
  const refreshToken = await issueRefreshToken(user);

  setRefreshCookie(res, refreshToken);

  logger.auth.info('User registered', { userId: user._id, role: user.role, ip: req.ip });
  await sendAuthResponse(res, 201, user, accessToken, isMobileClient(req) ? { refreshToken } : {});
};

// ── POST /api/auth/login ──────────────────────────────────────────────────────

exports.login = async (req, res) => {
  const { identifier, password } = req.body;

  const isEmail = identifier.includes('@');
  const query = isEmail ? { email: identifier.toLowerCase() } : { phone: identifier };

  const user = await User.findOne(query).select('+password');
  if (!user || !(await user.comparePassword(password))) {
    logger.auth.warn('Failed login attempt', { identifier, ip: req.ip });
    return res.status(401).json({
      status: 'fail',
      message: isEmail ? 'Invalid email or password' : 'Invalid phone number or password',
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
  await sendAuthResponse(res, 200, user, accessToken, isMobileClient(req) ? { refreshToken } : {});
};

// ── POST /api/auth/google ─────────────────────────────────────────────────────
// Public. Verifies a Google ID token minted client-side (expo-auth-session),
// then logs in the matching user or creates a new one. Google doesn't supply a
// phone number, so new accounts are created without one — the client must
// prompt for it afterwards (see completePhone below) before the user can post
// or accept errands. New Google accounts default to the 'customer' role;
// runners still go through the full phone/identity verification signup.

exports.googleAuth = async (req, res) => {
  const { idToken } = req.body;

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE.CLIENT_IDS,
    });
    payload = ticket.getPayload();
  } catch (err) {
    logger.auth.warn('Invalid Google ID token', { ip: req.ip });
    return res.status(401).json({ status: 'fail', message: 'Invalid Google sign-in token' });
  }

  if (!payload?.email || !payload.email_verified) {
    return res.status(401).json({ status: 'fail', message: 'Google account email is not verified' });
  }

  let user = await User.findOne({ googleId: payload.sub });

  if (!user) {
    user = await User.findOne({ email: payload.email.toLowerCase() });
    if (user) {
      // Existing local account with the same email — link Google as a login method.
      user.googleId = payload.sub;
      await user.save();
    }
  }

  if (!user) {
    user = await User.create({
      name: payload.name || payload.email.split('@')[0],
      email: payload.email.toLowerCase(),
      googleId: payload.sub,
      role: 'customer',
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

  logger.auth.info('User logged in via Google', { userId: user._id, ip: req.ip });
  await sendAuthResponse(res, 200, user, accessToken, {
    phoneRequired: !user.phone,
    ...(isMobileClient(req) ? { refreshToken } : {}),
  });
};

// ── PATCH /api/auth/complete-phone ────────────────────────────────────────────
// Authenticated. Lets a Google sign-up (created without a phone) add one.
// Does not mark the phone as verified — the client should follow up with the
// existing send-otp/verify-otp flow if verification is required.

exports.completePhone = async (req, res) => {
  const { phone } = req.body;

  const existing = await User.findOne({ phone });
  if (existing && String(existing._id) !== String(req.user._id)) {
    return res.status(409).json({
      status: 'fail',
      message: 'An account with this phone number already exists',
    });
  }

  req.user.phone = phone;
  await req.user.save();

  const photoUrl = await resolvePhotoUrl(req.user.photoKey);

  logger.auth.info('Phone number added to account', { userId: req.user._id, ip: req.ip });
  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
        role: req.user.role,
        wallet: req.user.wallet,
        workingCapital: req.user.workingCapital,
        customerWallet: req.user.customerWallet,
        level: req.user.level,
        rating: req.user.rating,
        photoUrl,
      },
    },
  });
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
    ...(isMobileClient(req) ? { refreshToken: newRefreshToken } : {}),
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
    ...(isMobileClient(req) ? { refreshToken } : {}),
  });
};

// ── POST /api/auth/send-otp ───────────────────────────────────────────────────
// Public — called right after runner registration, before login.

exports.sendOtp = async (req, res) => {
  const { phone } = req.body;

  const user = await User.findOne({ phone });
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'No account found with this phone number' });
  }
  if (user.phoneVerified) {
    return res.status(400).json({ status: 'fail', message: 'Phone number is already verified' });
  }

  // TODO: restore Termii integration once sender ID is approved
  // const pinId = await termiiService.sendOtp(phone);
  // const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
  // await User.findByIdAndUpdate(user._id, { otpPinId: pinId, otpPinExpiresAt: expiresAt });

  // DEV BYPASS: mark a dummy pinId so verifyOtp knows an OTP was "sent"
  await User.findByIdAndUpdate(user._id, {
    otpPinId: 'dev-bypass',
    otpPinExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  });

  logger.auth.info('OTP sent (dev bypass)', { userId: user._id, ip: req.ip });
  res.status(200).json({ status: 'success', message: 'OTP sent to your phone number' });
};

// ── POST /api/auth/verify-otp ─────────────────────────────────────────────────

exports.verifyOtp = async (req, res) => {
  const { phone, otp } = req.body;

  const user = await User.findOne({ phone }).select('+otpPinId +otpPinExpiresAt');
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'No account found with this phone number' });
  }
  if (user.phoneVerified) {
    return res.status(400).json({ status: 'fail', message: 'Phone number is already verified' });
  }
  if (!user.otpPinId || !user.otpPinExpiresAt || user.otpPinExpiresAt < new Date()) {
    return res.status(400).json({ status: 'fail', message: 'OTP has expired. Please request a new one.' });
  }

  // TODO: restore Termii verification once sender ID is approved
  // const verified = await termiiService.verifyOtp(user.otpPinId, otp);
  // if (!verified) {
  //   return res.status(400).json({ status: 'fail', message: 'Invalid OTP. Please try again.' });
  // }

  // DEV BYPASS: accept any 6-digit code
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ status: 'fail', message: 'Invalid OTP. Please try again.' });
  }

  await User.findByIdAndUpdate(user._id, {
    phoneVerified: true,
    otpPinId: null,
    otpPinExpiresAt: null,
  });

  logger.auth.info('Phone verified', { userId: user._id, ip: req.ip });
  res.status(200).json({ status: 'success', message: 'Phone number verified successfully' });
};

// ── POST /api/auth/forgot-password ────────────────────────────────────────────
// Public. Always returns a generic response — never reveals whether the email
// is registered (and accounts without an email on file get the same response).

exports.forgotPassword = async (req, res) => {
  const { email } = req.body;

  const genericResponse = () =>
    res.status(200).json({
      status: 'success',
      message: 'If an account with that email exists, a reset code has been sent.',
    });

  const user = await User.findOne({ email });
  if (!user) return genericResponse();

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const resetCodeHash = await bcrypt.hash(code, 10);
  const resetCodeExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

  await User.findByIdAndUpdate(user._id, { resetCodeHash, resetCodeExpiresAt });

  try {
    await emailService.sendPasswordResetEmail(email, code);
    logger.auth.info('Password reset code sent', { userId: user._id, ip: req.ip });
  } catch (err) {
    logger.auth.error('Failed to send password reset email', { userId: user._id, ip: req.ip });
  }

  return genericResponse();
};

// ── POST /api/auth/reset-password ─────────────────────────────────────────────
// Public. Verifies the emailed code and sets a new password.
// Invalidates existing sessions, same as changePassword.

exports.resetPassword = async (req, res) => {
  const { email, code, newPassword } = req.body;

  const user = await User.findOne({ email }).select('+resetCodeHash +resetCodeExpiresAt');
  if (!user || !user.resetCodeHash || !user.resetCodeExpiresAt || user.resetCodeExpiresAt < new Date()) {
    return res.status(400).json({
      status: 'fail',
      message: 'Reset code has expired. Please request a new one.',
    });
  }

  const isValidCode = await bcrypt.compare(code, user.resetCodeHash);
  if (!isValidCode) {
    return res.status(400).json({ status: 'fail', message: 'Invalid reset code. Please try again.' });
  }

  user.password = newPassword; // pre-save hook hashes it
  user.passwordChangedAt = new Date();
  user.resetCodeHash = null;
  user.resetCodeExpiresAt = null;
  user.refreshTokenHash = null;
  user.refreshTokenExpiresAt = null;
  user.lastLogoutAt = new Date();
  await user.save();

  logger.auth.info('Password reset via email code', { userId: user._id, ip: req.ip });

  res.status(200).json({ status: 'success', message: 'Password reset successfully. Please log in.' });
};

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

exports.getMe = async (req, res) => {
  const photoUrl = await resolvePhotoUrl(req.user.photoKey);

  res.status(200).json({
    status: 'success',
    data: {
      user: {
        id: req.user._id,
        name: req.user.name,
        email: req.user.email,
        phone: req.user.phone,
        role: req.user.role,
        wallet: req.user.wallet,
        workingCapital: req.user.workingCapital,
        customerWallet: req.user.customerWallet,
        level: req.user.level,
        rating: req.user.rating,
        completedErrands: req.user.completedErrands,
        isActive: req.user.isActive,
        availability: req.user.availability && { status: req.user.availability.status },
        dateOfBirth: req.user.dateOfBirth,
        gender: req.user.gender,
        vehicleInfo: req.user.vehicleInfo,
        payoutDetails: req.user.payoutDetails,
        payoutMpesaNumber: req.user.payoutMpesaNumber,
        photoUrl,
      },
    },
  });
};
