# Hunt : Server2 Deploy From Windows

Purpose: give one reliable Windows path to deploy Hunt changes to `server2`.

## Deploying a release

From the Hunt checkout, preview the combined C0, C1 and C2 application release, then run it.

```powershell
.\scripts\deploy_server2.ps1 -Stages 6,7 -PrintOnly
.\scripts\deploy_server2.ps1 -Stages 6,7
```

The wrapper selects the checkout commit by default. Pass `-ReleaseRef` with a full commit SHA to select another release. Before invoking Ansible it checks GitHub for a successful, completed push run of Hunt's CI workflow on main for that exact commit. A missing, pending or failed result stops the release. `-PrintOnly` prints the pinned command. `-Check` invokes Ansible check mode.

Stages 6 and 7 together select the application-only playbook path. The playbook verifies the release's image and schema qualification receipts before replacing the five app services. A single stage selects full mode for its component bundle (6 for C0/C1, 7 for C2). Full mode can recreate dependencies and apply schema changes. C3 runs on the user's computer. See [C3 Applications](../executioner/docs/product.md).

Install the infrastructure repository at `..\server_ansible_setup` or pass its path with `-AnsibleRepo`. Configure its server2 inventory, Hunt host variables, SSH access and deployment receipts. The wrapper calls its `ansible.ps1` with `playbooks/apps/hunt.yml`, the exact release SHA and a host limit of `server2`. Docker Desktop runs the Ansible control node.

## Public access and auth

For `server2`, internet exposure is still managed by `server_ansible_setup`, not by `python deploy.py` alone.

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
3. Preview the application release with `.\scripts\deploy_server2.ps1 -Stages 6,7 -PrintOnly`.
4. Use `.\scripts\deploy_server2.ps1 -Stages 6,7 -Check` for an Ansible dry run. The hosted CI check runs when activating the release.
5. Run the combined app deploy, or select a single stage when you intend full mode.
6. Run the relevant `server2` smoke checks before calling the deploy complete.

## How to test the full server2 path

Use this when you want to prove not just that Hunt can start, but that the Ansible wrapper still turns that runtime into a public Cloudflare-backed service.

1. Prove the Hunt-side runtime command first:

```powershell
python deploy.py all --mode server --env-file .env.server2 --dry-run
```

2. Optional Ansible check mode:

```powershell
.\scripts\deploy_server2.ps1 -Stages 6,7 -Check
```

3. Real remote deploy:

```powershell
.\scripts\deploy_server2.ps1 -Stages 6,7
```

4. After deploy, verify the private runtime contract on the host:

- Hunt containers are up on `server2`
- `hunt_review` and `hunt_frontend` exist with the expected names
- the `homelab` Docker network still contains those services

5. Then verify the public contract:

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

- Ansible checks out the pinned release and runs the selected deployment mode
- Cloudflare Tunnel still points at the same Hunt container identities
- public access works because the surrounding `server2` ingress and auth layer is still in place
