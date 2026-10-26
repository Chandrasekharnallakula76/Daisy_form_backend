const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { testDatabaseEnv } = require("../test/helpers/postgres");

try {
  testDatabaseEnv();
  const result = spawnSync(process.execPath, ["--test", "test/postgres-storage.test.js", "test/cloud-run-api.test.js", "test/postgres-tls-integration.test.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: "inherit", env: process.env,
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
