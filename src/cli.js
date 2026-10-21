import { check, errorReport } from './check.js';

export const VERSION = '0.1.0';
export const HELP = `release-ancestry ${VERSION}
Check that a candidate Git commit contains existing release commits.

Usage:
  release-ancestry check [options]
  release-ancestry --help
  release-ancestry --version

Inputs (at least one is required; repeat to check multiple):
  --required-ref REF          Required local ref, e.g. origin/main
  --live-sha SHA              Observed live commit, 7–64 hex characters
  --health-url URL            JSON health endpoint (HTTPS; loopback HTTP allowed)

Options:
  --repo PATH                Git repository directory (default: .)
  --candidate REF            Commit to check (default: HEAD)
  --sha-path PATH             Dotted JSON property path (default: sha)
  --timeout-ms N              Health timeout including response body (default: 5000)
  --allow-dirty               Explicitly skip the working tree cleanliness check
  --require-matching-live     Require two or more live inputs to resolve to one commit
  --json                     Emit one JSON report, including errors
  --help, -h                 Show help
  --version, -v              Show version

Exit codes: 0 pass; 1 known safety failure; 2 invalid usage or unchecked input.
Fetch intended refs and full history first. This tool never fetches or deploys.
`;

function parse(args) {
  const options = { requiredRefs: [], liveShas: [], healthUrls: [] };
  if (!args.length) throw new Error('Expected the check command. Use --help for usage.');
  if (args[0] !== 'check') throw new Error('Unknown command. Use check or --help.');
  const valueOptions = new Map([
    ['--repo', 'repo'], ['--candidate', 'candidate'], ['--required-ref', 'requiredRefs'],
    ['--live-sha', 'liveShas'], ['--health-url', 'healthUrls'], ['--sha-path', 'shaPath'],
    ['--timeout-ms', 'timeoutMs'],
  ]);
  const seen = new Set();
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') continue;
    if (arg === '--allow-dirty' || arg === '--require-matching-live') {
      options[arg === '--allow-dirty' ? 'allowDirty' : 'requireMatchingLive'] = true;
      continue;
    }
    const key = valueOptions.get(arg);
    if (!key) throw new Error('Unknown option or positional argument. Use --help for usage.');
    const value = args[++index];
    if (!value || value.startsWith('-')) throw new Error(`${arg} requires a value that does not start with a dash.`);
    if (Array.isArray(options[key])) options[key].push(value);
    else {
      if (seen.has(key)) throw new Error(`${arg} may be specified only once.`);
      seen.add(key);
      if (key === 'timeoutMs') {
        if (!/^\d+$/.test(value)) throw new Error('Timeout must be a positive integer in milliseconds.');
        options[key] = Number(value);
      } else options[key] = value;
    }
  }
  return options;
}

export async function main(args, output = process.stdout) {
  const json = args.includes('--json');
  if ((args.length === 1 && ['--help', '-h'].includes(args[0])) || (args.length === 2 && args[0] === 'check' && ['--help', '-h'].includes(args[1]))) {
    output.write(HELP);
    return 0;
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    output.write(`${VERSION}\n`);
    return 0;
  }
  let report;
  let options;
  try {
    options = parse(args);
  } catch (error) {
    report = errorReport(error.message);
  }
  if (!report) {
    try {
      report = await check(options);
    } catch {
      report = errorReport('Unexpected failure while checking. Verify the repository and inputs.');
    }
  }
  if (json) output.write(`${JSON.stringify(report, null, 2)}\n`);
  else {
    output.write(`Release ancestry: ${report.ok ? 'PASS' : report.exitCode === 1 ? 'FAIL' : 'ERROR'}\n`);
    if (report.candidate) output.write(`Candidate: ${report.candidate}\n`);
    for (const item of report.checks) {
      const context = item.source ?? item.ref;
      output.write(`  ${item.status.toUpperCase()}: ${item.message}${context ? ` (${JSON.stringify(context)})` : ''}\n`);
    }
  }
  return report.exitCode;
}
