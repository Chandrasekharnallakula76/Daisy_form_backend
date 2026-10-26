const { randomUUID } = require("node:crypto");

function testDatabaseEnv() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("TEST_DATABASE_URL must point to a dedicated local PostgreSQL test database");
  }
  const url = new URL(process.env.TEST_DATABASE_URL);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("TEST_DATABASE_URL must use postgres:// or postgresql://");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("TEST_DATABASE_URL must point to localhost; production and Cloud SQL are never test targets");
  }
  return {
    DB_HOST: url.hostname === "[::1]" ? "::1" : url.hostname,
    DB_PORT: url.port || "5432",
    DB_NAME: decodeURIComponent(url.pathname.slice(1)),
    DB_USER: decodeURIComponent(url.username),
    DB_PASSWORD: decodeURIComponent(url.password),
  };
}

async function createPostgresFixture(t) {
  const { Pool } = require("pg");
  const env = testDatabaseEnv();
  const schema = `daisy_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new Pool({
    host: env.DB_HOST, port: Number(env.DB_PORT), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD, max: 3,
    connectionTimeoutMillis: 5000, statement_timeout: 10000,
  });
  const stores = [];
  t.after(async () => {
    await Promise.allSettled(stores.map((store) => store.close()));
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  });
  await pool.query(`CREATE SCHEMA "${schema}"`);
  async function openStore(options = {}) {
    const { openPostgresStorage } = require("../../src/postgres-storage");
    const store = await openPostgresStorage({ env, schema, ...options });
    stores.push(store);
    return store;
  }
  const store = await openStore();
  return { store, openStore, env, schema, pool };
}

module.exports = { createPostgresFixture, testDatabaseEnv };
