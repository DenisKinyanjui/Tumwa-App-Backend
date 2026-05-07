const axios = require('axios');

const SANDBOX_BASE = 'https://sandbox.safaricom.co.ke';
const PRODUCTION_BASE = 'https://api.safaricom.co.ke';

const baseURL = () =>
  process.env.MPESA_ENVIRONMENT === 'production' ? PRODUCTION_BASE : SANDBOX_BASE;

// ── Token cache ───────────────────────────────────────────────────────────────
// M-Pesa tokens expire in 3600s. Cache to avoid one round-trip per request.
let _cachedToken = null;
let _tokenExpiresAt = 0;

const getAccessToken = async () => {
  if (_cachedToken && Date.now() < _tokenExpiresAt) return _cachedToken;

  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const { data } = await axios.get(`${baseURL()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  _cachedToken = data.access_token;
  // Refresh 60s before actual expiry
  _tokenExpiresAt = Date.now() + (parseInt(data.expires_in, 10) - 60) * 1000;

  return _cachedToken;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format timestamp as YYYYMMDDHHmmss (required by Daraja API) */
const getTimestamp = () => {
  const now = new Date();
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');
};

/** Generate STK push password: base64(ShortCode + Passkey + Timestamp) */
const getSTKPassword = (timestamp) =>
  Buffer.from(`${process.env.MPESA_SHORTCODE}${process.env.MPESA_PASSKEY}${timestamp}`).toString(
    'base64'
  );

/**
 * Normalize phone to 2547XXXXXXXX format.
 * Accepts: +254..., 254..., 07..., 7...
 */
const normalizePhone = (phone) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('254')) return digits;
  if (digits.startsWith('0')) return `254${digits.slice(1)}`;
  if (digits.startsWith('7') || digits.startsWith('1')) return `254${digits}`;
  throw new Error(`Cannot normalize phone number: ${phone}`);
};

/**
 * Extract a value from M-Pesa's odd key-value array structure.
 * Used to parse callback metadata and B2C result parameters.
 */
const extractCallbackValue = (items, key) => {
  const item = items.find((i) => i.Name === key || i.Key === key);
  return item ? item.Value : null;
};

// ── STK Push (Lipa Na M-Pesa Online) ─────────────────────────────────────────

/**
 * Initiate an STK push to the customer's phone.
 * Returns { checkoutRequestId, merchantRequestId }
 */
const initiateSTKPush = async ({ phone, amount, accountReference, description }) => {
  const token = await getAccessToken();
  const timestamp = getTimestamp();
  const normalizedPhone = normalizePhone(phone);

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORTCODE,
    Password: getSTKPassword(timestamp),
    Timestamp: timestamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Math.round(amount), // M-Pesa requires integer
    PartyA: normalizedPhone,
    PartyB: process.env.MPESA_SHORTCODE,
    PhoneNumber: normalizedPhone,
    CallBackURL: `${process.env.MPESA_CALLBACK_URL}/api/payments/callback/stk`,
    AccountReference: accountReference.slice(0, 12), // max 12 chars
    TransactionDesc: description.slice(0, 13),        // max 13 chars
  };

  const { data } = await axios.post(
    `${baseURL()}/mpesa/stkpush/v1/processrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (data.ResponseCode !== '0') {
    throw new Error(data.ResponseDescription || 'STK push failed');
  }

  return {
    checkoutRequestId: data.CheckoutRequestID,
    merchantRequestId: data.MerchantRequestID,
  };
};

/**
 * Query the status of an STK push.
 * Useful for polling when no callback is received.
 */
const querySTKStatus = async (checkoutRequestId) => {
  const token = await getAccessToken();
  const timestamp = getTimestamp();

  const { data } = await axios.post(
    `${baseURL()}/mpesa/stkpushquery/v1/query`,
    {
      BusinessShortCode: process.env.MPESA_SHORTCODE,
      Password: getSTKPassword(timestamp),
      Timestamp: timestamp,
      CheckoutRequestID: checkoutRequestId,
    },
    { headers: { Authorization: `Bearer ${token}` } }
  );

  return data;
};

// ── B2C (Business to Customer — withdrawals) ──────────────────────────────────

/**
 * Initiate a B2C payment (runner withdrawal to their M-Pesa).
 * Returns { conversationId, originatorConversationId }
 */
const initiateB2C = async ({ phone, amount, remarks, occasion = '' }) => {
  const token = await getAccessToken();
  const normalizedPhone = normalizePhone(phone);

  const payload = {
    InitiatorName: process.env.MPESA_INITIATOR_NAME,
    SecurityCredential: process.env.MPESA_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment',
    Amount: Math.round(amount),
    PartyA: process.env.MPESA_B2C_SHORTCODE,
    PartyB: normalizedPhone,
    Remarks: remarks.slice(0, 100),
    QueueTimeOutURL: `${process.env.MPESA_CALLBACK_URL}/api/payments/callback/b2c`,
    ResultURL: `${process.env.MPESA_CALLBACK_URL}/api/payments/callback/b2c`,
    Occasion: occasion.slice(0, 100),
  };

  const { data } = await axios.post(
    `${baseURL()}/mpesa/b2c/v1/paymentrequest`,
    payload,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (data.ResponseCode !== '0') {
    throw new Error(data.ResponseDescription || 'B2C initiation failed');
  }

  return {
    conversationId: data.ConversationID,
    originatorConversationId: data.OriginatorConversationID,
  };
};

// ── Callback parsers ──────────────────────────────────────────────────────────

/**
 * Parse an STK push callback body.
 * Returns { success, resultCode, resultDesc, receiptNumber, amount, phone, checkoutRequestId, merchantRequestId }
 */
const parseSTKCallback = (body) => {
  const cb = body?.Body?.stkCallback;
  if (!cb) throw new Error('Invalid STK callback structure');

  const success = cb.ResultCode === 0;
  const items = cb.CallbackMetadata?.Item || [];

  return {
    success,
    resultCode: cb.ResultCode,
    resultDesc: cb.ResultDesc,
    checkoutRequestId: cb.CheckoutRequestID,
    merchantRequestId: cb.MerchantRequestID,
    receiptNumber: extractCallbackValue(items, 'MpesaReceiptNumber'),
    amount: extractCallbackValue(items, 'Amount'),
    phone: extractCallbackValue(items, 'PhoneNumber'),
  };
};

/**
 * Parse a B2C result/timeout callback body.
 * Returns { success, resultCode, resultDesc, receiptNumber, conversationId, originatorConversationId }
 */
const parseB2CCallback = (body) => {
  const result = body?.Result;
  if (!result) throw new Error('Invalid B2C callback structure');

  const success = result.ResultCode === 0;
  const params = result.ResultParameters?.ResultParameter || [];

  return {
    success,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    conversationId: result.ConversationID,
    originatorConversationId: result.OriginatorConversationID,
    transactionId: result.TransactionID,
    receiptNumber: extractCallbackValue(params, 'TransactionReceipt'),
    amount: extractCallbackValue(params, 'TransactionAmount'),
  };
};

module.exports = {
  getAccessToken,
  initiateSTKPush,
  querySTKStatus,
  initiateB2C,
  parseSTKCallback,
  parseB2CCallback,
  normalizePhone,
};
