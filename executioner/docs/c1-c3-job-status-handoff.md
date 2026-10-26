# Planned C1/C3 job-status handoff

This page records a future integration contract only. C3 does not currently
write C1 job state, schedule a later C1 run, or change C1 storage.

## C3 availability outcomes

C3 classifies the page it can currently prove, after every navigation and
settled browser action. It does not identify a journey by memorizing a fixed
sequence of company-specific pages. The same page-state classifier therefore
applies before account entry, after sign-in, after verification, and between
application steps.

An exact Workday maintenance redirect with both reviewed maintenance markers is
reloaded up to three times. If any reload clears maintenance, C3 resumes normal
classification on the recovered page. If all three reloads remain the exact
maintenance page, C3 stops with:

```text
posting_unavailable(reason=maintenance)
```

Exact removed-posting states remain distinct:

```text
posting_unavailable(reason=not_found)
posting_unavailable(reason=closed)
posting_unavailable(reason=removed)
```

The existing exact generic unavailable state remains
`posting_unavailable(reason=unavailable)`. Ambiguous or contradictory pages do
not get relabeled as maintenance or removed; they fail closed as ambiguous.

An exact Workday `Something went wrong` runtime shell with the reviewed refresh
instruction is also reloaded up to three times. If it persists, C3 returns
`posting_unavailable(reason=runtime_error)` and the monitor must independently
classify `runtime_error`; this is temporary site/application-shell failure, not
evidence that the posting was removed.

The terminal result, retained evidence, and MCP response preserve the exact
reason code. The independent monitor uses `maintenance` only for that exact
reason and `posting_unavailable` for removed, closed, not-found, or generic
unavailable results; the completion audit rejects crossed labels. No final job
Submit is activated by these checks.

## Future C1 mapping

When C1/C3 synchronization is implemented, C1 should map the factual C3 result,
not infer from a company name or URL:

| C3 factual result | Planned C1 meaning | Planned C1 action |
| --- | --- | --- |
| `maintenance` | temporarily unavailable | record a retry-later status and schedule a separately authorized later attempt |
| `runtime_error` | temporarily unavailable | record a retry-later status and schedule a separately authorized later attempt |
| `not_found`, `closed`, or `removed` | posting is no longer available | record a no-longer-available status and stop normal application retries |
| `unavailable` | exact generic unavailability without a stronger cause | retain the exact cause and apply a future reviewed C1 retry/review policy |

C1 should retain the C3 observation time and admitted evidence reference with
the status. The retry schedule, status names, and C1 database mutation are still
planned work and must be implemented and tested in C1 separately.
