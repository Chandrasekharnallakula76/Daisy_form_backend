const dotenv = require("dotenv");
const { createApp } = require("./app");
const { openStorage } = require("./storage");

async function startServer({ env = process.env, logger = console } = {}) {
  const production = env.NODE_ENV === "production" || Boolean(env.K_SERVICE);
  const port = env.PORT === undefined || env.PORT === "" ? 4000 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const backend = env.STORAGE_BACKEND || (production ? "postgres" : "sqlite");
  if (!["postgres", "sqlite"].includes(backend)) throw new Error("STORAGE_BACKEND must be postgres or sqlite");
  if (production && backend === "sqlite") throw new Error("SQLite is unavailable in production; configure PostgreSQL");
  const host = env.HOST || (production ? "0.0.0.0" : "127.0.0.1");
  const proxySetting = env.TRUST_PROXY_HOPS;
  const trustProxyHops = proxySetting === undefined || proxySetting === ""
    ? (env.K_SERVICE ? 1 : undefined) : Number(proxySetting);
  if (trustProxyHops !== undefined && (!Number.isInteger(trustProxyHops) || trustProxyHops < 1)) {
    throw new Error("TRUST_PROXY_HOPS must be a positive integer");
  }
  const store = backend === "postgres"
    ? await require("./postgres-storage").openPostgresStorage({ env, logger })
    : await openStorage(env.DATABASE_PATH || "./data/inquiries.sqlite");
  let app;
  let server;
  try {
    app = createApp({
      store,
      clientOrigin: env.CLIENT_ORIGIN,
      nodeEnv: production ? "production" : env.NODE_ENV,
      staticDir: env.STATIC_DIR,
      appBasePath: env.APP_BASE_PATH,
      trustProxyHops,
      logger,
    });
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(port, host, () => resolve(listener));
      listener.once("error", reject);
    });
  } catch (error) {
    try { await app?.locals.close(); }
    finally { await store.close(); }
    throw error;
  }
  let closing;
  const close = () => {
    closing ??= (async () => {
      try {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally {
        try { await app.locals.close(); }
        finally { await store.close(); }
      }
    })();
    return closing;
  };
  logger.log(`Inquiry API listening on ${host}:${server.address().port}`);
  return { app, server, store, close };
}

if (require.main === module) {
  dotenv.config();
  startServer().then(({ close }) => {
    const shutdown = () => {
      close().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
      });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => {
    console.error(error.code === "EADDRINUSE"
      ? "The configured port is already in use. Set a different PORT in .env."
      : error.message);
    process.exitCode = 1;
  });
}

module.exports = { startServer };
