const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const net = require("node:net");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { test } = require("node:test");
const { scryptSync } = require("node:crypto");

// These credentials belong only to the test fixture, never the fixed production account.
const fixturePassword = "  fixture Pass#9!  ";
const fixtureAccount = {
  email: "admin@daisyai.com",
  salt: "daisy-integration-test-salt",
  hash: scryptSync(fixturePassword, "daisy-integration-test-salt", 64).toString("hex"),
};
const cookieName = "daisy_gci_event_form_session";

const serverPath = path.resolve(__dirname, "../src/server.js");
const validInquiry = {
  fullName: "Ada Lovelace",
  companyOrganization: "Analytical Engines",
  businessEmail: "ada@example.com",
  interests: ["product-demo"],
  preferredFollowUpMethods: ["email"],
};

async function unusedPort() {
  const reservation = net.createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const { port } = reservation.address();
  await new Promise((resolve) => reservation.close(resolve));
  return port;
}

async function startProcess(t, directory, extraEnv = {}) {
  const port = await unusedPort();
  const child = spawn(process.execPath, [serverPath], {
    cwd: directory,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      DATABASE_PATH: path.join(directory, "inquiries.sqlite"),
      DATA_FILE: path.join(directory, "legacy.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => (output += data));
  child.stderr.on("data", (data) => (output += data));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await once(child, "exit");
  };
  t.after(stop);
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return { url, stop, child };
    } catch {}
    if (child.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`API did not become ready: ${output}`);
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-api-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function post(url, body) {
  return fetch(`${url}/api/inquiries`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function startApp(t, options = {}) {
  const { createApp } = require("../src/app");
  const { openStorage } = require("../src/storage");
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "inquiries.sqlite");
  const store = openStorage(databasePath);
  const app = createApp({ store, adminAccount: fixtureAccount, ...options });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.locals.close?.();
    store.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, store, databasePath, app };
}

function login(url, body = { email: fixtureAccount.email, password: fixturePassword }, headers = {}) {
  return fetch(`${url}/api/admin/login`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
}

function sessionCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

// Catches a missing session guard or accidental browser Basic authentication prompt.
test("private endpoints reject anonymous access without a Basic challenge", async (t) => {
  const { url } = await startApp(t);
  for (const route of ["/api/admin/session", "/api/inquiries", "/api/inquiries/export.csv"]) {
    for (const headers of [{}, { cookie: `${cookieName}=invalid` }, { authorization: "Bearer invalid" }]) {
      const response = await fetch(`${url}${route}`, { headers });
      assert.equal(response.status, 401);
      assert.equal(typeof (await response.json()).error, "string");
      assert.equal(response.headers.get("www-authenticate"), null);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
});

// Catches cache policy diverging from Express's case-insensitive routes and automatic HEAD handling.
test("private GET and HEAD responses stay uncacheable across route casing and session state", async (t) => {
  const { url } = await startApp(t);
  const loggedIn = await login(url);
  const validCookie = sessionCookie(loggedIn);
  for (const route of ["/api/Admin/session", "/api/Inquiries", "/api/Inquiries/export.csv", "/api/inquiries"]) {
    for (const method of ["GET", "HEAD"]) {
      for (const [state, cookie, status] of [["valid", validCookie, 200], ["invalid", `${cookieName}=invalid`, 401]]) {
        await t.test(`${method} ${route} with ${state} session`, async () => {
          const response = await fetch(`${url}${route}`, { method, headers: { cookie } });
          assert.equal(response.status, status);
          assert.equal(response.headers.get("cache-control"), "no-store");
          if (method === "HEAD") assert.equal(await response.text(), "");
        });
      }
    }
  }
});

// Catches losing private cache headers before mixed-case login/logout reach the JSON error handler.
test("mixed-case login and logout keep no-store on success and early JSON errors", async (t) => {
  const { url } = await startApp(t);
  for (const [route, body, status] of [
    ["/api/Admin/Login", "{", 400],
    ["/api/Admin/Login", JSON.stringify({ email: fixtureAccount.email, password: fixturePassword }), 200],
    ["/api/Admin/Logout", "{", 400],
    ["/api/Admin/Logout", "{}", 204],
  ]) {
    await t.test(`${route} returns ${status} without caching`, async () => {
      const response = await fetch(`${url}${route}`, {
        method: "POST", headers: { "content-type": "application/json" }, body,
      });
      assert.equal(response.status, status);
      assert.equal(response.headers.get("cache-control"), "no-store");
    });
  }
});

// Catches putting a session token in JSON, omitting cookie flags, or forgetting durable newest-first reads.
test("login creates an opaque cookie that authorizes session, inquiry list, and CSV", async (t) => {
  const { url, store } = await startApp(t);
  store.saveInquiry({ ...validInquiry, id: "old", submittedAt: "2025-01-01T00:00:00.000Z" });
  store.saveInquiry({ ...validInquiry, id: "new", submittedAt: "2026-01-01T00:00:00.000Z" });
  const response = await login(url, { email: "  ADMIN@DaisyAI.com  ", password: fixturePassword });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { email: "admin@daisyai.com" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^daisy_gci_event_form_session=[a-f0-9]{64};/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=43200/);
  assert.doesNotMatch(setCookie, /; Secure/);
  const headers = { cookie: sessionCookie(response) };
  const session = await fetch(`${url}/api/admin/session`, { headers });
  assert.equal(session.status, 200);
  assert.deepEqual(await session.json(), { email: "admin@daisyai.com" });
  const list = await fetch(`${url}/api/inquiries`, { headers });
  assert.equal(list.status, 200);
  assert.deepEqual((await list.json()).inquiries.map(({ id }) => id), ["new", "old"]);
  assert.equal(list.headers.get("cache-control"), "no-store");
  const csv = await fetch(`${url}/api/inquiries/export.csv`, { headers });
  assert.equal(csv.status, 200);
  assert.equal(csv.headers.get("content-disposition"), 'attachment; filename="daisy-gci-event-form-responses.csv"');
  assert.equal(csv.headers.get("cache-control"), "no-store");
});

// Catches password trimming, type coercion, and disclosure of which credential was wrong.
test("login preserves password punctuation and whitespace and rejects malformed credentials generically", async (t) => {
  const { url } = await startApp(t);
  for (const body of [
    {}, { email: 12, password: fixturePassword }, { email: fixtureAccount.email, password: {} },
    { email: fixtureAccount.email, password: fixturePassword.trim() },
    { email: fixtureAccount.email, password: fixturePassword.replace("#", "!") },
    { email: "other@example.com", password: fixturePassword }, [], null,
  ]) {
    const response = await login(url, body);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Invalid email or password" });
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await login(url)).status, 200);
});

// Catches a logout that merely clears the browser cookie without revoking the server session.
test("logout revokes an existing session, clears matching cookie flags, and is idempotent", async (t) => {
  const { url } = await startApp(t, { nodeEnv: "production" });
  const loggedIn = await login(url);
  assert.match(loggedIn.headers.get("set-cookie"), /; Secure/);
  const headers = { cookie: sessionCookie(loggedIn) };
  const logout = await fetch(`${url}/api/admin/logout`, { method: "POST", headers });
  assert.equal(logout.status, 204);
  assert.equal(await logout.text(), "");
  assert.equal(logout.headers.get("cache-control"), "no-store");
  assert.match(logout.headers.get("set-cookie"), /^daisy_gci_event_form_session=;/);
  assert.match(logout.headers.get("set-cookie"), /Path=\/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Lax/);
  assert.equal((await fetch(`${url}/api/admin/session`, { headers })).status, 401);
  assert.equal((await fetch(`${url}/api/admin/logout`, { method: "POST", headers })).status, 204);
});

// Catches sliding expiration and accidentally persistent or global session storage.
test("sessions expire after an absolute twelve hours and are invalid in a fresh app", async (t) => {
  let clock = Date.now();
  const { url } = await startApp(t, { now: () => clock });
  const first = await login(url);
  const second = await login(url);
  assert.notEqual(sessionCookie(first), sessionCookie(second));
  const headers = { cookie: sessionCookie(first) };
  clock += 12 * 60 * 60 * 1000 - 1;
  assert.equal((await fetch(`${url}/api/admin/session`, { headers })).status, 200);
  clock += 1;
  assert.equal((await fetch(`${url}/api/admin/session`, { headers })).status, 401);
  const restarted = await startApp(t);
  assert.equal((await fetch(`${restarted.url}/api/admin/session`, { headers: { cookie: sessionCookie(second) } })).status, 401);
});

// Catches credentialed wildcard CORS and cross-origin session mutation.
test("explicit client origin receives credentialed CORS and foreign login/logout origins are rejected", async (t) => {
  const { url } = await startApp(t, { clientOrigin: "http://localhost:5173" });
  const response = await login(url, undefined, { origin: "http://localhost:5173" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
  assert.equal(response.headers.get("access-control-allow-credentials"), "true");
  const headers = { origin: "https://foreign.example", cookie: sessionCookie(response) };
  for (const route of ["login", "logout"]) {
    const rejected = await fetch(`${url}/api/admin/${route}`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ email: fixtureAccount.email, password: fixturePassword }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(rejected.headers.get("access-control-allow-origin"), null);
    assert.equal(rejected.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(`${url}/api/admin/session`, { headers: { cookie: sessionCookie(response) } })).status, 200);
});

test("unconfigured origins support same-origin proxy HTTPS without enabling wildcard CORS", async (t) => {
  const { url } = await startApp(t);
  // Native HTTP preserves the reverse proxy's Host; Node fetch replaces custom Host headers.
  const response = await new Promise((resolve, reject) => {
    const request = http.request(`${url}/api/admin/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json", origin: "https://event.example",
        host: "event.example", "x-forwarded-proto": "https",
      },
    }, (result) => {
      result.resume();
      result.once("end", () => resolve(result));
    });
    request.once("error", reject);
    request.end(JSON.stringify({ email: fixtureAccount.email, password: fixturePassword }));
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["access-control-allow-credentials"], undefined);
  assert.equal((await login(url, undefined, { origin: "https://foreign.example" })).status, 403);
});

// Catches bypassing the shared failure limit via CSV, forged leftmost XFF, or the correct password.
test("ten failed login/export attempts share a fifteen-minute limit per trusted client address", async (t) => {
  let clock = Date.now();
  const { url } = await startApp(t, { now: () => clock });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const headers = { "x-forwarded-for": `198.51.100.${attempt + 1}, 203.0.113.8` };
    const response = attempt % 2 === 0
      ? await login(url, { email: fixtureAccount.email, password: "incorrect" }, headers)
      : await fetch(`${url}/api/inquiries/export.csv`, { headers: { ...headers, authorization: "Basic !!!" } });
    assert.equal(response.status, 401);
  }
  const headers = { "x-forwarded-for": "198.51.100.99, 203.0.113.8" };
  for (const route of ["login", "export"]) {
    const response = route === "login" ? await login(url, undefined, headers)
      : await fetch(`${url}/api/inquiries/export.csv`, { headers: { ...headers, authorization } });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "900");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await login(url, undefined, { "x-forwarded-for": "203.0.113.9" })).status, 200);
  assert.equal((await post(url, validInquiry)).status, 201);
  clock += 15 * 60 * 1000;
  assert.equal((await login(url, undefined, headers)).status, 200);
});

test("login keeps the existing JSON body limit and malformed JSON contract private", async (t) => {
  const { url } = await startApp(t);
  for (const [body, status] of [["{", 400], [JSON.stringify({ email: "x".repeat(21 * 1024), password: "x" }), 413]]) {
    const response = await fetch(`${url}/api/admin/login`, { method: "POST", headers: { "content-type": "application/json" }, body });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

// Catches raw payload spreading and acknowledging writes before durable storage.
test("submissions normalize fields, own their metadata, and survive restart", async (t) => {
  const directory = await temporaryDirectory(t);
  const first = await startProcess(t, directory);
  const response = await post(first.url, {
    ...validInquiry,
    fullName: "  Ada Lovelace  ",
    companyOrganization: "  Analytical Engines  ",
    businessEmail: "  ada@example.com  ",
    jobTitle: "  Engineer  ",
    id: "client-chosen-id",
    submittedAt: "1900-01-01T00:00:00.000Z",
    unknown: "do not retain",
  });
  assert.equal(response.status, 201);
  const { message, inquiry } = await response.json();
  assert.equal(message, "Inquiry received");
  assert.equal(inquiry.fullName, "Ada Lovelace");
  assert.equal(inquiry.companyOrganization, "Analytical Engines");
  assert.equal(inquiry.businessEmail, "ada@example.com");
  assert.equal(inquiry.jobTitle, "Engineer");
  assert.equal(inquiry.unknown, undefined);
  assert.match(inquiry.id, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(inquiry.submittedAt) > Date.parse("2020-01-01"));
  await first.stop();

  const Database = require("better-sqlite3");
  const database = new Database(path.join(directory, "inquiries.sqlite"), { readonly: true });
  const row = database.prepare("SELECT id, submitted_at, payload FROM inquiries").get();
  assert.equal(row.id, inquiry.id);
  assert.equal(row.submitted_at, inquiry.submittedAt);
  assert.deepEqual(JSON.parse(row.payload), inquiry);
  database.close();

  const second = await startProcess(t, directory);
  assert.equal((await post(second.url, validInquiry)).status, 201);
  await second.stop();
  const reopened = new Database(path.join(directory, "inquiries.sqlite"), { readonly: true });
  assert.equal(reopened.prepare("SELECT count(*) AS count FROM inquiries").get().count, 2);
  reopened.close();
});

// Each row catches accepting an invalid required value or silently coercing a type.
test("invalid fields receive JSON errors without writing a row", async (t) => {
  const { url, store } = await startApp(t);
  const cases = [
    ["missing name", { fullName: undefined }],
    ["blank name", { fullName: " \t " }],
    ["numeric name", { fullName: 12 }],
    ["missing company", { companyOrganization: undefined }],
    ["blank company", { companyOrganization: " " }],
    ["object company", { companyOrganization: {} }],
    ["missing email", { businessEmail: undefined }],
    ["invalid email", { businessEmail: "no-address" }],
    ["space in email", { businessEmail: "ada @example.com" }],
    ["array email", { businessEmail: ["ada@example.com"] }],
    ["missing interests", { interests: undefined }],
    ["no interests", { interests: [] }],
    ["string interests", { interests: "product-demo" }],
    ["null interests", { interests: null }],
    ["object interest", { interests: [{}] }],
    ["unsupported interest", { interests: ["exploring-ai"] }],
    ["numeric job title", { jobTitle: 42 }],
    ["null phone", { phoneNumber: null }],
    ["object other interest", { interestOther: {} }],
    ["array comments", { questionsOrComments: [] }],
    ["string follow-up", { preferredFollowUpMethods: "email" }],
    ["null follow-up", { preferredFollowUpMethods: null }],
    ["object follow-up", { preferredFollowUpMethods: [{}] }],
    ["unsupported follow-up", { preferredFollowUpMethods: ["sms"] }],
    ["phone without number", { preferredFollowUpMethods: ["phone"] }],
    ["phone with blank number", { preferredFollowUpMethods: ["phone"], phoneNumber: "  " }],
    ["other without detail", { interests: ["other"] }],
    ["other with blank detail", { interests: ["other"], interestOther: " " }],
  ];
  for (const [name, override] of cases) {
    await t.test(name, async () => {
      const response = await post(url, { ...validInquiry, ...override });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).error, "string");
    });
  }
  for (const body of [null, 42, "text", [], true]) {
    const response = await post(url, body);
    assert.equal(response.status, 400);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.deepEqual(store.listInquiries(), []);
});

test("all supported interests, conditional details, and empty follow-up are accepted", async (t) => {
  const { url } = await startApp(t);
  const response = await post(url, {
    ...validInquiry,
    interests: [" product-demo ", "ai-solutions", "business-partnership", "pricing-info", "other"],
    interestOther: "  Cloud services  ",
    phoneNumber: " +91 98765 43210 ",
    preferredFollowUpMethods: ["phone", "email"],
    questionsOrComments: "  Call after 3pm.  ",
  });
  assert.equal(response.status, 201);
  const { inquiry } = await response.json();
  assert.equal(inquiry.interests[0], "product-demo");
  assert.equal(inquiry.interestOther, "Cloud services");
  assert.equal(inquiry.phoneNumber, "+91 98765 43210");
  assert.equal(inquiry.questionsOrComments, "Call after 3pm.");
  assert.equal((await post(url, { ...validInquiry, preferredFollowUpMethods: [] })).status, 201);
});

test("malformed and oversized JSON return the API error contract", async (t) => {
  const { url, store } = await startApp(t);
  for (const [body, status] of [["{", 400], [JSON.stringify({ ...validInquiry, questionsOrComments: "x".repeat(21 * 1024) }), 413]]) {
    const response = await fetch(`${url}/api/inquiries`, {
      method: "POST", headers: { "content-type": "application/json" }, body,
    });
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, "string");
  }
  assert.deepEqual(store.listInquiries(), []);
});

// Catches relaxing the existing public JSON parser while making login type checks generic.
test("public submissions retain the original JSON parsing error for primitive bodies", async (t) => {
  const { url } = await startApp(t);
  const response = await post(url, null);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request body must be valid JSON" });
});

test("concurrent HTTP submissions keep every distinct inquiry", async (t) => {
  const { url, store } = await startApp(t);
  const responses = await Promise.all(Array.from({ length: 30 }, (_, index) => post(url, {
    ...validInquiry, fullName: `Visitor ${index}`,
  })));
  const saved = await Promise.all(responses.map(async (response) => {
    assert.equal(response.status, 201);
    return (await response.json()).inquiry;
  }));
  assert.equal(new Set(saved.map((inquiry) => inquiry.id)).size, 30);
  assert.equal(new Set(store.listInquiries().map((inquiry) => inquiry.fullName)).size, 30);
});

test("a rejected SQLite write is never acknowledged as a submission", async (t) => {
  const { url, store, databasePath } = await startApp(t, { logger: { error() {} } });
  const Database = require("better-sqlite3");
  const database = new Database(databasePath);
  database.exec("CREATE TRIGGER reject_writes BEFORE INSERT ON inquiries BEGIN SELECT RAISE(ABORT, 'storage unavailable'); END");
  database.close();
  const response = await post(url, validInquiry);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Unable to process inquiry" });
  assert.deepEqual(store.listInquiries(), []);
});

test("health reports unavailable storage", async (t) => {
  const { url, store } = await startApp(t);
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { status: "ok" });
  store.close();
  const response = await fetch(`${url}/api/health`);
  assert.equal(response.status, 503);
  assert.equal(typeof (await response.json()).error, "string");
});

const authorization = `Basic ${Buffer.from(`${fixtureAccount.email}:${fixturePassword}`).toString("base64")}`;
const csvHeader = "id,submittedAt,fullName,companyOrganization,businessEmail,jobTitle,phoneNumber,interests,interestOther,preferredFollowUpMethods,questionsOrComments\n";

test("explicit Basic export failures challenge and cannot authorize the session-only inquiry list", async (t) => {
  const { url } = await startApp(t);
  for (const header of ["Basic !!!", `Basic ${Buffer.from("admin@daisyai.com:wrong").toString("base64")}`, `Basic ${Buffer.from(`wrong:${fixturePassword}`).toString("base64")}`]) {
    const response = await fetch(`${url}/api/inquiries/export.csv`, { headers: { authorization: header } });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), 'Basic realm="Daisy GCI Event Administration"');
    assert.equal(typeof (await response.json()).error, "string");
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal((await fetch(`${url}/api/inquiries`, { headers: { authorization } })).status, 401);
});

test("an authorized empty export includes CSV headers and a UTF-8 BOM", async (t) => {
  const { url } = await startApp(t);
  const response = await fetch(`${url}/api/inquiries/export.csv`, { headers: { authorization } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="daisy-gci-event-form-responses.csv"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString("utf8"), csvHeader);
});

test("CSV exports every field with quoted Unicode text, safe formulas, and stable newest-first order", async (t) => {
  const { url, store } = await startApp(t);
  store.saveInquiry({
    id: "old", submittedAt: "2025-01-01T00:00:00.000Z", ...validInquiry,
    fullName: "Old visitor", preferredFollowUpMethods: [],
  });
  store.saveInquiry({
    id: "a", submittedAt: "2026-01-01T00:00:00.000Z", ...validInquiry,
    fullName: "Older tie", preferredFollowUpMethods: [],
  });
  store.saveInquiry({
    id: "z", submittedAt: "2026-01-01T00:00:00.000Z",
    fullName: 'Zoë, "दिशा"', companyOrganization: "=HYPERLINK(A1)", businessEmail: "zoe@example.com",
    jobTitle: "+Lead", phoneNumber: "-123", interests: ["ai-solutions", "other"],
    interestOther: "@Research", preferredFollowUpMethods: ["email", "phone"], questionsOrComments: "First line\nSecond line",
  });
  const response = await fetch(`${url}/api/inquiries/export.csv`, { headers: { authorization } });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(3).toString("utf8"), csvHeader
    + 'z,2026-01-01T00:00:00.000Z,"Zoë, ""दिशा""",\'=HYPERLINK(A1),zoe@example.com,\'+Lead,\'-123,ai-solutions;other,\'@Research,email;phone,"First line\nSecond line"\n'
    + "a,2026-01-01T00:00:00.000Z,Older tie,Analytical Engines,ada@example.com,,,product-demo,,,\n"
    + "old,2025-01-01T00:00:00.000Z,Old visitor,Analytical Engines,ada@example.com,,,product-demo,,,\n");
});
