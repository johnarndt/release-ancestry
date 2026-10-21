import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = await mkdtemp(join(tmpdir(), 'release-ancestry-demo-'));
const bin = fileURLToPath(new URL('../bin/release-ancestry.js', import.meta.url));
const git = (...args) => execFileSync('git', [
  '-C', repo, '-c', 'user.name=Demo Maintainer',
  '-c', 'user.email=demo@example.invalid', '-c', 'commit.gpgsign=false',
  ...args,
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function check(candidate, live, expected) {
  let output;
  let status = 0;
  try {
    output = execFileSync(process.execPath, [bin, 'check', '--repo', repo,
      '--candidate', candidate, '--live-sha', live, '--json'], { encoding: 'utf8' });
  } catch (error) {
    status = error.status;
    output = error.stdout;
  }
  assert.equal(status, expected);
  const report = JSON.parse(output);
  assert.equal(report.exitCode, expected);
  console.log(`${report.ok ? 'PASS' : 'BLOCKED'}: ${report.checks.find(item => item.name === 'live-sha').message}`);
}

try {
  git('init', '-b', 'main');
  git('commit', '--allow-empty', '-m', 'Shared base');
  git('checkout', '-b', 'candidate');
  git('commit', '--allow-empty', '-m', 'Candidate feature');
  git('checkout', 'main');
  git('commit', '--allow-empty', '-m', 'Production hotfix');
  const live = git('rev-parse', 'HEAD');
  console.log('1. A feature branch missing the production hotfix:');
  check('candidate', live, 1);
  git('checkout', 'candidate');
  git('merge', '--no-ff', 'main', '-m', 'Include production hotfix');
  console.log('2. The feature branch after merging the hotfix:');
  check('candidate', live, 0);
  console.log('Demo complete. No production endpoints were contacted.');
} finally {
  await rm(repo, { recursive: true, force: true });
}
