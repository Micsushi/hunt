# Resume review publication and compiler recovery

The review package is the authoritative document record. Legacy per-version
`current.json`, `original.json`, and `generated.json` files are no longer read
or refreshed. Existing files are not removed. Save through the review API;
editing those historical copies does not change the current document.

Saves increment an edit revision under a cross-process publication lock.
JSON publication uses a flushed temporary file and atomic replacement. This
prevents partial JSON visibility, not a database/filesystem-wide transaction
or a power-loss durability guarantee.

The save API requires `expected_revision` alongside `current`. A different saved
revision rejects an overwrite with HTTP 409. Retrying an already saved identical
document returns its existing revision, covering a lost acknowledgement without
creating another edit. Internal replacement callers retain their explicit
replacement behavior.

The review editor keeps newer typing when a pending save finishes. Conflicts
retain the draft and offer **Review saved version**, then an explicit choice to
keep the draft for saving or use the saved document. Drafts and an open block
edit survive navigation within the same app session through its in-memory query
cache. This is not a disk backup or cross-restart recovery promise. Apply a block
edit before saving the document, compiling, or switching versions. The editor's
Undo can restore a draft replaced by **Use saved version**.

Option B upload completion clears the submitted description only when both that
text and the selected resume are still unchanged. Newer input stays intact.
An existing run with the same description
is shown as a warning; it does not prevent a separate run using another resume.

Compilation uses an isolated temporary directory outside the publication lock.
Before publishing, the saved version must still match the initial snapshot,
including its edit revision. Concurrent edits, even an edit followed by revert,
reject the obsolete compile. Reload and compile the saved version again; do not
restore the obsolete snapshot. Overlapping compiles can publish only one result.
Previously published revisions are never overwritten. An interrupted promotion
may leave an unreferenced revision; the next publication skips it.

The selected job resume receives the exact new revision paths. Database selection
and package replacement are not one transaction: an unavailable database can
still prevent selection. Confirm selected paths before C3 admission. These
repairs do not certify the live C3 journey or waive its separate security gate.

## Executable regression rules

Run from the repository root:

```powershell
python -B -m pytest tests/test_fletcher_review_workspace.py tests/test_resume_review_io.py tests/test_resume_compiler_bounds.py tests/test_resume_review_ui.py tests/test_resume_renderer.py tests/test_component2_pipeline.py tests/test_ad_hoc_pipeline.py tests/test_fletcher_queue_recovery.py -q -p no:cacheprovider
```

| Failure | Executable coverage | Recovery rule |
| --- | --- | --- |
| Compile erases newer save | `test_compile_completion_preserves_newer_saved_edit` | Reject stale result; retain saved edit |
| Edit/revert hides concurrent mutation | `test_compile_rejects_edit_then_revert_even_when_content_matches` | Compare edit revision, not content alone |
| Concurrent compiles share artifacts | `test_overlapping_compiles_publish_only_one_isolated_revision` | Separate staging; publish once |
| New compile selects old PDF | `test_successful_recompile_selects_the_new_revision` | Select exact promoted revision |
| Replacement fails | `test_failed_publication_preserves_previous_record` | Retain readable previous JSON |
| Writer lock contention | `test_publication_lock_is_bounded_and_released` | Return busy after five seconds; retry |
| Page-tree subtraction undercounts pages | `test_fallback_counts_leaf_pages_without_subtracting_tree` | Count leaf `/Page` objects, not `/Pages` nodes |
| Stalled/flooding document tools | `test_harmless_stalled_tool_is_bounded`, `test_harmless_output_flood_is_bounded` | Fail closed; no old PDF returned |
| Exited parent leaves output pipe open | `test_exited_parent_cannot_leave_pipe_open` | Terminate the owned process tree |

`pdflatex` has a 120-second execution limit and a 1 MiB captured-output limit;
`pdfinfo` has 10 seconds and 64 KiB. Cleanup has separate bounded waits. Windows
tools start suspended, enter an owned job before resuming, and the job is
terminated on exit. POSIX tools use an owned process group. No shell is used.
These lifecycle controls are not a sandbox for hostile executables or TeX.

The fallback page counter is best-effort for simple generated PDFs. It reads at
most 16 MiB plus one sentinel byte and returns unknown for oversized files or
compressed object streams. Unknown is never treated as one page. The fake-tool
tests require no installed TeX, accounts, external applications, or personal data.
