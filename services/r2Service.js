const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const logger = require('../utils/logger');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

/**
 * Upload a Buffer to R2 and return its object key.
 * The bucket has no public access — callers must use getSignedDownloadUrl()
 * to read the file back (e.g. when an admin views verification documents).
 * @param {Buffer} buffer - file contents
 * @param {string} folder - e.g. 'runner-verification/userId'
 * @param {string} label  - e.g. 'id-front'
 * @param {string} mimeType - e.g. 'image/jpeg'
 * @returns {Promise<string>} the R2 object key
 */
exports.uploadFile = async (buffer, folder, label, mimeType) => {
  const ext = mimeType === 'image/png' ? 'png' : 'jpg';
  const key = `${folder}/${label}-${Date.now()}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));

  logger.info('R2 upload complete', { key, mimeType });
  return key;
};

/**
 * Generate a short-lived signed URL to read a private R2 object.
 * @param {string} key - R2 object key
 * @param {number} [expiresIn] - seconds until the link expires (default 15 min)
 */
exports.getSignedDownloadUrl = async (key, expiresIn = 900) => {
  const command = new GetObjectCommand({
    Bucket: process.env.R2_BUCKET_NAME,
    Key: key,
  });
  return getSignedUrl(s3, command, { expiresIn });
};
