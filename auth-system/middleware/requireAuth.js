const { verifyToken } = require('../utils/jwt');

function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authenticated' });
  }
  try {
    req.user = verifyToken(token);
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: 'Invalid or expired session' });
  }
}

module.exports = requireAuth;
