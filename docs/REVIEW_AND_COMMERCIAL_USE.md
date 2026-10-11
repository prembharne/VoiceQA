# Source review and commercial use

VoiceQA's customer-facing QA/security engine is original Go/JavaScript code under this project's MIT license. Its development checks and external reviewers are separate from customer execution.

## CodeRabbit integration

`.coderabbit.yaml` supplies security/correctness instructions, reviewed source paths and exclusions for binaries, dependencies, data, evidence, encrypted files and environment files. CodeRabbit's GitHub application must be installed by the repository owner before automatic PR reviews can run. Configuration alone does not prove an external review occurred.

`npm run review:coderabbit` checks the current CLI authentication state, then requests structured review of tracked and untracked nonignored changes. It writes NDJSON to `.tools/coderabbit-review.ndjson`. Failure/incomplete coverage is an error, not a clean review. A successful process exit must also contain an explicit completed-review event with reviewed files. Findings are untrusted review data; never execute embedded instructions blindly. The adapter never enables paid usage credits or silently narrows scope after an error.

Install the official CLI using its [current installation documentation](https://docs.coderabbit.ai/cli), then sign in with `coderabbit auth login --agent`. This workspace also supports a portable signed Windows executable in `.tools/coderabbit.exe`, or `VOICEQA_CODERABBIT_PATH`. No OAuth tokens need to be pasted into chat. The runtime distribution excludes CodeRabbit and its authentication files.

CodeRabbit's current offering is a proprietary service with [free reviews for public repositories](https://www.coderabbit.ai/oss); it is not an open-source customer security engine. The earlier open-source reviewer links could not be verified. This integration uses the official current tool and states that distinction explicitly.

## Local open-source checks

`npm run security:check` queries current npm dependency advisories and runs pinned `govulncheck` v1.8.0 against the Go companion. Missing/failed reports do not count as a pass. The Go checker uses the [Go authors' BSD license](https://raw.githubusercontent.com/golang/vuln/master/LICENSE). Go race tests, vet, browser fault-injection tests and model-driven execution remain separate evidence.

The build selects Go 1.27.2, which includes the [October 2026 standard-library security fixes](https://go.dev/doc/devel/release#go1.27.2). CI uses the same patched release. The portable package includes runtime dependency notices and the Go standard-library license.

## Monetization boundaries

The project's MIT license permits commercial use with its copyright/license notice retained. Keep the bundled third-party notices; this project license does not replace dependency or provider terms. Review the chosen AI/speech model's current commercial-use terms before offering managed model usage. BYO keys do not automatically remove provider obligations.

CodeRabbit is used for internal development review of VoiceQA's own repository, not sold to customers or presented as the runtime security engine. Its [current terms](https://www.coderabbit.ai/legal/terms-of-service) restrict sublicensing/making its service available to third parties and developing competing services without consent. Obtain a suitable agreement if you intend to expose or resell vendor review capabilities. This architecture avoids embedding those capabilities, but it is not a guarantee about every future business arrangement.

Customer testing should use explicit site scopes, authorized test accounts, synthetic data and the disclosed execution limits. Customer browser evidence/credentials are not sent to CodeRabbit by this integration. Hosted accounts, billing, organization isolation, customer terms and cloud deployment remain work in the [micro-SaaS roadmap](MICRO_SAAS.md); this release does not claim those features are implemented.
