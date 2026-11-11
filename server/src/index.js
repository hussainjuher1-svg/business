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

migrate();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

app.get('/health', (req, res) => res.json({ ok: true, service: 'daybook-api', db: DB_PATH }));
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
  console.error('[api] error:', err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[daybook] API listening on http://0.0.0.0:${PORT} (db: ${DB_PATH})`);
});
