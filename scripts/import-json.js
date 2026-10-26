const dotenv = require("dotenv");
const { importJson } = require("../src/legacy-import");

dotenv.config();

if (process.argv.length !== 3) {
  console.error("Usage: npm run import:json -- SOURCE_PATH");
  process.exitCode = 1;
} else {
  try {
    const { imported, skipped } = importJson(process.argv[2], process.env.DATABASE_PATH || "./data/inquiries.sqlite");
    console.log(`Imported ${imported} inquiries; skipped ${skipped} existing IDs.`);
  } catch (error) {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  }
}
