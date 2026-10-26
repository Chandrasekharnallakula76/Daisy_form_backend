# Historical deployment: existing HTTPS server and SQLite

> **Legacy reference only.** These instructions describe the earlier SQLite deployment on Nginx/systemd. The current production application requires PostgreSQL and is packaged for Cloud Run; use the [manual Cloud Run guide](cloud-run/README.md). Do not use this historical guide to configure a new production deployment. Its SQLite storage, in-memory sessions, proxy configuration, and backup commands describe the old runtime; they do not describe the current PostgreSQL production runtime. In particular, the current server rejects SQLite with `NODE_ENV=production`. Existing data can be migrated using the PostgreSQL import command in the current guide.

These examples add the public form at `https://YOUR_DOMAIN/daisy-gci-event-form/` and its administrator pages to an existing Linux server running Nginx and systemd. Replace `YOUR_DOMAIN`, the SSH target, and the existing site configuration path with your actual values. The public path is **`daisy-gci-event-form`**, with GCI in that order. Continue to the next command only after the previous one succeeds.

| Component | Location |
| --- | --- |
| Built frontend files | `/var/www/daisy-gci-event-form/` |
| Backend code and Linux dependencies | `/opt/daisy-gci-event/backend/` |
| Private backend environment | `/etc/daisy-gci-event.env` |
| Persistent inquiry database | `/var/lib/daisy-gci-event/inquiries.sqlite` |
| Service | `daisy-gci-event.service` |
| Administrator sign-in | `https://YOUR_DOMAIN/daisy-gci-event-form/login` |
| Administrator responses | `https://YOUR_DOMAIN/daisy-gci-event-form/admin` |
| CSV download | `https://YOUR_DOMAIN/daisy-gci-event-form/api/inquiries/export.csv` |

The API binds to `127.0.0.1:4000`; only Nginx exposes it. Keep port 4000 closed to public access. The existing HTTPS virtual host retains its TLS setup and other site locations. These are deployment instructions and examples; no server or AWS resources are changed by this repository.

The administrator extension reuses the existing SQLite database at the path above without a migration. Keep the existing service account, backend directory, environment file, and database location when updating an installed deployment. Only the public URL and frontend installation directory use the new `daisy-gci-event-form` name.

## 1. Build and upload

Use a supported Node.js release at least 22.12, preferably a current patched LTS release. Use Yarn Classic for the frontend and npm for the backend. From the directory containing both repositories, run locally:

```sh
cd Daisy_form
yarn install --frozen-lockfile
yarn typecheck
VITE_API_URL= yarn build --base=/daisy-gci-event-form/
rsync -av --delete dist/ deploy@YOUR_HOST:/tmp/daisy-gci-event-frontend/
cd ../Daisy_form_backend
npm ci
npm test
rsync -av --delete --exclude=.git --exclude=node_modules --exclude=.env --exclude=data --exclude=yarn.lock ./ deploy@YOUR_HOST:/tmp/daisy-gci-event-backend/
```

The explicit `VITE_API_URL=` clears any local API override, including when a local `.env` points at port 4000. The `--base=/daisy-gci-event-form/` override preserves this historical prefixed deployment even though the current frontend defaults to `/`. The resulting frontend calls `/daisy-gci-event-form/api/inquiries` on the same origin, with credentials included for administrator sessions. The trailing slash on `dist/` copies its contents. Both remote staging directories are dedicated to this deployment.

Install the backend dependencies **on the Linux host**. `better-sqlite3` contains a native module: do not upload macOS `node_modules` or reuse modules built for another Node version or CPU architecture. `npm ci --omit=dev` installs the pinned production dependency versions.

## 2. Prepare the host once

The remaining commands run on the server as an administrator with `sudo`. The existing Nginx and systemd installations are assumed. Check the application's Node installation and required transfer tool:

```sh
node --version
command -v node
command -v npm
command -v rsync
```

Install only missing tools. For Debian or Ubuntu, if `rsync` is absent, use `sudo apt-get install rsync`. The optional `sqlite3` command used in the restore integrity check can be installed with `sudo apt-get install sqlite3`; other distributions use their own package manager.

The service example uses `/usr/bin/node`. Confirm that it is the intended supported version. If the host uses a different installation, change `ExecStart` to that Node binary's absolute path and use the same installation for dependency installation and maintenance commands. A login shell's nvm selection does not automatically apply to systemd. Keep an application's Node installation separate if changing a shared binary would affect other sites.

Create the service account once, then its directories:

```sh
sudo useradd --system --user-group --home-dir /nonexistent --shell /usr/sbin/nologin daisy-gci-event
sudo install -d -o root -g daisy-gci-event -m 0750 /opt/daisy-gci-event/backend
sudo install -d -o daisy-gci-event -g daisy-gci-event -m 0750 /var/lib/daisy-gci-event
sudo install -d -o root -g root -m 0755 /var/www/daisy-gci-event-form
```

The database directory is created explicitly before any import. systemd also maintains it through `StateDirectory=daisy-gci-event`. Keep inquiry data outside the application-code directory so future code replacement leaves it intact.

## 3. Install backend code and private settings

Install native dependencies in the uploaded staging directory as your normal administrator account, then install the prepared application as root-owned code readable by the service group:

```sh
cd /tmp/daisy-gci-event-backend
npm ci --omit=dev
sudo rsync -a --delete --exclude=.env --exclude=data --chown=root:daisy-gci-event ./ /opt/daisy-gci-event/backend/
sudo chmod -R g+rX,o-rwx /opt/daisy-gci-event/backend
sudo install -o root -g daisy-gci-event -m 0640 deploy/daisy-gci-event.env.example /etc/daisy-gci-event.env
sudoedit /etc/daisy-gci-event.env
```

If dependency installation cannot find a matching native prebuild and fails because compilation tools are missing, install `build-essential` and `python3` on Debian or Ubuntu, then retry `npm ci --omit=dev` in the staging directory. Install that toolchain only when needed.

Set `CLIENT_ORIGIN=https://YOUR_DOMAIN`, with the real hostname and **no path or trailing slash**. Keep `HOST=127.0.0.1`, `PORT=4000`, and `DATABASE_PATH=/var/lib/daisy-gci-event/inquiries.sqlite`. CORS permits credentials only for the explicit `CLIENT_ORIGIN`. No administrator environment settings are needed: use the configured fixed administrator account (`admin@daisyai.com`), whose password is verified against a fixed salted scrypt hash in the backend.

The service sets `NODE_ENV=production`, which makes its HttpOnly session cookie Secure. Keep this setting and the existing HTTPS setup. The backend trusts only the loopback proxy, and Nginx forwards the original scheme. Administrator sessions last 12 hours and live in memory; logout revokes a session, and restarting the backend signs administrators out without removing records. Sign-in is limited to 10 failed attempts per 15 minutes.

Install the service definition, adapting its Node path first if required:

```sh
sudo install -o root -g root -m 0644 deploy/daisy-gci-event.service /etc/systemd/system/daisy-gci-event.service
sudo systemctl daemon-reload
```

### Existing JSON data

Skip this section for a fresh deployment. Before the final import, **stop the old JSON-writing process using its current supervisor**. Keep it stopped after the cutover. Otherwise, new submissions can be stranded in the old JSON file after the SQLite import. Preserve an untouched copy of that final JSON file.

For example, after stopping the old service, replace `/ABSOLUTE/PATH/TO/OLD/inquiries.json` below with the final file. The first command copies it into private storage readable by the new service account; it does not change the original.

```sh
sudo install -o daisy-gci-event -g daisy-gci-event -m 0640 /ABSOLUTE/PATH/TO/OLD/inquiries.json /var/lib/daisy-gci-event/legacy-inquiries.json
cd /opt/daisy-gci-event/backend
sudo -u daisy-gci-event env DATABASE_PATH=/var/lib/daisy-gci-event/inquiries.sqlite npm run import:json -- /var/lib/daisy-gci-event/legacy-inquiries.json
```

Do not continue until import succeeds. It uses a transaction, preserves existing IDs and submission times, skips IDs already present in SQLite, and leaves the source JSON unchanged. Running it again does not duplicate those IDs. The explicit `DATABASE_PATH` matches the service environment; run it as the service user so file ownership also matches. Keep the old JSON copy private for recovery.

## 4. Start the API and add Nginx locations

```sh
sudo systemctl enable --now daisy-gci-event
sudo systemctl status daisy-gci-event --no-pager
curl --fail http://127.0.0.1:4000/api/health
```

If startup fails, inspect `sudo journalctl -u daisy-gci-event -n 100 --no-pager` and fix the error before exposing the form.

Install the frontend and the [Nginx location snippet](nginx.conf):

```sh
sudo rsync -a --delete --chown=root:root /tmp/daisy-gci-event-frontend/ /var/www/daisy-gci-event-form/
sudo find /var/www/daisy-gci-event-form -type d -exec chmod 0755 {} +
sudo find /var/www/daisy-gci-event-form -type f -exec chmod 0644 {} +
sudo install -d -o root -g root -m 0755 /etc/nginx/snippets
sudo install -o root -g root -m 0644 /opt/daisy-gci-event/backend/deploy/nginx.conf /etc/nginx/snippets/daisy-gci-event.conf
```

Edit the **existing HTTPS `server { ... }` block for your domain** and add this include inside it:

```nginx
include /etc/nginx/snippets/daisy-gci-event.conf;
```

Keep the virtual host's other routes and TLS settings. Do not install the snippet as a standalone site or include it in every server. Its exact public-path redirect adds the trailing slash and preserves the query string. Its scoped `root /var/www` maps assets to `/var/www/daisy-gci-event-form/`. Exact `/daisy-gci-event-form/login` and `/daisy-gci-event-form/admin` locations serve that directory's same `index.html`, so direct visits and refreshes work; optional trailing slashes redirect to the clean page URLs. Other missing files, including assets, return `404`.

The isolated `^~ /daisy-gci-event-form/api/` location uses `proxy_pass http://127.0.0.1:4000/api/;` with a trailing slash to transform `/daisy-gci-event-form/api/...` into the backend's `/api/...` route. Cookies and the Basic authentication header reach Express. API errors are handled by the backend and do not fall back to the frontend HTML.

Validate before reloading:

```sh
sudo nginx -t && sudo systemctl reload nginx
```

## 5. Verify the public deployment

Replace `YOUR_DOMAIN` in these commands. Check the form and assets in a browser, submit an inquiry while signed out, and verify another existing site route on the host still works. Open the clean `/login` page directly, sign in with the configured fixed administrator account, then refresh `/admin` and confirm the response list loads. Sign out and confirm administrator access requires signing in again while the public form still accepts submissions.

```sh
curl -I 'https://YOUR_DOMAIN/daisy-gci-event-form?check=1'
curl --fail https://YOUR_DOMAIN/daisy-gci-event-form/
curl --fail https://YOUR_DOMAIN/daisy-gci-event-form/login
curl --fail https://YOUR_DOMAIN/daisy-gci-event-form/admin
curl --fail https://YOUR_DOMAIN/daisy-gci-event-form/api/health
curl -I https://YOUR_DOMAIN/daisy-gci-event-form/assets/does-not-exist.js
curl -i https://YOUR_DOMAIN/daisy-gci-event-form/api/admin/session
curl -i https://YOUR_DOMAIN/daisy-gci-event-form/api/inquiries
curl -i https://YOUR_DOMAIN/daisy-gci-event-form/api/inquiries/export.csv
```

Expect the first request to redirect to `/daisy-gci-event-form/?check=1`, all three frontend page requests to serve the built HTML, and the missing asset to return `404`. The unauthenticated session, inquiry-list, and export requests return `401`. The frontend handles administrator authorization after loading the page.

This request writes a sample inquiry; use it in a test environment or identify the sample in your production export:

```sh
curl --include --fail-with-body --request POST https://YOUR_DOMAIN/daisy-gci-event-form/api/inquiries \
  --header 'Content-Type: application/json' \
  --data '{"fullName":"Deployment Test","companyOrganization":"Test Company","businessEmail":"deployment-test@example.com","interests":["ai-solutions"],"preferredFollowUpMethods":["email"]}'
```

It should return `201` and an inquiry ID. The preferred browser download is on the administrator page after signing in at `https://YOUR_DOMAIN/daisy-gci-event-form/login`. It uses the session cookie and downloads `daisy-gci-event-form-responses.csv`.

For command-line access, the same CSV route also accepts explicit HTTP Basic authentication for the configured fixed administrator account. Curl prompts for the password so it is not included in shell history:

```sh
umask 077
curl --fail --user admin@daisyai.com \
  --output daisy-gci-event-form-responses.csv \
  https://YOUR_DOMAIN/daisy-gci-event-form/api/inquiries/export.csv
```

Open the CSV and confirm the submission and all fields are present. The file contains contact information; store it privately.

## Subsequent deployments

1. Build, test, and upload as in step 1. Run `npm ci --omit=dev` in the Linux staging directory again, using the production Node installation.
2. Create a database backup using the commands below. Keep the private environment and database outside the code replacement.
3. Stop `daisy-gci-event`, replace backend code using the step 3 `rsync` and permissions commands, then restart it. Do **not** reinstall the environment example over your real settings. Preserve `DATABASE_PATH=/var/lib/daisy-gci-event/inquiries.sqlite`; the administrator extension needs no data migration. The database schema is initialized or checked on startup; JSON import is a one-time legacy migration, not a deployment step.
4. Replace the frontend using the step 4 `rsync` and permissions commands. Update the service or Nginx snippet only when it changed; run `systemctl daemon-reload` after service changes and `nginx -t` before any Nginx reload.
5. Repeat the health, browser, and authenticated export checks, confirming earlier submissions remain present. Every backend restart clears in-memory administrator sessions, so sign in again. Inspect the service logs if a check fails.

The backend restart commands are:

```sh
sudo systemctl stop daisy-gci-event
# Replace prepared backend code and permissions here, as in step 3.
sudo systemctl start daisy-gci-event
sudo systemctl status daisy-gci-event --no-pager
```

Changing `/etc/daisy-gci-event.env` also requires restarting the service. A code rollback can restore a saved previous backend release and frontend build, while retaining the database. Before a future change that alters the schema, take a snapshot and review that change's migration and rollback instructions.

## Backup and restore

### Create a consistent snapshot

The backup command can run while the API is serving requests. It uses SQLite's backup API, includes committed WAL data, and refuses an existing destination. Use a new filename each time:

```sh
sudo install -d -o daisy-gci-event -g daisy-gci-event -m 0750 /var/lib/daisy-gci-event/backups
cd /opt/daisy-gci-event/backend
DAISY_SNAPSHOT=/var/lib/daisy-gci-event/backups/inquiries-$(date -u +%Y%m%dT%H%M%SZ).sqlite
sudo -u daisy-gci-event env DATABASE_PATH=/var/lib/daisy-gci-event/inquiries.sqlite npm run backup -- "$DAISY_SNAPSHOT"
sudo chmod 0640 "$DAISY_SNAPSHOT"
```

Do not copy only the live `inquiries.sqlite` file: recent data may be in `inquiries.sqlite-wal`. A completed backup is standalone; its source sidecars are not needed to restore it.

Copy completed snapshots off the instance. For example, on the server, stage a private copy in the SSH administrator's home directory:

```sh
DAISY_SNAPSHOT_NAME=$(basename "$DAISY_SNAPSHOT")
sudo install -o "$USER" -g "$(id -gn)" -m 0600 "$DAISY_SNAPSHOT" "$HOME/$DAISY_SNAPSHOT_NAME"
```

Then run this on your local machine, replacing the timestamp with that completed snapshot's name:

```sh
scp deploy@YOUR_HOST:inquiries-YYYYMMDDTHHMMSSZ.sqlite ./
```

Verify the local copy before removing the temporary copy from the administrator's home. Keep backups private and retain them according to your organization's needs. These instructions do not create a recurring job or assume any cloud storage resources.

### Restore a completed snapshot

Upload the selected completed snapshot as `/tmp/inquiries-restore.sqlite`, restrict it to its owner, and check it before replacing the database:

```sh
chmod 0600 /tmp/inquiries-restore.sqlite
sqlite3 /tmp/inquiries-restore.sqlite 'PRAGMA integrity_check;'
```

Continue only if the check returns `ok`. Stop the service, then move the current database **and any sidecars** into a separate recovery directory. This preserves the previous state and prevents stale WAL files from being applied to the restored snapshot:

```sh
(
set -eu
sudo systemctl stop daisy-gci-event
DAISY_RESTORE_ARCHIVE=/var/lib/daisy-gci-event/restore-previous-$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o daisy-gci-event -g daisy-gci-event -m 0750 "$DAISY_RESTORE_ARCHIVE"
for suffix in '' -wal -shm; do
  if sudo test -e "/var/lib/daisy-gci-event/inquiries.sqlite$suffix"; then
    sudo mv "/var/lib/daisy-gci-event/inquiries.sqlite$suffix" "$DAISY_RESTORE_ARCHIVE/"
  fi
done
sudo install -o daisy-gci-event -g daisy-gci-event -m 0640 /tmp/inquiries-restore.sqlite /var/lib/daisy-gci-event/inquiries.sqlite
sudo systemctl start daisy-gci-event
curl --fail http://127.0.0.1:4000/api/health
)
```

SQLite recreates sidecars as needed. Check the service logs and authenticated CSV to confirm the expected records, then remove the temporary upload. Keep the archived previous database until you have verified the restore. Restoring a snapshot replaces the current dataset with its state at backup time; preserve any newer records you need before restoring.
