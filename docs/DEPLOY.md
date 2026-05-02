# Hunt : Repo-Native Deploy

Purpose: one repo command to start the full Hunt stack or a selected service bundle on either Windows or Linux.

## Standard command

From the repo root:

```bash
python deploy.py all
```

That is now the standard repo-native deploy entrypoint on both Windows and Linux.

Server-shaped deploys use the same command surface with an extra mode:

```bash
python deploy.py all --mode server --env-file .env.server2
```

## Targets

- `db`: Postgres only
- `c0`: C0 web runtime : backend review app + frontend + Postgres
- `c1`: C0 + C1 Hunter
- `c2`: C0 + C2 Fletcher + Ollama
- `c4`: C0 + C4 Coordinator
- `c1c2`: C0 + C1 + C2
- `all`: full local/runtime stack : C0 + C1 + C2 + C4

Aliases:

- `full` -> `all`
- `hunter` -> `c1`
- `fletcher` -> `c2`
- `coordinator` -> `c4`
- `pipeline` -> `all`

## Examples

```bash
python deploy.py c0
python deploy.py c1
python deploy.py c2 --no-build
python deploy.py all --dry-run
python deploy.py all --mode server --env-file .env.server2
python deploy.py c1 --stop
python deploy.py c4 --restart
python deploy.py all --logs
python deploy.py all --ps
```

## What was wrong before

Before this, the repo had `docker-compose.pipeline.yml` plus several local smoke and dev helpers, but no single deploy command that treated this repo as the deployment surface. That made local runtime, Windows runtime, and server deploy logic drift apart.

## How it works

- `deploy.py` forwards to `scripts/run_deploy_stack.py`
- the deploy runner uses `docker compose -f docker-compose.pipeline.yml`
- it targets the exact service bundle directly, so the same command works on Windows and Linux as long as Docker Compose is available
- `--mode server` adds `docker-compose.server.yml` so the deploy inherits the older server2 lessons: fixed container identities, `homelab` network compatibility, persistent host binds, and the Hunter scheduler sidecar

## Server2 note

This command is the runtime entrypoint the repo should own.

Today the remote `server2` deploy still goes through `ansible_homelab`, but the intended direction is simpler:

1. Ansible updates the repo and environment on `server2`
2. Ansible runs the repo-native deploy command from this repo
3. Smoke checks confirm the deployed services

Use `.env.server.example` as the tracked template for the target host deploy environment.

Public exposure is intentionally outside this command:

- manual local deploy: local-only unless you separately place it behind a public ingress
- Ansible `server2` deploy: same Hunt runtime command, but wrapped with Cloudflare Tunnel and the existing server auth model

## How to test local deploy

Use this when you want to prove the Hunt repo can deploy itself locally on either Windows or Linux.

1. Static verification:

```bash
python ci.py shared
python deploy.py all --dry-run
```

2. Real local deploy:

```bash
python deploy.py all
```

3. Container/runtime checks:

```bash
python deploy.py all --ps
python smoke.py
```

4. Quick manual endpoint checks:

```bash
curl http://127.0.0.1:18080/health
curl http://127.0.0.1:18090/
```

Expected result:

- Docker Compose shows the selected Hunt services as running
- `smoke.py` passes for the stack you started
- backend health responds on `127.0.0.1:18080`
- frontend loads on `127.0.0.1:18090`

If you only changed one component, use the narrower target instead of `all`, then run the matching smoke or test target.

## How to test server-shaped deploy locally

Use this when you want to prove the exact command Ansible will run is valid before touching `server2`.

1. Render and validate the server-shaped config:

```bash
python deploy.py all --mode server --env-file .env.server2 --dry-run
docker compose --env-file .env.server2 -f docker-compose.pipeline.yml -f docker-compose.server.yml config
```

2. Optional server-shaped local run:

```bash
python deploy.py all --mode server --env-file .env.server2
python deploy.py all --mode server --env-file .env.server2 --ps
```

Expected result:

- the dry run prints a server-mode command with both compose files
- Compose config renders without errors
- the runtime comes up with the fixed container names and server-shaped binds from `.env.server2`

Important limit:

- this proves the Hunt repo deploy contract
- it does **not** make the stack public by itself
- public internet access still requires the `server2` ingress layer managed by Ansible and Cloudflare Tunnel
