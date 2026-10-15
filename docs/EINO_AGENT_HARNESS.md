# Eino agent harness

VoiceQA embeds CloudWeGo Eino ADK v0.9.21 in the Go companion. This is a general tool-using agent runtime, not another browser driver. The extension remains responsible for the selected Chrome tabs and real page interaction.

## Execution path

Chat request → local mission/permission record → Eino ChatModelAgent and Runner → typed, validated tools → extension → public result/evidence → next live decision. Browser automation does not generate an initial action sequence.

`companion/internal/agentharness` is independent of Chrome and VoiceQA's provider implementation. Callers supply a decision model, tool catalog, invocation policy and terminal outcome gate. VoiceQA's adapter reuses the existing streaming/provider parser and native operation-specific function contracts, including OpenRouter and NVIDIA NIM compatibility. It does not introduce a second independent provider client.

## Customizations

- One tool call per model decision; tool execution is sequential. Unknown tools and malformed arguments cannot reach the browser. Live OpenRouter calls prefer advertised native tool support even when strict JSON is also available; other planning formats remain unchanged. Completed Eino call/result pairs are forwarded through the provider tool-message channel, including actual sanitized read results. Models without native tools retain the validated JSON fallback.
- Scope, origin, permission, operation, control-type, private-reference and replay checks run before dispatch. Eino has no implicit shell/filesystem capabilities.
- Rejected decisions return structured tool feedback. Three consecutive invalid decisions stop the run. Dispatches with ambiguous outcomes are never retried.
- The model cannot finish by emitting ordinary prose. Only the application tool handler can mark a terminal result after completion coverage and actual assertions, or after a measured failure/blocker.
- A bounded Eino transcript retains complete recent tool-call/result pairs. Sanitized observations, earlier rules, read evidence and action results remain in the separately persisted run ledger; no extra paid summarization model is called.
- Model calls have a two-minute deadline per live decision, without an artificial output-token cap. Browser control lookups have a separate fifteen-second deadline. Provider limits still apply.
- Dots 3 remains the selected primary. Only when that exact OpenRouter model encounters a transient provider/network failure or returns no result can Eino switch to the operator-authorized Qwen 3.7 Flash. Numeric provider status is preserved even for error envelopes inside HTTP 200 responses. Authentication, insufficient balance, unknown upstream errors and permission failures do not trigger paid fallback. Other model selections remain unchanged. The run records the actual model and fallback event.
- Run records include `agentRuntime`, `agentModel` and bounded metadata-only `agentEvents`, including safe provider failure classes/status codes for future model errors and switches. History lists omit event bodies; full selected runs retain them for diagnosis.

## Native submission feedback

Before automation clicks a native submit button or presses Enter to submit, VoiceQA reads native ValidityState. Invalid fields return public selectors, constraint metadata and reason flags, without field values or site-generated validation messages. It reads validity properties rather than firing validation events. A valid corrected submission can then proceed. The execution boundary rechecks validity before reserving its duplicate-submission identity. Explicit formnovalidate/novalidate semantics are respected.

QA workflows can still intentionally submit invalid forms: this preflight belongs to adaptive browser automation. Existing keyed form identities survive page navigation without exposing raw credential values or the signing key.

## Persistence and interruption limits

The existing run ledger, Stop control, browser pause/resume and human checkpoints remain in use. This integration does **not** enable Eino checkpoint replay after host/browser crashes: a checkpoint of model state cannot establish whether a browser submission happened. Interrupted native sessions remain reviewable and are not automatically replayed. MFA credentials remain local origin-bound profile references; CAPTCHA/SMS/passkeys require the existing operator handoff and subsequent verification.

QA plan generation, deterministic plan execution and read-only Q&A retain their existing controllers in this increment. The new general harness is the live automation runtime; migration of other agent loops is separate work.

## Verification

Focused harness checks cover feedback-driven recovery, terminal gating, cancellation, unknown-tool rejection, ambiguous-dispatch non-replay and model fallback preserving completed tool feedback. Provider contract checks cover lossless decision conversion, paired native tool results, empty/error envelopes and rejection of undeclared arguments. Four focused real-browser checks passed: private-safe form constraints without validation events, custom IDE controls, navigation-stable form identities and repeated runs preserving current width. The companion race suite and all 51 JavaScript checks passed. Dependency scanning reported zero npm findings and zero reachable Go vulnerabilities; one imported-package finding was reported as not called by this application.

Actual-model evidence, using isolated extension profiles and the owned Release Studio application:

| Run | Result | Independent acceptance |
| --- | --- | --- |
| `paced-live-run-xHeQpi` | Dots returned decisions, then a local control lookup stalled after navigation | Stopped as partial evidence; added bounded control lookup timeout. This recording does not prove the original stall's root cause. |
| `paced-live-run-3IXsCB` | Native-invalid handle submission rejected before dispatch; Dots timed out; Eino switched to authorized Qwen, which corrected the handle, saved once, refreshed and passed three assertions | Full gate rejected because no actual focused inspection tool was called. Demonstrates live fallback/recovery, not full focused-read acceptance. |
| `paced-live-run-MOJZaL` | Qwen passed 10 recorded steps and three assertions; actual pattern inspection, custom dropdown selection, exactly one save and persisted values verified | Passed, with actual `eino-adk/0.9.21` runtime events. |
| `paced-live-run-jNn1im` | Corrupted persistence variant reached refresh and one passed title check, then Qwen timed out | Failed acceptance; no completed defect-detection claim. The raw internal timeout message was subsequently replaced with a readable message that preserves its cancellation/deadline cause. |
| `paced-live-run-Mg8YJN` | Qwen tried to submit unchanged data again after the corrupted refresh; the duplicate guard rejected it before dispatch | Blocked, not accepted defect detection. |
| `paced-live-run-mMeU4U` | Dots JSON mode labeled fill/click actions as inspection, then repeated unchanged clicks | Blocked; motivated native tool transport instead of treating a label as an actual read. |
| `paced-live-run-DsmlLi` | Dots native tools performed a real constraint read, then repeated the read | Blocked; exposed missing native tool-result conversation forwarding. |
| `paced-live-run-NLaXQp` | Fresh Dots-only run with native tool exchanges: actual pattern inspection, valid handle, custom status selection, one save, refresh and a measured Ready-versus-Archived persistence regression | Negative acceptance passed: run correctly failed after eight recorded steps in 99.7 seconds. No Qwen or fallback event. The local temporal witness, reviewed against the request, records the actual mismatch. |
| `paced-live-run-GMmuUY` | Dots executed the healthy flow and passed three assertions, then returned no usable final result | Full gate rejected the run as error. This prompted typed empty-result/provider-status handling for the authorized availability fallback; passed steps alone do not make a mission complete. The retained recording does not establish why the upstream result was missing. |
| `paced-live-run-WjCqBA` | Fresh Dots-first healthy run encountered a provider failure before dispatch; the authorized Qwen fallback used actual constraint inspection, custom selection, one save, refresh and three passed assertions | Full healthy acceptance passed: 10 recorded steps in 87.3 seconds. Dots was attempted first. This run predates failure-class event metadata, so its recording does not establish the numeric upstream failure cause. |

This is not a claim of flawless automation or complete compatibility with every website. Custom submissions, application-side validation, complex widgets and independently correct semantic expectations still require application evidence.

## Open source

Eino is Apache-2.0 licensed. The pinned module graph is in `go.mod` and `go.sum`; packaging includes dependency licenses, including hyphenated files such as Eino's `LICENSE-APACHE`. The model service and its charges are separate from the framework license.
