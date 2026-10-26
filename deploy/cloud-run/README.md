# Manual Cloud Run deployment

This guide prepares one Cloud Run container for the public form, administrator pages, and API. Express serves the compiled frontend at `/`, administrator pages at `/login` and `/admin`, and the API at `/api/...` on the same origin. PostgreSQL stores inquiries, administrator sessions, and sign-in limits. The image runs one Node process as the unprivileged `node` user; it needs no Nginx, systemd, or persistent container disk.

The v4 release adds theme-specific Daisy logos and favicons, and fixes checkbox labels scrolling the form to the top. It retains the root URLs introduced in v3 and the existing service, image name, database, user, and verified PostgreSQL TLS configuration. This frontend update needs no database migration. The repository contains deployment files only. Building a ZIP or image creates no cloud resources. Perform the cloud setup and deployment manually when ready; no database password is needed to build.

## Target settings

| Setting | Value |
| --- | --- |
| Cloud Run and Cloud SQL project | `di-cl-mgeorgas-8998` |
| Cloud Run region | `northamerica-northeast1` |
| Existing image registry | `gcr.io/di-cl-mgeorgas-8998` (Artifact Registry-backed) |
| Existing Cloud SQL instance | `di-ai-pg-01` |
| Existing database engine | PostgreSQL 18.6, Enterprise |
| Instance zone | `northamerica-northeast1-c` — this is a zone, not the service region |
| Confirmed instance connection name | `di-cl-mgeorgas-8998:northamerica-northeast1:di-ai-pg-01` |
| Confirmed instance IP configuration | Private IP only: `10.64.1.34` |
| Confirmed TLS policy / CA | `ENCRYPTED_ONLY` / Google-managed shared CA (`GOOGLE_MANAGED_CAS_CA`) |
| TLS server identity | `0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog` |
| Existing VPC network | `projects/di-if-vpc-p-hopn/global/networks/di-if-vpc-p-cne-glb-hopn` |
| Network host project | `di-if-vpc-p-hopn` — distinct from the Cloud Run project |
| Subnet shown in the working service | `di-if-vpc-p-cns-nane1-cloudlab-subnet` — verify its region is `northamerica-northeast1` before reuse |
| Application database | `daisy_gci_event_form` |
| Existing PostgreSQL app user | `daisy-gci-event-form` |
| Suggested Cloud Run service | `daisy-gci-event-form` |
| Image | `gcr.io/di-cl-mgeorgas-8998/daisy-gci-event-form:v4` |

These instance settings were confirmed from the existing instance. Use the existing PostgreSQL user `daisy-gci-event-form`; configure its password later as a runtime setting. Identify the existing regional subnet or Serverless VPC Access connector from a working Cloud Run service that reaches this instance, or ask DevOps. The selected connection must have the required Shared VPC permissions.

## 1. Prepare the source upload locally

Keep both repositories side by side. From any working directory, run the packaging script using its actual location:

```sh
python3 /path/to/Daisy_form_backend/deploy/cloud-run/package.py \
  --output /path/to/daisy-cloud-run-root-v4.zip
```

Use the explicit `--output` above to name this release `daisy-cloud-run-root-v4.zip`; the packager's generic default remains `release/daisy-cloud-run.zip` in the directory containing both repositories. An existing output is rejected unless you deliberately add `--overwrite`. Use `--list` to preview included paths without creating a ZIP.

The ZIP has exactly these two top-level directories:

```text
Daisy_form/
Daisy_form_backend/
  deploy/cloud-run/Dockerfile
  deploy/cloud-run/Dockerfile.dockerignore
```

It includes source, public assets, dependency manifests and lockfiles, environment examples, and the public regional CA at `Daisy_form_backend/src/certs/cloudsql-northamerica-northeast1.crt`. The Dockerfile copies that CA with the backend source. It omits Git metadata, installed dependencies, builds, tests, local data, SQLite files and sidecars, backups, environment values, private credential/key files, logs, scratch files, and older archives. The existing `*.pem` and private-key exclusions remain in place; the bundled `.crt` contains public CA certificates only. Frontend dependencies use `yarn.lock`; backend dependencies use `package-lock.json`, so the unused backend `yarn.lock` is omitted. Run application tests in the working repositories before packaging; this upload is a build context rather than a test bundle. Keep any legacy inquiry export separate and private.

## 2. Prepare the existing database manually

For the existing service's v4 rollout, retain `daisy_gci_event_form`, its existing records, and the current user grants; skip database creation and import. This frontend update requires no database migration.

For a first deployment only, if this application database does not exist, select project `di-cl-mgeorgas-8998` in the Google Cloud Console, then **Cloud SQL → di-ai-pg-01 → Databases → Create database**. Create **`daisy_gci_event_form` inside this existing instance**. Do not create another instance.

The application initializes its own tables on startup under an advisory lock, including when multiple instances start together. The existing app user needs ownership of this application database and permission to create tables and indexes in its `public` schema. In Cloud SQL Studio, using an administrator with the necessary privileges, replace `EXISTING_APP_USER` with that existing user's exact SQL identifier:

```sql
-- Run while connected to an administrative database such as postgres.
ALTER DATABASE daisy_gci_event_form OWNER TO "EXISTING_APP_USER";
```

Reconnect Studio to `daisy_gci_event_form`, then run:

```sql
GRANT USAGE, CREATE ON SCHEMA public TO "EXISTING_APP_USER";
```

The database owner already has database access. If an administrator manages ownership differently, grant the equivalent database connection and schema DDL privileges to the app user. Keep these grants scoped to the application database. Startup fails if PostgreSQL is unavailable or the required settings or permissions are missing; production has no SQLite fallback.

## 3. Reuse the existing registry and check runtime access

Use the existing `gcr.io/di-cl-mgeorgas-8998` registry. No new image repository is required for this deployment. The existing `gcr.io` repository must be hosted on Artifact Registry: legacy Container Registry no longer accepts pushes. Artifact Registry continues to support the same `gcr.io` image URLs. Its `gcr.io` backing repository is in the `us` multi-region; Cloud Run and Cloud SQL remain in `northamerica-northeast1`. See Google's [gcr.io repository documentation](https://docs.cloud.google.com/artifact-registry/docs/transition/gcr-repositories).

Your signed-in Cloud Shell account needs permission to push to this existing repository. If a push is denied, ask DevOps for **Artifact Registry Writer** (`roles/artifactregistry.writer`) on the existing `gcr.io` repository in this project. Configuring Docker authentication does not grant repository permissions. See [Artifact Registry access roles](https://docs.cloud.google.com/artifact-registry/docs/access-control).

Have DevOps confirm that the required Cloud Run and Artifact Registry APIs are enabled. If using a Secret Manager reference for `DB_PASSWORD`, the selected runtime service account needs **Secret Manager Secret Accessor** on that specific secret. Reuse the approved existing runtime service account and permissions. The person deploying the service also needs the organization's deployment permissions; image-push access does not grant deployment or network access.

### Private IP connection for this instance

The confirmed Cloud SQL instance has **private IP only**, so the main deployment path is a PostgreSQL TCP connection to `10.64.1.34:5432`. Set `DB_HOST=10.64.1.34` and retain the existing SQL user's password and database grants. **Changing `DB_HOST` alone is insufficient**: Cloud Run also needs the existing route to the private network and verified TLS as described below.

Reuse one of these existing connectivity options, matching a working service or the settings provided by DevOps, in **Cloud Run → service → Edit and deploy new revision → Networking** (Console labels may vary):

- **Direct VPC egress:** select the existing network `di-if-vpc-p-cne-glb-hopn` in host project `di-if-vpc-p-hopn` and an approved existing subnet in `northamerica-northeast1` that can reach `10.64.1.34`. The working-service screenshot shows `di-if-vpc-p-cns-nane1-cloudlab-subnet`. Confirm that subnet belongs to this network in `northamerica-northeast1` and that this service can use it before reusing it; the screenshot alone does not establish its region or permissions.
- **Serverless VPC Access connector:** select an approved existing connector in `northamerica-northeast1` whose network routing and firewall rules allow access to `10.64.1.34:5432`. Its name has not been confirmed; copy it from a working service in this region or obtain it from DevOps.

For either option, select **Route only requests to private IPs through the VPC** (`private-ranges-only`). DevOps must confirm Shared VPC service-project access, the applicable deployment and connector permissions, and the existing routes and firewall policy. For Direct VPC egress, the **Cloud Run service agent** needs **Compute Network User** (`roles/compute.networkUser`) on the host project or selected subnet; subnet-scoped access also requires Compute Network Viewer on the host project. This is separate from the selected runtime service account. The Cloud Run project `di-cl-mgeorgas-8998` differs from the network host project `di-if-vpc-p-hopn`; permissions in the service project alone do not establish Shared VPC access. Use Google's [private IP connection guide](https://docs.cloud.google.com/sql/docs/postgres/connect-run#private-ip) and [Shared VPC Direct VPC egress guide](https://docs.cloud.google.com/run/docs/configuring/shared-vpc-direct-vpc) for the applicable configuration.

### Verified TLS for the direct private-IP connection

The instance's confirmed SSL mode is `ENCRYPTED_ONLY`, using a Google-managed shared CA. Keep this policy. It accepts TLS with the existing SQL username/password without requiring a client certificate. The legacy `requireSsl: false` field does not override the confirmed SSL mode. Google's [SSL mode guide](https://docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance#enforce-ssl) describes the encrypted-only policy.

The v4 production image retains these non-secret verified TLS defaults:

```text
DB_SSL_MODE=verify-full
DB_SSL_SERVERNAME=0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog
```

`verify-full` requires a trusted CA and normal server-identity verification. The bundled public regional CA is `src/certs/cloudsql-northamerica-northeast1.crt`; `DB_SSL_CA_PATH` can explicitly select another trusted CA file if needed. The server name above is the confirmed `PRIVATE_SERVICES_ACCESS` DNS name returned for this Cloud SQL instance. It is used for TLS verification while TCP still connects to `DB_HOST=10.64.1.34`, so this change needs no DNS record, VPC change, or additional IAM permission. A trailing dot on a configured server name is normalized. Google documents why shared CAs require [hostname and CA verification](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl).

Leave `DB_SSL_CA_PATH` unset for the bundled CA. The public bundle comes from Google's [regional CA bundle](https://storage.googleapis.com/cloudsql-ca-bundles/northamerica-northeast1.pem); its source and checksum are recorded in [the certificate README](../../src/certs/README.md). Refresh the bundle through a reviewed release and rebuild the image; the application does not fetch trust material at runtime. Never put a client private key or database credential in this directory.

For source execution, `DB_SSL_MODE` is optional to preserve the existing PostgreSQL behavior when it is absent. `DB_SSL_MODE=disable` is intended for local PostgreSQL or an approved managed socket/proxy that supplies the secure transport. An explicit mode takes precedence over generic PostgreSQL SSL environment settings. Keep `verify-full` for this direct-IP production connection.

The direct private-IP path authenticates with the existing SQL username/password and database grants. It does not use a `/cloudsql` socket, so a **Cloud SQL connections** attachment and **Cloud SQL Client** (`roles/cloudsql.client`) are not prerequisites for this TCP path. Those are required for the managed Cloud SQL socket/proxy path, which also uses the Cloud SQL Admin API.

### Conditional managed socket alternative

For a different deployment where DevOps has explicitly approved the instance's public-IP managed connection path, attach its confirmed connection name under **Cloud SQL connections**, enable the Cloud SQL Admin API, and grant the runtime service account **Cloud SQL Client**. Then use `/cloudsql/INSTANCE_CONNECTION_NAME` as `DB_HOST` and explicitly set `DB_SSL_MODE=disable` for the local socket; the managed proxy handles the encrypted upstream connection. Cloud Run supplies that socket only when configured for the managed connection. This is conditional guidance, not the recommended path for the confirmed private-IP-only instance; adding an attachment does not replace the required VPC connectivity.

## 4. Build and push the v4 image manually

Open Cloud Shell for the target project. Use its upload control to upload `daisy-cloud-run-root-v4.zip`, then extract it into a **new dedicated folder**. The build context must be the directory containing both extracted repositories, not either repository by itself and not an unrelated Git parent.

These commands are for you to run manually. Choose a fresh folder name if this one exists. The same Docker build command also works locally from the parent directory containing `Daisy_form/` and `Daisy_form_backend/`; skip the upload and extraction steps when building from those local sources.

```sh
mkdir daisy-cloud-run-root-v4
unzip daisy-cloud-run-root-v4.zip -d daisy-cloud-run-root-v4
cd daisy-cloud-run-root-v4
gcloud config set project di-cl-mgeorgas-8998
gcloud auth configure-docker gcr.io
docker build --platform linux/amd64 \
  -f Daisy_form_backend/deploy/cloud-run/Dockerfile \
  --tag gcr.io/di-cl-mgeorgas-8998/daisy-gci-event-form:v4 \
  .
docker push gcr.io/di-cl-mgeorgas-8998/daisy-gci-event-form:v4
```

If the uploaded file is named `Archive.zip`, use `Archive.zip` in the unzip command instead. The ZIP's contents and build command stay the same. Keep the final `.` in the build command: both extracted folders must be in its build context. The `-f` option selects the Dockerfile stored inside the backend folder. Use a new version tag such as `v5` for later releases.

Only continue after each command succeeds. The Dockerfile-specific ignore file beside the Dockerfile filters the shared context. The build uses Node 22 on Debian Bookworm, Yarn Classic `1.22.22` with `--frozen-lockfile` for the frontend, and `npm ci --omit=dev` for the backend. It builds the frontend with an empty `VITE_API_URL` and the default `/` base, so requests use `/api/...` on the same HTTPS origin. For a deliberate custom base, change the frontend build base and runtime `APP_BASE_PATH` together; see the [frontend build guidance](../../../Daisy_form/README.md). The native SQLite dependency remains for legacy tooling; its compiler toolchain stays in the dependency stage and is absent from the runtime stage. No password, login value, or runtime secret belongs in a build argument or image layer.

## 5. Deploy the revision in the Console

For the existing service, use **Cloud Run → daisy-gci-event-form → Edit and deploy new revision** and complete both changes in that revision:

1. Select `gcr.io/di-cl-mgeorgas-8998/daisy-gci-event-form:v4`.
2. Explicitly set the runtime environment variable **`APP_BASE_PATH=/`**, replacing any older `/daisy-gci-event-form` value. Cloud Run runtime environment variables override image defaults, so selecting the v4 image alone does not remove an existing prefix override.

Retain the existing database/password, `DB_SSL_*` verified TLS settings, VPC, service account, and canonical `CLIENT_ORIGIN`. Keep `CLIENT_ORIGIN` as the HTTPS origin without a path or trailing slash. The current service form URL becomes `https://daisy-gci-event-form-100366934313.northamerica-northeast1.run.app/`. Check any existing `DB_SSL_*` overrides against the values below. For a first deployment, use **Deploy container / Create service** with the same image and configure:

| Service setting | Recommended value |
| --- | --- |
| Service name | `daisy-gci-event-form` |
| Region | `northamerica-northeast1` |
| Execution environment | Second generation |
| Container port | `8080` |
| CPU / memory | `1` vCPU / `512 MiB` |
| Minimum / maximum instances | `0` / `2` |
| Maximum concurrent requests per instance | `20` |
| Runtime service account | The approved existing account, with access to the password secret if used |
| Authentication | Allow public invocation so visitors can submit the public form |
| VPC connectivity | Approved existing Direct VPC egress subnet or Serverless VPC Access connector with reachability to `10.64.1.34:5432` |
| VPC egress routing | Private ranges only (`private-ranges-only`) |

Public invocation exposes the form; administrator routes still enforce the application's session or supported CSV authentication. A PostgreSQL pool has at most three connections per container, so two serving instances ordinarily use up to six application connections; leave headroom for rollout overlap, import tools, and administration.

Add the following runtime environment variables using the Console. The [environment example](.env.example) is a reference, not a file to fill with secrets and upload.

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `HOST` | `0.0.0.0` |
| `STORAGE_BACKEND` | `postgres` |
| `STATIC_DIR` | `/app/frontend/dist` |
| `APP_BASE_PATH` | `/` — explicitly replace any older runtime override |
| `TRUST_PROXY_HOPS` | `1` for the direct Cloud Run service setup described here |
| `DB_HOST` | `10.64.1.34` — requires the approved VPC connectivity above |
| `DB_PORT` | `5432` |
| `DB_SSL_MODE` | Image default: `verify-full` |
| `DB_SSL_SERVERNAME` | Image default: `0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog` |
| `DB_SSL_CA_PATH` | Omit to use the bundled public regional CA |
| `DB_NAME` | `daisy_gci_event_form` |
| `DB_USER` | `daisy-gci-event-form` — the existing PostgreSQL app user |
| `DB_PASSWORD` | Prefer a runtime reference to its Secret Manager secret; otherwise configure the private runtime value in the Console |
| `CLIENT_ORIGIN` | Omit on the first deployment, then set the canonical service HTTPS origin without a path or trailing slash |

Cloud Run supplies `PORT=8080` from the container port setting; do not add it as a separate Console environment variable. The image also has an `8080` default for local use.

After the first deployment, copy the service's HTTPS URL, edit the service, set `CLIENT_ORIGIN` to that exact origin, and deploy the configuration update **before testing the form or administrator sign-in**. For example, if the service URL is `https://SERVICE-HOST.run.app`, use that whole origin, and open the form at `https://SERVICE-HOST.run.app/`. Startup permits the origin to be unset for this discovery step; configure the explicit origin for normal operation.

`TRUST_PROXY_HOPS=1` trusts the immediate platform proxy and takes the rightmost forwarded address when evaluating the request address. An additional load balancer or CDN changes the proxy chain; have DevOps set the value for the known trusted topology. It is not a guarantee of the original visitor IP for every proxy arrangement. Keep `CLIENT_ORIGIN` exact so browser-origin checks remain independent of forwarded host headers.

No administrator login environment settings are required. The existing fixed administrator account and backend salted password hash remain in use. Database credentials are entirely backend runtime settings; they must never be frontend `VITE_*` values.

## 6. Verify manually after deployment

Replace `SERVICE-HOST.run.app` with the actual service host. In a browser, check the public form at `/`, open `/login` directly, sign in, and refresh `/admin`. Confirm the response list and CSV download work. Check that light mode uses the black-wordmark logo, dark mode uses the white-wordmark logo, and the browser loads the Daisy favicons. Scroll to the interest options and toggle both checkbox squares and labels; the page should stay at its current position. Sign out and confirm administrator access requires sign-in again. A deliberate sample inquiry writes a real record, so label it clearly and follow your normal data-handling process.

Optional read-only checks from Cloud Shell:

```sh
curl --fail https://SERVICE-HOST.run.app/api/health
curl --fail https://SERVICE-HOST.run.app/
curl --fail https://SERVICE-HOST.run.app/login
curl --fail https://SERVICE-HOST.run.app/admin
curl --include https://SERVICE-HOST.run.app/api/admin/session
curl --include https://SERVICE-HOST.run.app/api/inquiries
curl --include https://SERVICE-HOST.run.app/assets/does-not-exist.js
curl --head 'https://SERVICE-HOST.run.app/daisy-gci-event-form/login/?check=1'
curl --include https://SERVICE-HOST.run.app/daisy-gci-event-form/api/health
curl --include https://SERVICE-HOST.run.app/daisy-gci-event-form/assets/does-not-exist.js
```

Expect a healthy response from `/api/health`, frontend HTML from the three root page routes, `401` from unauthenticated administrator/session and inquiry-list requests, and `404` for a missing root asset. The legacy login check returns `301` with `Location: /login?check=1`. The old prefixed API and asset checks return `404`. Unknown API routes remain API errors rather than serving frontend HTML.

With `APP_BASE_PATH=/`, only legacy `GET` and `HEAD` page URLs at `/daisy-gci-event-form` (with or without its trailing slash), `/daisy-gci-event-form/login`, and `/daisy-gci-event-form/admin` redirect permanently (`301`) to `/`, `/login`, and `/admin`, preserving query strings. Legacy login/admin URLs also accept a trailing slash. Old prefixed API, assets, and unknown page paths are not redirected and return `404`. These root-migration redirects are disabled for a custom non-root `APP_BASE_PATH`, whose frontend build base must match.

Sessions expire after 12 hours and logout revokes them. PostgreSQL sessions and sign-in attempt limits are shared across instances and survive restarts, so a new revision alone does not sign out existing sessions. Cookie security requires HTTPS in production. Read Cloud Run logs for startup or database errors; do not put credentials into diagnostic output.

The current application initializes PostgreSQL before listening on its HTTP port. A database failure during startup causes the process to exit and the new Cloud Run revision to fail readiness. If PostgreSQL becomes unavailable after startup, the process normally keeps serving static pages, database operations return errors, and `/api/health` returns `503`; the pool can reconnect on later requests when access is restored.

If startup reports `ENOENT` for `/cloudsql/.../.s.PGSQL.5432`, the configured socket is absent. For this private-IP-only instance, use the v4 image with `DB_HOST=10.64.1.34`, verified TLS, approved VPC connectivity, and the existing password settings. A timeout requires checking the VPC route, Shared VPC permissions, and firewall access.

An error such as `no pg_hba.conf entry ... no encryption` means PostgreSQL was reachable but rejected an unencrypted connection. Select the v4 image with its retained `verify-full` default and retain the instance's `ENCRYPTED_ONLY` policy. Certificate-chain, expiry, or hostname errors require checking the trusted CA bundle and the exact confirmed `DB_SSL_SERVERNAME`; startup should fail until verification succeeds. A successful startup and healthy `/api/health` confirm that the new revision initialized its database connection.

## Existing records, backups, and later revisions

A fresh database needs no import. To migrate records, stop the old writer before producing the final private JSON export or consistent SQLite snapshot. Keep its original copy. From a trusted maintenance machine with PostgreSQL access and the destination `DB_*` runtime settings configured privately, run one of:

```sh
cd Daisy_form_backend
npm ci
npm run import:postgres -- /private/path/to/inquiries.json
# Or read an existing SQLite database without modifying it:
npm run import:postgres -- --sqlite /private/path/to/inquiries.sqlite
```

The PostgreSQL importer validates records, preserves IDs and timestamps, skips IDs already present, and imports transactionally. Keep the source file and credentials outside the upload ZIP and image. The app can begin with an empty PostgreSQL database if no legacy records are needed.

For production recovery, use the existing Cloud SQL instance's managed backup and recovery policy, configured and verified by your administrator. The `npm run backup` and `npm run import:json` commands are **SQLite legacy tools**, not PostgreSQL backup commands. Container disk is ephemeral and is not the data store.

For later releases, build a new version tag, push it manually, and select that image in a new Cloud Run revision while retaining the runtime configuration and existing database. Verify the new revision before sending it normal traffic. A prior container image can be selected for a code rollback; review database compatibility before rolling back code after future schema changes. No cloud rollout, database creation, import, or backup is performed by these repository files.
