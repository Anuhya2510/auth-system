require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const authRoutes = require('./routes/auth');
const requireAuth = require('./middleware/requireAuth');
const User = require('./models/User');

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.redirect('/login.html');
});

// API routes
app.use('/api/auth', authRoutes);

// Example protected endpoint — proves the session cookie works.
app.get('/api/me', requireAuth, (req, res) => {
  const user = User.findById(req.user.userId);
  if (!user) return res.status(404).json({ success: false, message: 'User not found' });
  res.json({ success: true, user });
});

// Static frontend (signup, login, forgot/reset password pages)
app.use(express.static(path.join(__dirname, 'public')));

// Centralized error handler — never leak internals to the client.
app.use((err, req, res, next) => {
  console.error(err); // server-side log only
  res.status(500).json({ success: false, message: 'Something went wrong. Please try again.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Auth server running on http://localhost:${PORT}`);
});
