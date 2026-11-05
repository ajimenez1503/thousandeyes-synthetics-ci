# Platform setup

Every example uses a version 1 suite and `TE_TOKEN` from the platform's secret store. Replace sample account groups, agents, targets, and thresholds before executing it. These examples create real instant tests and consume applicable units.

## Jenkins and GitLab

Build the native bundle as described in the [README](../README.md#build-and-run-the-preview). Install both executables together on the worker's `PATH`. Copy the example suite to the application repository as `thousandeyes-ci.json`.

For Jenkins, adapt the [Jenkinsfile](../examples/jenkins/Jenkinsfile) and create a secret-text credential named `thousandeyes-token`. For GitLab, copy [ci.yml](../examples/gitlab/ci.yml) to `.gitlab-ci.yml`, configure a masked/protected `TE_TOKEN`, and select an appropriately tagged Linux shell runner. The GitLab example runs only from the web UI. Protected variables require an eligible protected ref.

The shell command's exit status controls the gate. Both examples archive JSON/JUnit files after a failed check. A separate JUnit gate must account for non-blocking tests because their assertions remain XML failures even when the runner exits successfully. Jenkins, GitLab, and Argo examples have not been executed in your deployment environment.

## Container

Build the pinned backend source, then the image:

```bash
node scripts/prepare-backend.js
docker build -t te-synthetics:preview .
docker run --rm --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges -e TE_TOKEN \
  -v "$PWD/examples/synthetics:/config:ro" \
  te-synthetics:preview run-tests \
  --config /config/thousandeyes-ci.json --json
```

The container entrypoint is `te-synthetics`. Both native executables are included, so no Node, shell, or writable temporary directory is required at runtime. `--json` writes a sanitized report to stdout. For report files, mount a writable output volume and pass its paths to `--json-report` and `--junit-report`.

Release images stamp the release tag into `te-synthetics --version`. Local builds report `dev` unless you pass `--build-arg RUNNER_VERSION=<version>` to `docker build`.

## Argo CD and Argo Rollouts

Build and publish the image to your own registry, then pin its digest in the [Argo CD PostSync Job](../examples/argocd/post-sync-job.yaml) or pass it to the [Argo Rollouts AnalysisTemplate](../examples/synthetics/argo-rollouts/analysis-template.yaml). Create a Secret named `thousandeyes-api` with a `token` key, and create the suite ConfigMap:

```bash
kubectl create configmap thousandeyes-canary-suite \
  --from-file=thousandeyes-ci.json=examples/synthetics/thousandeyes-ci.json
```

The Job, ConfigMap, and Secret must be in the same namespace. Argo CD runs the example after synchronization and treats a failed Job as a failed hook. Argo Rollouts uses the Job's completion to decide whether the analysis succeeded; apply the template and add the [rollout step](../examples/synthetics/argo-rollouts/rollout-step.yaml), supplying its image, account group, suite ConfigMap, and Secret arguments. A ClusterAnalysisTemplate can use the same spec when appropriate.

The examples disable Job retries to avoid creating duplicate instant tests and set the outer Job deadline longer than the runner's five-minute deadline. Keep completed Job logs or export reports to your evidence store; these examples do not add external artifact storage.

Configure the suite target to reach the canary or preview revision explicitly. A weighted shared endpoint can route to the stable revision. A Job running inside Kubernetes does not give remote agents access to cluster-internal Services. Select Enterprise Agents with connectivity to private targets.
