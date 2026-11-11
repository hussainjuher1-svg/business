/**
 * Login rate limiting (release blocker #1).
 *
 * Two independent buckets, because they stop different attacks:
 *   - per email: credential stuffing against one account
 *   - per IP:    spraying many accounts from one source
 *
 * Attempts are persisted in SQLite, so a restart does not clear an attacker's
 * progress. Successful logins clear the email bucket for that account.
 */

const { q, run, get } = require('./db');

const WINDOW_MINUTES = Number(process.env.LOGIN_WINDOW_MINUTES || 15);
const MAX_ATTEMPTS_PER_EMAIL = Number(process.env.LOGIN_MAX_PER_EMAIL || 5);
const MAX_ATTEMPTS_PER_IP = Number(process.env.LOGIN_MAX_PER_IP || 20);
const LOCKOUT_MINUTES = Number(process.env.LOGIN_LOCKOUT_MINUTES || 15);
const RETENTION_DAYS = 30;

/**
 * Resolve the address to throttle.
 *
 * X-Forwarded-For is attacker-controlled unless a trusted proxy rewrote it, so
 * reading the header directly would let anyone bypass the per-IP limit by
 * sending a random value per request. The header is only honoured when
 * TRUST_PROXY is explicitly configured, in which case Express (app.set('trust
 * proxy')) has already resolved req.ip to the real client address.
 */
function clientIp(req) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1) so one client is one bucket.
  return String(ip).replace(/^::ffff:/, '').slice(0, 60);
}

function pruneOldAttempts() {
  try {
    run(`DELETE FROM login_attempts WHERE datetime(created_at) < datetime('now', ?)`, [`-${RETENTION_DAYS} days`]);
  } catch {
    /* non-fatal housekeeping */
  }
}

/**
 * How long *this* address is locked out. Deliberately narrower than the
 * window: the per-IP budget is a backstop against one source spraying many
 * accounts, so it is held while that source is still failing — and released
 * after a quiet spell — rather than freezing a shared office IP for 15 minutes
 * because one person fat-fingered their password a few times.
 */
const IP_LOCKOUT_MINUTES = Number(process.env.LOGIN_IP_LOCKOUT_MINUTES || 1);

/** Count failures in the current window for a given bucket. */
function failures({ email, ip, sinceMinutes }) {
  if (email) {
    return get(
      `SELECT COUNT(*) AS n FROM login_attempts
       WHERE succeeded = 0 AND email = ? AND datetime(created_at) >= datetime('now', ?)`,
      [email, `-${sinceMinutes} minutes`]
    )?.n || 0;
  }
  return get(
    `SELECT COUNT(*) AS n FROM login_attempts
     WHERE succeeded = 0 AND ip = ? AND datetime(created_at) >= datetime('now', ?)`,
    [ip, `-${sinceMinutes} minutes`]
  )?.n || 0;
}

/** When the oldest failure in the window occurred, for a reset-time hint. */
function oldestFailureAgeMinutes(bucket) {
  const row = bucket.email
    ? get(
        `SELECT MIN(created_at) AS t FROM login_attempts
         WHERE succeeded = 0 AND email = ? AND datetime(created_at) >= datetime('now', ?)`,
        [bucket.email, `-${WINDOW_MINUTES} minutes`]
      )
    : get(
        `SELECT MIN(created_at) AS t FROM login_attempts
         WHERE succeeded = 0 AND ip = ? AND datetime(created_at) >= datetime('now', ?)`,
        [bucket.ip, `-${WINDOW_MINUTES} minutes`]
      );
  if (!row?.t) return 0;
  const then = new Date(`${String(row.t).replace(' ', 'T')}Z`).getTime();
  return Math.max(0, Math.round((Date.now() - then) / 60000));
}

function minutesSinceLastFailure(bucket) {
  const row = bucket.email
    ? get(
        `SELECT MAX(created_at) AS t FROM login_attempts WHERE succeeded = 0 AND email = ?`,
        [bucket.email]
      )
    : get(
        `SELECT MAX(created_at) AS t FROM login_attempts WHERE succeeded = 0 AND ip = ?`,
        [bucket.ip]
      );
  if (!row?.t) return Number.MAX_SAFE_INTEGER;
  const then = new Date(`${String(row.t).replace(' ', 'T')}Z`).getTime();
  return Math.max(0, (Date.now() - then) / 60000);
}

/**
 * Check whether a login should be refused before verification is attempted.
 * @returns {{blocked: boolean, retryAfterSeconds?: number, message?: string, scope?: string}}
 */
function check(req, email) {
  const ip = clientIp(req);
  const normalized = String(email || '').toLowerCase();

  const emailFails = failures({ email: normalized, sinceMinutes: WINDOW_MINUTES });
  if (emailFails >= MAX_ATTEMPTS_PER_EMAIL) {
    const age = oldestFailureAgeMinutes({ email: normalized });
    const remaining = Math.max(1, LOCKOUT_MINUTES - age);
    return {
      blocked: true,
      scope: 'email',
      retryAfterSeconds: remaining * 60,
      message:
        `Too many failed sign-in attempts for this account. ` +
        `Try again in about ${remaining} minute${remaining === 1 ? '' : 's'}.`,
    };
  }

  const ipFails = failures({ ip, sinceMinutes: WINDOW_MINUTES });
  const sinceLastIpFailure = minutesSinceLastFailure({ ip });
  if (ipFails >= MAX_ATTEMPTS_PER_IP && sinceLastIpFailure < IP_LOCKOUT_MINUTES) {
    const remaining = Math.max(1, IP_LOCKOUT_MINUTES - sinceLastIpFailure);
    return {
      blocked: true,
      scope: 'ip',
      retryAfterSeconds: remaining * 60,
      message:
        `Too many failed sign-in attempts from this network. ` +
        `Try again in about ${remaining} minute${remaining === 1 ? '' : 's'}.`,
    };
  }

  return { blocked: false };
}

function recordFailure(req, email) {
  run('INSERT INTO login_attempts (email, ip, succeeded) VALUES (?,?,0)', [
    String(email || '').toLowerCase(),
    clientIp(req),
  ]);
  pruneOldAttempts();
}

function recordSuccess(req, email) {
  const normalized = String(email || '').toLowerCase();
  run('INSERT INTO login_attempts (email, ip, succeeded) VALUES (?,?,1)', [normalized, clientIp(req)]);
  // A successful login resets that account's failure streak.
  run('DELETE FROM login_attempts WHERE email = ? AND succeeded = 0', [normalized]);
  pruneOldAttempts();
}

/** Applied to the login route as middleware (cheap 429 before any hashing). */
function loginRateLimit(req, res, next) {
  const email = req.body?.email;
  if (!email) return next();
  const verdict = check(req, email);
  if (verdict.blocked) {
    res.set('Retry-After', String(verdict.retryAfterSeconds));
    return res.status(429).json({
      error: verdict.message,
      retryAfterSeconds: verdict.retryAfterSeconds,
      scope: verdict.scope,
    });
  }
  next();
}

module.exports = {
  loginRateLimit,
  check,
  recordFailure,
  recordSuccess,
  clientIp,
  limits: { WINDOW_MINUTES, MAX_ATTEMPTS_PER_EMAIL, MAX_ATTEMPTS_PER_IP, LOCKOUT_MINUTES, IP_LOCKOUT_MINUTES },
};
