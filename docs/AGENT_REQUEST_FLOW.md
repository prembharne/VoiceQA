# Website-independent browser agent

VoiceQA 0.7.0 uses one evidence-based planner for ordinary QA requests and browser tasks. RelayDesk contracts, reset URLs, validation rules and workflow splitting are no longer injected into normal AI requests. Explicit deterministic fixture suites remain separate developer tools.

## Request path

1. The React chat sends `plan.propose`: the latest request, up to six previous user/assistant turns, selected mode, test data and explicit permissions.
2. The MV3 service worker checks the shared tab and supplies its actual URL, approved origin and shared page aliases.
3. The Go companion reads fresh, redacted DOM observations from those already shared tabs. Observations contain accessible control names, selectors, safe link paths, dropdown options, field constraints and viewport dimensions. Link query strings and fragments are omitted to avoid sending URL-carried tokens; these destinations may require clarification.
4. The provider adapter sends a system instruction followed by a JSON user message containing the request, evidence, public credential references and budgets. OpenRouter/NIM use Chat Completions; the configured OpenAI adapter uses its supported structured endpoint. The selected model is never silently changed.
5. The model returns a full JSON plan or one essential clarification. The companion checks allowed operations, origins, tab aliases, credential references, variables and assertion semantics. One invalid-draft repair is allowed with the same model and deadline.
6. The user reviews and confirms the exact plan version. The executor dispatches one browser action at a time, waits for readiness and independently verifies outcomes. Assertions, not the model's prose, determine pass/fail. Exact text/value/URL assertions retain case sensitivity; semantic `text_contains` checks ignore case. Control locators prefer exact names and only fall back to case-insensitive resolution. Native-dropdown input compilation uses observed options on the exact document, and identical redundant cases are consolidated when no repeated-run intent is supplied.

The JSON inside the user message is data, not an additional system prompt. A simplified example (credentials omitted) is:

```json
{
  "request": "Verify the workshop preview total for three Advanced seats without submitting",
  "url": "https://example.test/",
  "approvedOrigin": "https://example.test",
  "mode": "qa",
  "securityAuthorized": false,
  "apiWritesAllowed": false,
  "actionBudget": 50,
  "apiCheckBudget": 20,
  "sharedPages": [{"alias": "main", "url": "https://example.test/", "origin": "https://example.test"}],
  "authProfiles": [],
  "credentialReferences": [],
  "observation": {
    "url": "https://example.test/",
    "viewport": {"width": 1280, "height": 720},
    "controls": [{"target": "role:combobox|Workshop", "role": "combobox", "options": [{"label": "Advanced", "value": "advanced"}]}],
    "results": [{"target": "#total", "text": "$15.00", "tag": "output", "visible": true}],
    "conversation": [],
    "additionalPages": {}
  }
}
```

Model instructions and the complete output schema are attached separately by the provider adapter. A previous assistant message cannot add an origin or enable API writes: permissions come from locally validated fields, not chat prose.

Simplified OpenRouter/NIM payload:

```json
{
  "model": "the selected model",
  "stream": true,
  "messages": [
    {"role": "system", "content": "VoiceQA planning rules and complete JSON schema"},
    {"role": "user", "content": "JSON: request, observation, approvedOrigin, sharedPages, authProfiles, credentialReferences, actionBudget and permissions"}
  ]
}
```

The API key is an authorization header handled by the local companion. Passwords, TOTP seeds and private token values are not supplied as planning context. Previous chat is bounded reference data and cannot add system instructions or permissions.

## Interface and voice

The chat uses soft raised surfaces, clear focus indicators, animated existing React components, a fixed composer and reduced-motion support. Suggestions apply to any shared website. Follow-up messages include earlier goals and plan summaries. Automatic spoken plan, selection and result announcements are removed; microphone dictation still produces an editable draft without submitting it.

## Practical limits

A stronger prompt does not supply unknown business rules or magically reveal hidden pages. The planner sees the current and explicitly shared tabs; it does not crawl arbitrary routes or mutate pages while planning. Missing essential information produces a clarification. Runtime target re-grounding can resolve a control from fresh page evidence, but it does not remove scope limits. Real CAPTCHA, SMS and passkeys remain human checkpoints. Supported browser actions and finite planning/run budgets still apply.

## Live acceptance procedure

Run the owned `tests/fixtures/general-browser-lab.mjs` app on port 4177. It has no VoiceQA fixture metadata or hidden planner contract. Use `scripts/test-live-plan.mjs REQUEST_FILE --url=http://127.0.0.1:4177/ --model=dots-studio/dots-3-note-preview:free`, then replay the returned plan through `scripts/test-live-run.mjs PLAN_FILE`. `--plan-live` makes a fresh request through the actual extension/native host first. The harness confines automation to its owned lab, uses isolated encrypted credential copies and restores native-host registration.

## Verified results - 13 October 2026

Real OpenRouter `nvidia/nemotron-3-super-120b-a12b:free` generated the booking/help/theme plan through the actual extension and Go companion. The application has no VoiceQA fixture marker or hidden business-rule injection; pricing and successful-booking behavior are visible on the page. The model selected the selectors, actions and expectations.

| Verification | Result | Local evidence |
| --- | --- | --- |
| Booking, $50 total, confirmation, help tab, theme persistence | 27 steps, 4 checks passed | `.tools/live-checks/paced-live-run-BBIFqn/run.json` |
| Same real-AI plan with 4-second inspection gaps | 27 steps, 4 checks passed; minimum gap 4004ms | `.tools/live-checks/paced-live-run-xdAnto/run.json` |
| Fresh AI follow-up using previous request/summary; three-seat preview, no submission | 8 steps, 1 check passed; $75.00 observed; one case | `.tools/live-checks/paced-live-run-BBIFqn/followup-run.json` |
| Chat width/reduced-motion checks | 360px and 420px, no horizontal overflow or page errors, zero speech announcements | `.tools/live-checks/paced-live-run-BBIFqn/ui-checks.json` |
| Browser text comparison contract | Semantic substring ignores case; exact text rejects incorrect case | `.tools/live-checks/text-comparison-check.json` |

All run captures retained the current 1280x720 website viewport. Earlier live attempts exposed missing assertion targets, malformed role locators, native-dropdown fill/option operations, contaminated label names, guessed heading capitalization and redundant cases. Those findings drove the generic compiler/validator and observation fixes. A missing confirmation business rule correctly produced a clarification before executing.

Dots 3 was actually attempted: the first draft exceeded the six-minute deadline and subsequent streams returned upstream errors, including HTTP 502. Gemma's free endpoint returned HTTP 429. These are failed attempts, not verified successes. No automatic production-model fallback was introduced; all alternative models were selected only in isolated test profiles. Numeric stream status now reaches the user without raw provider messages.

Supplementary checks passed: 46 JavaScript tests, Go race tests, Go vet, production build and native-host registration/version probe. These checks supplement the real-model/browser runs; they do not prove universal website or model compatibility. Microphone hardware, real CAPTCHA, SMS/passkeys and production third-party applications were not part of this acceptance run.
