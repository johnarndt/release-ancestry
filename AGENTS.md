# Contributor instructions

This is a dependency-free Node.js CLI for checking release ancestry. Read README.md before making changes.

- Preserve fail-closed behavior: missing or invalid evidence must not yield exit 0.
- Use argument arrays for Git subprocesses. Never interpolate refs or URLs into shell commands.
- Keep HTTP requests bounded by time and response size. Do not add implicit credentials, redirects, telemetry, or deployment actions.
- Add tests for meaningful behavior changes, then run `npm test` and `npm run check`.
- Keep examples synthetic. Do not commit production endpoints, private project names, credentials, or application materials.
- Document the point-in-time limitation. This tool is not a deployment lock.
- Do not publish releases or change repository settings unless the user requested it.
