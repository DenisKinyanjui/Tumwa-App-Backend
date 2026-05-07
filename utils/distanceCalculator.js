/**
 * Haversine-based distance calculation utilities.
 * All points are { lat: number, lng: number }.
 */

const EARTH_RADIUS_KM = 6371;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two lat/lng points, in kilometres.
 */
const haversineKm = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/**
 * True if pointA is within radiusKm of pointB.
 */
const isWithinRadius = (a, b, radiusKm) => haversineKm(a, b) <= radiusKm;

module.exports = { haversineKm, isWithinRadius };
