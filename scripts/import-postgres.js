const dotenv = require("dotenv");
const { importPostgres } = require("../src/postgres-import");

dotenv.config();

async function main() {
  const args = process.argv.slice(2);
  const sqlite = args[0] === "--sqlite";
  if ((!sqlite && args.length !== 1) || (sqlite && args.length !== 2) || args.at(-1)?.startsWith("--")) {
    console.error("Usage: npm run import:postgres -- SOURCE.json | --sqlite SOURCE.sqlite");
    process.exitCode = 1;
    return;
  }
  try {
    const { imported, skipped } = await importPostgres({ source: args.at(-1), sqlite });
    console.log(`Imported ${imported} inquiries; skipped ${skipped} existing IDs.`);
  } catch (error) {
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
