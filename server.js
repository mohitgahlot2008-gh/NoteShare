'use strict';

/* =====================================================================
   NoteShare backend
   Express + SQLite + local file storage.

   Features: signup/login (httpOnly cookie + JWT), upload notes (with file
   type checks), list, download, vote, save, report, delete.

   Moving to the cloud later:
   - SQLite       -> managed PostgreSQL (change the db.* calls)
   - ./uploads    -> object storage (S3 / Cloud Storage) with signed URLs
   ===================================================================== */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { DatabaseSync } = require('node:sqlite');   // built into Node.js 22.13+, so nothing to compile

/* ---------- Configuration (environment variables) ---------- */
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '').trim().toLowerCase();
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 10;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PROD) {
    console.error('JWT_SECRET must be set when NODE_ENV=production.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[warn] JWT_SECRET not set. Using a temporary secret: everyone is logged out when the server restarts.');
}

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SUBJECTS = [
  'Mathematics', 'Physics', 'Data Structures', 'Algorithms',
  'Operating Systems', 'DBMS', 'Computer Networks',
  'Cloud Computing', 'Machine Learning', 'Other'
];

// Allowed upload types. "magic" = the first bytes a genuine file of this type starts with.
const FILE_TYPES = {
  'application/pdf': { label: 'PDF', ext: '.pdf', magic: [0x25, 0x50, 0x44, 0x46] },
  'image/png': { label: 'PNG', ext: '.png', magic: [0x89, 0x50, 0x4e, 0x47] },
  'image/jpeg': { label: 'JPG', ext: '.jpg', magic: [0xff, 0xd8, 0xff] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    label: 'DOCX', ext: '.docx', magic: [0x50, 0x4b, 0x03, 0x04]
  }
};

/* ---------- Database ---------- */
const db = new DatabaseSync(path.join(DATA_DIR, 'noteshare.db'));
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notes (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    subject     TEXT NOT NULL,
    semester    INTEGER NOT NULL,
    tags        TEXT NOT NULL DEFAULT '[]',
    stored_name TEXT NOT NULL,
    file_name   TEXT NOT NULL,
    file_type   TEXT NOT NULL,
    file_mime   TEXT NOT NULL,
    file_size   INTEGER NOT NULL,
    downloads   INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_notes_created ON notes(created_at);
  CREATE INDEX IF NOT EXISTS idx_notes_subject ON notes(subject, semester);

  CREATE TABLE IF NOT EXISTS votes (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, note_id)
  );

  CREATE TABLE IF NOT EXISTS bookmarks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, note_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason     TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (note_id, user_id)
  );
`);

/* ---------- Helpers ---------- */
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function removeFile(file) {
  if (file && file.path) fs.unlink(file.path, () => {});
}

function matchesMagic(filePath, magic) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(magic.length);
    fs.readSync(fd, buf, 0, magic.length, 0);
    return magic.every((byte, i) => buf[i] === byte);
  } finally {
    fs.closeSync(fd);
  }
}

function setSessionCookie(res, user) {
  const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('token', token, {
    httpOnly: true,               // JavaScript in the page cannot read it
    sameSite: 'lax',              // blocks cross-site form posts
    secure: IS_PROD,              // HTTPS only in production
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A fixed hash used to keep login timing similar when the email does not exist.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

/* ---------- App setup ---------- */
const app = express();
if (IS_PROD) app.set('trust proxy', 1);   // needed behind a load balancer / reverse proxy

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'upgrade-insecure-requests': null   // lets http://localhost work during development
    }
  }
}));
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());

// Read the login cookie on every request (if present)
app.use((req, res, next) => {
  req.user = null;
  const token = req.cookies && req.cookies.token;
  if (token) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* expired or invalid: treat as logged out */ }
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in first.'));
  next();
}

const limiterOptions = { standardHeaders: true, legacyHeaders: false };
const apiLimiter = rateLimit({ ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 600 });
const authLimiter = rateLimit({
  ...limiterOptions, windowMs: 15 * 60 * 1000, limit: 30,
  message: { error: 'Too many attempts. Please try again in a few minutes.' }
});
const uploadLimiter = rateLimit({
  ...limiterOptions, windowMs: 60 * 60 * 1000, limit: 30,
  message: { error: 'Upload limit reached. Please try again later.' }
});
app.use('/api', apiLimiter);

/* ---------- Auth routes ---------- */
app.post('/api/auth/signup', authLimiter, asyncHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Please enter your name (2-60 characters).');
  if (!EMAIL_RE.test(email) || email.length > 120) throw new HttpError(400, 'Please enter a valid email.');
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith('@' + ALLOWED_EMAIL_DOMAIN)) {
    throw new HttpError(400, `Use your college email (@${ALLOWED_EMAIL_DOMAIN}).`);
  }
  if (password.length < 8 || password.length > 72) throw new HttpError(400, 'Password must be 8-72 characters.');

  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const user = {
    id: crypto.randomUUID(), name, email,
    password_hash: await bcrypt.hash(password, 10),
    created_at: new Date().toISOString()
  };
  db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (@id, @name, @email, @password_hash, @created_at)').run(user);

  setSessionCookie(res, user);
  res.status(201).json({ user: publicUser(user) });
}));

app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new HttpError(401, 'Wrong email or password.');

  setSessionCookie(res, user);
  res.json({ user: publicUser(user) });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email } : null });
});

/* ---------- Notes routes ---------- */
const LIST_SQL = `
  SELECT n.*, u.name AS author_name,
    (SELECT COUNT(*) FROM votes v WHERE v.note_id = n.id) AS vote_count,
    (SELECT COUNT(*) FROM reports r WHERE r.note_id = n.id) AS report_count,
    EXISTS(SELECT 1 FROM votes v WHERE v.note_id = n.id AND v.user_id = @uid) AS voted,
    EXISTS(SELECT 1 FROM bookmarks b WHERE b.note_id = n.id AND b.user_id = @uid) AS saved
  FROM notes n
  JOIN users u ON u.id = n.user_id
  WHERE n.id = COALESCE(@id, n.id)
    AND ((SELECT COUNT(*) FROM reports r WHERE r.note_id = n.id) < 3 OR n.user_id = @uid)
  ORDER BY n.created_at DESC
  LIMIT 500
`;

function toNote(row) {
  let tags = [];
  try { tags = JSON.parse(row.tags); } catch { /* ignore */ }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    subject: row.subject,
    semester: row.semester,
    tags,
    fileName: row.file_name,
    fileType: row.file_type,
    fileSize: row.file_size,
    authorId: row.user_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    downloads: row.downloads,
    voteCount: row.vote_count,
    voted: !!row.voted,
    saved: !!row.saved,
    reportCount: row.report_count
  };
}

app.get('/api/notes', (req, res) => {
  const rows = db.prepare(LIST_SQL).all({ uid: req.user ? req.user.id : '', id: null });
  res.json({ notes: rows.map(toNote) });
});

// File upload settings
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const type = FILE_TYPES[file.mimetype];
      cb(null, crypto.randomUUID() + (type ? type.ext : '.bin'));   // never use the user's filename on disk
    }
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    if (!FILE_TYPES[file.mimetype]) return cb(new HttpError(400, 'Only PDF, PNG, JPG and DOCX files are allowed.'));
    cb(null, true);
  }
});

app.post('/api/notes', requireAuth, uploadLimiter, upload.single('file'), asyncHandler(async (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new HttpError(400, 'Please choose a file to upload.');

    const type = FILE_TYPES[file.mimetype];
    if (!matchesMagic(file.path, type.magic)) {
      throw new HttpError(400, 'The file content does not match its type.');
    }

    const title = String(req.body.title || '').trim();
    const description = String(req.body.description || '').trim();
    const subject = String(req.body.subject || '');
    const semester = Number(req.body.semester);
    const tags = String(req.body.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 30))
      .filter(Boolean)
      .slice(0, 6);

    if (title.length < 3 || title.length > 100) throw new HttpError(400, 'Title must be 3-100 characters.');
    if (description.length > 300) throw new HttpError(400, 'Description must be 300 characters or fewer.');
    if (!SUBJECTS.includes(subject)) throw new HttpError(400, 'Please choose a valid subject.');
    if (!Number.isInteger(semester) || semester < 1 || semester > 8) throw new HttpError(400, 'Please choose a valid semester.');

    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO notes (id, user_id, title, description, subject, semester, tags,
                         stored_name, file_name, file_type, file_mime, file_size, created_at)
      VALUES (@id, @user_id, @title, @description, @subject, @semester, @tags,
              @stored_name, @file_name, @file_type, @file_mime, @file_size, @created_at)
    `).run({
      id, user_id: req.user.id, title, description, subject, semester,
      tags: JSON.stringify(tags),
      stored_name: file.filename,
      file_name: path.basename(file.originalname).slice(0, 120),
      file_type: type.label,
      file_mime: file.mimetype,
      file_size: file.size,
      created_at: new Date().toISOString()
    });

    const row = db.prepare(LIST_SQL).get({ uid: req.user.id, id });
    res.status(201).json({ note: toNote(row) });
  } catch (err) {
    removeFile(file);     // do not keep files for rejected uploads
    throw err;
  }
}));

// Preview (inline) or download (?download=1). Login required.
app.get('/api/notes/:id/file', requireAuth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) throw new HttpError(404, 'Note not found.');
  const filePath = path.join(UPLOAD_DIR, note.stored_name);
  if (!fs.existsSync(filePath)) throw new HttpError(404, 'File is missing.');

  if (req.query.download === '1') {
    db.prepare('UPDATE notes SET downloads = downloads + 1 WHERE id = ?').run(note.id);
    return res.download(filePath, note.file_name);
  }
  res.type(note.file_mime);
  res.sendFile(filePath);
});

app.delete('/api/notes/:id', requireAuth, (req, res) => {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id);
  if (!note) throw new HttpError(404, 'Note not found.');
  if (note.user_id !== req.user.id) throw new HttpError(403, 'You can only delete your own notes.');
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  fs.unlink(path.join(UPLOAD_DIR, note.stored_name), () => {});
  res.json({ ok: true });
});

function requireNote(id) {
  if (!db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw new HttpError(404, 'Note not found.');
}

function toggle(table) {
  return (req, res) => {
    requireNote(req.params.id);
    const removed = db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND note_id = ?`).run(req.user.id, req.params.id);
    if (removed.changes === 0) {
      db.prepare(`INSERT INTO ${table} (user_id, note_id) VALUES (?, ?)`).run(req.user.id, req.params.id);
    }
    res.json({ active: removed.changes === 0 });
  };
}

app.post('/api/notes/:id/vote', requireAuth, toggle('votes'));
app.post('/api/notes/:id/bookmark', requireAuth, toggle('bookmarks'));

app.post('/api/notes/:id/report', requireAuth, (req, res) => {
  requireNote(req.params.id);
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200);
  if (!reason) throw new HttpError(400, 'Please give a reason.');
  db.prepare('INSERT OR IGNORE INTO reports (note_id, user_id, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(req.params.id, req.user.id, reason, new Date().toISOString());
  res.json({ ok: true });
});

/* ---------- Static front end + errors ---------- */
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(express.static(path.join(__dirname, 'public')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? `File is too large. Maximum is ${MAX_FILE_MB} MB.` : 'Upload failed.';
    return res.status(400).json({ error: message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

app.listen(PORT, () => {
  console.log(`NoteShare running at http://localhost:${PORT}`);
});
