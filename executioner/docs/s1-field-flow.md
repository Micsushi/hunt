# Stage 1 executable flow

This is the human view of
`src/testing/contracts/field-flow-cases.ts`. F1 owns the canonical synthetic
IDs. F2, F5, and F6 must conform to these rows independently. A prototype may
suggest an implementation, but it cannot add a row or change an owner.

## Field flow

Every required fixture control has one producer, consumer, browser side-effect
owner, independent verifier, event owner, and factual failure owner. The shared
path is F2 fixture structure, F3 observation and mutation, F5 semantic meaning,
F6 answer resolution, F7 dispatch, F8 readback verification, F9 orchestration
and event emission, and F10 factual failure reporting.

| Field ID and visible label | Question ID and visible label | Options: ID, label, value | HTML and observation | Answer, mutation, readback | Exact owners |
| --- | --- | --- | --- | --- | --- |
| `s1-field-given-name`: Given name | `s1-question-given-name`: Given name | none | text input; textbox value | `profile.given_name`; type text; textbox value | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-family-name`: Family name | `s1-question-family-name`: Family name | none | text input; textbox value | `profile.family_name`; type text; textbox value | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-phone-number`: Phone number | `s1-question-phone-number`: Phone number | none | telephone input; textbox value | `profile.phone_number`; type text; textbox value | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-interest`: Brief interest statement | `s1-question-configured-narrative`: Why are you interested in this role? | none | textarea; textarea value | `profile.configured_narrative`; type textarea; textarea value | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-work-authorization`: Are you authorized to work in this location? | `s1-question-work-authorization`: Are you authorized to work in this location? | `s1-option-work-authorization-yes`, Yes, `yes`;<br>`s1-option-work-authorization-no`, No, `no` | radio group; options and selected option | `profile.work_authorization`; select one option; selected option | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-age-requirement`: I am at least 18 years of age. | `s1-question-age-requirement-met`: Are you at least 18 years of age? | none | checkbox; checked state | `profile.age_requirement_met`; set checked state; checked state | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-sponsorship`: Will you require sponsorship? | `s1-question-sponsorship-required`: Will you require sponsorship? | `s1-option-sponsorship-yes`, Yes, `yes`;<br>`s1-option-sponsorship-no`, No, `no` | native select; options and selected option | `profile.sponsorship_required`; select option; selected option | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-country`: Country | `s1-question-country`: Country | `s1-option-country-us`, United States, `US`;<br>`s1-option-country-ca`, Canada, `CA` | ARIA listbox; options and selected option | `profile.country`; select option; selected option | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-start-date`: Available start date | `s1-question-earliest-start-date`: Available start date | none | date input; date value | `profile.earliest_start_date`; set ISO date; date value | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |
| `s1-field-resume`: Resume | `s1-question-resume`: Resume | none | file input; file-input state | resolved resume artifact; upload verified copy; artifact digest | producer F2; consumer F9; side effect F3; verifier F8; event F9; failure F10 |

No row permits Submit. F5 owns semantic interpretation, F6 owns the answer and
option decision, and F7 owns behavior dispatch for every row.

## Executable control steps

| Step | Producer | Consumer | Side-effect owner | Verifier | Event owner | Failure owner |
| --- | --- | --- | --- | --- | --- | --- |
| MCP start | External MCP Client | F9 | F9 | F9 | F9 | F10 |
| Fixture start | F13 | F2 | F2 | F2 | F9 | F10 |
| Fixture reset | F13 | F2 | F2 | F2 | F9 | F10 |
| Fixture close | F13 | F2 | F2 | F2 | F9 | F10 |
| Intake | F4 | F9 | F4 | F4 | F9 | F10 |
| Resume | F4 | F9 | F4 | F4 | F9 | F10 |
| Profile | F4 | F6 | F4 | F4 | F9 | F10 |
| Observation | F3 | F5 | F3 | F5 | F9 | F10 |
| Semantic meaning | F5 | F9 | F5 | F5 | F9 | F10 |
| Answer | F6 | F9 | F6 | F6 | F9 | F10 |
| Mutation | F7 | F3 | F3 | F8 | F9 | F10 |
| Readback | F3 | F8 | F3 | F8 | F9 | F10 |
| Navigation | F8 | F3 | F3 | F8 | F9 | F10 |
| Journey state | F9 | F4 | F4 | F4 | F9 | F10 |
| Events | F9 | F10 | F10 | F10 | F9 | F10 |
| Failure | F9 | F10 | F10 | F10 | F9 | F10 |
| Privacy | F9 | F11 | F11 | F11 | F9 | F10 |
| Evidence | F9 | F11 | F11 | F11 | F9 | F10 |
| Terminal result | F9 | External MCP Client | F9 | F9 | F9 | F10 |

## Control slice

Each retained R2 F4, F9, F10, and F11 port occurs once. The R1
`ModelController` declaration remains frozen through T5, has no R2 row, and is
removed by the T6 contract amendment. Consumers call ports through contracts;
they never import provider implementations.

| Port | Provider | Consumer | Side effect and verification | Event and failure |
| --- | --- | --- | --- | --- |
| `McpJourneyApi` | F9 MCP facade | external MCP client | F9 | event F9; failure F10 |
| `JourneyControl` | F9 orchestrator | F9 MCP facade | F9 | event F9; failure F10 |
| `JourneyIntake` | F4 intake | F9 orchestrator | F4 | event F9; failure F10 |
| `JourneyStateStore` | F4 journey state | F9 orchestrator | F4 | event F9; failure F10 |
| `ProfileQuery` | F4 profile | F6 answer resolver | F4 | event F9; failure F10 |
| `EventSink` | F10 observability | F9 orchestrator | F10 | event F9; failure F10 |
| `ProgressReader` | F10 observability | F9 MCP facade | F10 | event F9; failure F10 |
| `FailureReporter` | F10 failure reporter | F9 orchestrator | F10 | event F9; failure F10 |
| `PrivacyGuard` | F11 privacy guard | F9 MCP facade | F11 | event F9; failure F10 |
| `SafetyGuard` | F11 safety guard | F9 orchestrator | F11 | event F9; failure F10 |
| `EvidenceStore` | F11 evidence store | F9 orchestrator, F10 failure reporter | F11 | event F9; failure F10 |

F2 exposes start, reset, close, and browser-visible fault state. Browser
navigation changes fixture pages. The acceptance harness, not F2, owns the
provider-failure wrapper.

## Contract delta classification

| ID | Classification | Decision |
| --- | --- | --- |
| `structural-browser-controls` | `requirement` | Preserve textarea, date, grouped-choice, option, and checked-state structure. |
| `verified-resume-artifact` | `requirement` | Upload only the immutable artifact whose digest was verified. |
| `closed-provider-failures` | `requirement` | Propagate closed provider failures with explicit ownership and retryability. |
| `immutable-admission` | `requirement` | Admit exact-shape immutable snapshots before side effects. |
| `stateful-conformance` | `requirement` | Exercise negative, replay, cancellation, concurrency, and cleanup scenarios. |
| `bounded-identity-classes` | `owner_decision` | Validate upstream opaque handles, inject non-sensitive generated IDs, and close coordinate enums. |
| `request-lifecycle` | `owner_decision` | Distinguish duplicate requests, changed-input replays, cancellation, uncertain mutation, retry, and terminalization. |
| `event-ownership` | `owner_decision` | F9 emits value-free provider-attributed events; F10 validates, stores, and projects them. |
| `model-controller-deferred` | `owner_decision` | Stage 1 has no ModelController port or source owner. |
| `fixture-browser-navigation` | `owner_decision` | F2 exposes start, reset, and close; browser navigation changes fixture pages. |
| `acceptance-provider-fault-wrapper` | `owner_decision` | The acceptance harness owns explicit provider-failure injection. |
| `same-process-state-reload` | `owner_decision` | Stage 1 proves deterministic same-process store reload, not crash recovery. |
| `fixture-transition-port` | `rejected_prototype_invention` | Reject direct FixtureTransition requests and results. |
| `fixture-provider-fault-wrapper` | `rejected_prototype_invention` | Keep provider-fault injection in the acceptance harness, not F2. |
| `derived-personal-identifiers` | `rejected_prototype_invention` | Never derive retained identifiers from applicant data, URLs, selectors, paths, or messages. |

T5 freezes these classifications without changing the serialized or in-process
R1 declarations. T6 applies the approved contract amendments. The executable
`contractDeltaDecisions` list is the mechanical classification source.

## Prototype ancestry evidence

On 2026-07-31, each recovery ref below resolved to its listed full SHA and each
commit had the single direct parent
`d95e845e61bcf0a030b3b07c6d6261e3d95c1fad`.

| Feature | Snapshot SHA | Recovery ref |
| --- | --- | --- |
| F2 | `880d9147272f1a699336192b6a8811de6f456312` | `refs/codex/snapshots/b84b21c9399328841633d91676d5b375a20c6ca8` |
| F3 | `0df1e3b0b945f687ea06189bab218da5843bd553` | `refs/codex/snapshots/507e8778e5f70e81bad2df4bb08f1517d578f18d` |
| F4 | `7c4d4028b36aa3ca8a19952bcc78ad5d2f972629` | `refs/codex/snapshots/f722d74d5353f1f2239b1b19e71d8362e5e622ea` |
| F5 | `1bdef6ba339ecf69d32a3fd913896a6900603775` | `refs/codex/snapshots/00847a8e8ce154b3c6853ca0a819fd8076d9b9fa` |
| F6 | `d4b69096aadccde665eb8af7d1682fa45e358ffd` | `refs/codex/snapshots/89de2a896da753699cf18dc86ebd73c948ce79ee` |
| F7 | `6fa31d26f441a0677c3a26139ed49d8b3d6a4099` | `refs/codex/snapshots/f19e2b26c96db1ac69b40a27a56cf3d73e3a9787` |
| F8 | `e0ef142f4521de7784aa2eea68d71aa6fdd2d92d` | `refs/codex/snapshots/e25aaaeb0e7cbfefcc943a868841147ec35a1c8e` |
| F9 | `9c3fac643f6182a6eb56466b4eca5cae882a7546` | `refs/codex/snapshots/16de1443efd015ba03341af5c59ac0a4b363c028` |
| F10 | `d442cd092164622735e70988454043998154b3b2` | `refs/codex/snapshots/2f5b393c2833ff1999504ed4c7695299445c01db` |
| F11 | `e297bfe6ff1e0650bce9297699490884c50f24a9` | `refs/codex/snapshots/05b27fc6128a49836bbf5edea7d59e307ec164dd` |
