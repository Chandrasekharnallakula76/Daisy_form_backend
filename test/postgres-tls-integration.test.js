const assert = require("node:assert/strict");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const tls = require("node:tls");
const { test } = require("node:test");
const { createApp } = require("../src/app");
const { createTlsPostgresFixture, tlsTestDatabaseEnv, withAmbientPgSslMode } = require("./helpers/tls-postgres");

const tlsOptions = {
  skip: process.env.TEST_TLS_DATABASE_URL ? false :
    "Set TEST_TLS_DATABASE_URL, TLS_TEST_CA_PATH and TLS_TEST_SERVERNAME for real local PostgreSQL TLS integration",
};
const inquiry = {
  fullName: "TLS Integration", companyOrganization: "Local fixture",
  businessEmail: "tls@example.com", interests: ["product-demo"],
  preferredFollowUpMethods: ["email"],
};

test("TLS integration fixtures refuse remote PostgreSQL targets before any connection", () => {
  for (const hostname of ["db.example.com", "10.0.0.3", "127.0.0.1.example.com"]) {
    assert.throws(() => tlsTestDatabaseEnv({
      TEST_TLS_DATABASE_URL: `postgres://fixture:fixture@${hostname}/daisy_tls_test`,
      TLS_TEST_CA_PATH: "/unused/public-test-ca.pem", TLS_TEST_SERVERNAME: "daisy-postgres.test",
    }), /localhost/);
  }
});

test("verified PostgreSQL TLS persists an API inquiry and shared sessions across independent pools", tlsOptions, async (t) => {
  const { openStore, pool, schema } = await createTlsPostgresFixture(t);
  const store = await openStore();
  const app = createApp({ store, nodeEnv: "test", logger: { error() {} } });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await app.locals.close();
  });
  await once(server, "listening");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/inquiries`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inquiry),
  });
  assert.equal(response.status, 201);
  const saved = (await response.json()).inquiry;
  assert.equal(saved.businessEmail, "tls@example.com");
  await store.saveSession("tls-test-session-hash", "tls-admin@example.com", 5000);
  assert.equal(await store.isReady(), true);
  const connections = await pool.query(`SELECT s.ssl, s.version, s.cipher FROM pg_stat_activity a
    JOIN pg_stat_ssl s USING (pid) WHERE a.datname = current_database()
      AND a.pid <> pg_backend_pid() AND a.state = 'idle' AND a.query LIKE $1`, [`%"${schema}".%`]);
  assert.ok(connections.rowCount >= 1, "PostgreSQL must report the application pool connection");
  for (const connection of connections.rows) {
    assert.equal(connection.ssl, true, "application queries must cross a real TLS connection");
    assert.match(connection.version, /^TLSv1\.[23]$/);
    assert.ok(connection.cipher);
  }
  const other = await openStore();
  assert.deepEqual(await other.getSession("tls-test-session-hash", 4999), {
    email: "tls-admin@example.com", expiresAt: 5000,
  });
  await store.close();
  await other.close();
  const reopened = await openStore();
  assert.deepEqual(await reopened.listInquiries(), [saved]);
  assert.deepEqual(await reopened.getSession("tls-test-session-hash", 4999), {
    email: "tls-admin@example.com", expiresAt: 5000,
  });
  await reopened.deleteSession("tls-test-session-hash");
  assert.equal(await reopened.getSession("tls-test-session-hash", 4999), undefined);
});

test("the TLS-only PostgreSQL fixture rejects plaintext even with ambient PGSSLMODE=no-verify", tlsOptions, async (t) => {
  await withAmbientPgSslMode("no-verify", async () => {
    const { openStore } = await createTlsPostgresFixture(t);
    await assert.rejects(openStore({ DB_SSL_MODE: "disable" }), (error) => {
      assert.equal(error.code, "28000");
      assert.match(error.message, /no encryption|SSL off|SSL required/i);
      return true;
    });
  });
});

test("verified PostgreSQL TLS rejects an unrelated CA despite ambient PGSSLMODE=no-verify", tlsOptions, async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-tls-wrong-ca-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const wrongCaPath = path.join(directory, "unrelated-public-ca.pem");
  await fs.writeFile(wrongCaPath, tls.rootCertificates[0]);
  await withAmbientPgSslMode("no-verify", async () => {
    const { openStore } = await createTlsPostgresFixture(t);
    await assert.rejects(openStore({ DB_SSL_CA_PATH: wrongCaPath }), (error) => {
      assert.ok([
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_SIGNATURE_FAILURE",
      ].includes(error.code), `expected a certificate trust rejection, received ${error.code}`);
      return true;
    });
  });
});

test("verified PostgreSQL TLS uses Node hostname validation despite ambient PGSSLMODE=no-verify", tlsOptions, async (t) => {
  await withAmbientPgSslMode("no-verify", async () => {
    const { openStore } = await createTlsPostgresFixture(t);
    await assert.rejects(openStore({ DB_SSL_SERVERNAME: "wrong-postgres.test" }), {
      code: "ERR_TLS_CERT_ALTNAME_INVALID",
    });
  });
});
