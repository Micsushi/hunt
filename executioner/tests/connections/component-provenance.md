# Component provenance metadata

`component-provenance.pack` preserves the exact commit and tree objects referenced
by `component-manifest.test.ts`. Its SHA-256 is
`9d37a4cfec7adaf1ba5459c2e875dd8b12758adcd6105e7efc349aad8d22c36c`.
It contains 58 commit objects and 537 tree objects, and **no blob objects or file
contents**. Git verifies the original object identities when indexing it.

The ten component tips in `component-revisions.json`, plus the pinned F4 repair
`0908aa70d25ef2353c6091940bddbac12c8db135`, were retained locally but are not
reachable from published branch heads. A full-depth remote checkout alone cannot
supply these objects after the selective release. The archive includes their
metadata above the already-published F1 base
`f274d9a6624978b61ab1dd1433ebdddfdef029d2`. That base and the later accepted
checkpoints remain available through the published `codex/c3-multi-ats` history.

The existing test imports this hash-pinned archive into a temporary object store,
with the checkout's objects as read-only alternates. It removes the temporary
store afterward. It does not change repository refs, merge historical code, or
write objects into the checkout. All existing ancestry, tree, path-set, blob-ID,
serialized-version, and rejection assertions remain in force.

Qualification used a fresh remote-only object store: the original suite failed
11 checks without the missing metadata; the metadata restored all 21 checks.
Historical file contents are deliberately excluded from this fixture and release.
