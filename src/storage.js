const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

function openStorage(databasePath) {
  const filename = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const database = new Database(filename);
  try {
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.pragma("busy_timeout = 5000");
    database.exec(`
      CREATE TABLE IF NOT EXISTS inquiries (
        id TEXT PRIMARY KEY NOT NULL,
        submitted_at TEXT NOT NULL,
        payload TEXT NOT NULL
      )
    `);
    const insert = database.prepare(
      "INSERT INTO inquiries (id, submitted_at, payload) VALUES (?, ?, ?)",
    );
    const selectAll = database.prepare(
      "SELECT payload FROM inquiries ORDER BY submitted_at DESC, id DESC",
    );
    const insertIfMissing = database.prepare(
      "INSERT INTO inquiries (id, submitted_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING",
    );
    const importInquiries = database.transaction((inquiries) => {
      let imported = 0;
      for (const inquiry of inquiries) {
        imported += insertIfMissing.run(inquiry.id, inquiry.submittedAt, JSON.stringify(inquiry)).changes;
      }
      return imported;
    });
    const health = database.prepare("SELECT count(*) FROM inquiries");

    return {
      saveInquiry(inquiry) {
        insert.run(inquiry.id, inquiry.submittedAt, JSON.stringify(inquiry));
      },
      listInquiries() {
        return selectAll.all().map((row) => JSON.parse(row.payload));
      },
      importInquiries,
      isReady() {
        try {
          health.get();
          return true;
        } catch {
          return false;
        }
      },
      close() {
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}

module.exports = { openStorage };
