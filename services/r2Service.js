const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
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
 * Upload a Buffer to R2 and return the public URL.
 * @param {Buffer} buffer - file contents
 * @param {string} folder - e.g. 'runner-verification/userId'
 * @param {string} label  - e.g. 'id-front'
 * @param {string} mimeType - e.g. 'image/jpeg'
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

  const publicUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
  logger.info('R2 upload complete', { key, mimeType });
  return publicUrl;
};
