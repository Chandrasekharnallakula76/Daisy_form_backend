# Daisy event inquiry API

Express serves the public React form at **`/`**, administrator pages at **`/login`** and **`/admin`**, and API at **`/api/...`** in one Cloud Run container. Production requires PostgreSQL and stores inquiries, administrator sessions, and sign-in attempt limits in the shared database. The [manual Cloud Run guide](deploy/cloud-run/README.md) covers the existing Cloud SQL instance, runtime settings, source ZIP, image build, and Console deployment. These files create no cloud resources or deployment by themselves.

## Local setup

Use Node.js **22.12 or newer**. This repository uses npm and its committed `package-lock.json`; the frontend uses Yarn Classic and a separate lockfile.

```sh
npm ci
cp .env.example .env
npm run dev
```

Local SQLite development defaults to `HOST=127.0.0.1`, `PORT=4000`, `CLIENT_ORIGIN=http://localhost:5173`, and `DATABASE_PATH=./data/inquiries.sqlite`. Relative SQLite paths resolve from the backend's working directory. The database and directory are created when needed. Keep `.env`, local databases and sidecars, backups, and old JSON files private and out of version control. `better-sqlite3` remains pinned to `12.11.1` for local development and legacy tools; PostgreSQL is the production data store.

The fixed administrator account is `admin@daisyai.com`. The backend verifies its password against the existing salted scrypt hash; no administrator environment variables or plaintext password in the image are required. Sign in through `/login`. Browser requests use an HttpOnly cookie with `SameSite=Lax`; use consistent `localhost` origins locally and the shared HTTPS origin in production.

## Production runtime

The container listens on `0.0.0.0:8080` and runs as the unprivileged `node` user. `STATIC_DIR=/app/frontend/dist` tells Express where to serve the bundled frontend. `APP_BASE_PATH=/` matches Vite's default root build base. Clean frontend `/login` and `/admin` routes serve the compiled entry page, and missing assets stay `404`. For a custom path, build the frontend with `VITE_API_URL= yarn build --base=/another-path/` and set `APP_BASE_PATH=/another-path` together; the custom prefixed API and root `/api/...` are then available.

With the default root base, legacy `GET` and `HEAD` URLs for `/daisy-gci-event-form` (with or without its trailing slash), `/daisy-gci-event-form/login`, and `/daisy-gci-event-form/admin` return a permanent `301` redirect to the corresponding root page, preserving query strings. The login/admin legacy URLs also accept a trailing slash. Old prefixed API, assets, and unknown page URLs return `404`; these migration redirects are disabled when a custom non-root base is configured.

Set `NODE_ENV=production`, `STORAGE_BACKEND=postgres`, and the required `DB_HOST`, `DB_NAME`, `DB_USER`, and `DB_PASSWORD`. `DB_PORT` defaults to `5432`. For the confirmed Cloud SQL instance, connect to private IP `10.64.1.34` through the existing approved VPC connection and use `DB_SSL_MODE=verify-full`. The production image supplies that mode and `DB_SSL_SERVERNAME=0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog` as non-secret defaults. TLS verifies both the certificate chain against the bundled public Google regional CA and the server's identity against this name; the TCP destination remains `DB_HOST`. No DNS record or additional IAM permission is needed for certificate-name verification. The instance retains its `ENCRYPTED_ONLY` policy and requires no client certificate for this connection.

`DB_SSL_CA_PATH` optionally selects another trusted CA file; leave it unset to use `src/certs/cloudsql-northamerica-northeast1.crt`. Refresh that public bundle through a reviewed release, rather than fetching it at runtime. `DB_SSL_MODE=disable` is for local PostgreSQL or an approved managed socket/proxy that supplies the secure transport. When running source without `DB_SSL_MODE`, the existing PostgreSQL connection behavior remains available; set the mode explicitly for deployment. An explicit `DB_SSL_MODE` takes precedence over generic PostgreSQL SSL environment settings.

PostgreSQL uses a maximum of three connections per container. The app initializes its schema under an advisory lock, so its user needs DDL privileges in the application database. Missing settings, failed database connections, an unreadable CA, or failed certificate verification fail startup; production never falls back to SQLite. See the [Cloud Run guide](deploy/cloud-run/README.md) for the manual v4 image build and rollout. When updating the existing Cloud Run service, select the v4 image and explicitly set its runtime `APP_BASE_PATH=/`; a retained older runtime value overrides the image default. Keep the existing database, TLS, VPC, credentials, and canonical `CLIENT_ORIGIN` settings.

Set `CLIENT_ORIGIN` to the exact canonical HTTPS service origin, without the application path or trailing slash. It can be omitted for the first deployment to discover the generated service URL, then set explicitly before acceptance checks. Production cookies are Secure. `TRUST_PROXY_HOPS=1` is the default for the direct Cloud Run setup and trusts the immediate platform proxy; DevOps should adapt this to any known extra proxy chain. Local development retains loopback proxy trust. See the [runtime environment example](deploy/cloud-run/.env.example); fill real credentials only through private runtime configuration, preferably a Secret Manager reference for the password.

Sessions expire after 12 hours and logout revokes them. PostgreSQL sessions survive restarts and are shared by all serving instances. Sign-in limits are also shared: ten failed or pending attempts in a 15-minute window. Local SQLite development uses the legacy in-memory authentication state, which resets on restart.

## API

The browser uses these root API routes for the default deployment.

| Route | Behavior |
| --- | --- |
| `GET /api/health` | Report application/database health. |
| `POST /api/inquiries` | Validate and persist a public inquiry; return `201` on success. |
| `POST /api/admin/login` | Accept `{ "email": "...", "password": "..." }`; return administrator email and set the session cookie on success. |
| `GET /api/admin/session` | Return administrator email for a valid session, otherwise `401`. |
| `POST /api/admin/logout` | Revoke the session and clear its cookie; return `204`. |
| `GET /api/inquiries` | Require an administrator session; return `{ "inquiries": [...] }`, otherwise `401`. |
| `GET /api/inquiries/export.csv` | Download all fields, IDs, and timestamps using an administrator session or explicit HTTP Basic authentication for the same account. |

The download filename is `daisy-gci-event-form-responses.csv`. For command-line export, curl prompts for the account's password so it stays out of shell history:

```sh
umask 077
curl --fail --user admin@daisyai.com \
  --output daisy-gci-event-form-responses.csv \
  https://YOUR_SERVICE_HOST/api/inquiries/export.csv
```

Example public submission:

```json
{
  "fullName": "Taylor Example",
  "companyOrganization": "Example Company",
  "businessEmail": "taylor@example.com",
  "jobTitle": "Product Manager",
  "phoneNumber": "+1 555 0100",
  "interests": ["ai-solutions", "other"],
  "interestOther": "Integration details",
  "preferredFollowUpMethods": ["email"],
  "questionsOrComments": "Please contact me next week."
}
```

Interest values are `product-demo`, `ai-solutions`, `business-partnership`, `pricing-info`, and `other`. Follow-up methods are `email` and `phone`; the array may be empty. Full name, organization, business email, and at least one interest are required. Selecting `other` requires `interestOther`; phone follow-up requires `phoneNumber`. Validation errors return `400`.

## Existing records and backups

A fresh PostgreSQL deployment starts empty. To migrate an old dataset, stop its old writer, preserve a private final source, and configure destination `DB_*` settings on a trusted maintenance machine. Then run either:

```sh
npm run import:postgres -- /private/path/to/inquiries.json
npm run import:postgres -- --sqlite /private/path/to/inquiries.sqlite
```

The importer reads the source without changing it, validates records, preserves IDs and submission timestamps, skips existing IDs, and imports transactionally. Do not add source records or credentials to the upload ZIP or image. For production backup and recovery, use the existing Cloud SQL instance's managed backup and recovery policy.

These commands remain available **only for legacy SQLite development/maintenance**:

```sh
npm run import:json -- /private/path/to/inquiries.json
npm run backup -- /private/path/to/new-backup.sqlite
```

They operate on `DATABASE_PATH`, not PostgreSQL. The backup command uses SQLite's backup API and refuses to overwrite an existing destination; copying only a live SQLite file can miss writes in its WAL sidecar. The [historical server guide](deploy/README.md) retains the old SQLite backup and restore workflow for reference.

## Verify and package

Run tests in the working source repository, before making a deployment ZIP:

```sh
npm test
```

PostgreSQL integration tests require a dedicated local PostgreSQL database configured with `TEST_DATABASE_URL`; the test helper rejects remote production targets. Without that setting the ordinary suite reports database integration tests as skipped. After configuring that private local test URL, run `npm run test:postgres` to validate the real database adapter; no cloud database should be a test target.

From the backend working directory, create a source-only upload:

```sh
python3 deploy/cloud-run/package.py --output /path/to/daisy-cloud-run-root-v4.zip
```

The script can also be called by its full path from any directory. It packages both sibling repositories and excludes installed dependencies, builds, tests, Git metadata, private environment files, databases, backups, credentials, and older archives. See the [Cloud Run guide](deploy/cloud-run/README.md) for the exact Docker build context and manual deployment steps.
