const dotenv = require("dotenv");
const { backupDatabase } = require("../src/backup");

dotenv.config();

if (process.argv.length !== 3) {
  console.error("Usage: npm run backup -- DESTINATION_PATH");
  process.exitCode = 1;
} else {
  backupDatabase(process.env.DATABASE_PATH || "./data/inquiries.sqlite", process.argv[2]).then((destination) => {
    console.log(`Backup saved to ${destination}`);
  }).catch((error) => {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
