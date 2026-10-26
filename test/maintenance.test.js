const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const Database = require("better-sqlite3");
const { openStorage } = require("../src/storage");

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "daisy-maintenance-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, databasePath: path.join(directory, "data", "inquiries.sqlite"), source: path.join(directory, "legacy.json") };
}

function cli(name, args, { directory, databasePath }, useDotenv = false) {
  const env = { ...process.env, DATABASE_PATH: databasePath };
  if (useDotenv) delete env.DATABASE_PATH;
  return spawnSync(process.execPath, [path.resolve(__dirname, `../scripts/${name}.js`), ...args], {
    cwd: directory, env, encoding: "utf8", timeout: 10000,
  });
}

const oldRecord = {
  id: "legacy-id", submittedAt: "2024-01-02T03:04:05.000Z",
  fullName: "Zoë", companyOrganization: "Legacy Co", businessEmail: "zoe@example.com",
  interests: ["exploring-ai"], preferredFollowUpMethods: ["email"],
};

function storedRows(databasePath) {
  const database = new Database(databasePath, { readonly: true });
  try {
    return database.prepare("SELECT payload FROM inquiries ORDER BY id").all().map((row) => JSON.parse(row.payload));
  } finally { database.close(); }
}

test("JSON import preserves legacy data and is safe to repeat", async (t) => {
  const context = await fixture(t);
  const original = JSON.stringify([oldRecord], null, 2);
  await fs.writeFile(context.source, original);
  await fs.writeFile(path.join(context.directory, ".env"), `DATABASE_PATH=${context.databasePath}\n`);
  const first = cli("import-json", [context.source], context, true);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Imported 1/);
  assert.deepEqual(storedRows(context.databasePath), [oldRecord]);
  const repeated = cli("import-json", [context.source], context);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.match(repeated.stdout, /Imported 0/);
  assert.deepEqual(storedRows(context.databasePath), [oldRecord]);
  assert.equal(await fs.readFile(context.source, "utf8"), original);
});

test("invalid legacy files leave existing inquiries and their source untouched", async (t) => {
  const context = await fixture(t);
  const store = openStorage(context.databasePath);
  store.saveInquiry(oldRecord);
  store.close();
  const newRecord = { ...oldRecord, id: "new-record" };
  const invalidFiles = [
    "{", "{}", "null", JSON.stringify([newRecord, null]), JSON.stringify([newRecord, []]),
    JSON.stringify([newRecord, { ...oldRecord, id: "" }]),
    JSON.stringify([newRecord, { ...oldRecord, id: 123 }]),
    JSON.stringify([newRecord, { ...oldRecord, submittedAt: undefined }]),
    JSON.stringify([newRecord, { ...oldRecord, submittedAt: "yesterday" }]),
    JSON.stringify([newRecord, { ...oldRecord, submittedAt: "2024-02-30T03:04:05.000Z" }]),
    JSON.stringify([newRecord, { ...oldRecord, fullName: {} }]),
    JSON.stringify([newRecord, { ...oldRecord, interests: ["exploring-ai", {}] }]),
    JSON.stringify([newRecord, { ...oldRecord, preferredFollowUpMethods: "email" }]),
  ];
  for (const source of invalidFiles) {
    await fs.writeFile(context.source, source);
    const result = cli("import-json", [context.source], context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Import failed:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
    assert.deepEqual(storedRows(context.databasePath), [oldRecord]);
    assert.equal(await fs.readFile(context.source, "utf8"), source);
  }
});

test("an import database failure rolls back records inserted earlier in the batch", async (t) => {
  const context = await fixture(t);
  const store = openStorage(context.databasePath);
  store.saveInquiry(oldRecord);
  store.close();
  const database = new Database(context.databasePath);
  database.exec("CREATE TRIGGER reject_import BEFORE INSERT ON inquiries WHEN NEW.id = 'reject' BEGIN SELECT RAISE(ABORT, 'cannot store record'); END");
  database.close();
  await fs.writeFile(context.source, JSON.stringify([
    { ...oldRecord, id: "first-new" }, { ...oldRecord, id: "reject" },
  ]));
  const result = cli("import-json", [context.source], context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Import failed:/);
  assert.deepEqual(storedRows(context.databasePath), [oldRecord]);
});

test("backup snapshots committed WAL data into a standalone database", async (t) => {
  const context = await fixture(t);
  const store = openStorage(context.databasePath);
  t.after(() => store.close());
  store.saveInquiry(oldRecord);
  const destination = path.join(context.directory, "backups", "event.sqlite");
  const result = cli("backup", [destination], context);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(storedRows(destination), [oldRecord]);
  store.saveInquiry({ ...oldRecord, id: "after-backup" });
  assert.deepEqual(storedRows(destination), [oldRecord]);
  assert.equal(store.listInquiries().length, 2);
});

test("backup refuses existing targets, source database paths, and symlinks", async (t) => {
  const context = await fixture(t);
  const store = openStorage(context.databasePath);
  store.saveInquiry(oldRecord);
  store.close();
  const destination = path.join(context.directory, "keep.sqlite");
  await fs.writeFile(destination, "do not overwrite");
  const symlink = path.join(context.directory, "source-link.sqlite");
  await fs.symlink(context.databasePath, symlink);
  for (const target of [destination, context.databasePath, symlink]) {
    const result = cli("backup", [target], context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Backup failed:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  }
  assert.equal(await fs.readFile(destination, "utf8"), "do not overwrite");
  assert.deepEqual(storedRows(context.databasePath), [oldRecord]);
});

test("maintenance commands reject missing arguments and a missing backup source", async (t) => {
  const context = await fixture(t);
  for (const script of ["import-json", "backup"]) {
    const result = cli(script, [], context);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
  const target = path.join(context.directory, "missing-source-backup.sqlite");
  const result = cli("backup", [target], context);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Backup failed:/);
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});
