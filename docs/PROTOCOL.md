# Native protocol v1

Chrome Native Messaging uses a 4-byte little-endian UTF-8 byte length followed by JSON. The Go transport rejects empty, truncated, wrong-version, and oversized messages. Maximum encoded envelope: 512 KiB.

```json
{"version":1,"id":"opaque-id","type":"plan.propose","payload":{"request":"Check the cart","url":"http://127.0.0.1:4173/","origin":"http://127.0.0.1:4173","demo":false,"responsive":true,"visual":false}}
```

Replies use `rpc.result` with `payload.requestId`, `result`, and optional `error`. Host-to-browser operations use `browser.request`; responses use `browser.result` with `requestId`, `result`, `error`, and `code`. `runId` and `actionId` bind execution and journals. Run events contain a persisted sequence number and a run snapshot.

`plan.progress` events carry `requestId`, `phase` (waiting/adapting/analyzing/generating/validating/repairing) and `receivedChars`, a UTF-8 output byte count. These are transient planning metadata, never raw output or reasoning. The worker accepts only the active planning ID and clears it on Stop, completion, restart or disconnect. `plan.propose` has a seven-minute companion deadline, with six minutes shared by AI generation and its optional single validation repair. Native/panel bridges wait 7.5/eight minutes; all other method limits remain unchanged.

Supported RPCs include `hello`, `settings.get/save`, `project.configure`, `plan.propose/confirm/get/list/fork`, `agent.query`, `automation.propose`, `run.start/cancel/get/list/compare`, `upload.begin/chunk/complete`, `artifact.get`, `audio.complete`, `baseline.approve`, and `report.export`.

## Investigation and adaptive automation (0.8/0.9)

`agent.query` uses the same guarded planning transport/deadline to return a source-linked answer or an essential clarification. Its model loop selects bounded read-only browser tools; tool names/arguments, source IDs and approved origins are checked locally.

`automation.propose` is now local request preparation: it accepts `request`, bounded conversation, trusted `allowConsequential`, `apiWritesAllowed` and `maxActions`, but calls no AI. The worker supplies URL/origin/shared pages. It returns a compatibility Plan record with `mode: automation`, no cases or initial criteria, one preserved viewport and `automation: {live: true, maxActions, allowConsequential, criteria: []}`. `plan.confirm` and `run.start` protect the exact request/permission version, not a predicted action plan. Changed UI permissions require fresh local preparation.

During live execution, each model decision is `action`, `complete` (runtime requirement descriptions and assertions) or `blocked`. A late coverage review checks the request after execution; it produces no action plan. Older saved missions retain criterion-ID completion. Fresh public observations, retained state evidence, recent results and remaining budget are included. `browser.request` also supports read-only `resolve_target` preflight. Run snapshots add `agentPhase`, bounded sanitized `observations` and `evidenceOmitted`; history summaries omit observation bodies/conversation. Control/form consequence checks precede Click, Enter and Space, independently of model labels. No automatic speech announcement accompanies events.

`agent.query` additionally accepts a selected terminal `runId`. Go validates current origin grants, exposes bounded `read_run` queries and returns an evidence-qualified `assessment` with facts/hypotheses/next checks. A recorded verdict cannot be rewritten by investigation. See `RECORDED_DEBUGGING.md`.

Speech RPCs: `speech.synthesize` takes `text` (1–4096 characters) and a unique `speechId`, returning a temporary MP3 artifact ID. `speech.cancel` cancels a specific synthesis without stopping a test run. `speech.release` deletes only a marked temporary speech artifact; it cannot delete test evidence. Existing chunked `artifact.get` transfers audio to the panel. The panel uses generation checks to suppress late playback after cancellation.

Settings include `ttsProvider` (`browser` or `openai`), `ttsModel`, `ttsVoice`, `ttsReuseMainKey`, input-only `ttsApiKey`, and public `hasTtsApiKey`. Legacy settings inherit browser speech defaults. Plaintext keys are never stored in settings JSON.

Uploads contain total size and SHA-256. Chunks are base64, at most 192 KiB raw, sequential, acknowledged individually, and limited to 16 MiB total with at most four pending uploads. Expired uploads are discarded after two minutes. Downloads use bounded offsets. Raw audio is removed after transcription.

Action commands: `navigate`, `click`, `fill`, `select`, `scroll`, `key`, `assert`, `wait_for`, `open_tab`, `switch_tab`, `close_tab`, `fill_secret`, `fill_totp`, and `human_checkpoint`. Internal fixed operations include `observe`, `observe_page`, `location`, `page_scope`, `handoff.poll`, `viewport`, `capture`, `accessibility`, `cleanup`. The native host cannot pass arbitrary CDP commands or JavaScript through this boundary.

Targets are `testid:ID`, `role:ROLE|EXACT NAME`, `label:EXACT LABEL`, `text:EXACT TEXT`, or a bounded CSS selector. Element geometry is recomputed before action. Ambiguous matches require review.

Assertions: `text`, `text_contains`, `value` (nonprivate inputs), `number`, `visible`, `hidden`, `count`, `enabled`, `selected`, `url`, `url_contains`, `focus`, and `no_overflow`. Expected values are strings; numerical tolerance defaults to zero. `wait_for` uses the same assertion structure and optional `timeoutMs` (0/default or 500–30000). Every case requires a separate `assert`.

Plans may include trusted `pages: [{alias,url,origin,title}]`; browser IDs never enter model context. Each case has a `page` alias, defaulting to `main` for older plans. `open_tab` takes target=unique alias/value=approved URL, `switch_tab` takes target=existing alias, and `close_tab` accepts only a run-created alias. Suite requests keep the main approved origin while their results identify the current `page` and actual `origin`.

Profile RPCs: `auth.list/save/delete`. Save accepts `id`, `origin`, `label`, input-only `username/password/totpSecret`, and `algorithm/digits/period`. Public replies expose `hasUsername/hasPassword/hasTotp`, never stored values. Secure planned entry uses `fill_secret` value=`profile:username|password` or `fill_totp` value=`profile`. The host sends a transient `fill` action with `secureOrigin` only to the trusted worker; original plan/run records retain references.

Panel-to-worker page RPCs are `pages.list/share/remove`. `pages.share` accepts an existing tab ID after a site permission grant. `handoff.complete` accepts the current checkpoint ID. `human_checkpoint` value is `mfa`, `captcha` or `approval`; its run snapshot exposes a fresh handoff ID and instructions. Completion polling never blocks a native request for the duration of operator interaction. Cancellation invalidates the handoff, and cleanup closes only tracked run-created tabs still in an explicitly approved origin.

## Version 0.4 workflow additions (envelope version remains 1)

`plan.propose` accepts trusted `mode` (`qa`/`security`), `securityAuthorized`, `apiWritesAllowed` and `dataset` (up to five public string-valued rows). Every case/row is validated; the model cannot grant permissions. `plan.fork` accepts an existing plan ID and optional dataset override, returning a new unconfirmed ID/version. `run.compare` accepts `before`/`after` run IDs on the same primary origin and returns fixed/regressed/added/removed step entries.

`capture_value` uses target=nonprivate element and value=public variable alias. Subsequent fields may contain `${alias}`. `http_check` uses an `http` object: method, same-current-origin URL, JSON body or empty string, expectedStatus, JSON pointer, expectedValue, expectedType, tolerance, public saveAs, idempotencyKey and optional named authSource/authPointer or csrfSource/csrfHeader/csrfBodyField. Actual session/CSRF values stay inside the browser. GET/HEAD permit no body. Writes need explicit trusted consent. Twenty checks/run, 16 KiB response and bounded scalar evidence apply. `security_audit` returns scoped indicators only in authorized security mode.

Steps include `iteration` (one-based row identity), `page` and viewport. Run snapshots may include `diagnosis`, `securityFindings`, and exact `recordedSteps/passedSteps/failedSteps/omittedSteps` counts. Large wire snapshots omit older details under 400 KiB while retaining complete local report records; clients must use counts rather than the visible array length. `report.export` additionally accepts `md` for a reproduction/triage report. Settings add `visualMaskSelectors` independently of private masks.

Plans support preserveViewport. In that mode viewports contains one observed geometry entry and current_viewport reads live geometry without resizing. plan.fork may set preserveViewport to create an unconfirmed current-width copy of a saved responsive plan. run.start never silently changes the confirmed viewport mode.
