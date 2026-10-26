const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPostgresFixture } = require("./helpers/postgres");

const databaseTest = process.env.TEST_DATABASE_URL ? test : (name, fn) => test(name, {
  skip: "Set TEST_DATABASE_URL to a dedicated local PostgreSQL database to run real PostgreSQL integration tests",
}, fn);
const record = {
  id: "legacy-not-a-uuid", submittedAt: "2024-01-02T03:04:05.000Z",
  fullName: "Zoë", interests: ["exploring-ai"], extra: { historical: true },
};

async function open(options) {
  const { openPostgresStorage } = require("../src/postgres-storage");
  return openPostgresStorage(options);
}

test("PostgreSQL configuration rejects missing or malformed credentials before connecting", async () => {
  const good = { DB_HOST: "127.0.0.1", DB_NAME: "unused", DB_USER: "unused", DB_PASSWORD: "secret" };
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    for (const value of [undefined, "", 42]) {
      await assert.rejects(open({ env: { ...good, [key]: value } }), new RegExp(key));
    }
  }
  for (const port of ["abc", "0", "65536", "1.2"]) {
    await assert.rejects(open({ env: { ...good, DB_PORT: port } }), /DB_PORT/);
  }
  await assert.rejects(open({ env: good, schema: 'public"; DROP SCHEMA public; --' }), /schema/);
});

databaseTest("inquiries persist complete payloads and use date then ID ordering across independent pools", async (t) => {
  const { store, openStore } = await createPostgresFixture(t);
  const newer = { ...record, id: "a", submittedAt: "2025-03-04T05:06:07.000Z" };
  const tie = { ...newer, id: "z" };
  await store.saveInquiry(record);
  await store.saveInquiry(newer);
  await store.saveInquiry(tie);
  await assert.rejects(store.saveInquiry(record), { code: "23505" });
  await store.close();
  await store.close();
  const reopened = await openStore();
  assert.deepEqual(await reopened.listInquiries(), [tie, newer, record]);
  assert.equal(await reopened.isReady(), true);
  assert.equal(await store.isReady(), false);
});

databaseTest("parallel cold starts initialize the same empty schema without collisions", async (t) => {
  const { store, openStore, pool, schema } = await createPostgresFixture(t);
  await store.close();
  await pool.query(`DROP TABLE "${schema}".inquiries, "${schema}".admin_sessions, "${schema}".login_attempt_windows`);
  const stores = await Promise.all(Array.from({ length: 6 }, () => openStore()));
  assert.deepEqual(await Promise.all(stores.map((storage) => storage.isReady())), Array(6).fill(true));
  await stores[0].saveInquiry(record);
  assert.deepEqual(await stores[5].listInquiries(), [record]);
});

databaseTest("inquiry import skips duplicate IDs and rolls back an entire failing batch", async (t) => {
  const { store, pool, schema } = await createPostgresFixture(t);
  await store.saveInquiry(record);
  assert.equal(await store.importInquiries([record, { ...record, id: "second" }, { ...record, id: "second" }]), 1);
  assert.equal(await store.importInquiries([{ ...record, fullName: "must not overwrite" }]), 0);
  assert.deepEqual((await store.listInquiries()).find((row) => row.id === record.id), record);
  await pool.query(`CREATE FUNCTION "${schema}".reject_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.id = 'reject' THEN RAISE EXCEPTION 'rejected test record'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER reject_record BEFORE INSERT ON "${schema}".inquiries
    FOR EACH ROW EXECUTE FUNCTION "${schema}".reject_record()`);
  await assert.rejects(store.importInquiries([{ ...record, id: "first-new" }, { ...record, id: "reject" }]), /rejected test record/);
  assert.deepEqual((await store.listInquiries()).map((row) => row.id), ["second", "legacy-not-a-uuid"]);
});

databaseTest("sessions are shared, expire at their exact deadline, and can be deleted by another instance", async (t) => {
  const { store, openStore } = await createPostgresFixture(t);
  const other = await openStore();
  await store.saveSession("hash-a", "admin@example.com", 5000);
  assert.deepEqual(await other.getSession("hash-a", 4999), { email: "admin@example.com", expiresAt: 5000 });
  assert.equal(await other.getSession("hash-a", 5000), undefined);
  await store.saveSession("hash-b", "admin@example.com", 15000);
  await other.deleteSession("hash-b");
  assert.equal(await store.getSession("hash-b", 5001), undefined);
});

databaseTest("parallel shared login reservations cap failures plus pending work at ten", async (t) => {
  const { store, openStore } = await createPostgresFixture(t);
  const other = await openStore();
  const results = await Promise.all(Array.from({ length: 24 }, (_, i) =>
    (i % 2 ? store : other).reserveLoginAttempt("address-hash", 1000000)));
  const accepted = results.filter((result) => result.windowId);
  assert.equal(accepted.length, 10);
  assert.deepEqual(results.filter((result) => !result.windowId), Array(14).fill({ retryAfter: 900 }));
  await Promise.all(accepted.map(({ windowId }) => other.completeLoginAttempt("address-hash", windowId, false, 1000100)));
  assert.deepEqual(await store.reserveLoginAttempt("address-hash", 1001000), { retryAfter: 899 });
});

databaseTest("approved attempts release capacity and stale completions cannot affect a new window", async (t) => {
  const { store, openStore } = await createPostgresFixture(t);
  const other = await openStore();
  const first = await store.reserveLoginAttempt("address-hash", 1000);
  await other.completeLoginAttempt("address-hash", first.windowId, true, 1001);
  const results = await Promise.all(Array.from({ length: 10 }, () => store.reserveLoginAttempt("address-hash", 1002)));
  assert.equal(results.filter((result) => result.windowId).length, 10);
  const rollover = await other.reserveLoginAttempt("address-hash", 901000);
  assert.ok(rollover.windowId);
  assert.notEqual(rollover.windowId, first.windowId);
  await store.completeLoginAttempt("address-hash", first.windowId, false, 901001);
  await other.completeLoginAttempt("address-hash", rollover.windowId, true, 901002);
  const next = await Promise.all(Array.from({ length: 10 }, () => other.reserveLoginAttempt("address-hash", 901003)));
  assert.equal(next.filter((result) => result.windowId).length, 10);
  assert.deepEqual(await store.reserveLoginAttempt("address-hash", 901003), { retryAfter: 900 });
});

databaseTest("health reflects a real database failure and close remains idempotent", async (t) => {
  const { store, pool, schema } = await createPostgresFixture(t);
  await pool.query(`DROP TABLE "${schema}".inquiries`);
  assert.equal(await store.isReady(), false);
  await store.close();
  await store.close();
  assert.equal(await store.isReady(), false);
});

test("dedicated PostgreSQL test command fails clearly without a local test URL", () => {
  const { spawnSync } = require("node:child_process");
  const path = require("node:path");
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  const result = spawnSync(process.execPath, [path.resolve(__dirname, "../scripts/run-postgres-checks.js")], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TEST_DATABASE_URL.*local PostgreSQL/);
});

test("PostgreSQL import validates every JSON or read-only SQLite record before opening a destination", async (t) => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const Database = require("better-sqlite3");
  const { readPostgresImportSource, importPostgres } = require("../src/postgres-import");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-pg-import-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "legacy.json");
  const original = JSON.stringify([record]);
  await fs.writeFile(source, original);
  assert.deepEqual(await readPostgresImportSource(source), [record]);
  assert.equal(await fs.readFile(source, "utf8"), original);
  await fs.writeFile(source, JSON.stringify([record, { ...record, id: "invalid", submittedAt: "yesterday" }]));
  await assert.rejects(importPostgres({ source, env: {} }), /Record 2: submittedAt/);
  await fs.writeFile(source, "{}");
  await assert.rejects(readPostgresImportSource(source), /JSON array/);
  await fs.writeFile(source, "{");
  await assert.rejects(readPostgresImportSource(source), /valid JSON/);
  const sqlite = path.join(directory, "source.sqlite");
  const database = new Database(sqlite);
  database.exec("CREATE TABLE inquiries (payload TEXT NOT NULL)");
  database.prepare("INSERT INTO inquiries (payload) VALUES (?)").run(original.slice(1, -1));
  database.close();
  const before = await fs.readFile(sqlite);
  assert.deepEqual(await readPostgresImportSource(sqlite, { sqlite: true }), [record]);
  assert.deepEqual(await fs.readFile(sqlite), before);
  await assert.rejects(readPostgresImportSource(path.join(directory, "missing.sqlite"), { sqlite: true }));
  await assert.rejects(fs.stat(path.join(directory, "missing.sqlite")), { code: "ENOENT" });
});

databaseTest("JSON and SQLite migration preserve complete records and skip IDs on repeated import", async (t) => {
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const Database = require("better-sqlite3");
  const { importPostgres } = require("../src/postgres-import");
  const { store, env, schema } = await createPostgresFixture(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-pg-migration-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = path.join(directory, "legacy.json");
  const original = JSON.stringify([record]);
  await fs.writeFile(source, original);
  assert.deepEqual(await importPostgres({ source, env, schema }), { imported: 1, skipped: 0 });
  assert.deepEqual(await importPostgres({ source, env, schema }), { imported: 0, skipped: 1 });
  const sqlite = path.join(directory, "source.sqlite");
  const database = new Database(sqlite);
  database.exec("CREATE TABLE inquiries (payload TEXT NOT NULL)");
  database.prepare("INSERT INTO inquiries (payload) VALUES (?)").run(JSON.stringify({ ...record, id: "sqlite-id" }));
  database.close();
  const before = await fs.readFile(sqlite);
  assert.deepEqual(await importPostgres({ source: sqlite, sqlite: true, env, schema }), { imported: 1, skipped: 0 });
  assert.deepEqual((await store.listInquiries()).map((row) => row.id), ["sqlite-id", "legacy-not-a-uuid"]);
  assert.equal(await fs.readFile(source, "utf8"), original);
  assert.deepEqual(await fs.readFile(sqlite), before);
});

test("PostgreSQL migration CLI rejects invalid input before connecting and leaves source untouched", async (t) => {
  const { spawnSync } = require("node:child_process");
  const fs = require("node:fs/promises");
  const path = require("node:path");
  const os = require("node:os");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-pg-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.resolve(__dirname, "../scripts/import-postgres.js");
  for (const args of [[], ["--sqlite"], ["a", "b"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: directory, env: {}, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const source = path.join(directory, "invalid.json");
  const contents = JSON.stringify([record, { ...record, id: "invalid", interests: "not-an-array" }]);
  await fs.writeFile(source, contents);
  const result = spawnSync(process.execPath, [script, source], { cwd: directory, env: {}, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Import failed: Record 2: interests/);
  assert.doesNotMatch(result.stderr, /\n\s+at /);
  assert.equal(await fs.readFile(source, "utf8"), contents);
});

test("PostgreSQL startup rejects a failed connection without leaking the password", async () => {
  const secret = "never-log-this-password";
  await assert.rejects(open({ env: {
    DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "unused", DB_USER: "unused", DB_PASSWORD: secret,
  } }), (error) => {
    assert.equal(error.code, "ECONNREFUSED");
    assert.ok(!error.message.includes(secret));
    return true;
  });
});

databaseTest("request-driven cleanup removes expired state while preserving live windows and sessions", async (t) => {
  const { store, pool, schema } = await createPostgresFixture(t);
  await store.saveSession("expired", "admin@example.com", 1000);
  await store.saveSession("live", "admin@example.com", 5000000);
  const old = await store.reserveLoginAttempt("old-address", 0);
  const live = await store.reserveLoginAttempt("live-address", 1800000);
  await store.completeLoginAttempt("live-address", live.windowId, false, 1800001);
  assert.deepEqual(await store.getSession("live", 2000000), { email: "admin@example.com", expiresAt: 5000000 });
  await store.reserveLoginAttempt("new-address", 2000000);
  assert.equal((await pool.query(`SELECT 1 FROM "${schema}".admin_sessions WHERE token_hash = $1`, ["expired"])).rowCount, 0);
  assert.equal((await pool.query(`SELECT 1 FROM "${schema}".login_attempt_windows WHERE address_key = $1`, ["old-address"])).rowCount, 0);
  await store.completeLoginAttempt("old-address", old.windowId, false, 2000001);
  const reservations = await Promise.all(Array.from({ length: 10 }, () => store.reserveLoginAttempt("live-address", 2000002)));
  assert.equal(reservations.filter((result) => result.windowId).length, 9);
});

databaseTest("idle connection loss is handled without secret-bearing logs and the pool reconnects", async (t) => {
  const messages = [];
  const { store, openStore, pool, schema, env } = await createPostgresFixture(t);
  await store.close();
  const recovering = await openStore({ logger: { error: (...args) => messages.push(args.join(" ")) } });
  assert.equal(await recovering.isReady(), true);
  const terminated = await pool.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state = 'idle' AND query LIKE $1`, [`%${schema}%`]);
  assert.ok(terminated.rowCount >= 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await recovering.isReady(), true);
  assert.ok(messages.length >= 1);
  assert.ok(messages.every((message) => !message.includes(env.DB_PASSWORD)));
});
