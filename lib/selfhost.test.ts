import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "./data/async-database.ts";
import { openDatabase } from "./data/database.ts";
import { createGhTokenSource, selfHostTokenKey, selfHostUser } from "./selfhost.ts";

const identity = { login: "octocat", id: 583231, name: "The Octocat", avatarUrl: "https://avatars.githubusercontent.com/u/583231" };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "emuly-selfhost-"));
  const database = openDatabase(join(directory, "test.db"));
  const client = createClient({ url: pathToFileURL(join(directory, "test.db")).href });
  return {
    directory, database, client,
    async close() {
      client.close();
      database.close();
      globalThis.gc?.();
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

test("selfHostUser inserts on first call and updates the same row on the next", async () => {
  const f = fixture();
  try {
    const first = await selfHostUser(f.client, { identity });
    assert.equal(first.login, "octocat");
    assert.equal(first.name, "The Octocat");
    assert.equal(first.initials, "TO");
    assert.equal(first.authKind, "session");
    const row = f.database.prepare("SELECT github_id, token_cipher, token_scopes FROM users").get() as
      { github_id: number; token_cipher: Uint8Array; token_scopes: string };
    assert.equal(row.github_id, 583231);
    assert.equal(row.token_cipher.length, 0);
    assert.equal(row.token_scopes, "");
    // A renamed account updates the row instead of inserting a second one.
    const second = await selfHostUser(f.client, { identity: { ...identity, login: "new-name" } });
    assert.equal(second.id, first.id);
    assert.equal(second.login, "new-name");
    assert.equal((f.database.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n, 1);
  } finally { await f.close(); }
});

test("selfHostUser derives initials from the name, or from the login when there is no name", async () => {
  const f = fixture();
  try {
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: "ada" } })).initials, "A");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: "Grace Brewster Hopper" } })).initials, "GB");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, name: null } })).initials, "OC");
    assert.equal((await selfHostUser(f.client, { identity: { ...identity, login: "li", name: "  " } })).initials, "LI");
  } finally { await f.close(); }
});

test("selfHostTokenKey reads or creates a 32-byte key file next to the database", async () => {
  const directory = mkdtempSync(join(tmpdir(), "emuly-selfhost-key-"));
  process.env.EMULY_DB = join(directory, "test.db");
  try {
    const first = selfHostTokenKey();
    const file = join(directory, "token.key");
    assert.equal(Buffer.from(first, "base64").length, 32);
    // 0600: the key seals GitHub tokens at rest in the same directory.
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(selfHostTokenKey(), first, "the stored key is reused, not regenerated");
    assert.equal(readFileSync(file, "utf8").trim(), first);
    // An empty file is treated as missing so a broken write cannot wedge the app.
    writeFileSync(file, "");
    assert.notEqual(selfHostTokenKey(), first);
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});

test("createGhTokenSource caches hits and rejections within the TTL and refetches after it", async () => {
  let time = 1_000;
  const clock = () => time;
  const calls: string[] = [];
  let fail = false;
  const run = async (_file: string, args: string[]) => {
    calls.push(args.join(" "));
    if (fail) throw new Error("gh auth token failed: not logged in");
    return "synthetic-token";
  };
  const token = createGhTokenSource(run, { ttlMs: 60_000, clock });
  await assert.equal(await token(), "synthetic-token");
  await assert.equal(await token(), "synthetic-token");
  assert.deepEqual(calls, ["auth token"], "a second call inside the TTL does not run gh again");
  fail = true;
  time += 60_001;
  await assert.rejects(token(), /^Error: gh auth token failed: not logged in$/);
  await assert.rejects(token(), /^Error: gh auth token failed: not logged in$/);
  assert.deepEqual(calls, ["auth token", "auth token"], "one run per TTL window, including a failure");
  fail = false;
  time += 60_001;
  await assert.equal(await token(), "synthetic-token");
  assert.equal(calls.length, 3);
});
