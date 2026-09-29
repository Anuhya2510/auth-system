require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');
const User = require('./models/User');
const { initDb } = require('./config/db');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
if (process.env.VERCEL) app.set('trust proxy', 1);

const allowedOrigins = new Set([
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://rohith-solutions.onrender.com',
]);

if (process.env.APP_BASE_URL) {
  allowedOrigins.add(process.env.APP_BASE_URL);
}
if (process.env.RENDER_EXTERNAL_URL) {
  allowedOrigins.add(process.env.RENDER_EXTERNAL_URL);
}

app.use((req, res, next) => {
  const origin = req.get('Origin');
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', async (req, res, next) => {
  try {
    await initDb();
    res.json({ status: 'ok' });
  } catch (err) {
    next(err);
  }
});

if (!process.env.VERCEL) {
  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

// API routes
app.use('/api', async (req, res, next) => {
  try {
    await initDb();
    next();
  } catch (err) {
    next(err);
  }
});
app.use('/api/auth', authRoutes);

// Example protected endpoint — proves the session cookie works.
app.get('/api/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
});

// Static frontend (signup, login, forgot/reset password pages)
app.use(express.static(path.join(__dirname, 'public')));

// Centralized error handler — never leak internals to the client.
app.use((err, req, res, next) => {
  console.error(err); // server-side log only
  res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Auth server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
