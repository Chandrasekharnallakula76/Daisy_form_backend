const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash, scryptSync } = require("node:crypto");
const { test } = require("node:test");
const { createApp } = require("../src/app");
const { startServer } = require("../src/server");
const { createPostgresFixture } = require("./helpers/postgres");
const password = "integration-only password #9";
const account = { email: "fixture@example.com", salt: "cloud-run-test-salt", hash: scryptSync(password, "cloud-run-test-salt", 64).toString("hex") };
const inquiry = { fullName: "Ada Lovelace", companyOrganization: "Engines", businessEmail: "ada@example.com", interests: ["product-demo"], preferredFollowUpMethods: ["email"] };
const silent = { error() {}, log() {} };
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function serve(t, store, options = {}) {
  const app = createApp({ store, adminAccount: account, logger: silent, ...options });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let closed = false;
  async function close() { if (closed) return; closed = true; await new Promise((resolve) => server.close(resolve)); await app.locals.close(); }
  t.after(close);
  return { app, url: `http://127.0.0.1:${server.address().port}`, close };
}
function login(url, body = { email: account.email, password }, headers = {}) { return fetch(`${url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); }
function cookie(response) { return response.headers.get("set-cookie")?.split(";")[0]; }
function submit(url) { return fetch(`${url}/api/inquiries`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inquiry) }); }

// Removing await acknowledges the write while its durable transaction is still pending.
test("async inquiry writes wait for durable success and reject failed commits", async (t) => {
  let commit = deferred();
  let entered = deferred();
  const { url } = await serve(t, { isReady: async () => true, saveInquiry() { entered.resolve(); return commit.promise; }, listInquiries: async () => [] });
  let settled = false;
  const pending = submit(url).then((response) => { settled = true; return response; });
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(settled, false);
  commit.resolve();
  assert.equal((await pending).status, 201);
  commit = deferred(); entered = deferred();
  const failed = submit(url);
  await entered.promise;
  commit.reject(new Error("database write unavailable"));
  assert.equal((await failed).status, 500);
});

// A readiness Promise stays truthy even when its result is false.
test("async database readiness false or rejection returns 503", async (t) => {
  let reject = false;
  const { url } = await serve(t, { async isReady() { if (reject) throw new Error("offline"); return false; } });
  assert.equal((await fetch(`${url}/api/health`)).status, 503);
  reject = true;
  assert.equal((await fetch(`${url}/api/health`)).status, 503);
});

// A failed throttle or session commit must never approve authentication.
test("authentication fails closed when shared-state commits fail", async (t) => {
  let fail = "complete";
  const store = {
    async reserveLoginAttempt() { return { windowId: "window" }; },
    async completeLoginAttempt() { if (fail === "complete") throw new Error("offline"); },
    async saveSession() { throw new Error("offline"); }, async getSession() {}, async deleteSession() {},
    async isReady() { return true; }, async listInquiries() { return []; },
  };
  const { url } = await serve(t, store);
  for (const phase of ["complete", "session"]) {
    fail = phase;
    const response = await login(url);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("set-cookie"), null);
  }
  fail = "complete";
  const response = await fetch(`${url}/api/inquiries/export.csv`, { headers: { authorization: `Basic ${Buffer.from(`${account.email}:${password}`).toString("base64")}` } });
  assert.equal(response.status, 500);
});

// Only the known proxy suffix may choose the limiter key.
test("Cloud Run proxy suffix ignores forged XFF prefixes", async (t) => {
  const { url } = await serve(t, { isReady: () => true }, { trustProxyHops: 1 });
  for (let n = 0; n < 10; n++) {
    assert.equal((await login(url, {}, { "x-forwarded-for": `198.51.100.${n + 1}, 203.0.113.8` })).status, 401);
  }
  assert.equal((await login(url, undefined, { "x-forwarded-for": "198.51.100.99, 203.0.113.8" })).status, 429);
  assert.equal((await login(url, undefined, { "x-forwarded-for": "198.51.100.99, 203.0.113.9" })).status, 200);
});

// Omitting APP_BASE_PATH must expose the public pages and assets at the root.
test("combined service defaults to root SPA pages and assets with protected APIs and JSON 404 boundaries", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-root-static-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><div id="root">root fixture</div>');
  await fs.writeFile(path.join(directory, "assets/app.js"), 'console.log("root fixture")');
  const { url } = await serve(t, { isReady: async () => true }, { staticDir: directory });
  for (const route of ["/", "/login", "/login/", "/admin", "/admin/"]) for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${url}${route}`, { method, redirect: "manual" });
    assert.equal(response.status, 200, `${method} ${route}`);
    assert.match(response.headers.get("content-type"), /text\/html/);
    if (method === "GET") assert.match(await response.text(), /root fixture/); else assert.equal(await response.text(), "");
  }
  const asset = await fetch(`${url}/assets/app.js`);
  assert.equal(asset.status, 200); assert.equal(await asset.text(), 'console.log("root fixture")');
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: "ok" });
  for (const route of ["/api/admin/session", "/api/inquiries", "/api/inquiries/export.csv"]) for (const method of ["GET", "HEAD"]) {
    const response = await fetch(`${url}${route}`, { method });
    assert.equal(response.status, 401, `${method} ${route}`);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(response.headers.get("content-type"), /application\/json/);
  }
  for (const route of ["/unknown", "/assets/missing.js", "/api/unknown", "/api", "/api/admin/unknown"]) {
    const response = await fetch(`${url}${route}`);
    assert.equal(response.status, 404, route); assert.match(response.headers.get("content-type"), /application\/json/);
    assert.deepEqual(await response.json(), { error: "Not found" });
  }
});

// Only exact former page URLs redirect; retired API and asset URLs stay unavailable.
test("root hosting redirects exact legacy GET and HEAD pages while preserving the query verbatim", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-legacy-static-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "daisy-gci-event-form/assets"), { recursive: true });
  await fs.mkdir(path.join(directory, "daisy-gci-event-form/api"));
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><div id="root">fixture</div>');
  await fs.writeFile(path.join(directory, "daisy-gci-event-form/assets/app.js"), "retired asset must stay unavailable");
  await fs.writeFile(path.join(directory, "daisy-gci-event-form/api/health"), "retired API must stay unavailable");
  for (const appBasePath of [undefined, "/"]) {
    const { url } = await serve(t, { isReady: async () => true }, { staticDir: directory, appBasePath });
    for (const [route, target] of [["/daisy-gci-event-form", "/"], ["/daisy-gci-event-form/login", "/login"], ["/daisy-gci-event-form/admin", "/admin"]]) {
      for (const trailing of ["", "/"]) for (const query of ["", "?campaign=one%2Ftwo&tag=a+b&tag=%2f&empty=&flag"]) for (const method of ["GET", "HEAD"]) {
        const response = await fetch(`${url}${route}${trailing}${query}`, { method, redirect: "manual" });
        assert.equal(response.status, 301, `${method} ${route}${trailing}${query}`);
        assert.equal(response.headers.get("location"), `${target}${query}`);
        if (method === "HEAD") assert.equal(await response.text(), "");
      }
      for (const trailing of ["", "/"]) for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
        const response = await fetch(`${url}${route}${trailing}?campaign=1`, { method, redirect: "manual" });
        assert.equal(response.status, 404, `${method} ${route}${trailing}`);
        assert.equal(response.headers.get("location"), null);
        assert.match(response.headers.get("content-type"), /application\/json/);
      }
    }
    for (const route of ["/daisy-gci-event-form/unknown", "/daisy-gci-event-form/login/nested", "/daisy-gci-event-form/admin//", "/DAISY-GCI-EVENT-FORM/login", "/daisy-gci-event-form/api/health", "/daisy-gci-event-form/api/admin/session", "/daisy-gci-event-form/assets/app.js", "/daisy-gci-event-form/assets/missing.js"]) for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${url}${route}`, { method, redirect: "manual" });
      assert.equal(response.status, 404, `${method} ${route}`); assert.equal(response.headers.get("location"), null);
      assert.match(response.headers.get("content-type"), /application\/json/);
      if (method === "GET") assert.deepEqual(await response.json(), { error: "Not found" });
    }
    assert.equal((await fetch(`${url}/daisy-gci-event-form/api/inquiries`, { method: "POST", redirect: "manual", headers: { "content-type": "application/json" }, body: JSON.stringify(inquiry) })).status, 404);
  }
});

// An explicit prefix keeps its page, asset and API behavior without root migration redirects.
test("combined service preserves explicit application base path overrides", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-static-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "assets"));
  await fs.writeFile(path.join(directory, "index.html"), '<!doctype html><div id="root">fixture</div>');
  await fs.writeFile(path.join(directory, "assets/app.js"), 'console.log("fixture")');
  for (const base of ["/daisy-gci-event-form", "/another-path"]) {
    const { url } = await serve(t, { isReady: async () => true }, { staticDir: directory, appBasePath: base });
    const prefix = base === "/" ? "" : base;
    for (const route of ["/", "/login", "/admin"]) for (const method of ["GET", "HEAD"]) {
      const response = await fetch(`${url}${prefix}${route}`, { method });
      assert.equal(response.status, 200); assert.match(response.headers.get("content-type"), /text\/html/);
      if (method === "GET") assert.match(await response.text(), /fixture/); else assert.equal(await response.text(), "");
    }
    if (prefix) {
      const redirect = await fetch(`${url}${prefix}?campaign=1`, { redirect: "manual" });
      assert.equal(redirect.status, 301); assert.equal(redirect.headers.get("location"), `${prefix}/?campaign=1`);
    }
    assert.equal((await fetch(`${url}${prefix}/assets/app.js`)).status, 200);
    for (const route of ["/assets/missing.js", "/unknown", "/api/unknown"]) {
      const response = await fetch(`${url}${prefix}${route}`);
      assert.equal(response.status, 404); assert.match(response.headers.get("content-type"), /application\/json/);
    }
    assert.deepEqual(await (await fetch(`${url}${prefix}/api/health`)).json(), { status: "ok" });
    assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: "ok" });
    const rejected = await fetch(`${url}${prefix}/API/Admin/Session`, { method: "HEAD" });
    assert.equal(rejected.status, 401); assert.equal(rejected.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${url}/login`, { redirect: "manual" })).status, 404);
    if (base === "/another-path") {
      const legacy = await fetch(`${url}/daisy-gci-event-form/login`, { redirect: "manual" });
      assert.equal(legacy.status, 404); assert.equal(legacy.headers.get("location"), null);
    }
  }
});

test("invalid application base paths fail before startup", () => {
  for (const appBasePath of ["relative", "https://event.example/path", "//event.example", "/path?x=1", "/path#x", "/a/../b", "/a%2fb", "/a*", "/a:dynamic", "/a(b)"]) {
    assert.throws(() => createApp({ store: {}, appBasePath }), /APP_BASE_PATH/);
  }
});

test("production defaults to PostgreSQL and refuses SQLite without fallback", async () => {
  for (const env of [{ NODE_ENV: "production", STORAGE_BACKEND: "sqlite" }, { K_SERVICE: "fixture", STORAGE_BACKEND: "sqlite" }]) {
    await assert.rejects(startServer({ env: { ...env, PORT: "0" }, logger: silent }), /SQLite.*production|production.*SQLite/i);
  }
  for (const env of [{ NODE_ENV: "production" }, { K_SERVICE: "fixture" }]) {
    await assert.rejects(startServer({ env: { ...env, PORT: "0" }, logger: silent }), /DB_HOST/);
  }
});

const pgOptions = { skip: process.env.TEST_DATABASE_URL ? false : "TEST_DATABASE_URL is required for real PostgreSQL cross-instance integration" };
test("PostgreSQL sessions cross instances, survive app replacement, and logout revokes everywhere", pgOptions, async (t) => {
  const fixture = await createPostgresFixture(t);
  const first = await serve(t, fixture.store);
  const second = await serve(t, await fixture.openStore());
  const loggedIn = await login(first.url); assert.equal(loggedIn.status, 200);
  const headers = { cookie: cookie(loggedIn) };
  const token = cookie(loggedIn).split("=")[1];
  const stored = await fixture.pool.query(`SELECT token_hash FROM "${fixture.schema}".admin_sessions`);
  assert.equal(stored.rows[0].token_hash, createHash("sha256").update(token).digest("hex"));
  assert.notEqual(stored.rows[0].token_hash, token);
  assert.equal((await fetch(`${second.url}/api/admin/session`, { headers })).status, 200);
  await first.close();
  await fixture.store.close();
  const revision = await serve(t, await fixture.openStore());
  assert.equal((await fetch(`${revision.url}/api/admin/session`, { headers })).status, 200);
  assert.equal((await fetch(`${revision.url}/api/admin/logout`, { method: "POST", headers })).status, 204);
  assert.equal((await fetch(`${second.url}/api/admin/session`, { headers })).status, 401);
});

test("PostgreSQL login and Basic export share atomic parallel reservations and expiry", pgOptions, async (t) => {
  let clock = 1800000000000;
  const fixture = await createPostgresFixture(t);
  const first = await serve(t, fixture.store, { now: () => clock });
  const second = await serve(t, await fixture.openStore(), { now: () => clock });
  const responses = await Promise.all(Array.from({ length: 20 }, (_, n) => n % 2
    ? fetch(`${first.url}/api/inquiries/export.csv`, { headers: { authorization: "Basic !!!" } }) : login(second.url, {})));
  assert.equal(responses.filter((response) => response.status === 401).length, 10);
  assert.equal(responses.filter((response) => response.status === 429).length, 10);
  assert.equal((await login(first.url)).status, 429);
  clock += 15 * 60 * 1000;
  assert.equal((await login(second.url)).status, 200);
});

// Database-backed reads must be awaited before building either response format.
test("async private listing and CSV return committed inquiry data", async (t) => {
  const saved = { ...inquiry, id: "persisted", submittedAt: "2026-10-26T10:00:00.000Z" };
  const { url } = await serve(t, { isReady: async () => true, listInquiries: async () => [saved] });
  const headers = { cookie: cookie(await login(url)) };
  const response = await fetch(`${url}/api/inquiries`, { headers });
  assert.deepEqual(await response.json(), { inquiries: [saved] });
  const csv = await fetch(`${url}/api/inquiries/export.csv`, { headers });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /persisted,2026-10-26T10:00:00.000Z,Ada Lovelace/);
});

// Traversal attempts must not expose files outside the frontend build directory.
test("static serving rejects encoded traversal and hidden files", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-traversal-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, "build"));
  await fs.writeFile(path.join(directory, "secret.txt"), "never serve parent secret");
  await fs.writeFile(path.join(directory, "build/.secret"), "never serve hidden secret");
  await fs.writeFile(path.join(directory, "build/app.js"), 'console.log("safe asset")');
  const { url } = await serve(t, {}, { staticDir: path.join(directory, "build") });
  const asset = await fetch(`${url}/app.js`);
  assert.equal(asset.status, 200); assert.equal(await asset.text(), 'console.log("safe asset")');
  for (const route of ["/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt", "/.secret"]) {
    const response = await new Promise((resolve, reject) => {
      const request = http.get(`${url}${route}`, resolve); request.once("error", reject);
    });
    const chunks = []; for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.statusCode, 404); assert.doesNotMatch(Buffer.concat(chunks).toString(), /never serve/);
  }
});

test("Cloud Run runtime binds the injected port on all interfaces with production proxy policy", pgOptions, async (t) => {
  const fixture = await createPostgresFixture(t);
  const reservation = net.createServer().listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const runtime = await startServer({ env: { ...fixture.env, K_SERVICE: "fixture", PORT: String(port) }, logger: silent });
  t.after(runtime.close);
  assert.equal(runtime.server.address().address, "0.0.0.0");
  assert.equal(runtime.server.address().port, port);
  assert.equal(runtime.app.get("trust proxy"), 1);
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(), { status: "ok" });
  await runtime.close();
  assert.equal(await runtime.store.isReady(), false);
});

// State-store outages must not turn invalid cookies into database work or successful logout.
test("persistent session reads and logout fail closed while malformed tokens are rejected locally", async (t) => {
  const store = {
    async saveSession() {}, async getSession() { throw new Error("offline"); },
    async deleteSession() { throw new Error("offline"); },
  };
  const { url } = await serve(t, store);
  for (const value of ["invalid", "j:%7B%22bad%22%3Atrue%7D"]) {
    assert.equal((await fetch(`${url}/api/admin/session`, { headers: { cookie: `daisy_gci_event_form_session=${value}` } })).status, 401);
  }
  const headers = { cookie: `daisy_gci_event_form_session=${"a".repeat(64)}` };
  assert.equal((await fetch(`${url}/api/admin/session`, { headers })).status, 500);
  const logout = await fetch(`${url}/api/admin/logout`, { method: "POST", headers });
  assert.equal(logout.status, 500); assert.equal(logout.headers.get("set-cookie"), null);
});

test("local runtime closes HTTP before releasing SQLite and repeated close is safe", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-runtime-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = await startServer({ env: { PORT: "0", DATABASE_PATH: path.join(directory, "inquiries.sqlite") }, logger: silent });
  t.after(runtime.close);
  assert.equal(runtime.server.address().address, "127.0.0.1");
  await Promise.all([runtime.close(), runtime.close()]);
  assert.equal(runtime.server.listening, false); assert.equal(runtime.store.isReady(), false);
});
