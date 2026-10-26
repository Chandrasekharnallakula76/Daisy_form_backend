const { X509Certificate } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { isIP } = require("node:net");
const path = require("node:path");
const { createSecureContext } = require("node:tls");

const DEFAULT_CA_PATH = path.join(__dirname, "certs", "cloudsql-northamerica-northeast1.crt");

function getPostgresTlsOptions(env) {
  if (env.DB_SSL_MODE === undefined) return undefined;
  if (env.DB_SSL_MODE === "disable") return false;
  if (env.DB_SSL_MODE !== "verify-full") {
    throw new Error("DB_SSL_MODE must be disable or verify-full");
  }

  const name = env.DB_SSL_SERVERNAME;
  const servername = typeof name === "string" ? name.replace(/\.$/, "") : "";
  if (!servername || servername.length > 253 || isIP(servername) || /^[\d.]+$/.test(servername) ||
    !servername.split(".").every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))) {
    throw new Error("DB_SSL_SERVERNAME must be a valid DNS hostname for verify-full");
  }

  const caPath = env.DB_SSL_CA_PATH === undefined ? DEFAULT_CA_PATH : env.DB_SSL_CA_PATH;
  if (typeof caPath !== "string" || !caPath.trim()) {
    throw new Error("DB_SSL_CA_PATH must identify a readable PEM CA bundle");
  }
  let ca;
  try {
    ca = readFileSync(caPath, "utf8");
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || ca.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, "").trim()) {
      throw new Error("Invalid CA bundle");
    }
    for (const certificate of certificates) new X509Certificate(certificate);
    createSecureContext({ ca });
  } catch {
    throw new Error("DB_SSL_CA_PATH must identify a readable, valid PEM CA bundle");
  }

  // Keep the certificate name separate from the TCP host so private IP
  // connections use Node's normal certificate and hostname verification.
  return { ca, rejectUnauthorized: true, servername };
}

module.exports = { getPostgresTlsOptions };
