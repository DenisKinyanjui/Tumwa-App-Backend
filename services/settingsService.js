/**
 * App-wide admin-editable settings (currently just Working Capital config).
 * Backed by a singleton AppSettings document, found-or-created on first read.
 *
 * Cached in memory since workingCapitalService reads this on every errand
 * completion/cancellation — the cache is invalidated on every write, so an
 * admin's change takes effect on the next read with no restart needed.
 */

const AppSettings = require('../models/AppSettings');

let cached = null;

const getSettings = async () => {
  if (cached) return cached;

  let settings = await AppSettings.findOne().sort({ createdAt: -1 });
  if (!settings) {
    settings = await AppSettings.create({});
  }

  cached = settings;
  return settings;
};

/**
 * @param {object} patch - flat dot-path keys under `workingCapital`, e.g.
 *   { 'workingCapital.defaultLimit': 750 }
 * @param {string} adminId
 */
const updateSettings = async (patch, adminId) => {
  const settings = await getSettings();

  Object.entries(patch).forEach(([path, value]) => {
    settings.set(path, value);
  });
  settings.updatedBy = adminId;
  await settings.save();

  cached = settings;
  return settings;
};

module.exports = { getSettings, updateSettings };
