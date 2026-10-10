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

Action commands: `navigate`, `click`, `fill`, `select`, `scroll`, `key`, and `assert`. Internal fixed operations: `observe`, `viewport`, `capture`, `accessibility`, `cleanup`. The native host cannot pass arbitrary CDP commands or JavaScript through this boundary.

Targets are `testid:ID`, `role:ROLE|EXACT NAME`, `label:EXACT LABEL`, `text:EXACT TEXT`, or a bounded CSS selector. Element geometry is recomputed before action. Ambiguous matches require review.

Assertions: `text`, `number`, `visible`, `count`, `enabled`, `selected`, `url`, `focus`, and `no_overflow`. Expected values are strings; numerical tolerance defaults to zero. Every case requires an assertion.
