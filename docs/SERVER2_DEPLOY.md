# Hunt : Server2 Deploy From Windows

Purpose: give one reliable Windows path to deploy Hunt changes to `server2`.

## What was missing before

Before this doc, Hunt mentioned `server2` and the separate Ansible repo, but it did not give a repo-local Windows command. That made deploys easy to forget or improvise.

## Standard command

From the Hunt repo in PowerShell:

```powershell
.\scripts\deploy_server2.ps1 -Stages 6
```

That runs the `job_agent` playbook in the sibling `ansible_homelab` repo and deploys Hunt Stage 6 to `server2`.

Useful variants:

```powershell
.\scripts\deploy_server2.ps1 -Stages 6 -Check
.\scripts\deploy_server2.ps1 -Stages 6,7
.\scripts\deploy_server2.ps1 -Stages 6 -PrintOnly
.\scripts\deploy_server2.ps1 -Stages 9 -AnsibleRepo C:\path\to\ansible_homelab
```

## Stage map

- `6`: C0 + C1 + Postgres base Hunt runtime
- `7`: C2 Fletcher
- `8`: C3 helper artifacts
- `9`: C4 Coordinator / OpenClaw runtime

## Prerequisites

- `ansible_homelab` exists next to this repo at `..\ansible_homelab`, or you pass `-AnsibleRepo`
- Docker Desktop is running on Windows: the Ansible helper launches a containerized control node
- `ansible_homelab\inventory.local` exists and points at `server2`
- `ansible_homelab\group_vars\job_agent\vars_local.yml` exists with the required Hunt secrets
- Your Windows `~\.ssh` key can reach `server2`

## What the wrapper does

`scripts/deploy_server2.ps1` does not deploy Hunt directly. It resolves the sibling `ansible_homelab` repo, then forwards to:

```powershell
powershell -ExecutionPolicy Bypass -File ..\ansible_homelab\deploy.ps1 -Target job_agent ...
```

That keeps the real deployment logic in one place while giving Hunt a stable operator command.

## Public access and auth

For `server2`, internet exposure is still managed by `ansible_homelab`, not by `python deploy.py` alone.

- Hunt owns the runtime command and container shape.
- Ansible owns the server environment around that runtime:
  - `homelab` Docker network
  - Cloudflare Tunnel container and ingress rules
  - the choice to use Cloudflare Access on `server2`

Current `server2` model:

- public hostname for the review/backend surface routes to `hunt_review`
- public hostname for the SPA routes to `hunt_frontend`
- `server2` does **not** use local Traefik/Authelia for Hunt
- auth is expected to be handled by Cloudflare Access outside the repo

Important limit:
- repo code can verify the tunnel target wiring and deployment contract
- repo code cannot verify the live Cloudflare Access dashboard policy itself

## Recommended flow

1. Run local verification first: `python ci.py shared` plus the component-specific target you changed.
2. Verify the repo-native runtime command you expect the host to run: for example `python deploy.py c1 --mode server --env-file .env.server2 --dry-run`.
   If you run it manually on `server2`, include `--project-name hunt-server2` so Docker Compose manages the same project Ansible owns.
3. Preview the remote deploy wrapper: `.\scripts\deploy_server2.ps1 -Stages 6 -PrintOnly`
4. Optional Ansible check mode: `.\scripts\deploy_server2.ps1 -Stages 6 -Check`
5. Run the real deploy.
6. Run the relevant `server2` smoke checks before calling the deploy complete.

## How to test the full server2 path

Use this when you want to prove not just that Hunt can start, but that the Ansible wrapper still turns that runtime into a public Cloudflare-backed service.

1. Prove the Hunt-side runtime command first:

```powershell
python deploy.py all --mode server --env-file .env.server2 --dry-run
```

2. Preview the exact remote playbook command:

```powershell
.\scripts\deploy_server2.ps1 -Stages 9 -PrintOnly
```

3. Optional Ansible check mode:

```powershell
.\scripts\deploy_server2.ps1 -Stages 9 -Check
```

4. Real remote deploy:

```powershell
.\scripts\deploy_server2.ps1 -Stages 9
```

5. After deploy, verify the private runtime contract on the host:

- Hunt containers are up on `server2`
- `hunt_review` and `hunt_frontend` exist with the expected names
- the `homelab` Docker network still contains those services

6. Then verify the public contract:

- open the public frontend hostname through Cloudflare Tunnel
- open the public review/backend hostname through Cloudflare Tunnel
- confirm Cloudflare Access still challenges or grants access the same way it did before
- run the relevant `server2` smoke checks

## C1 production-cycle validation

The previous repo-native `server2` smoke only proved that C0 could reach C1. It did not drive a live C1 run.

Use this when you need to validate the first C1 production checklist item:

```powershell
python smoke.py server2-c1
```

What it validates:

- C0 login still works
- C0 can reach the C1 service API
- a live `/api/gateway/c1/scrape` trigger is accepted
- the scrape and post-scrape enrich pass return to idle
- no LinkedIn rows remain stuck in `processing`
- C0 still reports C1 healthy after the cycle

If you want the combined production smoke:

```powershell
python smoke.py server2
```

Expected result:

- Ansible updates the repo, renders the server env file, and runs the Hunt repo-native deploy command remotely
- Cloudflare Tunnel still points at the same Hunt container identities
- public access works because the surrounding `server2` ingress and auth layer is still in place
