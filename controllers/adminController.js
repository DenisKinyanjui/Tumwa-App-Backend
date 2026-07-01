const mongoose = require('mongoose');
const User = require('../models/User');
const Errand = require('../models/Errand');
const Payment = require('../models/Payment');
const Dispute = require('../models/Dispute');
const Notification = require('../models/Notification');
const Rating = require('../models/Rating');
const RunnerVerification = require('../models/RunnerVerification');
const logger = require('../utils/logger');
const { creditFunds } = require('../utils/walletUtils');
const { emitToUser, emitToRoom } = require('../socket/socketManager'); // kept for broadcast endpoint
const { buildReport } = require('../services/adminReportService');
const notify = require('../services/notifyService');
const { presignVerification } = require('../utils/verificationPresign');

// ── Pagination helper ─────────────────────────────────────────────────────────
const paginate = (query) => {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(parseInt(query.limit) || 20, 100);
  return { page, limit, skip: (page - 1) * limit };
};

const paginatedResponse = (res, data, total, page, limit) =>
  res.status(200).json({
    status: 'success',
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    data,
  });

// ── Users ─────────────────────────────────────────────────────────────────────

// GET /api/admin/users
exports.getUsers = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { role, isActive, search, sortBy = 'createdAt', order = 'desc' } = req.query;

  const filter = {};
  if (role) filter.role = role;
  if (isActive !== undefined) filter.isActive = isActive === 'true';
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }

  const allowedSorts = ['createdAt', 'rating', 'completedErrands', 'name', 'trustWallet.total'];
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';
  const sortDir = order === 'asc' ? 1 : -1;

  const [users, total] = await Promise.all([
    User.find(filter)
      .select('-password')
      .sort({ [sortField]: sortDir })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  paginatedResponse(res, { users }, total, page, limit);
};

// GET /api/admin/users/:id
exports.getUser = async (req, res) => {
  const user = await User.findById(req.params.id).select('-password');
  if (!user) return res.status(404).json({ status: 'fail', message: 'User not found' });

  const [recentErrands, recentPayments, verificationDoc] = await Promise.all([
    Errand.find({ $or: [{ customer: user._id }, { runner: user._id }] })
      .sort('-createdAt')
      .limit(5)
      .select('title status amount createdAt'),

    Payment.find({ $or: [{ customer: user._id }, { runner: user._id }] })
      .sort('-createdAt')
      .limit(5)
      .select('type amount status completedAt'),

    user.role === 'runner' ? RunnerVerification.findOne({ user: user._id }).lean() : null,
  ]);

  const verification = await presignVerification(verificationDoc);

  res.status(200).json({
    status: 'success',
    data: { user, recentErrands, recentPayments, verification },
  });
};

// GET /api/admin/verifications/:userId
// Returns fresh presigned verification URLs for a single runner.
// Used by the admin panel to refresh documents without reloading the full page.
exports.getVerification = async (req, res) => {
  const verificationDoc = await RunnerVerification.findOne({ user: req.params.userId }).lean();
  if (!verificationDoc) {
    return res.status(404).json({ status: 'fail', message: 'No verification submission found' });
  }
  const verification = await presignVerification(verificationDoc);
  res.status(200).json({ status: 'success', data: { verification } });
};

// PATCH /api/admin/verifications/:userId/approve
exports.approveVerification = async (req, res) => {
  const { notes } = req.body;
  const verificationDoc = await RunnerVerification.findOneAndUpdate(
    { user: req.params.userId },
    { status: 'approved', adminNotes: notes || null, reviewedAt: new Date() },
    { new: true },
  ).lean();
  if (!verificationDoc) return res.status(404).json({ status: 'fail', message: 'Verification not found' });

  await User.findByIdAndUpdate(req.params.userId, { verificationStatus: 'approved' });

  const verification = await presignVerification(verificationDoc);

  notify.send({
    userId: req.params.userId,
    title: 'Verification Approved',
    message: 'Your identity verification has been approved. You\'re all set to start accepting errands!',
    type: 'admin',
    relatedId: req.params.userId,
    relatedModel: 'User',
    eventName: 'verification-status-changed',
    eventData: { status: 'approved' },
  });

  logger.info('Runner verification approved', { userId: req.params.userId, adminId: req.user._id });
  res.status(200).json({ status: 'success', data: { verification } });
};

// PATCH /api/admin/verifications/:userId/reject
exports.rejectVerification = async (req, res) => {
  const { notes } = req.body;
  if (!notes || !notes.trim()) {
    return res.status(400).json({ status: 'fail', message: 'Admin notes are required when rejecting.' });
  }
  const verificationDoc = await RunnerVerification.findOneAndUpdate(
    { user: req.params.userId },
    { status: 'rejected', adminNotes: notes.trim(), reviewedAt: new Date() },
    { new: true },
  ).lean();
  if (!verificationDoc) return res.status(404).json({ status: 'fail', message: 'Verification not found' });

  await User.findByIdAndUpdate(req.params.userId, { verificationStatus: 'rejected' });

  const verification = await presignVerification(verificationDoc);

  notify.send({
    userId: req.params.userId,
    title: 'Verification Rejected',
    message: `Your identity verification was rejected: ${notes.trim()}. Please resubmit your documents to try again.`,
    type: 'admin',
    relatedId: req.params.userId,
    relatedModel: 'User',
    eventName: 'verification-status-changed',
    eventData: { status: 'rejected', reason: notes.trim() },
  });

  logger.info('Runner verification rejected', { userId: req.params.userId, adminId: req.user._id });
  res.status(200).json({ status: 'success', data: { verification } });
};

// PATCH /api/admin/users/:id
exports.updateUser = async (req, res) => {
  const allowed = ['isActive', 'level', 'name', 'phone', 'role', 'rating', 'cancelCount'];
  const updates = {};
  allowed.forEach((field) => {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  });

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ status: 'fail', message: 'No valid fields to update' });
  }

  const user = await User.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true,
  }).select('-password');

  if (!user) return res.status(404).json({ status: 'fail', message: 'User not found' });

  // Notify user if their account was deactivated or reactivated
  if (updates.isActive !== undefined) {
    const statusMsg = user.isActive
      ? 'Your account has been reactivated.'
      : 'Your account has been deactivated. Contact support.';
    notify.send({
      userId: user._id,
      title: user.isActive ? 'Account Reactivated' : 'Account Deactivated',
      message: statusMsg,
      type: 'admin',
      relatedId: user._id,
      relatedModel: 'User',
      eventName: 'account-status-changed',
      eventData: { isActive: user.isActive },
    });
  }

  res.status(200).json({ status: 'success', data: { user } });
};

// DELETE /api/admin/users/:id
// Permanently removes the user and all their associated data.
// Admin accounts are protected and cannot be deleted.
exports.deleteUser = async (req, res) => {
  const user = await User.findById(req.params.id);
  if (!user) return res.status(404).json({ status: 'fail', message: 'User not found' });

  if (user.role === 'admin') {
    return res.status(403).json({ status: 'fail', message: 'Admin accounts cannot be deleted' });
  }

  const userId = user._id;

  await Promise.all([
    Notification.deleteMany({ user: userId }),
    Rating.deleteMany({ $or: [{ runner: userId }, { customer: userId }] }),
    Errand.deleteMany({ $or: [{ customer: userId }, { runner: userId }] }),
    Payment.deleteMany({ $or: [{ customer: userId }, { runner: userId }] }),
    Dispute.deleteMany({ $or: [{ customer: userId }, { runner: userId }, { raisedBy: userId }] }),
    RunnerVerification.deleteMany({ user: userId }),
  ]);

  await User.findByIdAndDelete(userId);

  logger.info('User permanently deleted by admin', {
    deletedUserId: userId,
    deletedUserName: user.name,
    adminId: req.user._id,
    ip: req.ip,
  });

  res.status(200).json({ status: 'success', message: 'User and all associated data deleted permanently' });
};

// ── Errands ───────────────────────────────────────────────────────────────────

// GET /api/admin/errands
exports.getErrands = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { status, isPaid, runner, customer, dateFrom, dateTo, sortBy = 'createdAt', order = 'desc' } =
    req.query;

  const filter = {};
  if (status) filter.status = status;
  if (isPaid !== undefined) filter.isPaid = isPaid === 'true';
  if (runner) filter.runner = runner;
  if (customer) filter.customer = customer;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  const allowedSorts = ['createdAt', 'amount', 'status', 'completedAt'];
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';

  const [errands, total] = await Promise.all([
    Errand.find(filter)
      .populate('customer', 'name phone')
      .populate('runner', 'name phone rating level')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Errand.countDocuments(filter),
  ]);

  paginatedResponse(res, { errands }, total, page, limit);
};

// GET /api/admin/errands/:id
exports.getErrand = async (req, res) => {
  const errand = await Errand.findById(req.params.id)
    .populate('customer', 'name phone')
    .populate('runner', 'name phone rating level trustWallet');

  if (!errand) return res.status(404).json({ status: 'fail', message: 'Errand not found' });

  const [payment, dispute] = await Promise.all([
    Payment.findOne({ errand: errand._id, type: 'errand_payment' }).sort('-createdAt'),
    Dispute.findOne({ errand: errand._id }),
  ]);

  res.status(200).json({
    status: 'success',
    data: { errand, payment, dispute },
  });
};

// ── Trust Wallets ─────────────────────────────────────────────────────────────

// GET /api/admin/wallets
exports.getWallets = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { minBalance, hasLocked, search } = req.query;

  const filter = { role: 'runner' };
  if (minBalance) filter['trustWallet.total'] = { $gte: parseFloat(minBalance) };
  if (hasLocked === 'true') filter['trustWallet.locked'] = { $gt: 0 };
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
    ];
  }

  const [runners, total] = await Promise.all([
    User.find(filter)
      .select('name phone level rating completedErrands trustWallet isActive')
      .sort({ 'trustWallet.total': -1 })
      .skip(skip)
      .limit(limit),
    User.countDocuments(filter),
  ]);

  // Compute availableBalance for each
  const data = runners.map((r) => ({
    ...r.toObject(),
    availableBalance: r.trustWallet.total - r.trustWallet.locked,
  }));

  paginatedResponse(res, { wallets: data }, total, page, limit);
};

// PATCH /api/admin/wallets/:userId
// Manually adjust a user's trust wallet balance.
exports.adjustWallet = async (req, res) => {
  const { operation, amount, reason } = req.body;

  if (!operation || !amount || !reason) {
    return res.status(400).json({
      status: 'fail',
      message: 'operation, amount, and reason are required',
    });
  }
  if (!['credit', 'debit'].includes(operation)) {
    return res.status(400).json({
      status: 'fail',
      message: "operation must be 'credit' or 'debit'",
    });
  }
  if (amount <= 0) {
    return res.status(400).json({ status: 'fail', message: 'amount must be greater than 0' });
  }

  const user = await User.findById(req.params.userId);
  if (!user) return res.status(404).json({ status: 'fail', message: 'User not found' });

  if (operation === 'debit') {
    const available = user.trustWallet.total - user.trustWallet.locked;
    if (amount > available) {
      return res.status(400).json({
        status: 'fail',
        message: `Cannot debit ${amount}. Available (unlocked) balance is ${available}.`,
      });
    }
    user.trustWallet.total -= amount;
  } else {
    user.trustWallet.total += amount;
  }

  await user.save();

  // Notify the affected user
  notify.send({
    userId: user._id,
    title: 'Trust Wallet Adjusted',
    message: `An admin ${operation}ed KES ${amount} ${operation === 'credit' ? 'to' : 'from'} your trust wallet. Reason: ${reason}.`,
    type: 'admin',
    relatedId: user._id,
    relatedModel: 'User',
    eventName: 'wallet-adjusted',
    eventData: {
      operation,
      amount,
      reason,
      newTotal: user.trustWallet.total,
      newAvailable: user.trustWallet.total - user.trustWallet.locked,
    },
  });

  res.status(200).json({
    status: 'success',
    message: `Wallet ${operation}ed by ${amount}`,
    data: {
      userId: user._id,
      name: user.name,
      trustWallet: user.trustWallet,
      availableBalance: user.trustWallet.total - user.trustWallet.locked,
    },
  });
};

// ── Disputes ──────────────────────────────────────────────────────────────────

// GET /api/admin/disputes
// Richer than the shared /api/disputes — includes pagination and all filters.
exports.getDisputes = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { status, dateFrom, dateTo, runner, customer, sortBy = 'createdAt', order = 'desc' } =
    req.query;

  const filter = {};
  if (status) filter.status = status;
  if (runner) filter.runner = runner;
  if (customer) filter.customer = customer;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  const allowedSorts = ['createdAt', 'status', 'resolution.resolvedAt'];
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';

  const [disputes, total] = await Promise.all([
    Dispute.find(filter)
      .populate('errand', 'title amount status')
      .populate('raisedBy', 'name role')
      .populate('customer', 'name phone')
      .populate('runner', 'name phone rating')
      .populate('resolution.resolvedBy', 'name')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Dispute.countDocuments(filter),
  ]);

  paginatedResponse(res, { disputes }, total, page, limit);
};

// ── Payments ──────────────────────────────────────────────────────────────────

// GET /api/admin/payments
exports.getPayments = async (req, res) => {
  const { page, limit, skip } = paginate(req.query);
  const { type, status, dateFrom, dateTo, sortBy = 'createdAt', order = 'desc' } = req.query;

  const filter = {};
  if (type) filter.type = type;
  if (status) filter.status = status;
  if (dateFrom || dateTo) {
    filter.createdAt = {};
    if (dateFrom) filter.createdAt.$gte = new Date(dateFrom);
    if (dateTo) filter.createdAt.$lte = new Date(dateTo);
  }

  const allowedSorts = ['createdAt', 'amount', 'completedAt'];
  const sortField = allowedSorts.includes(sortBy) ? sortBy : 'createdAt';

  const [payments, total] = await Promise.all([
    Payment.find(filter)
      .populate('customer', 'name phone')
      .populate('runner', 'name phone')
      .populate('errand', 'title amount')
      .sort({ [sortField]: order === 'asc' ? 1 : -1 })
      .skip(skip)
      .limit(limit),
    Payment.countDocuments(filter),
  ]);

  paginatedResponse(res, { payments }, total, page, limit);
};

// ── Reports ───────────────────────────────────────────────────────────────────

// GET /api/admin/reports?period=month
exports.getReports = async (req, res) => {
  const { period = 'month' } = req.query;
  const validPeriods = ['day', 'week', 'month', 'quarter', 'year'];
  if (!validPeriods.includes(period)) {
    return res.status(400).json({
      status: 'fail',
      message: `period must be one of: ${validPeriods.join(', ')}`,
    });
  }

  const report = await buildReport(period);
  res.status(200).json({ status: 'success', data: { report } });
};

// ── System status ─────────────────────────────────────────────────────────────

// A var counts as "configured" if it's set and isn't still the .env.example placeholder.
const isConfigured = (...values) =>
  values.every((v) => v && !/^your_/i.test(v));

// GET /api/admin/system-status
// Lightweight health snapshot for the admin dashboard — reflects real
// connection state and credential presence, not synthetic data.
exports.getSystemStatus = async (_req, res) => {
  const mongoConnected = mongoose.connection.readyState === 1;

  const services = [
    {
      key: 'app',
      label: 'App Status',
      operational: mongoConnected,
      detail: mongoConnected ? 'All systems operational' : 'Database unavailable',
    },
    {
      key: 'paymentGateway',
      label: 'Payment Gateway',
      operational: isConfigured(
        process.env.MPESA_CONSUMER_KEY,
        process.env.MPESA_CONSUMER_SECRET,
        process.env.MPESA_SHORTCODE,
        process.env.MPESA_PASSKEY,
      ),
      detail: 'M-Pesa Daraja API',
    },
    {
      key: 'smsService',
      label: 'SMS Service',
      operational: isConfigured(process.env.TERMII_API_KEY),
      detail: 'Termii OTP',
    },
    {
      key: 'mapService',
      label: 'Map Service',
      operational: mongoConnected,
      detail: 'Location matching',
    },
    {
      key: 'pushNotifications',
      label: 'Push Notifications',
      operational: isConfigured(
        process.env.FCM_PROJECT_ID,
        process.env.FCM_CLIENT_EMAIL,
        process.env.FCM_PRIVATE_KEY,
      ),
      detail: 'Firebase Cloud Messaging',
    },
  ];

  res.status(200).json({ status: 'success', data: { services } });
};

// ── Broadcast ─────────────────────────────────────────────────────────────────

// POST /api/admin/broadcast
// Send a real-time message to all admins, all runners, or a specific user.
exports.broadcast = async (req, res) => {
  const { target, event, message } = req.body;

  if (!target || !event || !message) {
    return res.status(400).json({ status: 'fail', message: 'target, event, and message are required' });
  }

  const payload = { message, sentBy: 'admin', sentAt: new Date() };

  if (target === 'admins' || target === 'runners' || target === 'customers') {
    emitToRoom(target, event, payload);
  } else {
    // Treat target as a userId
    const user = await User.findById(target).select('_id name');
    if (!user) return res.status(404).json({ status: 'fail', message: 'Target user not found' });
    emitToUser(target, event, payload);
  }

  res.status(200).json({ status: 'success', message: `Broadcast sent to '${target}'` });
};
