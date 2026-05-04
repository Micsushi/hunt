# UI CLI

The C0 operator CLI lives in `scripts/uictl.py`.
Use it through the repo-root launchers:

- Windows PowerShell: `.\ui.ps1`
- Windows cmd: `.\ui.cmd`
- Linux/macOS shell: `./ui.sh`

Get help:

```powershell
.\ui.ps1 --help
.\ui.ps1 serve --help
.\ui.ps1 build --help
```

```bash
./ui.sh --help
./ui.sh serve --help
./ui.sh build --help
```

## Commands

- `serve`: Build the frontend if needed and start the C0 control plane at `http://localhost:8000`.
  Pass `--build` to force a rebuild even if `frontend/dist/` already exists.
- `build`: Compile the React frontend (`frontend/` → `frontend/dist/`).

## Examples

```powershell
.\ui.ps1 serve
.\ui.ps1 serve --build
.\ui.ps1 build
```

```bash
./ui.sh serve
./ui.sh serve --build
./ui.sh build
```

## Notes

- The frontend build requires Node/npm on `PATH`. Run `npm install` in `frontend/` before the
  first build, or let `serve` handle it automatically.
- C0 serves the review app and control plane API. It does not run C1/C2 - start those separately.
