/**
 * CloudShare — server.js
 * All data persisted in PostgreSQL — visible on every login
 * Download count incremented in DB on every download
 */

const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcrypt');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST || 'localhost',
  port:     parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'cloudshare',
  user:     process.env.DB_USER || 'postgres',
  password: process.env.DB_PASS || 'admin123',   // ← YOUR PG PASSWORD HERE
});

pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Database connection failed:', err.message);
    console.log('   → Update the password field in server.js line ~22');
  } else {
    release();
    console.log('✅ Connected to PostgreSQL.');
  }
});

// ─── Multer ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, uuidv4() + path.extname(file.originalname));
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'cloudshare_secret_2024',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

function requireAuth(req, res, next) {
  if (!req.session.userId)
    return res.status(401).json({ error: 'Unauthorized. Please log in.' });
  next();
}

// ─── Auto-delete expired files every 60s ─────────────────────────────────────
// Physical files are removed from disk but DB rows are KEPT so expired count
// remains accurate across sessions. file_path is cleared to '' after disk delete.
setInterval(async () => {
  try {
    // Only clean disk for files expired more than 5 minutes ago
    const { rows } = await pool.query(
      `SELECT id, file_path FROM files WHERE expiry < NOW() - INTERVAL '5 minutes' AND file_path != ''`
    );
    for (const f of rows) {
      if (f.file_path && fs.existsSync(f.file_path)) {
        try { fs.unlinkSync(f.file_path); } catch (_) {}
      }
      // Clear path in DB — keep row for stats/history
      await pool.query(`UPDATE files SET file_path = '' WHERE id = $1`, [f.id]);
    }
    if (rows.length > 0)
      console.log(`🗑  Cleaned ${rows.length} expired file(s) from disk (DB rows kept).`);
  } catch (err) { console.error('Auto-delete error:', err.message); }
}, 60000);

// ═══════════════════════════════════════════════════════════
//  AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  if (password.length < 6)  return res.status(400).json({ error: 'Password must be 6+ characters.' });
  try {
    const ex = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (ex.rows.length) return res.status(409).json({ error: 'Email already registered.' });
    const hashed = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email,password) VALUES ($1,$2) RETURNING id,email', [email, hashed]);
    req.session.userId = rows[0].id;
    req.session.email  = rows[0].email;
    res.json({ success: true, email: rows[0].email });
  } catch (err) { console.error('Signup:', err.message); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows.length) return res.status(401).json({ error: 'Invalid email or password.' });
    if (!await bcrypt.compare(password, rows[0].password))
      return res.status(401).json({ error: 'Invalid email or password.' });
    req.session.userId = rows[0].id;
    req.session.email  = rows[0].email;
    res.json({ success: true, email: rows[0].email });
  } catch (err) { console.error('Login:', err.message); res.status(500).json({ error: 'Server error.' }); }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'Not logged in.' });
  res.json({ userId: req.session.userId, email: req.session.email });
});

// ═══════════════════════════════════════════════════════════
//  FILE ROUTES — all data stored & fetched from PostgreSQL
// ═══════════════════════════════════════════════════════════

// Upload — saves to DB with user_id so it persists across logins
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  const minutes = Math.max(1, parseInt(req.body.expiry_minutes) || 60);
  const limit   = Math.max(1, parseInt(req.body.download_limit) || 100);
  const expiry  = new Date(Date.now() + minutes * 60000);
  const hpw     = req.body.password ? await bcrypt.hash(req.body.password, 10) : null;
  try {
    const { rows } = await pool.query(
      `INSERT INTO files (original_name,file_path,file_size,mime_type,expiry,password,download_limit,download_count,user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) RETURNING id`,
      [req.file.originalname, req.file.path, req.file.size, req.file.mimetype,
       expiry, hpw, limit, req.session.userId]
    );
    const id   = rows[0].id;
    const link = `${req.protocol}://${req.get('host')}/download/${id}`;
    res.json({ success: true, fileId: id, downloadLink: link, originalName: req.file.originalname, expiry });
  } catch (err) {
    console.error('Upload error:', err.message);
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: 'Failed to save file.' });
  }
});

// Get all files for this user — loads from DB every time so data persists
app.get('/api/files', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, original_name, file_size, mime_type, expiry,
              download_count, download_limit, created_at,
              (password IS NOT NULL) AS password_protected
       FROM files WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error('Files fetch:', err.message);
    res.status(500).json({ error: 'Failed to fetch files.' });
  }
});

// Delete
app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT file_path,user_id FROM files WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'File not found.' });
    if (rows[0].user_id !== req.session.userId) return res.status(403).json({ error: 'Access denied.' });
    if (fs.existsSync(rows[0].file_path)) fs.unlinkSync(rows[0].file_path);
    await pool.query('DELETE FROM files WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete:', err.message);
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

// Stats — expired count is computed from DB rows (rows kept even after disk cleanup)
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         COUNT(*)                                      AS total_uploaded,
         COUNT(*) FILTER (WHERE expiry > NOW())        AS active,
         COUNT(*) FILTER (WHERE expiry <= NOW())       AS expired,
         COALESCE(SUM(download_count), 0)              AS total_downloads
       FROM files WHERE user_id = $1`,
      [req.session.userId]
    );
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: 'Failed to fetch stats.' }); }
});

// File info — metadata only, no count increment (used by Download via Link preview)
app.get('/api/file-info/:id', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, original_name, file_size, mime_type, expiry,
              download_count, download_limit,
              (password IS NOT NULL) AS password_protected
       FROM files WHERE id=$1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'File not found or link is invalid.' });
    const f   = rows[0];
    const exp = new Date() > new Date(f.expiry);
    const lim = f.download_count >= f.download_limit;
    res.json({ ...f, is_expired: exp, is_limited: lim, available: !exp && !lim });
  } catch (err) {
    console.error('File-info:', err.message);
    res.status(500).json({ error: 'Server error.' });
  }
});

// ═══════════════════════════════════════════════════════════
//  DOWNLOAD — public route, increments count in DB every time
// ═══════════════════════════════════════════════════════════
app.get('/download/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM files WHERE id=$1', [req.params.id]);
    if (!rows.length)
      return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));

    const file = rows[0];

    if (new Date() > new Date(file.expiry)) {
      if (fs.existsSync(file.file_path)) fs.unlinkSync(file.file_path);
      await pool.query('DELETE FROM files WHERE id=$1', [file.id]);
      return res.status(410).send(errPage('⏰ Link Expired', 'This file has expired and is no longer available.'));
    }

    if (file.download_count >= file.download_limit)
      return res.status(403).send(errPage('🚫 Limit Reached', 'This file has reached its maximum download count.'));

    if (file.password) {
      const provided = req.query.password || req.headers['x-file-password'];
      if (!provided) return res.send(pwPage(req.params.id, file.original_name));
      if (!await bcrypt.compare(provided, file.password))
        return res.send(pwPage(req.params.id, file.original_name, true));
    }

    if (!file.file_path || !fs.existsSync(file.file_path)) {
      return res.status(410).send(errPage('📁 File Unavailable',
        'This file has been cleaned from the server. The link is no longer downloadable.'));
    }

    // Increment download_count in DB — reflected immediately on dashboard
    await pool.query('UPDATE files SET download_count = download_count + 1 WHERE id=$1', [file.id]);

    res.download(file.file_path, file.original_name);
  } catch (err) {
    console.error('Download error:', err.message);
    res.status(500).send(errPage('⚠️ Server Error', 'Something went wrong. Please try again.'));
  }
});

// ─── HTML page helpers ────────────────────────────────────────────────────────
function errPage(title, msg) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}.card{background:rgba(255,255,255,.07);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:3rem;text-align:center;max-width:440px;width:90%}h1{font-size:2.2rem;margin-bottom:1rem}p{color:rgba(255,255,255,.7);font-size:1.1rem;line-height:1.6;margin-bottom:2rem}a{display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;text-decoration:none;padding:.75rem 2rem;border-radius:50px;font-weight:600}</style></head><body><div class="card"><h1>${title}</h1><p>${msg}</p><a href="/">← Go Home</a></div></body></html>`;
}
function pwPage(id, name, wrong = false) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Password Required</title><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Segoe UI',sans-serif;background:linear-gradient(135deg,#0f0c29,#302b63,#24243e);min-height:100vh;display:flex;align-items:center;justify-content:center;color:#fff}.card{background:rgba(255,255,255,.07);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.15);border-radius:24px;padding:3rem;text-align:center;max-width:440px;width:90%}.ic{font-size:3rem;margin-bottom:1rem}h1{font-size:1.6rem;margin-bottom:.5rem}p{color:rgba(255,255,255,.6);margin-bottom:1.5rem;font-size:.95rem}.fn{background:rgba(255,255,255,.1);padding:.5rem 1rem;border-radius:8px;font-size:.9rem;margin-bottom:1.5rem;word-break:break-all}input{width:100%;background:rgba(255,255,255,.1);border:1px solid rgba(255,255,255,.2);border-radius:12px;padding:.85rem 1.2rem;color:#fff;font-size:1rem;outline:none;margin-bottom:1rem}button{width:100%;background:linear-gradient(135deg,#667eea,#764ba2);border:none;color:#fff;padding:.9rem;border-radius:12px;font-size:1rem;font-weight:600;cursor:pointer}.er{color:#ff6b6b;font-size:.9rem;margin-bottom:1rem}</style></head><body><div class="card"><div class="ic">🔐</div><h1>Password Required</h1><p>This file is password protected</p><div class="fn">📄 ${name}</div>${wrong?'<p class="er">❌ Incorrect password.</p>':''}<form method="GET" action="/download/${id}"><input type="password" name="password" placeholder="Enter file password" required autofocus><button>🔓 Unlock & Download</button></form></div></body></html>`;
}

app.listen(PORT, () => {
  console.log(`\n🚀 CloudShare → http://localhost:${PORT}`);
  console.log(`📁 Uploads  → ${path.join(__dirname, 'uploads')}`);
  console.log('─'.repeat(48));
});