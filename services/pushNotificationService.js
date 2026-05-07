let admin;

/**
 * Lazily initialize Firebase Admin SDK.
 * Returns null if FCM credentials are not configured — push notifications
 * will be silently skipped, but the rest of the app continues working.
 */
const getAdmin = () => {
  if (admin) return admin;

  const { FCM_PROJECT_ID, FCM_CLIENT_EMAIL, FCM_PRIVATE_KEY } = process.env;
  if (!FCM_PROJECT_ID || !FCM_CLIENT_EMAIL || !FCM_PRIVATE_KEY) {
    return null;
  }

  try {
    admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: FCM_PROJECT_ID,
          clientEmail: FCM_CLIENT_EMAIL,
          // .env stores \n as literal backslash-n — convert to real newline
          privateKey: FCM_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    }
    console.log('[FCM] Firebase Admin initialized');
    return admin;
  } catch (err) {
    console.error('[FCM] Firebase Admin initialization failed:', err.message);
    return null;
  }
};

/**
 * Send a push notification to a single device token.
 *
 * @param {object} params
 * @param {string} params.token   - FCM device registration token
 * @param {string} params.title   - notification title
 * @param {string} params.body    - notification body text
 * @param {object} [params.data]  - optional key-value data payload (all values must be strings)
 *
 * Silently returns on any error — push failures must never break the main flow.
 */
const sendPush = async ({ token, title, body, data = {} }) => {
  const firebaseAdmin = getAdmin();
  if (!firebaseAdmin) return; // FCM not configured
  if (!token) return;         // user has no registered device

  // FCM data payload requires all values to be strings
  const stringData = Object.fromEntries(
    Object.entries(data).map(([k, v]) => [k, v == null ? '' : String(v)])
  );

  try {
    await firebaseAdmin.messaging().send({
      token,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { sound: 'default', channelId: 'tumwa_default' },
      },
      apns: {
        payload: { aps: { sound: 'default', badge: 1 } },
      },
    });
  } catch (err) {
    // INVALID_ARGUMENT or UNREGISTERED means the token is stale — clean it up
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      console.warn('[FCM] Stale token detected — clearing from user record');
      const User = require('../models/User');
      await User.findOneAndUpdate({ fcmToken: token }, { $set: { fcmToken: null } }).catch(() => {});
    } else {
      console.error('[FCM] sendPush error:', err.message);
    }
  }
};

/**
 * Send the same push notification to multiple tokens in one batch.
 * Ignores null/undefined tokens automatically.
 */
const sendMulticastPush = async ({ tokens, title, body, data = {} }) => {
  const validTokens = tokens.filter(Boolean);
  if (!validTokens.length) return;

  await Promise.allSettled(validTokens.map((token) => sendPush({ token, title, body, data })));
};

module.exports = { sendPush, sendMulticastPush };
