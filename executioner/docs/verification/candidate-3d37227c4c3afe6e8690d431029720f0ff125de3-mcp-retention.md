# Verification evidence

Code candidate: `3d37227c4c3afe6e8690d431029720f0ff125de3`

- Parent: `f457f3a1eae7503137f594697b405dc32b92bedd`
- Candidate tree: `2705a5283e00eb390cd31965c2950432ca9b21fe`
- Requested base tree: `94c709dea0f5089f200375197321248131ef4fa9`
- Branch: `codex/c3-retention-admission-evidence`
- Isolated worktree: `C:\Users\sushi\Documents\Github\temp\hunt-retention-admission-evidence`
- Artifact SHA-256: recorded in the adjacent `.sha256` file

## Scope

The regression is browser-free and starts `createStage2McpFromPreparedRun` with no caller-supplied `capture`, `run`, or `journeyBinding`. The test installs a controlled seam at the imported default binding module boundary before dynamically importing the composition. The composition therefore selects its default `runPreparedJourney` route, which calls `runStage2RealJourney`, and the result is read back through MCP.

The test covers:

- preserve succeeds;
- retention expiry is exactly the earlier of owner approval expiry and lease expiry;
- release returns `false`;
- fallback close runs after release failure;
- the original `page_incomplete` application error remains the primary MCP terminal;
- no browser, live account, secret, lease, Submit, or external service mutation.

Changed code and test files:

- `executioner/src/composition/s2-mcp-control.ts`
- `executioner/tests/composition/s2-mcp-control.test.ts`
- `executioner/tests/run.ts`

## Scoped toolchain

No inherited `PATH` claim was used. Commands used absolute executable paths.

| Tool | Absolute path | Version | SHA-256 |
| --- | --- | --- | --- |
| Node | `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\node.exe` | `v22.23.2` | `0D0F5E39F9F3D9587BC19F73EAB3C2C9C4903FD02D6DBF9C853DD81B3D95FAD4` |
| npm command | `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd` | `10.9.8` | `21B46C69AD6E2F231F02A9E120F4BA6C8E75FEF5A45637103002EAB99F888AB8` |
| npm CLI | `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\node_modules\npm\bin\npm-cli.js` | `10.9.8` | `3CE7CBA6F5128DD5F54C98B6A5036B0F850496878CC2E21044B675FE3C594E3E` |
| Git | `C:\Program Files\Git\cmd\git.exe` | `git version 2.53.0.windows.2` | `37C5725818D602E951BA2563B870D62763322956B73373DA4C33A0B566A80BC9` |
| PowerShell host | `C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell\pwsh.exe` | `7.6.4` | `DB6DD81183FE57D22E03B911EC9A30A2FD7C40542E97743615355A6FB44F458F` |
| ACL child PowerShell | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | `5.1.26100.7705` | `0FF6F2C94BC7E2833A5F7E16DE1622E5DBA70396F31C7D5F56381870317E8C46` |

Child and nested resolution evidence:

- `npm.cmd` sets `NODE_EXE=%~dp0\node.exe` and `NPM_CLI_JS=%~dp0\node_modules\npm\bin\npm-cli.js`.
- `npm run env --silent` reported `npm_node_execpath=C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\node.exe`.
- The same command reported `npm_execpath=C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\node_modules\npm\bin\npm-cli.js`.
- `executioner/tests/run.ts` passes `--experimental-test-module-mocks` and spawns the test child with `process.execPath`; the direct child probe resolved to the scoped Node path above.
- The ACL fixture helper resolves the absolute Windows PowerShell path above. No browser or live-process command was resolved or launched.

## Checks

All commands ran from `C:\Users\sushi\Documents\Github\temp\hunt-retention-admission-evidence\executioner`.

| Command | Result |
| --- | --- |
| `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd ci --ignore-scripts --no-audit --no-fund` | exit `0`, 5 packages added |
| `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd run typecheck` | exit `0` |
| `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd run build` | exit `0` |
| `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd test -- tests/composition/s2-mcp-control.test.ts` | exit `0`, 5 passed, 0 failed |
| `C:\Users\sushi\Documents\Codex\2026-08-21\hunt-codex-infra\node-v22.23.2-win-x64\npm.cmd test -- tests/composition/s2-application-walk-production-binding.test.ts` | exit `0`, 7 passed, 0 failed |
| `C:\Program Files\Git\cmd\git.exe diff --check` | exit `0` |

The verification artifact was generated after code commit `3d37227c4c3afe6e8690d431029720f0ff125de3` and its tree were known. The adjacent hash file records this document's SHA-256.
