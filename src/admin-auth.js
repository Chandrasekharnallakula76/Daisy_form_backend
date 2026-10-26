const { createHash, randomBytes, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");

const deriveKey = promisify(scrypt);
const SESSION_TTL = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const MAX_ENTRIES = 10000;

// The fixed account contains only a salt and derived key, never a plaintext password.
const FIXED_ACCOUNT = {
  "email": "admin@daisyai.com",
  "salt": "af40367420a861b2e405c1b0c088a80a",
  "hash": "a72d7310317651f311d30cfac0c6965ca19b431255666af29aa4b8ea671db2f2c8a9b83f38555bc48647209c8da2bd46ba95082dfd837fc372f5c0c1e11122af"
};

function createAdminAuth({ account = FIXED_ACCOUNT, now = Date.now, stateStore } = {}) {
  const expectedHash = Buffer.from(account.hash, "hex");
  const sessions = new Map();
  const attempts = new Map();

  function cleanExpired() {
    const time = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(token);
    }
    for (const [address, attempt] of attempts) {
      if (attempt.startedAt + FAILURE_WINDOW <= time) attempts.delete(address);
    }
  }

  function reserveEntry(map) {
    if (map.size >= MAX_ENTRIES) {
      cleanExpired();
      if (map.size >= MAX_ENTRIES) map.delete(map.keys().next().value);
    }
  }

  const cleanupTimer = stateStore ? undefined : setInterval(cleanExpired, 60 * 1000);
  cleanupTimer?.unref();
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const validToken = (token) => typeof token === "string" && /^[a-f0-9]{64}$/.test(token);

  return {
    email: account.email,

    async verifyCredentials(email, password) {
      if (typeof email !== "string" || typeof password !== "string") return false;
      const candidate = await deriveKey(password, account.salt, 64);
      const passwordMatches = expectedHash.length === candidate.length && timingSafeEqual(candidate, expectedHash);
      return email.trim().toLowerCase() === account.email && passwordMatches;
    },

    async beginAttempt(address) {
      const addressKey = digest(typeof address === "string" ? address : "unknown");
      if (stateStore) {
        const reservation = await stateStore.reserveLoginAttempt(addressKey, now());
        if (reservation.retryAfter) return reservation;
        let completed = false;
        return {
          async complete(approved) {
            if (completed) return;
            completed = true;
            await stateStore.completeLoginAttempt(addressKey, reservation.windowId, approved, now());
          },
        };
      }
      address = addressKey;
      let attempt = attempts.get(address);
      const time = now();
      if (attempt && attempt.startedAt + FAILURE_WINDOW <= time) {
        attempts.delete(address);
        attempt = undefined;
      }
      if (!attempt) {
        reserveEntry(attempts);
        attempt = { failures: 0, pending: 0, startedAt: time };
        attempts.set(address, attempt);
      }
      if (attempt.failures + attempt.pending >= MAX_FAILURES) {
        return { retryAfter: Math.max(1, Math.ceil((attempt.startedAt + FAILURE_WINDOW - time) / 1000)) };
      }
      attempt.pending += 1;
      let completed = false;
      return {
        async complete(approved) {
          if (completed) return;
          completed = true;
          if (attempts.get(address) !== attempt) return;
          attempt.pending -= 1;
          if (!approved) attempt.failures += 1;
          if (!attempt.failures && !attempt.pending) attempts.delete(address);
        },
      };
    },

    async createSession() {
      if (!stateStore) reserveEntry(sessions);
      const token = randomBytes(32).toString("hex");
      const session = { email: account.email, expiresAt: now() + SESSION_TTL };
      if (stateStore) await stateStore.saveSession(digest(token), session.email, session.expiresAt);
      else sessions.set(digest(token), session);
      return { token, ...session };
    },

    async getSession(token) {
      if (!validToken(token)) return undefined;
      token = digest(token);
      if (stateStore) return stateStore.getSession(token, now());
      const session = sessions.get(token);
      if (session && session.expiresAt <= now()) {
        sessions.delete(token);
        return undefined;
      }
      return session;
    },

    async deleteSession(token) {
      if (!validToken(token)) return;
      token = digest(token);
      if (stateStore) await stateStore.deleteSession(token);
      else sessions.delete(token);
    },

    close() {
      clearInterval(cleanupTimer);
      sessions.clear();
      attempts.clear();
    },
  };
}

module.exports = { createAdminAuth, SESSION_TTL };
