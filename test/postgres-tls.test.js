const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { test } = require("node:test");

const servername = "0ede6ea68d67.1rm5nct1ov6wn.northamerica-northeast1.sql-psa.goog";

function options(env) {
  const { getPostgresTlsOptions } = require("../src/postgres-tls");
  return getPostgresTlsOptions(env);
}

function certificateFixture(t, contents = tls.rootCertificates[0]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "daisy-pg-ca-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, "ca.pem");
  fs.writeFileSync(filename, contents);
  return filename;
}

test("PostgreSQL rejects an unsupported TLS mode before attempting a connection", async () => {
  const { openPostgresStorage } = require("../src/postgres-storage");
  await assert.rejects(openPostgresStorage({ env: {
    DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "unused", DB_USER: "unused", DB_PASSWORD: "test-only",
    DB_SSL_MODE: "no-verify",
  } }), /DB_SSL_MODE/);
});

test("unset TLS mode preserves pg environment defaults and explicit disable requires no CA", () => {
  assert.equal(options({}), undefined);
  assert.equal(options({ DB_SSL_CA_PATH: "/missing/ca.pem", DB_SSL_SERVERNAME: "invalid/name" }), undefined);
  assert.equal(options({ DB_SSL_MODE: "disable", DB_SSL_CA_PATH: "/missing/ca.pem" }), false);
});

test("TLS mode accepts only disable or verify-full", () => {
  for (const mode of ["", "require", "verify-ca", "no-verify", "VERIFY-FULL", " verify-full ", 1, null]) {
    assert.throws(() => options({ DB_SSL_MODE: mode }), /DB_SSL_MODE/);
  }
});

test("verified TLS requires a DNS server name before reading the CA", () => {
  for (const name of [undefined, null, 1, "", " ", "10.64.1.34", "::1", "[::1]", "127.1", "https://sql.example.com",
    "sql.example.com:5432", "sql.example.com/path", "*.example.com", "sql_example.com", "sql..example.com",
    "-sql.example.com", "sql-.example.com", "sql.example.com..", " sql.example.com", "sql.example.com ",
    `${"a".repeat(64)}.example.com`, `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`]) {
    assert.throws(() => options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: name }), /DB_SSL_SERVERNAME/);
  }
});

test("verified TLS loads a custom CA and preserves normal hostname verification", (t) => {
  const filename = certificateFixture(t);
  const result = options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: `${servername}.`, DB_SSL_CA_PATH: filename });
  assert.equal(result.ca, tls.rootCertificates[0]);
  assert.equal(result.servername, servername);
  assert.equal(result.rejectUnauthorized, true);
  assert.equal(result.checkServerIdentity, undefined);
  tls.createSecureContext(result);
  fs.unlinkSync(filename);
  assert.equal(result.ca, tls.rootCertificates[0]);
});

test("verified TLS uses the bundled Cloud SQL CA when a custom path is absent", () => {
  const result = options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: servername });
  assert.equal(result.ca, fs.readFileSync(path.resolve(__dirname, "../src/certs/cloudsql-northamerica-northeast1.crt"), "utf8"));
  assert.equal(result.servername, servername);
  assert.equal(result.rejectUnauthorized, true);
  tls.createSecureContext(result);
});

test("verified TLS fails closed for unreadable or invalid CA paths", () => {
  for (const filename of ["/missing/daisy-ca.pem", "", " ", 1, null, __dirname]) {
    assert.throws(() => options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: servername, DB_SSL_CA_PATH: filename }), /DB_SSL_CA_PATH/);
  }
});

test("verified TLS rejects empty, malformed, or partially malformed certificate bundles without echoing their contents", (t) => {
  for (const contents of ["", " \n", "invalid-public-ca-marker", "-----BEGIN CERTIFICATE-----\ninvalid-public-ca-marker\n-----END CERTIFICATE-----",
    `${tls.rootCertificates[0]}\ninvalid-public-ca-marker`, `${tls.rootCertificates[0]}\n-----BEGIN CERTIFICATE-----\ninvalid-public-ca-marker\n-----END CERTIFICATE-----`]) {
    const filename = certificateFixture(t, contents);
    assert.throws(() => options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: servername, DB_SSL_CA_PATH: filename }), (error) => {
      assert.match(error.message, /DB_SSL_CA_PATH/);
      assert.ok(!error.message.includes("invalid-public-ca-marker"));
      return true;
    });
  }
});

test("verified TLS accepts a bundle containing multiple valid CA certificates", (t) => {
  const bundle = `${tls.rootCertificates[0]}\n${tls.rootCertificates[1]}\n`;
  const filename = certificateFixture(t, bundle);
  const result = options({ DB_SSL_MODE: "verify-full", DB_SSL_SERVERNAME: servername, DB_SSL_CA_PATH: filename });
  assert.equal(result.ca, bundle);
  tls.createSecureContext(result);
});
