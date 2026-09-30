const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self' https://sjgijtwakgsehlmwbxks.supabase.co; " +
    "manifest-src 'self'; worker-src 'self'; base-uri 'self'; frame-ancestors 'none'"
  );
  next();
});
app.get('/api/status', (req, res) => {
  res.json({ ok: true, backend: 'supabase' });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('*', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Mochi frontend running on http://localhost:${PORT}`);
});
