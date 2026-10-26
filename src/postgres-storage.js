const { randomUUID } = require("node:crypto");
const { Pool } = require("pg");
const { getPostgresTlsOptions } = require("./postgres-tls");

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPT_LIMIT = 10;

function postgresConfig(env) {
  for (const name of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (typeof env[name] !== "string" || !env[name].trim()) {
      throw new Error(`${name} is required and must be a non-empty string`);
    }
  }
  const port = env.DB_PORT === undefined ? "5432" : env.DB_PORT;
  if (typeof port !== "string" || !/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error("DB_PORT must be an integer from 1 to 65535");
  }
  return {
    host: env.DB_HOST, port: Number(port), database: env.DB_NAME,
    user: env.DB_USER, password: env.DB_PASSWORD,
    max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    ssl: getPostgresTlsOptions(env),
  };
}

/**
 * PostgreSQL-backed inquiry storage and shared admin state. Every mutation resolves
 * after PostgreSQL commits. Callers store only hashes of session tokens and client
 * addresses, and complete each reserved login attempt once outside password work.
 */
async function openPostgresStorage({ env = process.env, logger = console, schema = "public" } = {}) {
  if (typeof schema !== "string" || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) {
    throw new Error("PostgreSQL schema must be a valid identifier of at most 63 characters");
  }
  const pool = new Pool(postgresConfig(env));
  pool.on("error", () => logger.error?.("PostgreSQL idle connection lost; requests will reconnect"));
  const inquiries = `"${schema}".inquiries`;
  const sessions = `"${schema}".admin_sessions`;
  const windows = `"${schema}".login_attempt_windows`;
  let closed = false;
  let closePromise;

  async function transaction(work) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* Keep the original failure. */ }
      throw error;
    } finally { client.release(); }
  }

  try {
    await transaction(async (client) => {
      // Serialize schema initialization across Cloud Run instances without a
      // separate lock service or destructive migrations.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1)::bigint)", [`daisy-form:${schema}`]);
      await client.query(`CREATE TABLE IF NOT EXISTS ${inquiries} (
        id TEXT PRIMARY KEY NOT NULL,
        submitted_at TIMESTAMPTZ NOT NULL,
        payload JSONB NOT NULL
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS inquiries_newest_idx ON ${inquiries}
        (submitted_at DESC, id COLLATE "C" DESC)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${sessions} (
        token_hash TEXT PRIMARY KEY NOT NULL,
        email TEXT NOT NULL,
        expires_at_ms BIGINT NOT NULL
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON ${sessions} (expires_at_ms)`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${windows} (
        address_key TEXT PRIMARY KEY NOT NULL,
        window_id UUID NOT NULL,
        start_ms BIGINT NOT NULL,
        failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
        pending INTEGER NOT NULL DEFAULT 0 CHECK (pending >= 0),
        CHECK (failures + pending <= ${LOGIN_ATTEMPT_LIMIT})
      )`);
      await client.query(`CREATE INDEX IF NOT EXISTS login_attempt_windows_start_idx ON ${windows} (start_ms)`);
    });
  } catch (error) {
    await pool.end();
    throw error;
  }

  async function cleanupSessions(nowMs) {
    await pool.query(`WITH expired AS (
      SELECT token_hash FROM ${sessions} WHERE expires_at_ms <= $1
      ORDER BY expires_at_ms LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${sessions} USING expired WHERE ${sessions}.token_hash = expired.token_hash`, [nowMs]);
  }

  async function cleanupWindows(nowMs) {
    // Cleanup is bounded and skips busy rows. An active window is never deleted;
    // correctness and crash recovery use the stored window's expiration itself.
    await pool.query(`WITH expired AS (
      SELECT address_key FROM ${windows} WHERE start_ms <= $1
      ORDER BY start_ms LIMIT 100 FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${windows} USING expired WHERE ${windows}.address_key = expired.address_key`, [nowMs - LOGIN_WINDOW_MS]);
  }

  return {
    async saveInquiry(inquiry) {
      await pool.query(`INSERT INTO ${inquiries} (id, submitted_at, payload) VALUES ($1, $2, $3::jsonb)`,
        [inquiry.id, inquiry.submittedAt, JSON.stringify(inquiry)]);
    },
    async listInquiries() {
      const result = await pool.query(`SELECT payload FROM ${inquiries} ORDER BY submitted_at DESC, id COLLATE "C" DESC`);
      return result.rows.map(({ payload }) => payload);
    },
    async importInquiries(records) {
      return transaction(async (client) => {
        let imported = 0;
        for (const inquiry of records) {
          const result = await client.query(`INSERT INTO ${inquiries} (id, submitted_at, payload)
            VALUES ($1, $2, $3::jsonb) ON CONFLICT (id) DO NOTHING`,
          [inquiry.id, inquiry.submittedAt, JSON.stringify(inquiry)]);
          imported += result.rowCount;
        }
        return imported;
      });
    },
    async isReady() {
      if (closed) return false;
      try {
        await pool.query(`SELECT 1 FROM ${inquiries} LIMIT 1`);
        return true;
      } catch { return false; }
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = pool.end();
      }
      return closePromise;
    },
    async saveSession(tokenHash, email, expiresAtMs) {
      await pool.query(`INSERT INTO ${sessions} (token_hash, email, expires_at_ms) VALUES ($1, $2, $3)
        ON CONFLICT (token_hash) DO UPDATE SET email = EXCLUDED.email, expires_at_ms = EXCLUDED.expires_at_ms`,
      [tokenHash, email, expiresAtMs]);
    },
    async getSession(tokenHash, nowMs) {
      const result = await pool.query(`SELECT email, expires_at_ms FROM ${sessions}
        WHERE token_hash = $1 AND expires_at_ms > $2`, [tokenHash, nowMs]);
      await cleanupSessions(nowMs);
      if (!result.rows.length) return undefined;
      return { email: result.rows[0].email, expiresAt: Number(result.rows[0].expires_at_ms) };
    },
    async deleteSession(tokenHash) {
      await pool.query(`DELETE FROM ${sessions} WHERE token_hash = $1`, [tokenHash]);
    },
    async reserveLoginAttempt(addressKey, nowMs) {
      await cleanupWindows(nowMs);
      return transaction(async (client) => {
        await client.query(`INSERT INTO ${windows} (address_key, window_id, start_ms)
          VALUES ($1, $2, $3) ON CONFLICT (address_key) DO NOTHING`, [addressKey, randomUUID(), nowMs]);
        const result = await client.query(`SELECT window_id, start_ms, failures, pending FROM ${windows}
          WHERE address_key = $1 FOR UPDATE`, [addressKey]);
        let window = result.rows[0];
        if (nowMs - Number(window.start_ms) >= LOGIN_WINDOW_MS) {
          const updated = await client.query(`UPDATE ${windows} SET window_id = $2, start_ms = $3,
            failures = 0, pending = 0 WHERE address_key = $1 RETURNING window_id, start_ms, failures, pending`,
          [addressKey, randomUUID(), nowMs]);
          window = updated.rows[0];
        }
        if (window.failures + window.pending >= LOGIN_ATTEMPT_LIMIT) {
          return { retryAfter: Math.max(1, Math.ceil((Number(window.start_ms) + LOGIN_WINDOW_MS - nowMs) / 1000)) };
        }
        await client.query(`UPDATE ${windows} SET pending = pending + 1 WHERE address_key = $1`, [addressKey]);
        return { windowId: window.window_id };
      });
    },
    async completeLoginAttempt(addressKey, windowId, approved, nowMs) {
      await pool.query(`UPDATE ${windows} SET pending = pending - 1, failures = failures + $3
        WHERE address_key = $1 AND window_id = $2 AND pending > 0 AND start_ms > $4`,
      [addressKey, windowId, approved ? 0 : 1, nowMs - LOGIN_WINDOW_MS]);
    },
  };
}

module.exports = { openPostgresStorage };
