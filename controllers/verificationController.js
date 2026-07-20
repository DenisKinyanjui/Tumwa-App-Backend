const User = require('../models/User');
const RunnerVerification = require('../models/RunnerVerification');
const r2Service = require('../services/r2Service');
const logger = require('../utils/logger');
const notify = require('../services/notifyService');

// ── Allowed values ────────────────────────────────────────────────────────────

const TRANSPORT_OPTIONS = ['motorbike', 'bicycle', 'car', 'on_foot', 'public_transport'];

// ── Upload slots ──────────────────────────────────────────────────────────────
// Files never pass through this server — the client PUTs them straight to R2
// using the presigned URLs from getUploadUrls below, then submit() only ever
// sees the resulting object keys. This keeps the request body tiny, which
// matters because our hosting platform hard-caps request bodies at 4.5MB and
// four full-size photos in one multipart request routinely blew past that.
const UPLOAD_SLOTS = {
  // Private KYC documents — never shown to other users.
  idFront: { folder: (userId) => `runner-verification/${userId}`, label: 'id-front' },
  idBack:  { folder: (userId) => `runner-verification/${userId}`, label: 'id-back' },
  selfie:  { folder: (userId) => `runner-verification/${userId}`, label: 'selfie' },
  // Public profile picture — either the selfie above re-picked by the client,
  // or a separate gallery photo. Stored independently on User.photoKey.
  profilePhoto: { folder: (userId) => `profile-photos/${userId}`, label: 'photo' },
};

const keyBelongsToUser = (key, folder) =>
  typeof key === 'string' && key.startsWith(`${folder}/`);

// ── POST /api/verification/upload-urls ────────────────────────────────────────
// Public — same trust model as submit() below (identified by phone, called
// before login during onboarding). Issues short-lived presigned R2 PUT URLs
// so the client can upload photo bytes directly to R2, then call submit()
// with just the resulting keys.
exports.getUploadUrls = async (req, res) => {
  const { phone, files } = req.body;

  const errors = [];
  if (!phone?.trim()) errors.push('Phone number is required');

  const slots = files && typeof files === 'object' ? Object.keys(files) : [];
  if (slots.length === 0) errors.push('At least one file is required');
  for (const slot of slots) {
    if (!UPLOAD_SLOTS[slot]) errors.push(`Unknown file slot: ${slot}`);
    else if (typeof files[slot] !== 'string' || !files[slot].startsWith('image/')) {
      errors.push(`Only image files are allowed for ${slot}`);
    }
  }

  if (errors.length > 0) {
    return res.status(422).json({ status: 'fail', message: 'Validation failed', errors });
  }

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

  const entries = await Promise.all(
    slots.map(async (slot) => {
      const { folder, label } = UPLOAD_SLOTS[slot];
      const mimeType = files[slot];
      const ext = mimeType === 'image/png' ? 'png' : 'jpg';
      const key = `${folder(user._id)}/${label}-${Date.now()}.${ext}`;
      const uploadUrl = await r2Service.getSignedUploadUrl(key, mimeType);
      return [slot, { key, uploadUrl }];
    }),
  );

  res.status(200).json({ status: 'success', data: Object.fromEntries(entries) });
};

// ── POST /api/verification/submit ─────────────────────────────────────────────
// Public — runner is not yet logged in (called right after phone verification).
// Identified by phone number; requires phoneVerified=true.

exports.submit = async (req, res) => {
  const {
    phone, nationalId, meansOfTransport, areasOfOperation, reuseSelfieAsProfilePhoto,
    idFrontKey, idBackKey, selfieKey, profilePhotoKey,
  } = req.body;
  // When the client re-picks the same selfie as the profile picture, it sends
  // this flag instead of re-uploading the identical image bytes a second time
  // (which was needlessly doubling the upload size / time for that case).
  const reuseSelfie = reuseSelfieAsProfilePhoto === 'true' || reuseSelfieAsProfilePhoto === true;

  // ── Manual validation ────────────────────────────────────────────────────────
  const errors = [];

  if (!phone?.trim())        errors.push('Phone number is required');
  if (!nationalId?.trim())   errors.push('National ID number is required');
  if (!meansOfTransport || !TRANSPORT_OPTIONS.includes(meansOfTransport)) {
    errors.push('A valid means of transport is required');
  }

  const areas = Array.isArray(areasOfOperation) ? areasOfOperation : [];
  if (areas.length === 0) errors.push('At least one area of operation is required');

  if (!idFrontKey) errors.push('ID front photo is required');
  if (!idBackKey)  errors.push('ID back photo is required');
  if (!selfieKey)  errors.push('Selfie photo is required');
  if (!reuseSelfie && !profilePhotoKey) errors.push('A profile picture is required');

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

  // The only way to have written anything under these prefixes is via a
  // presigned URL this same user was just issued by getUploadUrls above.
  const verificationFolder = `runner-verification/${user._id}`;
  const profileFolder = `profile-photos/${user._id}`;
  if (
    !keyBelongsToUser(idFrontKey, verificationFolder) ||
    !keyBelongsToUser(idBackKey, verificationFolder) ||
    !keyBelongsToUser(selfieKey, verificationFolder) ||
    (!reuseSelfie && !keyBelongsToUser(profilePhotoKey, profileFolder))
  ) {
    return res.status(422).json({ status: 'fail', message: 'Validation failed', errors: ['Uploaded file references are invalid'] });
  }

  // Check for existing submission
  const existing = await RunnerVerification.findOne({ user: user._id });
  if (existing && existing.status !== 'rejected') {
    return res.status(409).json({ status: 'fail', message: 'Verification already submitted' });
  }

  // Reusing the selfie copies its R2 key onto photoKey rather than sharing a
  // live reference — the KYC selfieKey stays private on RunnerVerification;
  // nothing downstream ever derives a profile picture from it again.
  const photoKey = reuseSelfie ? selfieKey : profilePhotoKey;
  const previousPhotoKey = user.photoKey;

  // ── Save verification record ──────────────────────────────────────────────────
  if (existing) {
    // Re-submission after rejection
    await RunnerVerification.findByIdAndUpdate(existing._id, {
      nationalId: nationalId.trim(),
      idFrontKey,
      idBackKey,
      selfieKey,
      meansOfTransport,
      areasOfOperation: areas,
      status: 'pending',
      adminNotes: null,
      submittedAt: new Date(),
      reviewedAt: null,
    });

    // Notify all admins so they know to review the updated documents
    notify.sendToRole({
      role: 'admin',
      title: 'Verification Resubmitted',
      message: `${user.name} has resubmitted their identity verification documents for review.`,
      type: 'admin',
      relatedId: user._id,
      relatedModel: 'User',
      eventName: 'verification-resubmitted',
      eventData: { userId: String(user._id), userName: user.name },
    });
  } else {
    await RunnerVerification.create({
      user: user._id,
      nationalId: nationalId.trim(),
      idFrontKey,
      idBackKey,
      selfieKey,
      meansOfTransport,
      areasOfOperation: areas,
    });

    notify.sendToRole({
      role: 'admin',
      title: 'New Verification Submitted',
      message: `${user.name} has submitted their identity verification documents for review.`,
      type: 'admin',
      relatedId: user._id,
      relatedModel: 'User',
      eventName: 'verification-submitted',
      eventData: { userId: String(user._id), userName: user.name },
    });
  }

  await User.findByIdAndUpdate(user._id, { verificationStatus: 'pending', photoKey });

  if (previousPhotoKey) {
    r2Service.deleteFile(previousPhotoKey).catch((err) => {
      logger.error('Failed to delete previous profile photo', { userId: user._id, err: err.message });
    });
  }

  logger.info('Runner verification submitted', { userId: user._id, ip: req.ip });

  res.status(201).json({
    status: 'success',
    message: 'Verification submitted successfully. We will review your documents within 24–48 hours.',
  });
};

// ── GET /api/verification/status ──────────────────────────────────────────────
// Protected — lets a logged-in runner check their own verification status
// (and rejection reason, if any) so the app can prompt them to resubmit.
exports.getMyStatus = async (req, res) => {
  const verification = await RunnerVerification.findOne({ user: req.user._id })
    .select('status adminNotes submittedAt reviewedAt')
    .lean();

  res.status(200).json({
    status: 'success',
    data: {
      verificationStatus: req.user.verificationStatus,
      adminNotes: verification?.adminNotes ?? null,
      submittedAt: verification?.submittedAt ?? null,
      reviewedAt: verification?.reviewedAt ?? null,
    },
  });
};
