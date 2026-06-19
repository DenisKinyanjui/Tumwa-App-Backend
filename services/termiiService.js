const axios = require('axios');
const logger = require('../utils/logger');

const BASE_URL = process.env.TERMII_BASE_URL || 'https://v3.api.termii.com';

// Convert any Kenyan phone format to the international form Termii expects (e.g. 2547XXXXXXXX).
const normalizePhone = (phone) => {
  let p = String(phone).replace(/[\s\-()]/g, '');
  if (p.startsWith('+')) p = p.slice(1);         // +254... → 254...
  if (p.startsWith('0')) p = '254' + p.slice(1); // 07xx  → 2547xx
  return p;
};

exports.sendOtp = async (phoneNumber) => {
  const normalized = normalizePhone(phoneNumber);
  try {
    const { data } = await axios.post(`${BASE_URL}/api/sms/otp/send`, {
      api_key:          process.env.TERMII_API_KEY,
      message_type:     'NUMERIC',
      to:               normalized,
      from:             process.env.TERMII_SENDER_ID || 'N-Alert',
      channel:          'generic',
      pin_attempts:     3,
      pin_time_to_live: 10,
      pin_length:       6,
      pin_placeholder:  '< 1234 >',
      message_text:     'Your Tumwa verification code is < 1234 >. Valid for 10 minutes.',
      pin_type:         'NUMERIC',
    });
    logger.info('Termii OTP sent', { to: normalized, pinId: data.pinId });
    return data.pinId;
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    logger.error('Termii sendOtp failed', { to: normalized, status: err.response?.status, detail });
    throw new Error(detail || 'Failed to send OTP. Please try again.');
  }
};

exports.verifyOtp = async (pinId, pin) => {
  try {
    const { data } = await axios.post(`${BASE_URL}/api/sms/otp/verify`, {
      api_key: process.env.TERMII_API_KEY,
      pin_id:  pinId,
      pin,
    });
    return data.verified === 'True';
  } catch (err) {
    const detail = err.response?.data?.message || err.response?.data?.error || err.message;
    logger.error('Termii verifyOtp failed', { pinId, status: err.response?.status, detail });
    throw new Error(detail || 'Verification failed. Please try again.');
  }
};
