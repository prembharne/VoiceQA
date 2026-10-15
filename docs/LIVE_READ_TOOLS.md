# Focused live inspection and submission hardening

Browser automation still begins with a locally prepared request/permission record and no AI-generated action plan. During execution, the model can now choose a focused read instead of a mutation:

- `inspect_element`: current-page input constraints, public descriptions, options and redacted values.
- `search_page`: bounded visible text/control matches and selectors, including custom controls absent from the broad snapshot. Stops after 20 matches.
- `diagnostics`: captured network/runtime metadata for the selected page. Empty events do not establish health.
- `accessibility`: partial automated accessibility findings on the selected page.

These are declared typed functions for compatible providers. The Go controller and extension both reject other page aliases, URLs, undeclared tools and extra arguments. Change tabs through the existing approved alias before inspecting another page. Read-only tools cannot dispatch clicks or scripts. Twenty-four reads are allowed per live run; identical reads at the same action/state are rejected. Actions can change constraints omitted from broad snapshots, so a new action permits fresh inspection.

## Evidence and request size

Read results are persisted separately with R-prefixed evidence IDs, execution-page references and the action cursor. The retained read ledger is capped at 48 KiB; omitted details are explicit. It is supplied to the next model decision and completion audit, and recorded-run debugging can retrieve it through `observation:Rn`. History listings omit full read bodies.

Model-facing control snapshots remove empty/null fields, false default metadata and text duplicated by an accessible name. Editable values, meaningful checked/disabled/selected states, historical business rules and result values remain available. Source recordings are not changed. This compaction does not impose an output-token cap or manufacture expected outcomes.

Native select and text-fill operations are checked against the resolved control type before clicking. A custom option requires an actual click, and checkboxes/files/buttons cannot be treated as text fields. Rejected live decisions receive bounded correction before any mutation is dispatched. Provider waiting, reply validation and local control resolution now have distinct recorded phases.

## Navigation-safe duplicate protection

Each automation run generates a fresh private signing key in the extension worker. Form identities are computed inside the isolated content world using HMAC-SHA-256 over the page/form/control identity and input values. Only opaque keyed identities return to the worker; credential values and the signing key are never supplied to the model. Volatile CSRF/challenge tokens are excluded from duplicate identity. Unchanged forms remain recognizable after page navigation or DOM replacement, while changed inputs and new runs receive different identities.

This extends the existing unchanged-submission guard. It is not a server idempotency guarantee or a universal interpretation of natural-language submission limits. Dynamic form semantics, changed submissions, unsupported secure-context APIs and non-form custom submissions remain further acceptance scope. QA/security workflows retain their reviewed testing behavior.

## Acceptance evidence so far

- Owned Release Studio requires discovering a field pattern, interacting with a custom dropdown, saving once and refreshing to verify persistence. No planner fixture marker or business-rule contract is supplied.
- Dots-first run `paced-live-run-93kXMi` ended with an RPC timeout after recording zero actions and no AI reply. Its saved state does not identify a model-side root cause; no successful Dots acceptance is claimed.
- Authorized Qwen fallback `paced-live-run-jCpLke` passed 15 recorded steps and seven assertions, with actual search and constraint-inspection calls, a compliant `rel-atlas` handle and exactly one saved release after refresh. This preceded request compaction and later submission hardening.
- Negative attempt `paced-live-run-D7t5MR` blocked on a native-select request against a custom option. It exposed a check performed after clicking; both controller preflight and the executor boundary now reject this before clicking.
- Negative attempt `paced-live-run-SBiQUb` resubmitted the form and reported a false pass. The independent gate rejected it. This exposed navigation resetting the old per-document duplicate identity and drove the keyed identity guard. It is not valid defect-detection evidence.

The focused browser regressions verify custom-control search, real constraint inspection, private-description exclusion, editor focus and stable keyed form identities across navigation, including changed data/new-run isolation. Companion race checks and 51 JavaScript checks passed.

Version 0.12.0 moves this live loop to Eino ADK. A fresh Dots-only run, `paced-live-run-NLaXQp`, used actual native tool calls with their completed result messages: it inspected the pattern, saved one valid release, refreshed and correctly failed on expected Ready versus observed Archived. The independent negative gate passed. Earlier Qwen timeout/retry blockers and Dots transport failures remain documented in [the Eino acceptance record](EINO_AGENT_HARNESS.md); this fixture result does not establish universal application compatibility.
