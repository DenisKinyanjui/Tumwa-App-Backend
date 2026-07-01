const logger = require('../utils/logger');

let resend;

/**
 * Lazily initialize the Resend client. Returns null if RESEND_API_KEY is not
 * configured — callers should treat that as "email sending unavailable"
 * rather than crashing the process.
 */
const getResend = () => {
  if (resend) return resend;
  if (!process.env.RESEND_API_KEY) return null;

  const { Resend } = require('resend');
  resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
};

// Resend's shared test sender — swap for a verified domain address before production.
const FROM = process.env.RESEND_FROM_EMAIL || 'Tumwa <onboarding@resend.dev>';

exports.sendPasswordResetEmail = async (email, code) => {
  const client = getResend();
  if (!client) {
    logger.error('Resend not configured — RESEND_API_KEY missing', { to: email });
    throw new Error('Failed to send reset email. Please try again.');
  }

  try {
    const { error } = await client.emails.send({
      from: FROM,
      to: email,
      subject: 'Reset your Tumwa password',
      html: `
        <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
          <h2>Reset your password</h2>
          <p>Use the code below to reset your Tumwa account password. This code is valid for 15 minutes.</p>
          <p style="font-size: 32px; font-weight: bold; letter-spacing: 6px;">${code}</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        </div>
      `,
    });

    if (error) throw new Error(error.message || 'Failed to send email');

    logger.info('Password reset email sent', { to: email });
  } catch (err) {
    logger.error('Resend sendPasswordResetEmail failed', { to: email, detail: err.message });
    throw new Error('Failed to send reset email. Please try again.');
  }
};
