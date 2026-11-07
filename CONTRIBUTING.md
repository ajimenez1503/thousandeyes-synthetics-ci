# Contributing to ThousandEyes Synthetics CI

Contributions can include bug reports, documentation, tests, platform examples, and code. Follow the [code of conduct](CODE_OF_CONDUCT.md) in issues, pull requests, and other project discussions.

## Report issues and suggest features

Search the repository's issues and pull requests before opening a new issue. For a bug, include the runner version or source commit, operating system, integration platform, reproduction steps, and expected and actual results. Include a minimal suite and sanitized diagnostics when useful.

For a feature, describe the problem, intended users, expected behavior, and alternatives. Discuss changes to the suite format, backend contract, or supported test types before investing in a large implementation.

Use synthetic values such as `https://example.com` in shared examples. Remove tokens, credentials, private targets, internal domains, account identifiers, and agent details from reports and logs. Report suspected vulnerabilities using [SECURITY.md](SECURITY.md), rather than a public issue or pull request.

## Set up a development environment

Install:

- Git.
- The Go version specified in [go.mod](go.mod), or a compatible newer version.
- Node.js 24 and npm. The Action runs on Node.js 24 in GitHub Actions.
- **Optional:** Docker to check the runtime image. The container API smoke test requires Linux.

Fork the repository, clone your fork, and create a branch from the current `main`. From the repository root, run:

```bash
npm ci --ignore-scripts
node scripts/build-native.js
```

The native build downloads the official CLI source pinned in [backend.json](backend.json) and Go dependencies. It writes both executables to `build/bin`. Keep `te-synthetics` and `thousandeyes` together when moving the bundle. See [architecture](docs/architecture.md) for the backend contract and the local source override.

## Coding and documentation conventions

- Format Go changes with `gofmt` or `make fmt`.
- Follow the existing CommonJS style in JavaScript. Do not edit generated files in `dist/` directly.
- Keep API access in the official CLI backend and CI policy in the runner. Keep the GitHub Action focused on integration and reporting.
- Preserve compatibility for suite and report formats, or describe a proposed breaking change explicitly.
- Use inclusive language, descriptive names, and concise documentation. Examples must use synthetic targets, identities, and credentials.
- Preserve existing copyright notices, license headers, and third-party attribution. Add a header to new source files as described in [licensing](docs/licensing.md).

## Validate changes

Run checks that cover the behavior you changed. The checks below match the main local development workflow and use a local fake API; no real ThousandEyes token or account is required:

```bash
npm test
npm run build
node scripts/build-native.js
TE_TEST_API_CLI_PATH="$PWD/build/bin/thousandeyes" make ci
npm run smoke:native
```

To test the generated Action entry point, run:

```bash
ACTION_ENTRY=dist/index.js node --test test/action.test.js
```

On Windows, use `thousandeyes.exe` for the backend test path and set environment variables with your shell's syntax. Run `go test ./...` and `go vet ./...` directly if Make is unavailable. Native command integration tests explicitly skip when `TE_TEST_API_CLI_PATH` is absent; skipped integration tests do not validate the backend contract.

For container changes, run these additional checks on Linux with Docker available:

```bash
node scripts/prepare-backend.js
node scripts/smoke-container.js --api
```

Commit the rebuilt `dist/` whenever JavaScript source changes affect the Action. After committing it, `npm run check:dist` verifies that rebuilding produces no differences. The CI workflow also tests Linux, macOS, and Windows, a restricted container, and release snapshots. Platform examples require separate validation in the relevant CI or Kubernetes environment.

Use fake tokens and the local API fixtures for automated tests. Run live tests only against targets and agents you are authorized to use; instant tests consume applicable ThousandEyes units. Do not commit real credentials or reports containing private account data.

## Submit a pull request

1. Keep the change focused and explain the problem it solves. Link a related issue when one exists.
2. Use a concise, imperative commit subject, such as `Document agent selection`.
3. Add or update meaningful tests for behavior changes and documentation for user-facing changes.
4. Complete the pull request template with the resulting behavior, checks performed, and any limitations or compatibility effects.
5. Open the pull request against `main` and respond to review feedback.

By submitting a contribution for inclusion, you agree to the contribution terms in section 5 of the [Apache-2.0 license](LICENSE). Preserve third-party licensing when incorporating external code; identify its source, license, and modifications in the pull request.

## Versioning and releases

Runner release tags follow [Semantic Versioning](https://semver.org/) without a `v` prefix, for example `0.1.0`. The current release workflow publishes prereleases. A version in `package.json` does not establish an available runner release; npm publication is disabled with `private: true`.

Release publication is a maintainer responsibility. Changes to the backend pin require reviewing the exact official CLI commit and rerunning integration checks. See [licensing](docs/licensing.md) for attribution that must accompany distributions.
