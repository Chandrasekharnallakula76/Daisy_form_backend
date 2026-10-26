const crypto = require("node:crypto");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const express = require("express");
const helmet = require("helmet");
const { installWeb, normalizeBasePath } = require("./web");
const { createAdminAuth, SESSION_TTL } = require("./admin-auth");
const { inquiriesToCsv } = require("./csv");
const { ValidationError, validateSubmission } = require("./validation");

const SESSION_COOKIE = "daisy_gci_event_form_session";

function createApp({ store, clientOrigin, adminAccount, now, nodeEnv = process.env.NODE_ENV, logger = console, staticDir, appBasePath, trustProxyHops }) {
  normalizeBasePath(appBasePath);
  if (trustProxyHops !== undefined && (!Number.isInteger(trustProxyHops) || trustProxyHops < 1)) throw new Error("TRUST_PROXY_HOPS must be a positive integer");
  const allowedOrigin = clientOrigin && clientOrigin !== "*" ? new URL(clientOrigin).origin : undefined;
  const app = express();
  const auth = createAdminAuth({ account: adminAccount, now, stateStore: typeof store.saveSession === "function" ? store : undefined });
  app.locals.close = () => auth.close();
  app.set("trust proxy", trustProxyHops ?? "loopback");
  const cookieOptions = { path: "/", httpOnly: true, sameSite: "lax", secure: nodeEnv === "production" };
  app.use(helmet());
  installWeb(app, { staticDir, appBasePath });
  app.use((request, response, next) => {
    const path = request.path.toLowerCase();
    if (path.startsWith("/api/admin/") || (["GET", "HEAD"].includes(request.method) && path.startsWith("/api/inquiries"))) {
      response.set("Cache-Control", "no-store");
    }
    next();
  });
  if (allowedOrigin) {
    app.use(cors({
      origin: (origin, callback) => callback(null, origin === allowedOrigin ? allowedOrigin : false),
      credentials: true,
    }));
  }
  app.use(cookieParser());
  app.use("/api/admin/login", express.json({ limit: "20kb", strict: false }));
  app.use(express.json({ limit: "20kb" }));

  function checkOrigin(request, response, next) {
    const origin = request.get("origin");
    const expected = allowedOrigin || `${request.protocol}://${request.get("host")}`;
    if (origin && origin !== expected) return response.status(403).json({ error: "Request origin is not allowed" });
    return next();
  }

  async function requireSession(request, response, next) {
    const session = await auth.getSession(request.cookies[SESSION_COOKIE]);
    if (!session) return response.status(401).json({ error: "Administrator authentication required" });
    request.adminSession = session;
    return next();
  }

  async function beginAttempt(request, response) {
    const attempt = await auth.beginAttempt(request.ip);
    if (attempt.retryAfter) {
      response.set("Retry-After", String(attempt.retryAfter)).status(429).json({ error: "Too many authentication attempts. Try again later." });
      return undefined;
    }
    return attempt;
  }

  app.post("/api/admin/login", checkOrigin, async (request, response, next) => {
    const attempt = await beginAttempt(request, response);
    if (!attempt) return;
    try {
      const body = request.body;
      const approved = await auth.verifyCredentials(body?.email, body?.password);
      await attempt.complete(approved);
      if (!approved) return response.status(401).json({ error: "Invalid email or password" });
      const session = await auth.createSession();
      response.cookie(SESSION_COOKIE, session.token, { ...cookieOptions, maxAge: SESSION_TTL });
      return response.json({ email: session.email });
    } catch (error) {
      await attempt.complete(false);
      return next(error);
    }
  });

  app.get("/api/admin/session", requireSession, (request, response) => response.json({ email: request.adminSession.email }));

  app.post("/api/admin/logout", checkOrigin, async (request, response) => {
    await auth.deleteSession(request.cookies[SESSION_COOKIE]);
    response.clearCookie(SESSION_COOKIE, cookieOptions);
    return response.status(204).end();
  });

  app.get("/api/health", async (_request, response) => {
    try {
      if (await store.isReady()) return response.json({ status: "ok" });
    } catch {}
    return response.status(503).json({ error: "Inquiry storage is unavailable" });
  });

  async function exportAuth(request, response, next) {
    if (await auth.getSession(request.cookies[SESSION_COOKIE])) return next();
    const authorization = request.get("authorization") || "";
    if (!/^Basic(?:\s|$)/i.test(authorization)) {
      return response.status(401).json({ error: "Administrator authentication required" });
    }
    const attempt = await beginAttempt(request, response);
    if (!attempt) return;
    try {
      const encoded = /^Basic +([a-z0-9+/]+={0,2})$/i.exec(authorization)?.[1];
      const decoded = encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
      const separator = decoded.indexOf(":");
      const approved = separator >= 0 && await auth.verifyCredentials(decoded.slice(0, separator), decoded.slice(separator + 1));
      await attempt.complete(approved);
      if (approved) return next();
      return response.set("WWW-Authenticate", 'Basic realm="Daisy GCI Event Administration"')
        .status(401).json({ error: "Administrator authentication required" });
    } catch (error) {
      await attempt.complete(false);
      return next(error);
    }
  }

  app.get("/api/inquiries", requireSession, async (_request, response, next) => {
    try {
      return response.json({ inquiries: await store.listInquiries() });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/inquiries/export.csv", exportAuth, async (_request, response, next) => {
    try {
      const csv = inquiriesToCsv(await store.listInquiries());
      return response.set({
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="daisy-gci-event-form-responses.csv"',
      }).send(csv);
    } catch (error) {
      return next(error);
    }
  });

  app.post("/api/inquiries", async (request, response, next) => {
    try {
      const inquiry = validateSubmission(request.body);
      inquiry.id = crypto.randomUUID();
      inquiry.submittedAt = new Date().toISOString();
      await store.saveInquiry(inquiry);
      return response.status(201).json({ message: "Inquiry received", inquiry });
    } catch (error) {
      return next(error);
    }
  });

  app.use((_request, response) => {
    response.status(404).json({ error: "Not found" });
  });

  app.use((error, _request, response, _next) => {
    if (error instanceof ValidationError) {
      return response.status(400).json({ error: error.message });
    }
    if (error.type === "entity.parse.failed") {
      return response.status(400).json({ error: "Request body must be valid JSON" });
    }
    if (error.type === "entity.too.large") {
      return response.status(413).json({ error: "Request body is too large" });
    }
    logger.error(error);
    return response.status(500).json({ error: "Unable to process inquiry" });
  });
  return app;
}

module.exports = { createApp };
