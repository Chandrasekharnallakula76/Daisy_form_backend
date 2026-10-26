const fs = require("node:fs/promises");
const { validateLegacyInquiry } = require("./legacy-import");
const { openPostgresStorage } = require("./postgres-storage");

async function readPostgresImportSource(source, { sqlite = false } = {}) {
  let records;
  if (sqlite) {
    const Database = require("better-sqlite3");
    const database = new Database(source, { readonly: true, fileMustExist: true });
    try {
      records = database.prepare("SELECT payload FROM inquiries").all().map(({ payload }, index) => {
        try { return JSON.parse(payload); }
        catch { throw new Error(`Record ${index + 1}: payload must contain valid JSON`); }
      });
    } finally { database.close(); }
  } else {
    const contents = await fs.readFile(source, "utf8");
    try { records = JSON.parse(contents); }
    catch { throw new Error("Source must contain valid JSON"); }
    if (!Array.isArray(records)) throw new Error("Source must contain a JSON array");
  }
  records.forEach(validateLegacyInquiry);
  return records;
}

async function importPostgres({ source, sqlite = false, env = process.env, schema = "public", logger = console }) {
  const records = await readPostgresImportSource(source, { sqlite });
  const store = await openPostgresStorage({ env, schema, logger });
  try {
    const imported = await store.importInquiries(records);
    return { imported, skipped: records.length - imported };
  } finally { await store.close(); }
}

module.exports = { readPostgresImportSource, importPostgres };
