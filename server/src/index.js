require('node:sqlite'); // ensure experimental module loads with warning suppressed in logs
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('node:path');
const fs = require('node:fs');
const { migrate, DB_PATH } = require('./db');
const apiRouter = require('./routes');
const assistantRouter = require('./assistant');
const knowledgeRouter = require('./knowledge');
const onboardingRouter = require('./onboarding');
const demoGuard = require('./demo-guard');

migrate();

// Retained demo accounts must not keep working with the published password.
const demoState = demoGuard.enforceDemoPasswordRotation();
if (demoState.production && demoState.retained.length) {
  console.warn(
    `[daybook] WARNING: ${demoState.retained.length} demo account(s) exist in a PRODUCTION deployment ` +
    `(${demoState.retained.map((u) => u.email).join(', ')}). Delete them before real use.`
  );
} else if (demoState.forced) {
  console.log(`[daybook] forced password change on ${demoState.forced} demo account(s) still using the published demo password`);
}

const app = express();
const PORT = process.env.PORT || 3001;

// Hosting platforms put Daybook behind exactly one proxy hop. Express then
// resolves req.ip from the right-hand side of X-Forwarded-For, so the rate
// limiter sees a real address that a client cannot spoof. Off by default:
// trusting the header without a proxy in front is worse than not trusting it.
if (process.env.TRUST_PROXY) {
  app.set('trust proxy', Number.isNaN(Number(process.env.TRUST_PROXY)) ? process.env.TRUST_PROXY : Number(process.env.TRUST_PROXY));
}

app.use(cors({ origin: true, credentials: true }));
// 1 MB is comfortably more than any real request body this API accepts — the
// largest are a knowledge entry (4,000 chars), a document-metadata payload and a
// CSV import. It used to be 5 MB, which allowed a single request to carry ~436,000
// array elements; every one of those that fails validation becomes an issue object
// held in memory at once. Tightening the ceiling bounds the worst case for any
// validator that accumulates issues, before the request ever reaches a route.
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true, service: 'daybook-api', db: DB_PATH }));

/**
 * Global gate for retained demo accounts that still use the published password.
 * Applies to every /api route except the ones needed to complete the change.
 * A demo session cannot read or write business data until it has rotated.
 */
const PASSWORD_CHANGE_EXEMPT = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/auth/logout',
  '/api/auth/login',
  '/api/auth/register',
]);

app.use('/api', (req, res, next) => {
  if (PASSWORD_CHANGE_EXEMPT.has(req.path) || PASSWORD_CHANGE_EXEMPT.has(`/api${req.path}`)) return next();
  // Resolve the session here only to check the flag; routers authenticate again.
  const { getSessionUser } = require('./auth');
  const user = getSessionUser(req.cookies?.daybook_session);
  if (user?.must_change_password) {
    return res.status(403).json({
      error: 'You must change your password before using Daybook. This demo account is still using the published demo password.',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }
  next();
});

app.use('/api', apiRouter);
app.use('/api/assistant', assistantRouter);
app.use('/api/knowledge', knowledgeRouter);
app.use('/api', onboardingRouter);

// Serve built client in production
const clientDist = path.join(__dirname, '..', '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^(?!\/api|\/health).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

app.use((err, req, res, next) => {
  // A request body the client got wrong is not a server fault. Express body
  // parsers report these with a status and a `type`; using them keeps real
  // outages distinguishable from malformed input in the logs and to the client.
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      error: 'That request was too large. The limit is 1 MB.',
      code: 'PAYLOAD_TOO_LARGE',
    });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: 'That request was not valid JSON.',
      code: 'INVALID_JSON',
    });
  }
  console.error('[api] error:', err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[daybook] API listening on http://0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
