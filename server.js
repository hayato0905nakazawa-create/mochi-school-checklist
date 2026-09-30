const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const SESSION_DAYS = 30;
const TZ = 'Asia/Tokyo';

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadDb() {
  const db = readJson(DB_FILE, { users: [], tasks: [], subscriptions: [] });
  db.users ||= [];
  db.tasks ||= [];
  db.subscriptions ||= [];
  return db;
}
function saveDb(db) { writeJsonAtomic(DB_FILE, db); }
if (!fs.existsSync(DB_FILE)) saveDb(loadDb());

function getOrCreateSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (fs.existsSync(SECRET_FILE)) return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
  return secret;
}
const SESSION_SECRET = getOrCreateSecret();

function getOrCreateVapid() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  }
  if (fs.existsSync(VAPID_FILE)) return readJson(VAPID_FILE, null);
  const keys = webpush.generateVAPIDKeys();
  writeJsonAtomic(VAPID_FILE, keys);
  return keys;
}
const vapid = getOrCreateVapid();
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', vapid.publicKey, vapid.privateKey);

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}
function sign(text) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(text).digest('base64url');
}
function makeSession(userId) {
  const exp = Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000;
  const payload = `${userId}.${exp}`;
  return `${b64url(payload)}.${sign(payload)}`;
}
function parseSession(token) {
  try {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const payload = Buffer.from(body, 'base64url').toString('utf8');
    const expected = sign(payload);
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [userId, expRaw] = payload.split('.');
    if (Date.now() > Number(expRaw)) return null;
    return userId;
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[decodeURIComponent(part.slice(0, idx).trim())] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `mochi_session=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=${SESSION_DAYS * 86400}; SameSite=Lax${secure}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'mochi_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(pin, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPin(pin, salt, hash) {
  const candidate = crypto.scryptSync(pin, salt, 64);
  const stored = Buffer.from(hash, 'hex');
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}
function randomId(prefix='') { return prefix + crypto.randomBytes(12).toString('hex'); }
function cleanUsername(value) { return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24); }
function cleanText(value) { return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80); }
function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function validTime(value) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || '')); }

const loginAttempts = new Map();
function allowLogin(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, start: now };
  if (now - rec.start > 10 * 60 * 1000) { rec.count = 0; rec.start = now; }
  rec.count += 1;
  loginAttempts.set(ip, rec);
  return rec.count <= 20;
}
function resetLoginAttempts(ip) { loginAttempts.delete(ip); }

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; frame-ancestors 'none'");
  next();
});

function auth(req, res, next) {
  const token = parseCookies(req).mochi_session;
  const userId = token && parseSession(token);
  if (!userId) return res.status(401).json({ error: 'ログインが必要です' });
  const db = loadDb();
  const user = db.users.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'ログインが必要です' });
  req.user = user;
  next();
}

app.get('/api/status', (req, res) => {
  const db = loadDb();
  res.json({ hasUsers: db.users.length > 0, signupOpen: db.users.length === 0 || process.env.ALLOW_SIGNUP === 'true' });
});

app.post('/api/register', (req, res) => {
  const db = loadDb();
  if (db.users.length > 0 && process.env.ALLOW_SIGNUP !== 'true') return res.status(403).json({ error: '初回設定は完了しています' });
  const username = cleanUsername(req.body.username);
  const pin = String(req.body.pin || '');
  if (username.length < 3) return res.status(400).json({ error: 'IDは3文字以上にしてください' });
  if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ error: 'PINは4〜8桁の数字にしてください' });
  if (db.users.some(u => u.username === username)) return res.status(409).json({ error: 'そのIDは使われています' });
  const hp = hashPin(pin);
  const user = { id: randomId('u_'), username, pinSalt: hp.salt, pinHash: hp.hash, createdAt: new Date().toISOString() };
  db.users.push(user);
  saveDb(db);
  setSessionCookie(res, makeSession(user.id));
  res.json({ ok: true, username: user.username });
});

app.post('/api/login', (req, res) => {
  if (!allowLogin(req.ip)) return res.status(429).json({ error: 'ログイン試行が多すぎます。少ししてから試してください' });
  const username = cleanUsername(req.body.username);
  const pin = String(req.body.pin || '');
  const db = loadDb();
  const user = db.users.find(u => u.username === username);
  if (!user || !verifyPin(pin, user.pinSalt, user.pinHash)) return res.status(401).json({ error: 'IDまたはPINが違います' });
  resetLoginAttempts(req.ip);
  setSessionCookie(res, makeSession(user.id));
  res.json({ ok: true, username: user.username });
});

app.post('/api/logout', (req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => res.json({ username: req.user.username }));

app.get('/api/tasks', auth, (req, res) => {
  const db = loadDb();
  const date = String(req.query.date || '');
  const tasks = db.tasks
    .filter(t => t.userId === req.user.id && (!date || t.date === date))
    .sort((a, b) => (a.date + a.time + a.createdAt).localeCompare(b.date + b.time + b.createdAt));
  res.json({ tasks });
});

app.post('/api/tasks', auth, (req, res) => {
  const text = cleanText(req.body.text);
  const date = String(req.body.date || '');
  const time = String(req.body.time || '07:00');
  if (!text) return res.status(400).json({ error: '持ち物を入力してください' });
  if (!validDate(date)) return res.status(400).json({ error: '日付が正しくありません' });
  if (!validTime(time)) return res.status(400).json({ error: '時刻が正しくありません' });
  const db = loadDb();
  const task = { id: randomId('t_'), userId: req.user.id, text, date, time, done: false, notifiedAt: null, createdAt: new Date().toISOString() };
  db.tasks.push(task);
  saveDb(db);
  res.json({ task });
});

app.patch('/api/tasks/:id', auth, (req, res) => {
  const db = loadDb();
  const task = db.tasks.find(t => t.id === req.params.id && t.userId === req.user.id);
  if (!task) return res.status(404).json({ error: '見つかりません' });
  if (typeof req.body.done === 'boolean') task.done = req.body.done;
  const text = req.body.text === undefined ? null : cleanText(req.body.text);
  if (text !== null) {
    if (!text) return res.status(400).json({ error: '持ち物を入力してください' });
    task.text = text;
  }
  if (req.body.date !== undefined) {
    if (!validDate(req.body.date)) return res.status(400).json({ error: '日付が正しくありません' });
    task.date = req.body.date;
    task.notifiedAt = null;
  }
  if (req.body.time !== undefined) {
    if (!validTime(req.body.time)) return res.status(400).json({ error: '時刻が正しくありません' });
    task.time = req.body.time;
    task.notifiedAt = null;
  }
  saveDb(db);
  res.json({ task });
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const db = loadDb();
  const before = db.tasks.length;
  db.tasks = db.tasks.filter(t => !(t.id === req.params.id && t.userId === req.user.id));
  if (db.tasks.length === before) return res.status(404).json({ error: '見つかりません' });
  saveDb(db);
  res.json({ ok: true });
});

app.get('/api/push/public-key', auth, (req, res) => res.json({ publicKey: vapid.publicKey }));

app.post('/api/push/subscribe', auth, (req, res) => {
  const subscription = req.body.subscription;
  if (!subscription || !subscription.endpoint || !subscription.keys) return res.status(400).json({ error: '通知登録に失敗しました' });
  const db = loadDb();
  db.subscriptions = db.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  db.subscriptions.push({ id: randomId('s_'), userId: req.user.id, endpoint: subscription.endpoint, subscription, createdAt: new Date().toISOString() });
  saveDb(db);
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', auth, (req, res) => {
  const endpoint = String(req.body.endpoint || '');
  const db = loadDb();
  db.subscriptions = db.subscriptions.filter(s => !(s.userId === req.user.id && s.endpoint === endpoint));
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/push/test', auth, async (req, res) => {
  const db = loadDb();
  const userSubs = db.subscriptions.filter(s => s.userId === req.user.id);
  if (!userSubs.length) return res.status(400).json({ error: '通知先がサーバーに登録されていません' });

  const payload = JSON.stringify({
    title: 'Mochi 通知テスト',
    body: '通知テスト成功！',
    taskId: 'test-' + Date.now(),
  });

  let sent = 0;
  let changed = false;
  let lastStatus = null;
  for (const sub of userSubs) {
    try {
      await webpush.sendNotification(sub.subscription, payload);
      sent += 1;
    } catch (err) {
      lastStatus = err.statusCode || null;
      console.error('push test error:', err.statusCode || '', err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.subscriptions = db.subscriptions.filter(s => s.id !== sub.id);
        changed = true;
      }
    }
  }
  if (changed) saveDb(db);
  if (!sent) return res.status(502).json({ error: `通知送信に失敗しました${lastStatus ? ` (${lastStatus})` : ''}` });
  res.json({ ok: true, sent });
});

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function sendDueNotifications() {
  const now = tokyoParts();
  const db = loadDb();
  let changed = false;
  const due = db.tasks.filter(t => !t.done && !t.notifiedAt && t.date === now.date && t.time <= now.time);
  for (const task of due) {
    const userSubs = db.subscriptions.filter(s => s.userId === task.userId);
    const payload = JSON.stringify({ title: '持ち物チェック', body: `${task.text}、持った？`, taskId: task.id, date: task.date });
    let delivered = false;
    for (const sub of userSubs) {
      try {
        await webpush.sendNotification(sub.subscription, payload);
        delivered = true;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          db.subscriptions = db.subscriptions.filter(s => s.id !== sub.id);
          changed = true;
        } else {
          console.error('push error:', err.message);
        }
      }
    }
    if (delivered) {
      task.notifiedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) saveDb(db);
}
setInterval(() => sendDueNotifications().catch(console.error), 30 * 1000).unref();
setTimeout(() => sendDueNotifications().catch(console.error), 3000).unref();

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`Mochimono running on http://localhost:${PORT}`));
