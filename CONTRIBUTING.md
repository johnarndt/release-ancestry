# Contributing

Release Ancestry is an early project. Small, well-explained issues and pull requests are welcome.

Use Node.js 22 or newer and Git 2.45 or newer. Clone the repository and run `npm test`, `npm run check`, and `npm run demo`. No dependencies or credentials are needed.

For bug reports, include the tool version, Node and Git versions, the expected behavior, and a minimal reproduction with synthetic commits or a local health endpoint. Remove repository URLs, credentials, private endpoint details, and proprietary source before posting.

For a change, explain the release failure it catches and add an integration test reproducing that behavior. Keep Git commands shell-free and health responses bounded. Unknown evidence must fail closed. Avoid dependencies unless their benefit justifies the extra maintenance burden.

Never weaken a check solely to make a test pass. Document intentional changes to exit codes or report fields. Keep security reports private using the process in SECURITY.md.

Maintainer: [John Arndt](https://github.com/johnarndt). Response times are best effort; this project does not promise a support SLA.
