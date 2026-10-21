# Security

This new project has not received an independent security audit. The latest tagged release is the maintained version.

To report a vulnerability, email **john@soxoa.com** with the subject `Release Ancestry security report`. Describe the impact and provide a minimal reproduction using synthetic data. Please avoid public issues for unpatched vulnerabilities and do not include credentials or private production logs.

The CLI reads the local Git repository and contacts only the health URLs supplied by the caller. It has no telemetry, model calls, or deployment credentials. Treat supplied repository paths, refs, endpoints, and CI configuration as trusted operator input. Running the tool does not make arbitrary repositories or endpoints safe.

Reports may contain supplied refs, endpoint addresses, and commit IDs. Review reports before sharing them. Endpoint authentication, headers, query tokens, and redirect following are intentionally unsupported in v0.1.0.

The checker detects commit ancestry problems; it does not prove a deployed binary matches a commit, lock production, analyze application security, or guarantee that a release is safe.
