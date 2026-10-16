# Editor state and verified progress — 0.15.0

The reported Remix run reached a local VM deployment, but did not execute the remaining contract tests. Its temporary Monaco textarea exposed only the end of the source. The agent treated that fragment as the whole file and pasted the source again. Crowded toolbar evidence and identical Call/Transact labels obscured deployed functions. The run then exhausted its single 24-read allowance; repeated visual handoffs and rejected proposals used the remaining recovery budget. A deployment receipt was evidence of deployment, not functional correctness.

## Implementation

- A closed Monaco adapter reads or replaces the complete model bound to the selected editor. It uses a static extension function, never generated JavaScript. Exact URL, document identity, editor marker, model binding and privacy checks surround access. A write is read back and hashed. Re-entering identical source does not dispatch another edit.
- Exact readback preserves supplied LF or CRLF line endings instead of treating Windows EOL conversion as a source mismatch. Mixed line endings are explicitly unsupported. Real Monaco acceptance exercises both supported styles.
- Virtual textarea fragments are explicitly incomplete. Unsupported editors and models above the existing 4,000-character public-value allowance return a limitation; their fragments never masquerade as complete files. This release implements Monaco, not every editor framework.
- Passed outcome assertions and verified complete editor readbacks create durable progress checkpoints. The model receives these separately from recent actions and continues unfinished work. Clicks, visual `done` and input dispatch alone do not establish progress. Failed checks remain failures.
- Discovery has a 24-read window, replenished by new verified progress, with a separate total limit of `max(24, min(120, 2 * maxActions))`. Repeating the same checkpoint does not refill it. Exhausted reads disappear from the model's decision contract and remain rejected by the controller.
- Recovery permits up to `max(8, min(24, maxActions))` consecutive corrections since verified progress, with a total ceiling of `max(consecutiveLimit, min(160, 2 * maxActions))`. The reviewed action budget and 20-minute run deadline remain. These are bounded recovery controls, not a guarantee that every website goal succeeds.
- Grouped controls expose their context and related input/action handles. Duplicate accessible labels receive unique node handles. Native controls and focused fields survive crowded toolbar evidence budgets. Visible function search can return a specific function's Call/Transact control.
- Pointer controls with tooltip or accessible labels are discoverable even when implemented as custom icons. Visual actions record the actual hit's label/title, independently of the agent's intended action label, so the next decision can detect a mistaken target.
- Live visual clicks on short textual BUTTON captions must include that actual caption in the proposed description. A contradiction such as "name function button" resolving to "Explain contract" returns correction feedback before dispatch. Dynamic captions, custom icons and reviewed QA grounding retain their existing checks; this is a targeted mismatch check, not universal semantic validation.
- Model history omits repeated toolbar metadata and reports omitted evidence. Visual handoffs retain screenshot artifact references instead of copying large diagnostics into the read ledger. The latest 180 agent events retain final blocker reasons.
- A visual handoff with no action does not immediately route back to the same unchanged screen. New public state can make visual recovery eligible again.
- Empty and temporary provider failures before browser dispatch recover in place for models without an authorized fallback, using bounded backoff and the same recovery ceilings. Accompanying text beside one valid native tool call is ignored; only validated tool arguments can execute.

## NVIDIA-only acceptance

The current acceptance model is exactly `nvidia/nemotron-3.5-super-vl:free`, as requested. `--nemotron-only` sets an isolated process override for both Go model calls and Agent S vision. Other provider/model requests are rejected before network dispatch; the worker also checks its model identity. There is no Qwen fallback in this acceptance mode. Existing saved production model choices are not changed by tests.

```powershell
node scripts/test-agent-s-grounding.mjs --nemotron-only
node scripts/test-agent-s-remix-grounding.mjs --nemotron-only
node scripts/test-live-run.mjs tests/fixtures/remix-live-request.json --automation-live --remix-local-vm --visual-agent --nemotron-only --fast
```

Run native-host harnesses serially. The Remix acceptance uses an isolated browser and data directory, no wallet extension, and only the explicitly approved `https://app.remix.live` origin. Browser POST and WebSocket requests are blocked to prevent remote RPC writes; provider calls use the companion's separate client. Tests preserve the original viewport width, restore native-host registration and remove temporary encrypted key copies. Continuations can reuse a selected owned test profile; interrupted attempts require an explicit tester flag and remain recorded as interrupted. Actual model evidence and remaining limitations are recorded in [validation](VALIDATION.md).
