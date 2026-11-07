# Licensing and third-party attribution

The project is licensed under [Apache-2.0](../LICENSE). [NOTICE](../NOTICE) records Cisco copyright and source attribution. Dependencies and copied materials retain their own licenses and notices.

## Source headers

Add a copyright and license header to source files that support comments. Use the file's year of creation and the copyright holder `Cisco Systems, Inc. and its affiliates` for new Cisco-authored code. Preserve existing years and copyright holders when editing or copying files.

Existing Go files use this compact header:

```go
// Copyright 2026 Cisco Systems, Inc. and its affiliates
// SPDX-License-Identifier: Apache-2.0
```

Use the same identifiers for new files, with comment syntax appropriate to the language. Build and workflow files use `#`; JavaScript uses `//`. Preserve Go build constraints and executable shebangs in their required positions. JSON does not support comments; its repository license and attribution are recorded in the root [LICENSE](../LICENSE) and [NOTICE](../NOTICE), without adding unsupported keys or comments to suites and manifests.

Copied or adapted code must retain its original copyright and license notices. Identify the original source, version or commit, and modifications when submitting a contribution. Do not replace a third-party copyright holder with Cisco's name.

## Dependencies and generated files

| Component | Dependency record | Attribution |
| --- | --- | --- |
| Native runner | [go.mod](../go.mod) and [go.sum](../go.sum) | Apache-2.0 project license and [NOTICE](../NOTICE), plus applicable dependency licenses. |
| Official CLI backend | Exact repository, release, and commit in [backend.json](../backend.json) | The backend source's `LICENSE`, `NOTICE`, and dependency licenses. Its backend pin is separate from the source-derivation attribution in this project's `NOTICE`. |
| GitHub Action bundle | [package-lock.json](../package-lock.json) | Generated third-party license texts in [dist/licenses.txt](../dist/licenses.txt), plus notices retained in the bundle. |
| Code of conduct | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Contributor Covenant and Mozilla attribution retained in that document. |

Run `npm run build` after changing Action dependencies. Commit the generated bundle and `dist/licenses.txt` together. Do not prepend this project's copyright to copied dependency code or remove dependency notices from generated output.

Before distributing a native bundle or image, review licenses and notices for both executables and their dependencies, as well as the container base image. Include the required texts with the distribution. The root license is not a replacement for third-party notices. Changes to dependencies or copied code require a fresh license review.
