# Suite configuration and results

Use `te-synthetics run-tests --config thousandeyes-ci.json` with `TE_TOKEN` in the environment. The [source-build procedure](../README.md#build-and-run-the-preview) installs the runner and compatible official CLI backend together.

## Configuration and evaluation

Use the [JSON Schema](../schemas/thousandeyes-ci.schema.json) for completion, field descriptions, examples, and validation in compatible editors and schema-based generators. The [example suite](../examples/synthetics/thousandeyes-ci.json) already references it through `$schema`. In VS Code, completion inside `tests` offers HTTP and network test snippets. Replace their sample account group, agents, and targets before running a suite.

For another repository, copy the schema alongside your suite and set `"$schema": "./thousandeyes-ci.schema.json"`. Adjust this relative path if you store the schema elsewhere. The runner accepts `$schema` as editor metadata and never fetches it. Schema defaults are authoring hints; the runner applies execution defaults.

The schema covers the suite structure and the native fields inspected by the runner. Additional native configuration and agent fields remain allowed and are validated by the ThousandEyes API. The runner also checks constraints that the schema cannot fully express, including unique test names and agent IDs, the 200-byte UTF-8 name limit, and positive Go durations within the supported range.

The version 1 JSON format contains `accountGroupId`, an optional suite `timeout` (default `5m`), an optional `pollInterval` (default `5s`), and a nonempty `tests` array. Each test defines:

| Field | Meaning |
| --- | --- |
| `name` | Unique, single-line name without control characters. |
| `type` | `http-server` or `agent-to-server`. |
| `config` | Native instant-test request payload, including its target and `agents`. Do not include read-only fields such as `type` or `testId`. |
| `executionRule` | `blocking` (default), `non-blocking`, or `skipped`. |
| `thresholds` | Optional criteria shown below. |

| Type | Default gate | Optional thresholds |
| --- | --- | --- |
| HTTP server | A response code from 200 through 399, with no reported test error. | `expectedResponseCodes` replaces the CI's accepted codes; `maxResponseTime` limits time to first byte in milliseconds; `maxTotalTime` limits total time in milliseconds. |
| Agent to server | Measured end-to-end packet loss is zero. | `maxLoss` is a percentage; `maxLatency` limits average RTT in milliseconds; `maxJitter` limits jitter in milliseconds. |

Each test uses `config` and one flat `thresholds` object. Optional HTTP timing and network latency/jitter limits are unset when omitted or `null`; `0` is an active maximum. Packet loss still defaults to zero. Additional native configuration and agent fields are preserved in the creation request.

Every configured agent must return applicable results from one coherent round. Missing values remain pending until the suite deadline; they never become zero or success. A known primary measurement failure can fail immediately without waiting for timing values that may never arrive. Network diagnostics attached to HTTP tests do not automatically become additional gates. When testing an expected non-2xx/3xx response, also align the native payload's `desiredStatusCode` setting; a native test error remains a failed check even if its response code appears in `expectedResponseCodes`.

For agent-to-server creation, set `server` to the hostname or IP address and supply a separate integer `port` for TCP or UDP targets, as shown in the example suite. The API response may combine them as `hostname:port`.

The runner supports individual Cloud and Enterprise Agents. Cluster-agent completeness and network directions other than `to-target` are not supported. Suite definitions are validated before submitting tests. Unsupported test types, duplicate agents, incompatible thresholds, and invalid durations are rejected; the API validates the native test payload.

## Results and exit status

- Exit `0`: every blocking check passed, or was explicitly skipped. Non-blocking assertion failures remain visible in reports.
- Exit nonzero: a blocking assertion failed, execution was incomplete or timed out, an API/configuration error occurred, cancellation was requested, or a report could not be written. Infrastructure failures remain blocking even for a non-blocking test.
- `--json` prints the sanitized report to standard output. `--json-report` and `--junit-report` write files using the same results. Parent directories must already exist.
- Configuration and report paths must identify different files. Within the same directory, filenames that differ only by letter case or Unicode normalization are treated as collisions for portability.
- JUnit contains a case per agent, or a case for a test with no agent outcomes. An additional execution-error case preserves any test-level failure not represented by agent outcomes. Non-blocking assertion failures are represented as JUnit failures and have an `executionRule` property, while the runner exit status follows the configured rule. Consumers that independently gate on JUnit must account for that distinction.

Reports contain run/test/agent identities, status, selected numeric measurements, and permitted platform links. Version 1 also includes optional `tests[].target` and `tests[].agents[].agentName` fields. Targets show the configured HTTP URL with user information, query strings, and fragments removed, or the network host and configured port. Names come from result metadata, falling back to the expanded creation response, without an extra agent lookup. Terminal output includes both fields; JUnit includes them as case properties.

Failed checks include the measured value and configured expectation, such as `HTTP response code 503 did not match expected [200]` or `responseTime 125.5 ms exceeded maximum 100 ms`. Native error details remain excluded; native HTTP errors can include the same safe response-code context.

`agents[].url` is the ThousandEyes results page, distinct from the tested target. The runner prefers permitted API-provided links. If a result omits its link, the public `https://api.thousandeyes.com` origin can use a fallback built from validated account, test, agent, and round IDs. Custom API origins receive no generated application link.

Agent names are limited to 160 characters and targets to 2,048 characters; oversized or unrecognized targets are omitted. Reports exclude native request payloads, response headers, and arbitrary API error bodies. Control characters are removed from names, and the supplied API token is redacted from the new metadata. Target paths and agent names remain visible, so avoid embedding other secrets in them. Treat configuration files containing target credentials as secrets and supply `TE_TOKEN` through your CI's secret mechanism.

`--account-group-id`, `--timeout`, and `--poll-interval` override the corresponding suite settings. Each invocation is bounded by one suite deadline, including backend process startup, API calls, retries, and polling. Allow for that startup cost when sizing larger suites or running on slower workers. The engine handles rate-limit responses within that deadline and does not blindly retry creation requests whose outcome is ambiguous.
