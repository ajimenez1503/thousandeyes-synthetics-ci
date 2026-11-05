# Architecture

```text
GitHub Action, Jenkins, GitLab, terminal, or Argo Job
                         |
                te-synthetics runner
     suite -> create -> poll -> evaluate -> JSON/JUnit
                         |
          official thousandeyes CLI subprocess
             generic API request/response handling
                         |
              ThousandEyes API and agents
```

The Go runner owns CI policy. Its HTTP and network adapters validate native payloads, create instant tests, wait for every configured agent in a coherent round, evaluate thresholds, and produce version 1 reports. A single deadline bounds the run. Cancellation and incomplete execution fail the gate, including for non-blocking tests.

The official CLI owns generic OpenAPI routing, authentication, request serialization, HTTP transport, and machine-readable responses. The runner contains no second HTTP API client. It supplies complete native JSON on stdin using `--body-file -`, requests an `--http-response` envelope, disables redirects, and caps API response bodies at 4 MiB. It preserves status and retry headers for safe GET/rate-limit handling. Creation is never blindly retried when the server outcome is ambiguous.

The process adapter bounds captured stdout/stderr and never prints raw child diagnostics. It passes `TE_TOKEN` and `TE_BASE_URL` through the child environment. The expected response envelope is:

```json
{"statusCode":200,"headers":{},"body":{"testId":"123"}}
```

HTTP error responses keep the envelope but exit nonzero. Process, transport, and argument failures also exit nonzero and may have no envelope. The required backend options are `--body-file`, `--http-response`, `--no-redirects`, and `--max-response-bytes`, in addition to generated API command flags. The generic upstream changes do not add synthetic suite commands, polling, thresholds, or reports.

## Source and distribution

[`backend.json`](../backend.json) pins an exact commit in `thousandeyes/thousandeyes-cli`. Preparation verifies that source commit before building. `TE_API_CLI_SOURCE` is an explicit local-development override, not a release dependency. The release bundles and runtime image contain both executables, their license/notice, and backend metadata. Updating the pin requires reviewing the source and rerunning integration tests.

The preview depends on an official CLI candidate, not an official released compatibility promise. Replace the pin with a reviewed upstream release commit after the generic changes are accepted. Do not silently substitute an older CLI or the proof-of-concept fork.

## Migration from the proof of concept

The old repository name was `thousandeyes-synthetics-ci-github-action`. GitHub repository redirects do not preserve Action `uses:` references, so workflows must use `ajimenez1503/thousandeyes-synthetics-ci` explicitly.

The previous executable was `thousandeyes synthetics run-tests` from a personal fork. The standalone command is now `te-synthetics run-tests`. Suite version 1, JSON/JUnit reports, thresholds, and execution rules remain compatible. The official CLI remains an independently usable API tool.

For the new Action, use `runner-path` during the source-build preview, or `runner-version` after a runner release exists. The deprecated `cli-path` and `cli-version` names now refer to that same runner. They cannot install the previous forked CLI format.

The consolidated repository provides execution and evidence. It does not automatically infer a change's blast radius or choose optimal agents; users select targets and vantage points in the suite.
