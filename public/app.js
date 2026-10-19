'use strict';

/* =====================================================================
   NoteShare front end (talks to the Express backend in server.js)
   - All server calls live in the `api` object below.
   - Login uses an httpOnly cookie set by the server, so this file never
     sees the password after sending it and never stores a token.
   ===================================================================== */

const CONFIG = {
  MAX_FILE_MB: 10,               // keep in sync with MAX_FILE_MB on the server
  ALLOWED_TYPES: {
    'application/pdf': 'PDF',
    'image/png': 'PNG',
    'image/jpeg': 'JPG',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX'
  }
};

const SUBJECTS = [
  'Mathematics', 'Physics', 'Data Structures', 'Algorithms',
  'Operating Systems', 'DBMS', 'Computer Networks',
  'Cloud Computing', 'Machine Learning', 'Other'
];
const SEMESTERS = [1, 2, 3, 4, 5, 6, 7, 8];

/* ---------- Small helpers ---------- */
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child != null) node.append(child);   // strings become text nodes (safe from XSS)
  }
  return node;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

let toastTimer;
function toast(message) {
  const box = $('toast');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 2800);
}

/* ---------- API layer (all network calls) ---------- */
async function request(path, options = {}) {
  let res;
  try {
    res = await fetch('/api' + path, { credentials: 'same-origin', ...options });
  } catch {
    const err = new Error('Cannot reach the server. Is it running?');
    err.status = 0;
    throw err;
  }
  let data = null;
  try { data = await res.json(); } catch { /* no JSON body */ }
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const jsonBody = (method, body) => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const api = {
  async currentUser() { return (await request('/auth/me')).user; },
  async signup(data) { return (await request('/auth/signup', jsonBody('POST', data))).user; },
  async login(data) { return (await request('/auth/login', jsonBody('POST', data))).user; },
  async logout() { await request('/auth/logout', { method: 'POST' }); },

  async listNotes() { return (await request('/notes')).notes; },
  async createNote(formData) { return (await request('/notes', { method: 'POST', body: formData })).note; },
  async deleteNote(id) { await request(`/notes/${id}`, { method: 'DELETE' }); },
  async toggleVote(id) { await request(`/notes/${id}/vote`, { method: 'POST' }); },
  async toggleBookmark(id) { await request(`/notes/${id}/bookmark`, { method: 'POST' }); },
  async reportNote(id, reason) { await request(`/notes/${id}/report`, jsonBody('POST', { reason })); },

  fileUrl(id, download = false) { return `/api/notes/${id}/file` + (download ? '?download=1' : ''); }
};

/* ---------- Application state ---------- */
const state = {
  user: null,
  notes: [],
  filters: { q: '', subject: '', semester: '', sort: 'newest', tab: 'all' },
  authMode: 'login',
  viewing: null
};

/* Runs an action and shows a friendly message if it fails.
   If the session has expired (401) it asks the user to log in again. */
async function run(action) {
  try {
    return await action();
  } catch (err) {
    if (err.status === 401) {
      state.user = null;
      render();
      toast('Please log in.');
      openAuth('login');
    } else {
      toast(err.message || 'Something went wrong.');
    }
  }
}

/* ---------- Filtering and rendering ---------- */
function visibleNotes() {
  const { q, subject, semester, sort, tab } = state.filters;
  const query = q.trim().toLowerCase();

  const list = state.notes.filter((n) => {
    if (subject && n.subject !== subject) return false;
    if (semester && String(n.semester) !== semester) return false;
    if (tab === 'mine' && !(state.user && n.authorId === state.user.id)) return false;
    if (tab === 'saved' && !n.saved) return false;
    if (query) {
      const text = [n.title, n.description, n.subject, n.authorName, ...n.tags].join(' ').toLowerCase();
      if (!text.includes(query)) return false;
    }
    return true;
  });

  const sorters = {
    newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
    votes: (a, b) => b.voteCount - a.voteCount,
    downloads: (a, b) => b.downloads - a.downloads
  };
  return list.sort(sorters[sort]);
}

function noteCard(note) {
  const isOwner = state.user && note.authorId === state.user.id;

  return el('article', { class: 'card' },
    el('div', { class: 'card-top' },
      el('span', { class: 'badge' }, note.fileType),
      el('span', { class: 'muted small' }, `${note.subject} · Sem ${note.semester}`)
    ),
    el('h3', {}, note.title),
    note.description ? el('p', {}, note.description) : null,
    note.tags.length
      ? el('div', { class: 'tags' }, note.tags.map((t) => el('span', { class: 'tag' }, '#' + t)))
      : null,
    el('div', { class: 'card-meta' },
      `By ${note.authorName} · ${formatDate(note.createdAt)} · ${note.downloads} downloads`),
    el('div', { class: 'card-actions' },
      el('button', {
        class: 'btn small' + (note.voted ? ' active-state' : ''), type: 'button',
        'aria-pressed': String(note.voted), 'aria-label': 'Upvote',
        onclick: () => handleVote(note.id)
      }, `▲ ${note.voteCount}`),
      el('button', {
        class: 'btn small' + (note.saved ? ' active-state' : ''), type: 'button',
        'aria-pressed': String(note.saved),
        onclick: () => handleBookmark(note.id)
      }, note.saved ? '★ Saved' : '☆ Save'),
      el('button', { class: 'btn small primary', type: 'button', onclick: () => openView(note.id) }, 'View'),
      el('button', { class: 'btn small', type: 'button', onclick: () => handleReport(note.id) }, '⚑ Report'),
      isOwner
        ? el('button', { class: 'btn small danger', type: 'button', onclick: () => handleDelete(note.id) }, 'Delete')
        : null
    )
  );
}

function render() {
  const list = visibleNotes();
  $('notesGrid').replaceChildren(...list.map(noteCard));
  $('emptyState').hidden = list.length > 0;
  $('resultCount').textContent = `${list.length} note${list.length === 1 ? '' : 's'} found`;

  $('authBtn').textContent = state.user ? 'Log out' : 'Log in';
  $('userName').hidden = !state.user;
  $('userName').textContent = state.user ? 'Hi, ' + state.user.name.split(' ')[0] : '';

  document.querySelectorAll('.tab').forEach((tab) => {
    const active = tab.dataset.tab === state.filters.tab;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  });
}

async function refresh() {
  await run(async () => {
    state.notes = await api.listNotes();
    render();
  });
}

/* ---------- Guard for actions that need an account ---------- */
function requireLogin(message = 'Please log in first.') {
  if (state.user) return true;
  toast(message);
  openAuth('login');
  return false;
}

/* ---------- Note actions ---------- */
async function handleVote(id) {
  if (!requireLogin('Log in to upvote notes.')) return;
  await run(() => api.toggleVote(id));
  refresh();
}

async function handleBookmark(id) {
  if (!requireLogin('Log in to save notes.')) return;
  await run(() => api.toggleBookmark(id));
  refresh();
}

async function handleReport(id) {
  if (!requireLogin('Log in to report a note.')) return;
  const reason = window.prompt('Why are you reporting this note? (copyright, inappropriate, spam, wrong subject)');
  if (!reason || !reason.trim()) return;
  await run(async () => {
    await api.reportNote(id, reason.trim().slice(0, 200));
    toast('Thanks. The note has been reported for review.');
  });
  refresh();
}

async function handleDelete(id) {
  if (!window.confirm('Delete this note permanently?')) return;
  await run(async () => {
    await api.deleteNote(id);
    toast('Note deleted.');
  });
  refresh();
}

/* ---------- Dialogs: auth ---------- */
function openAuth(mode) {
  state.authMode = mode;
  const signup = mode === 'signup';
  $('authTitle').textContent = signup ? 'Create account' : 'Log in';
  $('authSubmit').textContent = signup ? 'Sign up' : 'Log in';
  $('nameRow').hidden = !signup;
  $('authSwitchText').textContent = signup ? 'Already have an account?' : 'New here?';
  $('authSwitch').textContent = signup ? 'Log in' : 'Create an account';
  $('authPassword').autocomplete = signup ? 'new-password' : 'current-password';
  $('authError').hidden = true;
  if (!$('authDialog').open) $('authDialog').showModal();
}

async function submitAuth(event) {
  event.preventDefault();
  const name = $('authName').value.trim();
  const email = $('authEmail').value.trim().toLowerCase();
  const password = $('authPassword').value;
  const showError = (msg) => { $('authError').textContent = msg; $('authError').hidden = false; };

  if (state.authMode === 'signup' && name.length < 2) return showError('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showError('Please enter a valid email.');
  if (password.length < 8) return showError('Password must be at least 8 characters.');

  $('authSubmit').disabled = true;
  try {
    state.user = state.authMode === 'signup'
      ? await api.signup({ name, email, password })
      : await api.login({ email, password });
    $('authDialog').close();
    $('authForm').reset();
    toast('Welcome, ' + state.user.name.split(' ')[0] + '!');
    await refresh();      // reload so votes and saved notes reflect this user
  } catch (err) {
    showError(err.message);
  } finally {
    $('authSubmit').disabled = false;
  }
}

async function logout() {
  await run(() => api.logout());
  state.user = null;
  state.filters.tab = 'all';
  toast('Logged out.');
  await refresh();
}

/* ---------- Dialogs: upload ---------- */
function openUpload() {
  if (!requireLogin('Log in to upload notes.')) return;
  $('uploadError').hidden = true;
  $('uploadDialog').showModal();
}

async function submitUpload(event) {
  event.preventDefault();
  const showError = (msg) => { $('uploadError').textContent = msg; $('uploadError').hidden = false; };

  const title = $('upTitle').value.trim();
  const file = $('upFile').files[0];

  if (title.length < 3) return showError('Please enter a title (at least 3 characters).');
  if (!file) return showError('Please choose a file.');
  if (!CONFIG.ALLOWED_TYPES[file.type]) return showError('Only PDF, PNG, JPG and DOCX files are allowed.');
  if (file.size > CONFIG.MAX_FILE_MB * 1024 * 1024) return showError(`File is too large. Maximum is ${CONFIG.MAX_FILE_MB} MB.`);

  const form = new FormData();
  form.append('title', title);
  form.append('description', $('upDescription').value.trim());
  form.append('subject', $('upSubject').value);
  form.append('semester', $('upSemester').value);
  form.append('tags', $('upTags').value);
  form.append('file', file);            // the file field goes last

  $('uploadSubmit').disabled = true;
  $('uploadSubmit').textContent = 'Uploading...';
  try {
    await api.createNote(form);
    $('uploadDialog').close();
    $('uploadForm').reset();
    toast('Notes uploaded. Thank you for sharing!');
    await refresh();
  } catch (err) {
    if (err.status === 401) { state.user = null; render(); $('uploadDialog').close(); openAuth('login'); }
    showError(err.message);
  } finally {
    $('uploadSubmit').disabled = false;
    $('uploadSubmit').textContent = 'Upload';
  }
}

/* ---------- Dialogs: view and download ---------- */
function clearPreview() {
  $('viewPreview').replaceChildren();
}

function openView(id) {
  const note = state.notes.find((n) => n.id === id);
  if (!note) return;
  if (!requireLogin('Log in to view and download notes.')) return;
  state.viewing = note;
  clearPreview();

  $('viewTitle').textContent = note.title;
  $('viewMeta').textContent =
    `${note.subject} · Semester ${note.semester} · by ${note.authorName} · ${note.fileType}, ${formatSize(note.fileSize)}`;
  $('viewDescription').textContent = note.description || '';

  const box = $('viewPreview');
  const url = api.fileUrl(note.id);
  if (note.fileType === 'PNG' || note.fileType === 'JPG') {
    box.append(el('img', { src: url, alt: 'Preview of ' + note.title }));
  } else if (note.fileType === 'PDF') {
    box.append(el('iframe', { src: url, title: 'PDF preview of ' + note.title }));
  } else {
    box.append(el('p', { class: 'muted' }, 'Preview is not available for this file type. Download it to open.'));
  }
  $('viewDownload').hidden = false;
  $('viewDialog').showModal();
}

function downloadCurrent() {
  const note = state.viewing;
  if (!note) return;
  const link = el('a', { href: api.fileUrl(note.id, true), download: note.fileName });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(refresh, 1200);      // update the download counter
}

/* ---------- Setup ---------- */
function fillSelect(select, values) {
  values.forEach((v) => select.append(el('option', { value: String(v) }, typeof v === 'number' ? 'Semester ' + v : v)));
}

function debounce(fn, wait = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

async function init() {
  // Fill dropdowns
  $('subjectFilter').replaceChildren(el('option', { value: '' }, 'All subjects'));
  $('semesterFilter').replaceChildren(el('option', { value: '' }, 'All semesters'));
  fillSelect($('subjectFilter'), SUBJECTS);
  fillSelect($('semesterFilter'), SEMESTERS);
  fillSelect($('upSubject'), SUBJECTS);
  fillSelect($('upSemester'), SEMESTERS);
  $('maxMb').textContent = CONFIG.MAX_FILE_MB;

  // Filters
  $('searchInput').addEventListener('input', debounce((e) => { state.filters.q = e.target.value; render(); }));
  $('subjectFilter').addEventListener('change', (e) => { state.filters.subject = e.target.value; render(); });
  $('semesterFilter').addEventListener('change', (e) => { state.filters.semester = e.target.value; render(); });
  $('sortSelect').addEventListener('change', (e) => { state.filters.sort = e.target.value; render(); });
  document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
    if ((tab.dataset.tab === 'mine' || tab.dataset.tab === 'saved') && !requireLogin()) return;
    state.filters.tab = tab.dataset.tab;
    render();
  }));

  // Header buttons
  $('uploadBtn').addEventListener('click', openUpload);
  $('authBtn').addEventListener('click', () => (state.user ? logout() : openAuth('login')));

  // Auth dialog
  $('authForm').addEventListener('submit', submitAuth);
  $('authCancel').addEventListener('click', () => $('authDialog').close());
  $('authSwitch').addEventListener('click', () => openAuth(state.authMode === 'login' ? 'signup' : 'login'));

  // Upload dialog
  $('uploadForm').addEventListener('submit', submitUpload);
  $('uploadCancel').addEventListener('click', () => $('uploadDialog').close());

  // View dialog
  $('viewClose').addEventListener('click', () => $('viewDialog').close());
  $('viewDialog').addEventListener('close', clearPreview);
  $('viewDownload').addEventListener('click', downloadCurrent);

  // Who is logged in? Then load the notes.
  try { state.user = await api.currentUser(); } catch { state.user = null; }
  await refresh();
}

init();
