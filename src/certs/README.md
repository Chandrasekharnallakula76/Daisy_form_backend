# Public Cloud SQL CA bundle

`cloudsql-northamerica-northeast1.crt` contains the public Google Cloud SQL regional CA bundle for `northamerica-northeast1`. It supports CA-chain verification for this instance's Google-managed shared CA; the application also verifies the configured server name. This is a CA trust bundle, not a pinned server leaf certificate. It contains no private key or credential.

- Official source: [Google regional CA bundle](https://storage.googleapis.com/cloudsql-ca-bundles/northamerica-northeast1.pem).
- Background: [Cloud SQL CA hierarchies and server identity verification](https://docs.cloud.google.com/sql/docs/postgres/authorize-ssl).
- Retrieved and checked: 2026-10-26.
- File size: 3,409 bytes; three PEM-encoded CA certificates, stored with a `.crt` extension.
- File SHA-256: `5709a1e3992c829883bb021074e23d9e423db3a2cd828f71ea4f3056f46b3e27`.

| Certificate common name | Expires (UTC) |
| --- | --- |
| Google Cloud SQL Sub Server CA c36a7c | 2034-07-02 06:18:34 |
| Google Cloud SQL Sub Server CA bf0ed5 | 2034-07-02 06:21:35 |
| Google Cloud SQL Root Server CA 0b29df | 2049-06-27 21:22:00 |

Refresh this public bundle from the official source as part of a reviewed release when Google updates its regional CA chain, and before the trusted certificates expire. Check the certificates, validity dates, and checksum, update this record, then rebuild and deploy the image. The application uses the packaged file and never downloads certificates at startup. `DB_SSL_CA_PATH` permits an explicit trusted-CA override.

The source packager and Dockerfile already include this `.crt` under `src/`. Keep their existing `*.pem`, `*.key`, and other private-credential exclusions intact. Store client keys and credentials outside the source tree and build context.
