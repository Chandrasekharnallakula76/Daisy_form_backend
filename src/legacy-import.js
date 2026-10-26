const fs = require("node:fs");
const { csvColumns } = require("./csv");

function validateLegacyInquiry(inquiry, index) {
  const fail = (message) => { throw new Error(`Record ${index + 1}: ${message}`); };
  if (!inquiry || typeof inquiry !== "object" || Array.isArray(inquiry)) {
    fail("must be a JSON object");
  }
  if (typeof inquiry.id !== "string" || !inquiry.id.trim()) fail("id must be a non-empty string");
  const timestamp = inquiry.submittedAt;
  if (typeof timestamp !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp)
      || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    fail("submittedAt must be a UTC ISO timestamp, for example 2026-01-01T00:00:00.000Z");
  }
  for (const field of csvColumns) {
    if (inquiry[field] === undefined) continue;
    if (field === "interests" || field === "preferredFollowUpMethods") {
      if (!Array.isArray(inquiry[field]) || inquiry[field].some((value) => typeof value !== "string")) {
        fail(`${field} must be an array of strings`);
      }
    } else if (typeof inquiry[field] !== "string") {
      fail(`${field} must be a string`);
    }
  }
}

function importJson(source, databasePath) {
  const { openStorage } = require("./storage");
  let records;
  const contents = fs.readFileSync(source, "utf8");
  try { records = JSON.parse(contents); }
  catch { throw new Error("Source must contain valid JSON"); }
  if (!Array.isArray(records)) throw new Error("Source must contain a JSON array");
  records.forEach(validateLegacyInquiry);
  const store = openStorage(databasePath);
  try {
    const imported = store.importInquiries(records);
    return { imported, skipped: records.length - imported };
  } finally { store.close(); }
}

module.exports = { importJson, validateLegacyInquiry };
