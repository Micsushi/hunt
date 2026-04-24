// Superseded by src/ats/registry.js (detection) and src/ats/workday/fill.js (fill logic).
// Kept as a placeholder so the content/ats/ layout remains consistent with design.md.
// Detection from a content-script context is no longer needed here because:
//   - the background resolves ATS type from the tab URL via registry.js
//   - fill functions are injected by fill-runner.js, not triggered from content scripts
