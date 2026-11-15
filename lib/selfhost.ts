import "server-only";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Client } from "@libsql/client";
import { env } from "./env.ts";
import type { User } from "./auth/identity.ts";

/** Off by default, so every hosted path stays exactly as it is. Set EMULY_SELF_HOST=1
    (at build time too — the proxy bundle may inline env) to run one container for yourself. */
export const SELF_HOST = process.env.EMULY_SELF_HOST === "1";

type Run = (file: string, args: string[]) => Promise<string>;

/** Run a gh subcommand and return its trimmed stdout. gh errors name the fix and carry no
    credentials, so the first line is safe to surface. */
function exec(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(new Error(`gh ${args[0]} failed: ${String(stderr || error.message).trim().split("\n")[0].slice(0, 200)}`));
      else resolve(stdout.trim());
    });
  });
}

/** Memoize a gh read for ttlMs, including a failed run, so one broken call cannot hammer gh. */
function memoize(run: Run, args: string[], ttlMs: number, clock: () => number): () => Promise<string> {
  let cache: { at: number } & ({ stdout: string } | { error: unknown }) | undefined;
  return async () => {
    if (cache && clock() - cache.at < ttlMs) {
      if ("error" in cache) throw cache.error;
      return cache.stdout;
    }
    try { cache = { stdout: await run("gh", args), at: clock() }; return cache.stdout; }
    catch (error) { cache = { error, at: clock() }; throw error; }
  };
}

/** gh >= 2.103 auto-refreshes an expiring token before printing it, so this needs no
    refresh logic of our own and nothing token-shaped is stored in the database. */
export function createGhTokenSource(run: Run, { ttlMs = 60_000, clock = Date.now } = {}) {
  return memoize(run, ["auth", "token"], ttlMs, clock);
}

const ghToken = createGhTokenSource((file, args) => exec(file, args, 15_000));
export { ghToken };

export type GhIdentity = { login: string; id: number; name: string | null; avatarUrl: string | null };

/** Validate the JSON shape like validateCodespace does: no unexpected response reaches the database. */
function validateIdentity(value: unknown): GhIdentity {
  const v = value as Record<string, unknown>;
  if (!v || typeof v.login !== "string" || !v.login || !Number.isSafeInteger(v.id)
    || (v.name !== null && typeof v.name !== "string")
    || (v.avatar_url !== null && typeof v.avatar_url !== "string")) {
    throw new Error("Unexpected `gh api user` response. Run `emuly doctor`.");
  }
  const { login, id, name, avatar_url: avatarUrl } = v as { login: string; id: number; name: string | null; avatar_url: string | null };
  return { login, id, name, avatarUrl };
}

const cachedIdentity = memoize((file, args) => exec(file, args, 15_000), ["api", "user"], 5 * 60_000, Date.now);
async function selfHostIdentity(): Promise<GhIdentity> {
  return validateIdentity(JSON.parse(await cachedIdentity()));
}

/** Upsert the one self-host user from the gh identity. The token columns stay empty: in
    self-host mode github-token.ts never reads them, the token lives in gh's own store. */
export async function selfHostUser(database: Client, options: { identity?: GhIdentity; now?: Date } = {}): Promise<User> {
  const identity = options.identity ?? await selfHostIdentity();
  const now = (options.now ?? new Date()).toISOString();
  const row = (await database.execute({
    sql: `INSERT INTO users (github_id, login, name, avatar_url, token_cipher, token_scopes, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, x'', '', ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET login = excluded.login, name = excluded.name,
      avatar_url = excluded.avatar_url, last_seen_at = excluded.last_seen_at
      RETURNING id, login, name, avatar_url`,
    args: [identity.id, identity.login, identity.name, identity.avatarUrl, now, now],
  })).rows[0] as unknown as { id: number; login: string; name: string | null; avatar_url: string | null } | undefined;
  if (!row) throw new Error("Could not store the self-host user. Run `emuly doctor`.");
  // Same derivation as identity.ts loadUser, so the console renders both identically.
  const initials = (row.name?.trim().split(/\s+/).map(part => Array.from(part)[0]).slice(0, 2).join("")
    || row.login.slice(0, 2)).toUpperCase();
  return { id: row.id, login: row.login, name: row.name, avatarUrl: row.avatar_url, initials, authKind: "session" };
}

/** The AES key for sealing values at rest, kept in a file next to the database so self-host
    needs no .env.local. Concurrent first boots may both write; the re-read after the write
    makes the winner the key everyone uses. */
export function selfHostTokenKey(): string {
  const file = join(dirname(env.dbPath), "token.key");
  try {
    const key = readFileSync(file, "utf8").trim();
    if (key) return key;
  } catch { /* missing: create it below */ }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${randomBytes(32).toString("base64")}\n`, { mode: 0o600 });
  return readFileSync(file, "utf8").trim();
}
