/**
 * TEST-ONLY helper for fixtures that need a demo account to behave like a
 * normal user.
 *
 * Release blocker #3 makes every seeded demo account (is_demo=1) rotate the
 * published password before it can read or write business data. That gate is
 * intentional and must stay on. Harnesses, however, log in as `demo@` /
 * `rival@` / `tech@` / `hvac@` and then read business records — which the gate
 * is designed to block.
 *
 * Rather than weakening the gate, the fixtures perform the rotation the product
 * demands, exactly as a real demo user would:
 *   1. log in with the account's current password,
 *   2. assert the forced-change gate is active,
 *   3. change the password to a per-run secret,
 *   4. keep using that secret for the rest of the run.
 *
 * Passwords are never logged. The per-run secret is generated in memory only.
 */

/** High-entropy password that satisfies the shared policy. */
function rotatedPassword(tag) {
  return `Rot-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Minimal cookie-keeping client, scoped to this helper. */
function client(baseUrl) {
  let cookie = '';
  return async (method, urlPath, body) => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    return { status: res.status, data };
  };
}

/**
 * Current password for a demo account.
 *
 * Only the auto-generated demonstration password is assumed, because these
 * harnesses run against a freshly seeded throwaway database. An operator can
 * override it with DAYBOOK_DEMO_PASSWORD for a database that was already
 * rotated; the value is read from the environment and never printed.
 */
function currentDemoPassword() {
  return process.env.DAYBOOK_DEMO_PASSWORD || 'demo1234';
}

/**
 * Log in as a demo account and clear the forced-change gate.
 * @param {string} baseUrl e.g. http://127.0.0.1:3301
 * @param {string} email   the demo account
 * @returns {Promise<string>} the new password for that account (never logged)
 */
async function adoptDemoAccount(baseUrl, email, tag = 'fixture') {
  const call = client(baseUrl);
  const currentPassword = currentDemoPassword();
  const password = rotatedPassword(tag);

  const login = await call('POST', '/api/auth/login', { email, password: currentPassword });
  if (login.status !== 200) {
    throw new Error(
      `${email}: could not log in with the configured demo password (status ${login.status}). ` +
      'This harness expects a freshly seeded throwaway database; re-create the instance, ' +
      'or set DAYBOOK_DEMO_PASSWORD to the account\'s current password.'
    );
  }
  if (!login.data?.user?.mustChangePassword) {
    throw new Error(`${email}: expected mustChangePassword=true from the seed; the forced-change gate is not active`);
  }

  const changed = await call('POST', '/api/auth/change-password', {
    currentPassword, newPassword: password,
  });
  if (changed.status !== 200) {
    throw new Error(`${email}: password rotation failed with ${changed.status} ${JSON.stringify(changed.data)}`);
  }

  return password;
}

/** Does this account still accept the configured demo password? */
async function stillAcceptsDemoPassword(baseUrl, email) {
  const call = client(baseUrl);
  const res = await call('POST', '/api/auth/login', { email, password: currentDemoPassword() });
  return res.status === 200;
}

module.exports = { adoptDemoAccount, stillAcceptsDemoPassword, rotatedPassword };
