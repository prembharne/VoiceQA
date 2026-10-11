# Native protocol v1

Chrome Native Messaging uses a 4-byte little-endian UTF-8 byte length followed by JSON. The Go transport rejects empty, truncated, wrong-version, and oversized messages. Maximum encoded envelope: 512 KiB.

```json
{"version":1,"id":"opaque-id","type":"plan.propose","payload":{"request":"Check the cart","url":"http://127.0.0.1:4173/","origin":"http://127.0.0.1:4173","demo":false,"responsive":true,"visual":false}}
```

Replies use `rpc.result` with `payload.requestId`, `result`, and optional `error`. Host-to-browser operations use `browser.request`; responses use `browser.result` with `requestId`, `result`, `error`, and `code`. `runId` and `actionId` bind execution and journals. Run events contain a persisted sequence number and a run snapshot.

Supported RPCs: `hello`, `settings.get/save`, `project.configure`, `plan.propose/confirm/get/list`, `run.start/cancel/get/list`, `upload.begin/chunk/complete`, `artifact.get`, `audio.complete`, `baseline.approve`, and `report.export`.

Speech RPCs: `speech.synthesize` takes `text` (1–4096 characters) and a unique `speechId`, returning a temporary MP3 artifact ID. `speech.cancel` cancels a specific synthesis without stopping a test run. `speech.release` deletes only a marked temporary speech artifact; it cannot delete test evidence. Existing chunked `artifact.get` transfers audio to the panel. The panel uses generation checks to suppress late playback after cancellation.

Settings include `ttsProvider` (`browser` or `openai`), `ttsModel`, `ttsVoice`, `ttsReuseMainKey`, input-only `ttsApiKey`, and public `hasTtsApiKey`. Legacy settings inherit browser speech defaults. Plaintext keys are never stored in settings JSON.

Uploads contain total size and SHA-256. Chunks are base64, at most 192 KiB raw, sequential, acknowledged individually, and limited to 16 MiB total with at most four pending uploads. Expired uploads are discarded after two minutes. Downloads use bounded offsets. Raw audio is removed after transcription.

Action commands: `navigate`, `click`, `fill`, `select`, `scroll`, `key`, `assert`, `wait_for`, `open_tab`, `switch_tab`, `close_tab`, `fill_secret`, `fill_totp`, and `human_checkpoint`. Internal fixed operations include `observe`, `observe_page`, `location`, `page_scope`, `handoff.poll`, `viewport`, `capture`, `accessibility`, `cleanup`. The native host cannot pass arbitrary CDP commands or JavaScript through this boundary.

Targets are `testid:ID`, `role:ROLE|EXACT NAME`, `label:EXACT LABEL`, `text:EXACT TEXT`, or a bounded CSS selector. Element geometry is recomputed before action. Ambiguous matches require review.

Assertions: `text`, `text_contains`, `value` (nonprivate inputs), `number`, `visible`, `hidden`, `count`, `enabled`, `selected`, `url`, `url_contains`, `focus`, and `no_overflow`. Expected values are strings; numerical tolerance defaults to zero. `wait_for` uses the same assertion structure and optional `timeoutMs` (0/default or 500–30000). Every case requires a separate `assert`.

Plans may include trusted `pages: [{alias,url,origin,title}]`; browser IDs never enter model context. Each case has a `page` alias, defaulting to `main` for older plans. `open_tab` takes target=unique alias/value=approved URL, `switch_tab` takes target=existing alias, and `close_tab` accepts only a run-created alias. Suite requests keep the main approved origin while their results identify the current `page` and actual `origin`.

Profile RPCs: `auth.list/save/delete`. Save accepts `id`, `origin`, `label`, input-only `username/password/totpSecret`, and `algorithm/digits/period`. Public replies expose `hasUsername/hasPassword/hasTotp`, never stored values. Secure planned entry uses `fill_secret` value=`profile:username|password` or `fill_totp` value=`profile`. The host sends a transient `fill` action with `secureOrigin` only to the trusted worker; original plan/run records retain references.

Panel-to-worker page RPCs are `pages.list/share/remove`. `pages.share` accepts an existing tab ID after a site permission grant. `handoff.complete` accepts the current checkpoint ID. `human_checkpoint` value is `mfa`, `captcha` or `approval`; its run snapshot exposes a fresh handoff ID and instructions. Completion polling never blocks a native request for the duration of operator interaction. Cancellation invalidates the handoff, and cleanup closes only tracked run-created tabs still in an explicitly approved origin.
