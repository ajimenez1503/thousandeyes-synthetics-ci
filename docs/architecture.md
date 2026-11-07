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

The GitHub Action installs or locates the runner, passes suite inputs, exposes report paths and counts, and writes a job summary. Jenkins, GitLab, terminals, and Argo Jobs invoke the same `te-synthetics run-tests` command directly or through its container.

The suite explicitly selects test targets and Cloud or Enterprise Agents. Defining targets and vantage points remains the suite author's responsibility.

## API backend contract

The official CLI owns generic OpenAPI routing, authentication, request serialization, HTTP transport, and machine-readable responses. The runner calls it as a subprocess, supplying complete native JSON on stdin using `--body-file -` and requesting an `--http-response` envelope. It disables redirects and caps API response bodies at 4 MiB. The adapter preserves status and retry headers for GET retries and rate-limit handling. An ambiguous creation outcome fails execution to avoid creating duplicate instant tests.

The process adapter bounds captured stdout/stderr and never prints raw child diagnostics. It passes `TE_TOKEN` and `TE_BASE_URL` through the child environment. The expected response envelope is:

```json
{"statusCode":200,"headers":{},"body":{"testId":"123"}}
```

HTTP error responses keep the envelope but exit nonzero. Process, transport, and argument failures also exit nonzero and may have no envelope. The required backend options are `--body-file`, `--http-response`, `--no-redirects`, and `--max-response-bytes`, in addition to generated API command flags. Suite commands, polling, threshold evaluation, and reports belong to the runner.

## Source and distribution

[`backend.json`](../backend.json) pins the official [ThousandEyes CLI 0.0.4 release](https://github.com/thousandeyes/thousandeyes-cli/releases/tag/0.0.4) to its source commit, `f5f5bbd3a93baf9447c6d419d5ee012246db3eff`. Preparation verifies that source commit before building the API backend. The native build compiles both the runner and the backend from source. `TE_API_CLI_SOURCE` is an explicit local-development override, not a release dependency.

The release bundles and runtime image contain both executables, their license/notice, and backend metadata. Updating the backend pin requires reviewing the selected release's source commit and rerunning integration tests.

## Integration configuration

Use `runner-path` in the GitHub Action to select an installed `te-synthetics` executable. Once a runner release is published, `runner-version` can select an exact native bundle from this repository. Keep both executables together when installing a bundle. Use `api-cli-path` to select a separately managed backend that supports the required API contract.

See [suite configuration and results](configuration.md) and [platform setup](platforms.md) for the shared suite format, secret handling, report semantics, and integration examples.
