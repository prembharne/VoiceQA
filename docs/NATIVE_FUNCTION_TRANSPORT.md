# Typed model function choices

Compatible OpenRouter models that advertise tools but lack strict structured output now receive functions generated from the actual response contract. This changes the model result channel; it does not add a new browser permission or silently change the selected model.

- Live automation exposes individual choices such as `browser_fill`, `browser_click`, `browser_select` and `browser_http_check`, plus completion/blocker functions. Each choice carries only its operation's arguments. There is no initial AI action plan.
- Read-only investigations expose only their allowed inspection functions. Execution functions from another mode are rejected.
- QA separates plan and clarification functions. Other contracts retain the generic result function. Models with strict structured output retain that transport.
- The controller restores only declared fixed discriminators from the selected function name. It rejects unknown functions, undeclared arguments, parallel calls, mixed text/calls and incomplete replies. Existing action, credential, origin, scope and permission validation still runs before browser dispatch.
- Function definitions and required-field lists have stable ordering. The adapter avoids repeating the full nested result schema in the system message when function definitions already supply it.
- Usage records count accepted `function_calls` and `typed_function_calls` separately from token counts. Formatting errors report only their category and byte length, never model response text.
- A plain JSON reply containing only function arguments can be restored only when its exact field signature identifies one declared response function. Shared shapes such as fill/select remain ambiguous and are not guessed. Restored JSON replies have a separate `typed_json_replies` counter; they are not counted as native function calls.

## Actual-model acceptance — 15 October 2026

The required model order was followed: Dots 3 first, then the authorized Qwen 3.7 Flash fallback after Dots returned invalid JSON. No artificial 6,000-token output cap was imposed and saved production settings were unchanged.

The healthy Qwen live-automation run used actual UI approval and current page observations to complete the owned multi-stage reservation wizard. It passed **12 recorded steps and all 5 checks**: Mira Patel, Osaka, three travellers, independently calculated $460 total and exactly one submission. The model supplied nine accepted typed function decisions; two additional review calls used the generic result function. Preparation had no AI plan/checklist. Evidence: `.tools/live-checks/paced-live-run-a5KUK0/`.

Changing permissions after mission review was rejected before a run started. The extension UI had no overflow/runtime errors at 360px/420px, respected reduced motion and produced zero spoken announcements. A completion review initially put approval prose into its essential-question field; the live loop corrected its completion reply without resubmitting the reservation. The question field now explicitly describes that it must remain empty when no user answer is needed. This is not proof that model review is always correct.

The separate complete logical-security request remains unsuccessful. Dots evidence: `.tools/live-checks/paced-live-run-ziB8WY/`. The Qwen attempt progressed beyond the earlier result-type failure but still referenced an unavailable captured order ID and was blocked before execution: `.tools/live-checks/paced-live-run-TV4oUd/`. A working live browser journey does not establish a passing security suite or universal website compatibility. The broader capability audit remains active.

## Quote-conflict false pass and local guard

The first actual Qwen negative run falsely passed the intentionally wrong $435 receipt by copying that receipt into its expected value. The independent gate rejected it: `.tools/live-checks/paced-live-run-MuLadD/`. This failed acceptance result is retained; it is not a successful defect-detection test.

Live assertion preflight now checks for a specific evidence conflict: one earlier visible HTML calculation output quoted a price before the final target appeared, but the proposed expectation simply matches a different current result. Later captures of the receipt do not establish an independent oracle. The controller requests a grounded correction; it never rewrites the expected amount or reruns a submission. A correctly disagreeing assertion remains executable, and an explicit user-supplied amount takes precedence. The actual false-pass recording is checked using `VOICEQA_QUOTE_RECORDING` in a regression test.

This guard is deliberately evidence-specific. Multiple ambiguous calculation outputs, unsupported locale/precision, unobserved rules, HTTP-only prices and other oracle categories still require further work. The guard does not assume every quote is authoritative, label a discrepancy automatically, or prove universally correct expectations. A legitimate added charge needs its independently established business rule rather than the final receipt alone.

The first guarded rerun (`paced-live-run-zU5569`) rejected the copied price, but then blocked on a malformed plain completion reply instead of recording the failed price assertion. It did not falsely pass, but it also did not pass negative acceptance. That concrete failure motivated the unique-signature reply adapter above.

The following fresh negative run (`paced-live-run-OzRDpb`) performed one submission but stopped on an incomplete/refused/ambiguous provider reply before recording outcome assertions. It also failed negative acceptance. Function-response diagnostics now distinguish finish category, call count, separate-text byte length and refusal/provider-error presence without storing response values. Fresh successful Qwen defect detection is still required; a safe block is not a measured application failure.

The final healthy control with the quote guard and reply adapter passed **12 steps/all 5 checks**, exactly one submission and the independently calculated **$460** price: `.tools/live-checks/paced-live-run-D60bUE/`. It used eight native typed decisions, had no recorded decision-validation errors and consumed 69,982 input/3,918 output tokens overall. Preparation still had no AI plan. The actual UI permission-change rejection, 360px/420px layout checks, reduced-motion setting and zero spoken announcements passed again. This is a successful healthy control, not a substitute for the still-incomplete negative acceptance or logical-security matrix.

## Reproduction

The checked-in `tests/fixtures/automation-wizard-request.json` contains only a goal and scope, with no planned actions. Start `node tests/fixtures/automation-wizard.mjs`, then run `node scripts/test-live-run.mjs tests/fixtures/automation-wizard-request.json --automation-ui --fast` to try Dots first. For the negative control start the fixture with `--incorrect-total` and add `--expect-total-defect` to the harness. Runs must be serial because they temporarily register an isolated native host.

If Dots fails, use a local copy of that same request with only `model` changed to `qwen/qwen3.7-flash`, and add `--paid-qwen` for the explicitly authorized paid fallback. This flag imposes no artificial output-token cap; provider limits and bounded execution still apply. Keep API keys in the normal local key store, not request files.
