# IDE controls and recovery — 0.11.4

The reported Remix run clicked `role:group|compile group` while labelling it as the contracts folder. Recorded text contained `contracts`, but the observation exposed no corresponding control. Its custom draggable DIV was excluded from the control query. The new-file input had no name, ARIA label, ID or test ID, so the old selector builder dropped it too. Green click rows only established dispatch, not file creation. The unchanged-action guard then stopped the sequence without allowing a corrected decision.

## Changes

- Discover draggable, focusable, contenteditable and explicit custom pointer controls. Expose unnamed controls through stable isolated-world `node:` handles, checked against connected approved document roots. Weak references and bounded handle metadata avoid retaining removed DOM elements.
- Prioritize focused editable fields and dialogs before evidence truncation. No site routes, contract source or application business rules are injected.
- Focus visible code-editor surfaces for caret-based textareas; confirm the intended editable control received focus before native select-all/text insertion. Contenteditable fields are also supported. Privacy and credential guards remain enforced.
- Resolve click points within the visible portion of partially clipped controls; offscreen/obscured targets remain blocked. This does not establish general transformed-frame support.
- Return unchanged-action rejection into the existing bounded correction loop. The rejected action is never replayed. Completed malformed provider replies can receive correction before dispatch; refusal, incomplete generation, provider/network failures and cancellation remain terminal. Rejected decision data is cleared between attempts.
- Display dispatched actions as Executed, keeping Passed/Failed for assertions. Successful dispatch still cannot establish overall mission completion.

## Real-model acceptance

Both runs used the actual extension → native messaging → Go companion → OpenRouter → validated browser action loop. No initial AI plan or action sequence was supplied. Production model settings were unchanged. Fast diagnostic mode intentionally disabled the ordinary between-step inspection gap.

1. Dots 3 first: `.tools/live-checks/paced-live-run-wGjqYm/`. Found the folder and unnamed filename input, entered the filename, then clicked Create instead of confirming it. Repeated folder clicks were rejected and the model repeated its rejected choice. Seven actions, zero checks; **blocked, not passed**. Output 643 tokens. The new observation support does not guarantee correct Dots decisions.
2. Authorized `qwen/qwen3.7-flash` fallback: `.tools/live-checks/paced-live-run-1amsYW/`. Created `contracts/VoiceQAProbe.sol`, entered the exact requested source through the caret-based editor, saved once and passed all four assertions across 11 recorded steps. An independent harness gate compared saved path, exact source and save count. Ten typed native function replies; no decision-validation errors. Usage: 104,399 input / 6,371 output tokens, without an artificial 6,000-token cap.

Reproduce the first test with `node tests/fixtures/ide-controls.mjs`, then `node scripts/test-live-run.mjs tests/fixtures/ide-controls-request.json --automation-ui --ide-controls --fast`. The owned Source Studio fixture reproduces inspected control patterns; it saves source and does **not** implement a Solidity compiler or EVM. Harness API keys remain local and their temporary copies are removed during cleanup.

## Supplementary checks and limits

The focused real-browser regression checks stable unnamed handles, focus priority despite 60 preceding controls, removed-target rejection, private text exclusion, editor focus and clipped click coordinates. A controller regression exercises malformed-reply correction followed by repeat-action rejection, proving only the corrected click and key dispatch. Provider checks distinguish correctable completed contracts from refusal/output-limit failures. All companion tests and 50 JavaScript checks passed (localhost checks required loopback permission).

Separately, approved inspection at `app.remix.live` created and manually compiled a synthetic `VoiceQAProbe.sol`; the file and compiled artifacts were visible. This was direct diagnostic interaction, **not** VoiceQA agent acceptance. No wallet connection, real-chain transaction, or deployment was performed. The narrow inspection view clipped the deployment sidebar. Full VoiceQA-driven real Remix file creation, local-VM deployment and contract interaction remain acceptance work. Dots reliability, broader custom editors and the general security matrix remain open; the broad capability goal is not complete.
