const multer = require('multer');
const User = require('../models/User');
const RunnerVerification = require('../models/RunnerVerification');
const r2Service = require('../services/r2Service');
const logger = require('../utils/logger');

// ── Multer setup ──────────────────────────────────────────────────────────────

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (_req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed'));
    }
    cb(null, true);
  },
});

// Export the multer middleware so the router can apply it
exports.uploadMiddleware = upload.fields([
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack',  maxCount: 1 },
  { name: 'selfie',  maxCount: 1 },
]);

// ── Allowed values ────────────────────────────────────────────────────────────

const TRANSPORT_OPTIONS = ['motorbike', 'bicycle', 'car', 'on_foot', 'public_transport'];

// ── POST /api/verification/submit ─────────────────────────────────────────────
// Public — runner is not yet logged in (called right after phone verification).
// Identified by phone number; requires phoneVerified=true.

exports.submit = async (req, res) => {
  const { phone, nationalId, meansOfTransport, areasOfOperation } = req.body;
  const files = req.files;

  // ── Manual validation ────────────────────────────────────────────────────────
  const errors = [];

  if (!phone?.trim())        errors.push('Phone number is required');
  if (!nationalId?.trim())   errors.push('National ID number is required');
  if (!meansOfTransport || !TRANSPORT_OPTIONS.includes(meansOfTransport)) {
    errors.push('A valid means of transport is required');
  }

  let areas = [];
  try {
    areas = JSON.parse(areasOfOperation || '[]');
    if (!Array.isArray(areas) || areas.length === 0) errors.push('At least one area of operation is required');
  } catch {
    errors.push('Invalid areas of operation format');
  }

  if (!files?.idFront?.[0])  errors.push('ID front photo is required');
  if (!files?.idBack?.[0])   errors.push('ID back photo is required');
  if (!files?.selfie?.[0])   errors.push('Selfie photo is required');

  if (errors.length > 0) {
    return res.status(422).json({ status: 'fail', message: 'Validation failed', errors });
  }

  // ── Look up user ─────────────────────────────────────────────────────────────
  const user = await User.findOne({ phone: phone.trim() });
  if (!user) {
    return res.status(404).json({ status: 'fail', message: 'No account found with this phone number' });
  }
  if (user.role !== 'runner') {
    return res.status(403).json({ status: 'fail', message: 'Identity verification is only for runners' });
  }
  if (!user.phoneVerified) {
    return res.status(403).json({ status: 'fail', message: 'Phone number must be verified first' });
  }

  // Check for existing submission
  const existing = await RunnerVerification.findOne({ user: user._id });
  if (existing && existing.status !== 'rejected') {
    return res.status(409).json({ status: 'fail', message: 'Verification already submitted' });
  }

  // ── Upload images to R2 ───────────────────────────────────────────────────────
  const folder = `runner-verification/${user._id}`;

  const [idFrontUrl, idBackUrl, selfieUrl] = await Promise.all([
    r2Service.uploadFile(files.idFront[0].buffer, folder, 'id-front', files.idFront[0].mimetype),
    r2Service.uploadFile(files.idBack[0].buffer, folder, 'id-back',  files.idBack[0].mimetype),
    r2Service.uploadFile(files.selfie[0].buffer, folder, 'selfie',   files.selfie[0].mimetype),
  ]);

  // ── Save verification record ──────────────────────────────────────────────────
  if (existing) {
    // Re-submission after rejection
    await RunnerVerification.findByIdAndUpdate(existing._id, {
      nationalId: nationalId.trim(),
      idFrontUrl,
      idBackUrl,
      selfieUrl,
      meansOfTransport,
      areasOfOperation: areas,
      status: 'pending',
      adminNotes: null,
      submittedAt: new Date(),
      reviewedAt: null,
    });
  } else {
    await RunnerVerification.create({
      user: user._id,
      nationalId: nationalId.trim(),
      idFrontUrl,
      idBackUrl,
      selfieUrl,
      meansOfTransport,
      areasOfOperation: areas,
    });
  }

  await User.findByIdAndUpdate(user._id, { verificationStatus: 'pending' });

  logger.info('Runner verification submitted', { userId: user._id, ip: req.ip });

  res.status(201).json({
    status: 'success',
    message: 'Verification submitted successfully. We will review your documents within 24–48 hours.',
  });
};
