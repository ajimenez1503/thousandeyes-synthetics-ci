# ThousandEyes Synthetics CI

Run ThousandEyes HTTP and network instant tests from GitHub Actions, Jenkins, GitLab, a developer terminal, or an Argo Job. All integrations use the same portable command and version 1 suite:

```bash
te-synthetics run-tests --config thousandeyes-ci.json \
  --json-report results.json --junit-report results.xml
```

This repository contains the Go orchestration runner and a thin Node24 GitHub Action. The runner calls the official [`thousandeyes` CLI](https://github.com/thousandeyes/thousandeyes-cli) as its API backend. Test selection, polling, per-agent completeness, thresholds, execution rules, and reports belong here. The official CLI only needs generic API-access capabilities.

This is a preview in a personal account. The backend requires generic CLI changes that are not yet in a released official binary. [`backend.json`](backend.json) identifies the exact official source commit used by builds. Build this preview from source; there is no default downloadable runner release yet. No published container is assumed by the examples.

Cloud or Enterprise Agents perform the measurements. Private targets require an Enterprise Agent that can reach them. Each run creates new instant tests and consumes applicable ThousandEyes units.

## Build and run the preview

Install Go and Node24, clone this repository, and run:

```bash
node scripts/build-native.js
```

The build places `te-synthetics` and its pinned `thousandeyes` backend together in `build/bin` (with `.exe` suffixes on Windows). Keep them together when copying the bundle. Node is a build dependency; terminals, CI shell steps, and containers run the native binaries without Node.

Copy the [example suite](examples/synthetics/thousandeyes-ci.json), then replace its account group, agents, targets, and thresholds. Supply the token through your secret manager or shell environment:

```bash
export TE_TOKEN="<thousandeyes-bearer-token>"
./build/bin/te-synthetics run-tests \
  --config examples/synthetics/thousandeyes-ci.json \
  --json-report results.json --junit-report results.xml
```

The runner resolves the backend from `--api-cli-path`, then `TE_API_CLI_PATH`, then the sibling `thousandeyes` executable, then `PATH`. An override must support the contract documented in [architecture](docs/architecture.md). An older official CLI is not compatible with this preview.

Use the [JSON Schema](schemas/thousandeyes-ci.schema.json) for completion and generation. The example already references it through `$schema`. See [suite configuration and results](docs/configuration.md) for defaults, threshold units, execution rules, and report semantics.

## GitHub Actions

The preview workflow below builds the bundle before invoking the Action. It requires no published runner release. For a reproducible workflow, replace both `main` references with the same reviewed full commit SHA.

```yaml
name: Synthetic checks
on: [workflow_dispatch]
permissions:
  contents: read
jobs:
  synthetics:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          persist-credentials: false
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          repository: ajimenez1503/thousandeyes-synthetics-ci
          ref: main
          path: .te-synthetics
          persist-credentials: false
      - uses: actions/setup-go@40f1582b2485089dde7abd97c1529aa768e1baff # v5
        with:
          go-version-file: .te-synthetics/go.mod
          cache-dependency-path: .te-synthetics/go.sum
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: 24
      - name: Build preview bundle
        working-directory: .te-synthetics
        run: node scripts/build-native.js
      - name: Run synthetic checks
        id: synthetics
        uses: ajimenez1503/thousandeyes-synthetics-ci@main
        with:
          api-token: ${{ secrets.TE_TOKEN }}
          config-path: thousandeyes-ci.json
          runner-path: ${{ github.workspace }}/.te-synthetics/build/bin/te-synthetics
      - name: Save reports
        if: always()
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7
        with:
          name: thousandeyes-results
          path: |
            ${{ steps.synthetics.outputs.json-report }}
            ${{ steps.synthetics.outputs.junit-report }}
          if-no-files-found: warn
```

Once an exact runner release is published, `runner-version` can install its native bundle and verify archive SHA-256 checksums against the release manifest. Floating `latest` is rejected. A release bundle contains both executables. Never point `runner-version` at the earlier forked CLI releases.

| Input | Default | Purpose |
| --- | --- | --- |
| `api-token` | Required | ThousandEyes API bearer token from a secret. |
| `config-path` | `thousandeyes-ci.json` | Suite file relative to the workspace, or absolute. |
| `runner-path` | Empty | Absolute path to a managed `te-synthetics` executable. |
| `runner-version` | Empty | Exact published release from this repository; required if no runner path is supplied. |
| `api-cli-path` | Bundled backend | Absolute path to a compatible official API CLI override. |
| `account-group-id` | Suite value | Override the account group. |
| `timeout`, `poll-interval` | Suite values | Positive duration overrides such as `5m` and `5s`. |
| `api-base-url` | `https://api.thousandeyes.com` | API origin; HTTP is permitted only for loopback test servers. |

`cli-version` and `cli-path` are deprecated aliases for the runner inputs. They now identify the portable runner, not the old forked API CLI. Conflicting aliases are rejected. Existing consumers pinned to earlier Action commits keep their earlier behavior.

The Action exposes `run-id`, `exit-code`, `json-report`, `junit-report`, and test counts (`passed`, `failed`, `non-blocking-failed`, `skipped`, `timed-out`, `errors`). Report paths are reserved before execution; files exist only if the runner produces them. Use `if: always()` for uploads.

The job summary includes timestamps, duration, test IDs, status symbols, and agent tables with test name, target, agent name/ID, round, measurements, bounded failure reasons, and permitted ThousandEyes result links. Failure rows are prioritized when summary limits are reached. Complete JSON/JUnit artifacts retain all results. The adapter validates reports and preserves the runner's exit decision.

The token is masked and passed through `TE_TOKEN`, never command arguments. Raw child output is not forwarded to GitHub logs. Summary values are bounded, sanitized, token-redacted, and escaped.

## Other platforms

| Platform | Example |
| --- | --- |
| Developer terminal | [Native command and report semantics](docs/configuration.md) |
| Jenkins | [Pipeline](examples/jenkins/Jenkinsfile) |
| GitLab CI | [Pipeline](examples/gitlab/ci.yml) |
| Argo CD | [PostSync Job](examples/argocd/post-sync-job.yaml) |
| Argo Rollouts | [AnalysisTemplate](examples/synthetics/argo-rollouts/analysis-template.yaml) and [rollout step](examples/synthetics/argo-rollouts/rollout-step.yaml) |

Jenkins and GitLab examples assume the two-binary bundle is already installed on the worker. Kubernetes examples require an image that you build and publish, a suite ConfigMap, and a token Secret. See [platform setup](docs/platforms.md).

## Development and validation

```bash
npm ci --ignore-scripts
npm test
npm run build
node scripts/build-native.js
TE_TEST_API_CLI_PATH="$PWD/build/bin/thousandeyes" make ci
npm run smoke:native
```

On Windows, use `thousandeyes.exe` for the backend test path and set the environment variable with your shell's syntax. Native command integration tests skip explicitly when `TE_TEST_API_CLI_PATH` is absent.

Commit `dist/` with Node source changes. Release artifacts go under `build/release`, separate from the committed Action bundle. CI runs the native runner and actual pinned API CLI against a local fake API on Linux, macOS, and Windows, and validates a restricted container. These tests use fake tokens and do not create real ThousandEyes tests. Jenkins, GitLab, and Argo runtime integration requires validation in your environment.

See [architecture](docs/architecture.md) for the component boundary, backend pin, and migration from the proof of concept. The thin adapter approach is inspired by the [Datadog synthetics Action](https://github.com/DataDog/synthetics-ci-github-action). No Datadog execution code is included.

Licensed under Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
