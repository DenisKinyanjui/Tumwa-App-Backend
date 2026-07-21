/**
 * serviceAreaService — auto-registers ServiceArea zones from the geocoded
 * locality/region captured on each new errand (see CreateErrand.tsx's
 * reverse-geocode → Errand.location.pickupLocality/deliveryLocality).
 *
 * Goal: the admin never has to type a zone in from scratch — new localities
 * show up on their own as customers actually order from them. The admin's
 * job becomes reviewing and managing (rename, merge, activate, retire)
 * rather than creating. New zones are inserted `status: 'inactive'` so they
 * don't reach the runner-facing "areas of operation" picker until an admin
 * has looked at them — that review step is what keeps "manage" meaningful.
 *
 * Called fire-and-forget (setImmediate) after errand creation in
 * paymentController — must never throw in a way that could be mistaken for
 * a payment/errand failure, so every DB error is caught and logged here.
 */

const ServiceArea = require('../models/ServiceArea');
const logger = require('../utils/logger');
const { escapeRegex } = require('../utils/regex');

const registerZone = async (name, region) => {
  const trimmed = name?.trim();
  if (!trimmed) return;

  try {
    // Case-insensitive existence check — geocoders are consistent enough
    // within a provider, but a straight unique-index insert would 500 on
    // the (rare) case-only difference and can't dedupe those anyway.
    const existing = await ServiceArea.findOne({
      name: new RegExp(`^${escapeRegex(trimmed)}$`, 'i'),
    });
    if (existing) return;

    const sortOrder = await ServiceArea.countDocuments();
    await ServiceArea.create({
      name: trimmed,
      region: region?.trim() || '',
      status: 'inactive',
      sortOrder,
      autoDetected: true,
    });
    logger.info('Auto-registered service area from errand geocode', { name: trimmed, region: region ?? null });
  } catch (err) {
    // Duplicate-key race between two concurrent errands resolving the same
    // new locality at once, or any other failure — this is a best-effort
    // side effect and must never bubble up into the errand-creation flow.
    logger.warn('Failed to auto-register service area', { name: trimmed, error: err.message });
  }
};

// Registers both the pickup and delivery localities on a just-created
// errand (each independently deduped against the existing zone list).
exports.registerZonesFromErrand = async (errand) => {
  const location = errand?.location ?? {};
  await Promise.all([
    registerZone(location.pickupLocality, location.pickupRegion),
    registerZone(location.deliveryLocality, location.deliveryRegion),
  ]);
};
