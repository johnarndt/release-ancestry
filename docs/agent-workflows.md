# Using Release Ancestry with coding agents

Parallel work makes it easy for one checkout to miss a release made from another. Give every deployment path the same required release ref and production health source, and serialize production changes outside the checker.

A repository instruction can say:

```text
Before deploying:
1. Acquire the environment's deployment lock.
2. Fetch origin/main and the complete history.
3. Build and test the exact candidate commit.
4. Run release-ancestry check --required-ref origin/main
   --health-url https://app.example.com/api/health --json.
5. Continue only if the command exits 0.
6. Deploy that same candidate, verify it, and release the lock.
If a check fails, report the failed evidence and reconcile the branch.
Do not bypass the check or use --allow-dirty just to get a pass.
```

Replace the example host and ref with your own. The health endpoint must return a build-time Git commit ID, rather than a branch name or a value computed from a separate mutable checkout. Configure the endpoint and any CDN to avoid cached responses.

For app/worker pairs, pass both health URLs and `--require-matching-live` when the services are expected to match before deployment. Updating the pair atomically and checking it afterward remain responsibilities of the deployment system.

The tool runs without an AI provider. Codex, Claude, a human, or a CI runner can use the same deterministic check. Any future automated maintenance workflow should operate on public source, require human review of changes, and use separate least-privilege credentials.
