# Release Ancestry

Catch a stale deployment before it removes someone else's release.

Release Ancestry is a dependency-free Node.js CLI that checks whether a candidate Git commit includes the commits already running in production and the release refs you require. It works with ordinary Git repositories and JSON health endpoints, regardless of hosting provider or coding assistant.

```text
production: A──B──C   ← hotfix is live
candidate:  A──B──D   ← deploying D would drop C

release-ancestry: FAIL — candidate does not contain the live commit
```

This is an initial release. There is no established adoption or production track record yet. Contributions and reproducible bug reports are welcome.

## Install

Requires Node.js 22 or newer and Git 2.45 or newer. The Git minimum enables disabling implicit partial-clone downloads during checks.

```sh
npm install --global github:johnarndt/release-ancestry#v0.1.0
release-ancestry --help
```

Or run from source:

```sh
git clone https://github.com/johnarndt/release-ancestry.git
cd release-ancestry
npm test
npm run demo
node bin/release-ancestry.js --help
```

There are no runtime dependencies, API keys, accounts, or model calls.

## Check before deploying

Fetch your release branch first. The CLI reads local Git refs; it does not fetch for you.

```sh
git fetch origin main
release-ancestry check \
  --required-ref origin/main \
  --health-url https://app.example.com/api/health
```

The health endpoint should return a Git commit identifier:

```json
{"sha": "0123456789abcdef0123456789abcdef01234567"}
```

For a nested field, add `--sha-path build.commit`. Full commit IDs are preferred; unique abbreviations of at least seven hexadecimal characters are accepted when they resolve to a local commit.

For services that must run the same commit:

```sh
release-ancestry check \
  --required-ref origin/main \
  --health-url https://app.example.com/api/health \
  --health-url https://worker.example.com/api/health \
  --require-matching-live \
  --json
```

For an offline check, supply a previously observed commit with `--live-sha`. Its freshness is your responsibility.

```sh
release-ancestry check --live-sha 0123456789abcdef0123456789abcdef01234567
```

## What it checks

- The repository is not shallow and required commit ancestry can be evaluated.
- The working tree has no tracked changes or non-ignored untracked files.
- The candidate resolves to a commit.
- Every required release ref and live commit is an ancestor of the candidate, or the candidate itself.
- Every health endpoint returns successful JSON with a valid, locally resolvable commit ID.
- With `--require-matching-live`, all observed live commits resolve to the same full commit.

Unknown or unavailable evidence never produces a passing result. A health endpoint is fetched with cache bypass request headers, a timeout, a one MiB response limit, and redirects disabled. HTTPS is required except for literal loopback addresses and `localhost`. URLs containing credentials, query parameters, or fragments are rejected.

Git replacement refs and legacy grafts are ignored so they cannot fabricate ancestry. Inherited repository, index, and configuration overrides are cleared for Git subprocesses; the supplied repository path determines what is checked.

## Options

| Option | Meaning |
| --- | --- |
| `--repo PATH` | Repository path; default is the current directory. |
| `--candidate REF` | Commit to check; default is `HEAD`. |
| `--required-ref REF` | Local Git ref that must be included; repeatable. |
| `--live-sha SHA` | Observed live commit identifier; repeatable. |
| `--health-url URL` | JSON health endpoint to inspect; repeatable. |
| `--sha-path PATH` | Dotted field path shared by all health endpoints; default `sha`. |
| `--timeout-ms N` | Deadline for each health request, including its body; default 5000. |
| `--require-matching-live` | Require at least two live sources and matching resolved commits. |
| `--allow-dirty` | Explicitly allow local modifications; checks still apply to the candidate commit. |
| `--json` | Emit a machine-readable report. |
| `--help`, `--version` | Show usage or the installed version. |

At least one required ref, live SHA, or health URL is required. Options with values use separate arguments, as shown above.

Exit codes: **0** means every check passed; **1** means a safety check failed; **2** means the command or evidence could not be evaluated. Only exit code 0 should permit the next step in a deployment pipeline.

## Use in CI or agent workflows

See [the GitHub Actions deployment example](examples/deployment.yml) and [agent workflow guidance](docs/agent-workflows.md). Check out the complete history (`fetch-depth: 0` in GitHub Actions), fetch the release refs, and run the check immediately before your deployment step. Use the same pinned commit for the check, build, and deploy.

## Limits

This is a point-in-time preflight check, not a deployment system or distributed lock. Another deployment can happen after the check. Use an environment lock or serialized deployment queue across **all** deployment paths; a single workflow's concurrency group does not coordinate unrelated local tools or repositories. Ignored files are outside the clean-tree check; build and deploy from the checked commit, not arbitrary local files.

A health response can be stale or inaccurate. The tool trusts the endpoint's reported commit and does not attest to deployed binaries. Ancestry does not establish application correctness, schema compatibility, or that a later commit did not revert a fix. Intentional rollbacks require a separate reviewed process. The CLI does not alter refs, fetch, deploy, roll back, or repair your repository.

Use trusted local repositories and Git configuration. This is not a sandbox: Git can consult repository, user, and system configuration and run configured helpers. The default clean-tree check refuses `assume-unchanged` and `skip-worktree` index flags because they can hide modifications; sparse checkouts therefore require the explicit `--allow-dirty` option and an immutable build source.

## Develop and contribute

```sh
npm test
npm run check
npm run demo
```

The tests create disposable Git repositories and local HTTP servers. They do not access production services. See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and the [roadmap](docs/roadmap.md).

Released under the [MIT license](LICENSE). Maintained by [John Arndt](https://github.com/johnarndt).
