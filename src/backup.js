const fs = require("node:fs/promises");
const path = require("node:path");
const Database = require("better-sqlite3");

async function backupDatabase(databasePath, destinationPath) {
  const source = path.resolve(databasePath);
  const destination = path.resolve(destinationPath);
  if ([source, `${source}-wal`, `${source}-shm`, `${source}-journal`].includes(destination)) {
    throw new Error("Destination must differ from the source database and its sidecars");
  }
  try {
    await fs.lstat(destination);
    throw new Error("Destination already exists; choose a new backup filename");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const database = new Database(source, { readonly: true, fileMustExist: true });
  let temporaryDirectory;
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    temporaryDirectory = await fs.mkdtemp(path.join(path.dirname(destination), ".daisy-backup-"));
    const temporaryPath = path.join(temporaryDirectory, "snapshot.sqlite");
    await database.backup(temporaryPath);
    await fs.chmod(temporaryPath, 0o600);
    // Publishing a hard link is atomic and refuses a destination created during backup.
    await fs.link(temporaryPath, destination);
    return destination;
  } finally {
    database.close();
    if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
}

module.exports = { backupDatabase };
