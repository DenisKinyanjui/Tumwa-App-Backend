const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');

// ── User-Agent parsing ────────────────────────────────────────────────────────
// No UA-parsing dependency exists in this backend — a hand-rolled regex parser
// covers the browsers/OSes/devices an admin panel actually sees (desktop
// Chrome/Firefox/Safari/Edge on Windows/macOS/Linux, occasional mobile admin
// access) without pulling in a new package for a "nice to have" detail field.
const parseUserAgent = (ua) => {
  if (!ua) return { browser: null, os: null, device: null };

  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /CriOS\//.test(ua) ? 'Chrome (iOS)' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Version\/.*Safari\//.test(ua) ? 'Safari' :
    /MSIE|Trident/.test(ua) ? 'Internet Explorer' :
    'Unknown';

  const os =
    /Windows NT 10/.test(ua) ? 'Windows 10/11' :
    /Windows NT/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'macOS' :
    /Android/.test(ua) ? 'Android' :
    /iPhone|iPad|iPod/.test(ua) ? 'iOS' :
    /Linux/.test(ua) ? 'Linux' :
    'Unknown';

  const device = /Mobi|Android.*Mobile|iPhone/.test(ua) ? 'Mobile' :
    /iPad|Tablet/.test(ua) ? 'Tablet' :
    'Desktop';

  return { browser, os, device };
};

// ── Session identifier ────────────────────────────────────────────────────────
// The backend is stateless JWT (no session store), so there's no real session
// row to point to. Deriving a short, stable hash from the access token's
// issuer/subject/issued-at gives every request within the same login a
// consistent "Session ID" without adding new session-tracking infrastructure.
const deriveSessionId = (req) => {
  const authHeader = req.headers?.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;

  try {
    const decoded = jwt.decode(authHeader.split(' ')[1]);
    if (!decoded?.id || !decoded?.iat) return null;
    return crypto.createHash('sha256').update(`${decoded.id}:${decoded.iat}`).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
};

/**
 * Records one immutable audit trail entry. Fire-and-forget by design — an
 * audit-logging failure must never break the admin action it's describing,
 * so callers invoke this without awaiting and errors are only logged.
 *
 * @param {object} params
 * @param {object} params.req - the Express request (for ip/device/session, and actor if not overridden)
 * @param {{id: any, name: string, email?: string, role: string}} [params.actor] - overrides
 *   req.user as the actor. Needed on auth routes (login/reset-password) where the acting
 *   user isn't (yet) the authenticated req.user.
 * @param {string} params.action - one of AuditLog.ACTIONS
 * @param {string} params.module - one of AuditLog.MODULES
 * @param {string} [params.severity='Low'] - one of AuditLog.SEVERITIES
 * @param {{type?: string, id?: any, label?: string}} [params.target]
 * @param {{before?: any, after?: any}} [params.changes]
 * @param {string} [params.reason]
 * @param {'success'|'failed'} [params.status='success']
 * @param {string} [params.errorMessage]
 */
const record = ({
  req,
  actor = null,
  action,
  module,
  severity = 'Low',
  target = null,
  changes = null,
  reason = null,
  status = 'success',
  errorMessage = null,
}) => {
  const actorSource = actor || req?.user;
  if (!actorSource) return;

  const doc = {
    actor: {
      id: actorSource._id ?? actorSource.id,
      name: actorSource.name,
      email: actorSource.email || null,
      role: actorSource.role,
    },
    action,
    module,
    severity,
    target: target ? { type: target.type ?? null, id: target.id ?? null, label: target.label ?? null } : undefined,
    changes: changes ? { before: changes.before ?? null, after: changes.after ?? null } : undefined,
    reason,
    requestId: req.headers['x-request-id'] || crypto.randomUUID(),
    ip: req.ip,
    device: { ...parseUserAgent(req.get?.('User-Agent')), userAgent: req.get?.('User-Agent') || null },
    sessionId: deriveSessionId(req),
    status,
    errorMessage,
  };

  AuditLog.create(doc).catch((err) => {
    logger.error('Failed to record audit log entry', { error: err.message, action, module });
  });
};

module.exports = { record, parseUserAgent, deriveSessionId };
