const r2Service = require('../services/r2Service');

// Records submitted before the presigned-URL migration stored a full
// (broken) public URL instead of a key — recover the key from it so old
// submissions keep working without a backfill being strictly required.
const LEGACY_MARKER = 'runner-verification/';

const resolveKey = (doc, keyField, legacyUrlField) => {
  if (doc[keyField]) return doc[keyField];
  const legacy = doc[legacyUrlField];
  if (legacy && legacy.includes(LEGACY_MARKER)) {
    return legacy.slice(legacy.indexOf(LEGACY_MARKER));
  }
  return null;
};

/**
 * Converts a RunnerVerification record (plain object — pass `.lean()` results)
 * into a plain object exposing short-lived signed URLs in place of the
 * stored R2 keys, so the admin panel can render the images directly.
 */
exports.presignVerification = async (verification) => {
  if (!verification) return null;

  const idFrontKey = resolveKey(verification, 'idFrontKey', 'idFrontUrl');
  const idBackKey  = resolveKey(verification, 'idBackKey',  'idBackUrl');
  const selfieKey  = resolveKey(verification, 'selfieKey',  'selfieUrl');

  const [idFrontUrl, idBackUrl, selfieUrl] = await Promise.all([
    idFrontKey ? r2Service.getSignedDownloadUrl(idFrontKey) : null,
    idBackKey  ? r2Service.getSignedDownloadUrl(idBackKey)  : null,
    selfieKey  ? r2Service.getSignedDownloadUrl(selfieKey)  : null,
  ]);

  return { ...verification, idFrontUrl, idBackUrl, selfieUrl };
};
