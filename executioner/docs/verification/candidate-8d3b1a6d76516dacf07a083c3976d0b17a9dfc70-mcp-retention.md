# Candidate verification evidence

Candidate under review: `8d3b1a6d76516dacf07a083c3976d0b17a9dfc70`

- Parent: `ed5e695a6b8ad44d804289a61bceb0aae62d0f0d`
- Candidate tree: `45f669e977f9a08056da95e7ddcbf06f5e00eea7`
- Accepted merge base: `5e147590faaa952e39f56d33d72e94bfba9b390a`
- Isolated worktree: `C:\Users\sushi\Documents\Github\temp\hunt-c3-retention-evidence-defect`
- Branch: `codex/c3-retention-evidence-defect`
- Artifact SHA-256: recorded in the adjacent `.sha256` file

## Scope

Browser-free regression only. The test uses temporary value-free owner fixtures and a fake live runtime behind the real production binding. It performs no browser, live account, secret, lease resource, submit, or external service mutation.

Changed files:

- `executioner/src/composition/s2-mcp-control.ts`
- `executioner/tests/composition/s2-mcp-control.test.ts`

The regression starts through `createStage2McpFromPreparedRun`, leaves its default `runPreparedJourney` runner selected, reaches `runStage2RealJourney` through `createStage2RealJourneyProductionBinding`, and reads the terminal back through MCP. It proves:

- preserve accepted, then release at the exact minimum of approval and lease expiry;
- preserve rejected, then fallback close;
- the primary `page_incomplete` error remains in the MCP terminal;
- the retained resume artifact is not reusable after cleanup.

## Scoped environment

Command:

```powershell
$nodeRoot='C:\Users\sushi\AppData\Local\Hunt\runtimes\node-v22.23.2-win-x64'; $env:PATH="$nodeRoot;$env:PATH"; Write-Output "PATH=$env:PATH"; Write-Output "PowerShell=$($PSVersionTable.PSVersion)"; node --version; npm --version; git --version
```

Result:

```text
PATH=C:\Users\sushi\AppData\Local\Hunt\runtimes\node-v22.23.2-win-x64;C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell;C:\Users\sushi\.codex\tmp\arg0\codex-arg0lp98ll;C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\override;C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot\bin;C:\VulkanSDK\1.4.350.0\Bin;C:\Program Files\Common Files\Oracle\Java\javapath;C:\WINDOWS\system32;C:\WINDOWS;C:\WINDOWS\System32\Wbem;C:\WINDOWS\System32\WindowsPowerShell\v1.0\;C:\WINDOWS\System32\OpenSSH\;C:\Program Files\nodejs\;C:\Program Files\dotnet\;C:\Program Files\NVIDIA Corporation\NVIDIA App\NvDLISR;C:\Program Files (x86)\NVIDIA Corporation\PhysX\Common;C:\Users\sushi\AppData\Local\Python\pythoncore-3.14-64\Scripts\.;C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot\\bin;C:\Program Files\Git\cmd;C:\Program Files\starship\bin\;C:\Program Files\SoundSwitch;C:\Program Files\Docker\Docker\resources\bin;C:\Program Files\CMake\bin;C:\Program Files\GitHub CLI\;C:\Users\sushi\AppData\Local\Programs\Python\Python311\Scripts\;C:\Users\sushi\AppData\Local\Programs\Python\Python311\;C:\Users\sushi\.cargo\bin;C:\Users\sushi\.onwatch;C:\Users\sushi\Documents\Github\budgeter\.venv\Scripts;C:\Program Files\Java\jdk-26\bin;C:\Program Files\Java\jdk-26\bin;C:\Users\sushi\AppData\Local\Programs\Python\Python313\Scripts\;C:\Users\sushi\AppData\Local\Programs\Python\Python313\;C:\Users\sushi\AppData\Local\Programs\Python\Launcher\;C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\powershell;C:\Users\sushi\AppData\Local\Microsoft\WindowsApps;C:\Users\sushi\AppData\Local\GitHubDesktop\bin;C:\Users\sushi\AppData\Roaming\npm;C:\Users\sushi\AppData\Local\Programs\Microsoft VS Code\bin;C:\Users\sushi\AppData\Local\Programs\cursor\resources\app\bin;C:\Users\sushi\AppData\Local\Python\bin;C:\Program Files\Java\jdk-26\bin;C:\Users\sushi\.local\bin;C:\Users\sushi\AppData\Local\Programs\Ollama;C:\Program Files (x86)\GnuWin32\bin;C:\Users\sushi\AppData\Local\Programs\Antigravity\bin;C:\Users\sushi\Documents\Github\hunt;C:\Users\sushi\AppData\Local\Programs\Antigravity IDE\bin;C:\Users\sushi\Documents\Github\BugMe\target\debug;C:\Users\sushi\Documents\Github\onWatch\.tmp-go\go\bin;C:\Users\sushi\Documents\Github\BugMe\target\release;C:\Users\sushi\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin;C:\Users\sushi\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\.\bun-windows-x64;C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback;C:\Users\sushi\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd;C:\Users\sushi\AppData\Local\OpenAI\Codex\bin\c4983cb2afde1223;C:\Program Files\WindowsApps\OpenAI.Codex_26.818.3698.0_x64__2p2nqsd0c76g0\app\resources
PowerShell=7.6.4
v22.23.2
10.9.8
git version 2.53.0.windows.2
```

## Command results

All commands ran from `C:\Users\sushi\Documents\Github\temp\hunt-c3-retention-evidence-defect\executioner` with the scoped child PATH above.

### Typecheck

Command: `npm run typecheck`

Result: exit `0`

```text
> @hunt/executioner@3.0.0 typecheck
> tsc --noEmit
```

### Build

Command: `npm run build`

Result: exit `0`

```text
> @hunt/executioner@3.0.0 build
> tsc -p tsconfig.build.json
```

### Default MCP regression

Command: `npm test -- tests/composition/s2-mcp-control.test.ts`

Result: exit `0`, 5 tests passed, 0 failed.

```text
# tests 5
# pass 5
# fail 0
# cancelled 0
```

### Related production binding suite

Command: `npm test -- tests/composition/s2-application-walk-production-binding.test.ts`

Result: exit `0`, 7 tests passed, 0 failed.

```text
# tests 7
# pass 7
# fail 0
# cancelled 0
```

### Diff hygiene

Command: `git diff --check`

Result: exit `0`.

No browser, live account, lease resource, secret, submit, remote, merge, or submit action was run.
