/**
 * Demo-account isolation (release blockers #2 and #3).
 *
 * Two separate risks, two separate controls:
 *
 *  1. New demo accounts must never be created in production. Seeding is the only
 *     way demo accounts come into existence, and it refuses to run when the
 *     deployment is production.
 *
 *  2. Retained demo accounts (e.g. a staging box) must not keep the published
 *     demo password as a working credential. They are flagged `is_demo`, are
 *     read-only on real business data, and are forced through a password change
 *     before they can be used for anything else.
 */

const { get, run, q } = require('./db');

/** The demo account emails created by the seed scripts. */
const DEMO_EMAILS = [
  'demo@daybook.local',
  'hvac@daybook.local',
  'rival@daybook.local',
  'tech@daybook.local',
  'marcus@daybook.local',
  'priya@daybook.local',
];

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

/**
 * Called by every seed script before it writes anything.
 * Throws when running against a production deployment.
 */
function assertSeedingAllowed(scriptName) {
  if (isProduction() && process.env.DAYBOOK_ALLOW_DEMO_SEED !== 'true') {
    const err = new Error(
      `${scriptName} refused to run: NODE_ENV=production. ` +
        'Demo accounts and demo credentials must never be created in a production deployment. ' +
        'Set DAYBOOK_ALLOW_DEMO_SEED=true only on a throwaway staging instance.'
    );
    err.code = 'DEMO_SEED_BLOCKED';
    throw err;
  }
}

/**
 * Flag a user row as a demo account. Used by seed scripts immediately after
 * creating the user.
 */
function markDemoUser(userId) {
  run(`UPDATE users SET is_demo = 1 WHERE id = ?`, [userId]);
}

/**
 * Retained demo accounts must change the published password before use.
 * Idempotent: safe to call on every boot.
 */
function enforceDemoPasswordRotation() {
  if (isProduction()) {
    // In production, demo accounts have no legitimate use at all.
    const demoUsers = q('SELECT id, email FROM users WHERE is_demo = 1');
    return { production: true, retained: demoUsers, forced: 0 };
  }

  const demoUsers = q('SELECT id, email FROM users WHERE is_demo = 1');
  let forced = 0;
  for (const u of demoUsers) {
    // Only force when the account still verifies with the published demo password.
    const row = get('SELECT password_hash, must_change_password FROM users WHERE id = ?', [u.id]);
    if (!row) continue;
    const { verifyPassword } = require('./auth');
    const stillDemoPassword = verifyPassword('demo1234', row.password_hash);
    if (stillDemoPassword && !row.must_change_password) {
      run('UPDATE users SET must_change_password = 1 WHERE id = ?', [u.id]);
      forced++;
    }
  }
  return { production: false, retained: demoUsers, forced };
}

/**
 * Middleware: block a session that must change its password from touching any
 * business data. The password-change endpoint and auth/me are exempted upstream.
 */
function requirePasswordChanged(req, res, next) {
  if (req.user?.must_change_password) {
    return res.status(403).json({
      error: 'You must change your password before using Daybook. This demo account is still using the published demo password.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
}

/** Password policy, shared with registration so the two cannot drift. */
function validateNewPassword(password) {
  const val = String(password || '');
  if (val.length < 10) return 'Password must be at least 10 characters.';
  if (val.length > 200) return 'Password is too long.';
  const DEMO = new Set([
    'demo1234', 'password', 'password1', 'password123', '12345678', '123456789',
    '1234567890', 'qwerty123', 'letmein1', 'welcome1', 'admin123', 'daybook123',
  ]);
  if (DEMO.has(val.toLowerCase())) {
    return 'That password is a shared demo password and cannot be used. Choose something unique.';
  }
  if (/^\d+$/.test(val)) return 'Password cannot be only numbers.';
  if (/^(.)\1+$/.test(val)) return 'Password cannot be a single repeated character.';
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(val)).length;
  if (classes < 2) {
    return 'Password must mix at least two of: lowercase letters, uppercase letters, numbers, symbols.';
  }
  return null;
}

module.exports = {
  DEMO_EMAILS,
  isProduction,
  assertSeedingAllowed,
  markDemoUser,
  enforceDemoPasswordRotation,
  requirePasswordChanged,
  validateNewPassword,
};
