# Resume Cooker CLI Contract

Schema v1 exposes `tools`, `build`, `preview`, `check`, `compare`, and `testers` through the package
binary. Relative paths resolve from the caller's working directory. Required input paths and
extensions are validated before output directories, tools, or network operations are started.

## Global behavior

- `--help` and `--version` write to stdout and exit 0.
- `--json` writes exactly one JSON object to stdout. Diagnostics use stderr.
- `--out <path>` atomically writes the same schema/status/run identity as stdout.
- Reports include `schema_version`, `command`, `run_id`, `status`, and
  `content_left_machine`.
- Stable reports sanitize secrets and machine-local absolute paths.
- API/full checks require `--allow-api`; provider configuration must independently authorize the
  request. A key alone never enables a request.

## Commands

```text
resume-cooker tools [--require-pdf-engine true] [--json]
resume-cooker build --resume <file.tex> [--out-dir <dir>] [--engine auto|native|docker]
resume-cooker preview --resume <file.tex> [--port 4177]
resume-cooker check --suite local|api|full --resume <file.tex> [--pdf <file.pdf>] [--jd <file>] [--tester-root <dir>]
resume-cooker compare --before <file> --after <file> [--pdf <file.pdf>] [--jd <file>]
resume-cooker testers --pdf <file.pdf> --text <file> [--profile normal|strict] [--tester-root <dir>]
```

Preview binds only `127.0.0.1`, reports its selected port, writes its ephemeral one-use launch URL
to stderr, and closes on SIGINT/SIGTERM. The launch URL is intentionally absent from JSON reports
and `--out` files. Opening it establishes an `HttpOnly`, `SameSite=Strict` session and redirects to a
clean URL. Temporary preview artifacts remain distinct from intentional build/output paths.

Tester applications are external development integrations and are not bundled in the npm package.
`--tester-root` selects their parent directory explicitly; otherwise adapters look under the
caller's `testers/` directory. Missing integrations remain structured unavailable evidence.

## Status and exits

| Result                            | Exit |
| --------------------------------- | ---: |
| `pass` or `pass_with_warnings`    |    0 |
| completed quality `fail`          |    2 |
| invalid command, option, or input |   64 |
| required capability unavailable   |   69 |
| unexpected internal failure       |   70 |

Additive optional fields may be added within schema v1. Removing, renaming, changing required field
meaning, or changing command/exit behavior requires a new schema or documented migration.
