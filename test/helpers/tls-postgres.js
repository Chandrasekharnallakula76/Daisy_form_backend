const { randomUUID } = require("node:crypto");
const { readFileSync } = require("node:fs");

function tlsTestDatabaseEnv(source = process.env) {
  if (!source.TEST_TLS_DATABASE_URL) {
    throw new Error("TEST_TLS_DATABASE_URL must point to a dedicated local PostgreSQL TLS test database");
  }
  const url = new URL(source.TEST_TLS_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("TEST_TLS_DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("TEST_TLS_DATABASE_URL must point to localhost; production and Cloud SQL are never test targets");
  }
  for (const name of ["TLS_TEST_CA_PATH", "TLS_TEST_SERVERNAME"]) {
    if (typeof source[name] !== "string" || !source[name].trim()) {
      throw new Error(`${name} is required for local PostgreSQL TLS integration tests`);
    }
  }
  return {
    DB_HOST: url.hostname === "[::1]" ? "::1" : url.hostname,
    DB_PORT: url.port || "5432",
    DB_NAME: decodeURIComponent(url.pathname.slice(1)),
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
    DB_SSL_MODE: "verify-full",
    DB_SSL_CA_PATH: source.TLS_TEST_CA_PATH,
    DB_SSL_SERVERNAME: source.TLS_TEST_SERVERNAME,
  };
}

async function createTlsPostgresFixture(t) {
  const { Pool } = require("pg");
  const env = tlsTestDatabaseEnv();
  const schema = `daisy_tls_test_${randomUUID().replaceAll("-", "")}`;
  // Bootstrap independently of the application TLS helper, so a broken helper
  // cannot make fixture setup and the application agree on insecure options.
  const pool = new Pool({
    host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD, max: 1,
    connectionTimeoutMillis: 5000, statement_timeout: 10000,
    ssl: {
      ca: readFileSync(env.DB_SSL_CA_PATH, "utf8"),
      servername: env.DB_SSL_SERVERNAME,
      rejectUnauthorized: true,
    },
  });
  const stores = [];
  let created = false;
  t.after(async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    try {
      if (created) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await pool.end();
    }
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  async function openStore(overrides = {}) {
    const { openPostgresStorage } = require("../../src/postgres-storage");
    const store = await openPostgresStorage({ env: { ...env, ...overrides }, schema });
    stores.push(store);
    return store;
  }
  return { env, schema, pool, openStore };
}

async function withAmbientPgSslMode(mode, work) {
  const before = process.env.PGSSLMODE;
  process.env.PGSSLMODE = mode;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.PGSSLMODE;
    else process.env.PGSSLMODE = before;
  }
}

module.exports = { createTlsPostgresFixture, tlsTestDatabaseEnv, withAmbientPgSslMode };
