# Roadmap

## Available in v0.1.0

- Git ancestry checks for required refs and live commit identifiers.
- JSON health endpoint observations with deadlines and size bounds.
- Multiple live sources and optional same-commit enforcement.
- Clean-tree checks and shallow-history detection.
- Human-readable and JSON reports, local integration tests, and a reproducible demo.

## Candidates for future releases

These are proposals, not committed delivery dates:

- Different JSON field paths per service in a validated configuration file.
- A versioned report schema and compatibility tests for downstream consumers.
- Health observation adapters for deployment platforms that do not expose commit IDs.
- Windows CI coverage and additional unusual Git history fixtures.
- A reusable GitHub Action after the CLI interface has stabilized.

Early feedback should establish which deployment failures matter most. Please open an issue with a reproducible example before adding infrastructure-specific behavior.
