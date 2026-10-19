# NoteShare

A college notes-sharing website. Students sign up, upload notes (PDF, PNG, JPG, DOCX), search and filter them, upvote, save, report and download.

- **Frontend:** plain HTML, CSS and JavaScript in `public/`
- **Backend:** Node.js, Express and SQLite in `server.js`
- **Files:** stored in the `uploads/` folder
- **Database:** `data/noteshare.db` (created automatically)

## Run it on your computer

1. Install Node.js 22.13 or newer from https://nodejs.org (the LTS version is fine). Check with `node --version`.
2. Open a terminal in this folder and run:

   ```
   npm install
   npm start
   ```

3. Open http://localhost:3000 in your browser.
4. Create an account, upload a note, and try the other features.

Use `npm run dev` while developing; the server restarts when you save a file.

The database is Node.js's built-in SQLite (`node:sqlite`), so nothing needs compiling and you do not need Python or C++ tools. Node may print a one-line "SQLite is an experimental feature" warning when the server starts; it is harmless.

On Windows PowerShell, if you see "running scripts is disabled", run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use `npm.cmd install` and `npm.cmd start`.

## Settings (environment variables)

See `.env.example`. The important ones:

| Name | Meaning |
| --- | --- |
| `JWT_SECRET` | Long random secret that signs login cookies. Required in production. |
| `ALLOWED_EMAIL_DOMAIN` | Only allow signups from this domain, e.g. `mycollege.edu.in`. |
| `PORT` | Port to listen on (default 3000). |
| `MAX_FILE_MB` | Maximum upload size in MB (default 10). Also change it in `public/app.js`. |

Set them in your terminal before starting. Mac or Linux example:

```
JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))") ALLOWED_EMAIL_DOMAIN=mycollege.edu.in npm start
```

## API reference

| Method and path | What it does | Login needed |
| --- | --- | --- |
| POST `/api/auth/signup` | Create account | No |
| POST `/api/auth/login` | Log in | No |
| POST `/api/auth/logout` | Log out | No |
| GET `/api/auth/me` | Who am I | No |
| GET `/api/notes` | List notes | No |
| POST `/api/notes` | Upload a note (multipart form with a `file` field) | Yes |
| GET `/api/notes/:id/file` | Preview a file (add `?download=1` to download) | Yes |
| DELETE `/api/notes/:id` | Delete your own note | Yes |
| POST `/api/notes/:id/vote` | Toggle upvote | Yes |
| POST `/api/notes/:id/bookmark` | Toggle save | Yes |
| POST `/api/notes/:id/report` | Report a note (JSON body with `reason`) | Yes |

## Security built in

- Passwords are hashed with bcrypt.
- Login uses an httpOnly cookie, so page scripts cannot steal it.
- Uploads are limited by type, size and file contents (not just the extension), and are saved under random names.
- Rate limits on login and uploads, and secure headers through Helmet.
- All database queries use parameters, which prevents SQL injection.
- The page builds cards with safe text nodes, which prevents script injection.
- Notes reported by 3 different people are hidden from everyone but their author.

## Before putting it on the internet

1. Set `NODE_ENV=production` and a strong `JWT_SECRET`.
2. Serve it over HTTPS (a hosting service or reverse proxy such as Nginx or Caddy does this).
3. Keep `data/` and `uploads/` on storage that survives restarts and back it up.
4. Add an admin page or at least a way to review reported notes (query the `reports` table).
5. Add terms of use that tell students to upload only their own notes or material they may share.

## Growing it on the cloud

| Now | Cloud version |
| --- | --- |
| SQLite file | Managed PostgreSQL (RDS, Cloud SQL, Azure Database, or Supabase) |
| `uploads/` folder | Object storage (S3, Cloud Storage, Blob Storage) using signed upload and download URLs |
| One Node process | A container on a managed service, behind a load balancer |
| Manual deploy | GitHub Actions pipeline that tests and deploys on every push |
| Console logs | Centralized logs, dashboards and uptime alerts |
