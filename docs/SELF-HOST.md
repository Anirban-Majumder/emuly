# Self-host

Run Emuly on your own machine or in one Docker container, with your GitHub account
instead of a hosted service. Everything the hosted deployment does stays the same:
phones still run in your own GitHub Codespaces on your plan's included hours.

## How it works

- One Node process runs the Next app, the backend and the phone stream proxy.
- The GitHub token does not live in Emuly. The `gh` CLI inside the same runtime
  holds it, and `gh auth token` hands it over at request time. gh ≥ 2.103
  refreshes an expiring token before printing it, so Emuly needs no refresh code.
- There is exactly one user: the account signed in to gh. No OAuth App, no client
  secret, no `.env.local`.
- The token encryption key is generated into `<database directory>/token.key` on
  first start, so webhook secrets still get AES-256-GCM at rest.
- `EMULY_SELF_HOST=1` turns the mode on. Unset (the default), Emuly behaves
  exactly like the hosted deployment.

## Option A: Docker (recommended)

You need Docker or Podman with Compose. From `deploy/selfhost/`:

```sh
docker compose build
docker compose run --rm emuly gh auth login -h github.com -s codespace
docker compose up
```

Then open `http://localhost:4321`. The login runs gh's device flow: GitHub shows a
one-time code, you enter it in the browser, and the credential store is written to
the `emuly-gh` volume — it survives restarts.

If the login reports the scope is missing, run:

```sh
docker compose run --rm emuly gh auth refresh -h github.com -s codespace
```

`docker compose run --rm emuly node emuly.mjs doctor` checks gh, the token, the
codespace scope and the data directory in one go. Publish the port on loopback
only (the compose file already does): the self-host API is intentionally
unauthenticated and must not be reachable from other machines.

## Option B: local, without Docker

You need Node 26, pnpm and the gh CLI, signed in on this machine:

```sh
pnpm install
pnpm emuly up
```

`up` checks gh, runs the database migration and starts the server with the flag
set. If it asks for a login or a scope repair, run the command it prints, or
`pnpm emuly login` and start again.

## The build-time flag

`EMULY_SELF_HOST=1` must be set when you build (`docker compose build` does this
through the Dockerfile). Bundles such as the proxy may inline environment values
at build time, so a runtime-only flag could leave self-host code compiled out.
The Dockerfile sets it in both stages, so the compose path needs no extra env
file.

## Volumes and backups

| Volume        | Contents                                    |
| ------------- | ------------------------------------------- |
| `emuly-data`  | `emuly.db` (SQLite) and the `token.key` file |
| `emuly-gh`    | gh's credential store (the GitHub token)     |

Both are ordinary Docker volumes. A backup is a copy: with the container stopped,
`docker run --rm -v emuly-data:/data -v "$PWD:/backup" alpine tar czf /backup/emuly-data.tgz /data`.
The gh volume contains a live token — keep it private, or simply log in again
after a restore instead of copying it.

To start over, `docker compose down -v` removes both volumes. Your phones live in
your GitHub codespaces and survive this; Emuly re-registers them on next start.

## Limitations

- **Webhooks need a public URL.** Set `EMULY_BASE_URL` to an address GitHub's
  webhooks can reach, and know that the API below it stays unauthenticated. If
  you do not need webhooks, leave everything on loopback.
- **One user.** Every request resolves to the gh-signed-in account; agent keys
  you create still work, but there is no second account and no sign-up page.
- **Unauthenticated API.** Anyone who can reach the port can drive your phones.
  Publish on loopback, or put your own front (VPN, Tailscale, reverse proxy with
  auth) in front of it.
- **No token rotation in the database.** gh owns the token and refreshes it. Do
  not set `GH_TOKEN`/`GITHUB_TOKEN`: it bypasses gh's store and usually lacks the
  `codespace` scope, so Emuly refuses to start with it set.

## Checks and repair

- `pnpm emuly doctor` (or `docker compose run --rm emuly node emuly.mjs doctor`)
  reports what is missing: gh version, a signed-in account, the `codespace`
  scope, `gh auth token`, and a writable data directory.
- A scope error from GitHub: run the `gh auth refresh -h github.com -s codespace`
  command from the table above.
- The console stays empty or the identity looks wrong: the gh account changed
  while the old user row exists; stop, and remove the database volume to re-seed.
