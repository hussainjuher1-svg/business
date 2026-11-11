const crypto = require('node:crypto');
const { get, run, q } = require('./db');

const COOKIE = 'daybook_session';
const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(candidate));
  } catch {
    return false;
  }
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  run('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?,?,?)', [userId, tokenHash(token), expires]);
  return token;
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', [tokenHash(token)]);
}

/** Revoke every session for a user — used after a password change. */
function destroyAllSessions(userId) {
  run('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

function getSessionUser(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.email, u.name, u.created_at, u.is_demo, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
    [tokenHash(token)]
  );
  if (!row) return null;
  return {
    ...row,
    is_demo: !!row.is_demo,
    must_change_password: !!row.must_change_password,
  };
}

function getMemberships(userId) {
  return q(
    `SELECT m.business_id, m.role, b.name AS business_name, b.timezone, b.currency
     FROM business_memberships m JOIN businesses b ON b.id = m.business_id
     WHERE m.user_id = ? ORDER BY m.created_at`,
    [userId]
  );
}

function getMembership(userId, businessId) {
  return get(
    'SELECT * FROM business_memberships WHERE user_id = ? AND business_id = ?',
    [userId, businessId]
  );
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  const user = getSessionUser(token);
  if (!user) return res.status(401).json({ error: 'Not authenticated. Please log in.' });
  req.user = user;
  req.sessionToken = token;
  next();
}

// Resolve business from query/body/header; enforce membership.
function resolveBusiness(req, res, next) {
  const raw =
    req.query.businessId || req.body?.businessId || req.headers['x-business-id'];
  let businessId = raw ? Number(raw) : null;
  if (!businessId || Number.isNaN(businessId)) {
    const memberships = getMemberships(req.user.id);
    if (memberships.length === 1) businessId = memberships[0].business_id;
    else if (memberships.length > 1) {
      return res.status(400).json({ error: 'Please select a business (businessId required).', businesses: memberships });
    } else {
      return res.status(403).json({ error: 'You do not belong to any business yet.' });
    }
  }
  const membership = getMembership(req.user.id, businessId);
  if (!membership) return res.status(403).json({ error: 'You do not have access to this business.' });
  req.businessId = businessId;
  req.role = membership.role;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.role)) {
      return res.status(403).json({ error: `Requires role: ${roles.join(' or ')}.` });
    }
    next();
  };
}

function setSessionCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, createSession, destroySession, destroyAllSessions,
  getSessionUser, getMemberships, getMembership, requireAuth, resolveBusiness,
  requireRole, setSessionCookie, clearSessionCookie,
};
