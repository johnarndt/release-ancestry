import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../bin/release-ancestry.js', import.meta.url));
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function fixture(t) {
  const repo = await mkdtemp(path.join(tmpdir(), 'release-ancestry-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Integration Test');
  git(repo, 'config', 'user.email', 'integration@example.invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repo, 'app.txt'), 'base\n');
  git(repo, 'add', 'app.txt');
  git(repo, 'commit', '--quiet', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  await writeFile(path.join(repo, 'app.txt'), 'release\n');
  git(repo, 'commit', '--quiet', '-am', 'release');
  const release = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'tag', 'release');
  await writeFile(path.join(repo, 'app.txt'), 'candidate\n');
  git(repo, 'commit', '--quiet', '-am', 'candidate');
  const candidate = git(repo, 'rev-parse', 'HEAD');
  return { repo, base, release, candidate };
}

function run(args, { timeout = 10_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...gitEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI did not finish within ${timeout}ms`));
    }, timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function check(repo, args = [], runOptions = {}) {
  const result = await run(['check', '--repo', repo, ...args, '--json'], runOptions);
  assert.equal(result.signal, null, `CLI terminated by signal: ${result.stderr}`);
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    assert.fail(`Expected one JSON document on stdout. stdout=${result.stdout} stderr=${result.stderr}`);
  }
  assert.equal(data.exitCode, result.code);
  assert.equal(data.ok, result.code === 0);
  assert.ok(Array.isArray(data.checks));
  return { ...result, data };
}

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve, reject) => {
    instance.once('error', reject);
    instance.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    instance.closeAllConnections();
    await new Promise((resolve) => instance.close(resolve));
  });
  return `http://127.0.0.1:${instance.address().port}`;
}

function json(res, data, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

test('help and version work without a repository', async () => {
  const help = await run(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /release-ancestry/);
  assert.match(help.stdout, /--health-url/);
  const version = await run(['--version']);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /\d+\.\d+\.\d+/);
});

test('a clean candidate containing each named required commit is safe', async (t) => {
  const f = await fixture(t);
  const result = await check(f.repo, ['--required-ref', 'release', '--required-ref', f.base]);
  assert.equal(result.code, 0);
  assert.equal(result.data.candidate, f.candidate);
});

test('a supplied candidate is checked instead of the checked-out HEAD', async (t) => {
  const f = await fixture(t);
  const result = await check(f.repo, ['--candidate', f.base, '--required-ref', 'release']);
  assert.equal(result.code, 1);
  assert.equal(result.data.candidate, f.base);
});

test('a candidate that omits an unrelated required branch is unsafe', async (t) => {
  const f = await fixture(t);
  git(f.repo, 'checkout', '--quiet', '-b', 'divergent', f.base);
  await writeFile(path.join(f.repo, 'other.txt'), 'another history\n');
  git(f.repo, 'add', 'other.txt');
  git(f.repo, 'commit', '--quiet', '-m', 'divergent release');
  git(f.repo, 'checkout', '--quiet', 'main');
  const result = await check(f.repo, ['--required-ref', 'divergent']);
  assert.equal(result.code, 1);
});

test('Git replacement refs cannot fabricate ancestry for a stale candidate', async (t) => {
  const f = await fixture(t);
  git(f.repo, 'replace', f.base, f.candidate);
  const result = await check(f.repo, ['--candidate', f.base, '--live-sha', f.release]);
  assert.equal(result.code, 1);
});

test('legacy Git grafts cannot fabricate ancestry for a stale candidate', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, '.git', 'info', 'grafts'), `${f.base} ${f.release}\n`);
  const result = await check(f.repo, ['--candidate', f.base, '--live-sha', f.release]);
  assert.equal(result.code, 1);
});

test('Git environment overrides cannot substitute a different repository', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  await writeFile(path.join(other.repo, 'other-repository.txt'), 'different repository\n');
  git(other.repo, 'add', 'other-repository.txt');
  git(other.repo, 'commit', '--quiet', '-m', 'different repository');
  const result = await check(f.repo, ['--required-ref', 'release'], {
    env: { GIT_DIR: path.join(other.repo, '.git'), GIT_WORK_TREE: other.repo },
  });
  assert.equal(result.code, 0);
  assert.equal(result.data.candidate, f.candidate);
});

test('dirty tracked files and untracked files are refused unless explicitly allowed', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'app.txt'), 'local edit\n');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
  git(f.repo, 'restore', 'app.txt');
  await writeFile(path.join(f.repo, 'untracked.txt'), 'not committed\n');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
  assert.equal((await check(f.repo, ['--required-ref', 'release', '--allow-dirty'])).code, 0);
});

test('staged changes are also refused', async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.repo, 'app.txt'), 'staged edit\n');
  git(f.repo, 'add', 'app.txt');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
});

test('assume-unchanged index flags are refused unless dirty checks are explicitly skipped', async (t) => {
  const f = await fixture(t);
  git(f.repo, 'update-index', '--assume-unchanged', 'app.txt');
  await writeFile(path.join(f.repo, 'app.txt'), 'hidden by assume-unchanged\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), '', 'fixture must hide its modification from normal status');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
  assert.equal((await check(f.repo, ['--required-ref', 'release', '--allow-dirty'])).code, 0);
});

test('skip-worktree index flags are refused unless dirty checks are explicitly skipped', async (t) => {
  const f = await fixture(t);
  git(f.repo, 'update-index', '--skip-worktree', 'app.txt');
  await writeFile(path.join(f.repo, 'app.txt'), 'hidden by skip-worktree\n');
  assert.equal(git(f.repo, 'status', '--porcelain'), '', 'fixture must hide its modification from normal status');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
  assert.equal((await check(f.repo, ['--required-ref', 'release', '--allow-dirty'])).code, 0);
});

test('submodule ignore configuration cannot hide an edited submodule', async (t) => {
  const f = await fixture(t);
  const child = await fixture(t);
  git(f.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '--quiet', child.repo, 'module');
  git(f.repo, 'commit', '--quiet', '-am', 'add submodule');
  git(f.repo, 'config', 'submodule.module.ignore', 'all');
  await writeFile(path.join(f.repo, 'module', 'app.txt'), 'edited submodule\n');
  assert.equal((await check(f.repo, ['--required-ref', 'release'])).code, 1);
});

test('a shallow clone is refused even if the visible commit matches', async (t) => {
  const f = await fixture(t);
  const cloneParent = await mkdtemp(path.join(tmpdir(), 'release-ancestry-shallow-'));
  t.after(() => rm(cloneParent, { recursive: true, force: true }));
  const clone = path.join(cloneParent, 'repo');
  git(cloneParent, 'clone', '--quiet', '--depth=1', pathToFileURL(f.repo).href, clone);
  assert.equal((await check(clone, ['--live-sha', f.candidate])).code, 1);
});

test('full and abbreviated live SHAs resolve to commits', async (t) => {
  const f = await fixture(t);
  const result = await check(f.repo, ['--live-sha', f.base, '--live-sha', f.release.slice(0, 8)]);
  assert.equal(result.code, 0);
});

test('a hex-looking branch cannot masquerade as an observed live SHA', async (t) => {
  const f = await fixture(t);
  const fakeSha = 'deadbeef';
  git(f.repo, 'branch', fakeSha, 'HEAD');
  assert.equal((await check(f.repo, ['--live-sha', fakeSha])).code, 2);
});

test('an abbreviated live object ID is resolved independently of a same-named branch', async (t) => {
  const f = await fixture(t);
  const abbreviation = f.release.slice(0, 8);
  git(f.repo, 'branch', abbreviation, f.candidate);
  const result = await check(f.repo, ['--candidate', f.release, '--live-sha', abbreviation]);
  assert.equal(result.code, 0);
  assert.equal(result.data.observations[0].sha, f.release);
});

test('live object IDs must identify commits rather than blobs or annotated tags', async (t) => {
  const f = await fixture(t);
  const blob = git(f.repo, 'rev-parse', 'HEAD:app.txt');
  git(f.repo, 'tag', '--annotate', 'annotated-release', '-m', 'Release metadata', f.release);
  const tag = git(f.repo, 'rev-parse', 'annotated-release');
  assert.equal((await check(f.repo, ['--live-sha', blob])).code, 2);
  assert.equal((await check(f.repo, ['--live-sha', tag])).code, 2);
  assert.equal((await check(f.repo, ['--required-ref', 'annotated-release'])).code, 0);
});

test('observed live commits must all be ancestors of the candidate', async (t) => {
  const f = await fixture(t);
  assert.equal((await check(f.repo, ['--candidate', f.base, '--live-sha', f.release])).code, 1);
});

test('different live commits are allowed by default and refused when matching is required', async (t) => {
  const f = await fixture(t);
  const args = ['--live-sha', f.base, '--live-sha', f.release];
  assert.equal((await check(f.repo, args)).code, 0);
  assert.equal((await check(f.repo, [...args, '--require-matching-live'])).code, 1);
  assert.equal((await check(f.repo, ['--live-sha', f.release, '--live-sha', f.release.slice(0, 8), '--require-matching-live'])).code, 0);
});

test('a missing source is a usage error', async (t) => {
  const f = await fixture(t);
  assert.equal((await check(f.repo)).code, 2);
});

test('missing refs, malformed SHAs, dash-prefixed refs, and unknown options are errors', async (t) => {
  const f = await fixture(t);
  const cases = [
    ['--required-ref', 'not-a-real-ref'],
    ['--required-ref', '--all'],
    ['--candidate', '--all', '--required-ref', 'release'],
    ['--live-sha', 'main'],
    ['--live-sha', 'xyz00000'],
    ['--required-ref', 'release', '--not-an-option'],
    ['--required-ref'],
    ['--required-ref', 'release', '--timeout-ms', '0'],
    ['--required-ref', 'release', '--timeout-ms', '-1'],
    ['--required-ref', 'release', '--timeout-ms', 'banana'],
    ['--required-ref', 'release', '--timeout-ms', '10ms'],
  ];
  for (const args of cases) {
    const result = await check(f.repo, args);
    assert.equal(result.code, 2, `Expected invalid usage: ${args.join(' ')}`);
  }
});

test('a non-repository path is an environment error', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'release-ancestry-no-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal((await check(directory, ['--live-sha', 'deadbeef'])).code, 2);
});

test('health JSON SHA is accepted and normalized', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (_req, res) => json(res, { sha: f.release.slice(0, 8) }));
  const result = await check(f.repo, ['--health-url', `${url}/api/health`]);
  assert.equal(result.code, 0);
  assert.ok(result.data.observations.some((observation) => observation.sha === f.release));
});

test('a nested SHA path and multiple health endpoints are supported', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (req, res) => json(res, { deployment: { commit: req.url === '/one' ? f.release : f.base } }));
  assert.equal((await check(f.repo, ['--health-url', `${url}/one`, '--health-url', `${url}/two`, '--sha-path', 'deployment.commit'])).code, 0);
  assert.equal((await check(f.repo, ['--health-url', `${url}/one`, '--health-url', `${url}/two`, '--sha-path', 'deployment.commit', '--require-matching-live'])).code, 1);
});

test('matching live checks compare explicit SHAs and health observations together', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (_req, res) => json(res, { sha: f.release.slice(0, 8) }));
  assert.equal((await check(f.repo, ['--live-sha', f.release, '--health-url', url, '--require-matching-live'])).code, 0);
  assert.equal((await check(f.repo, ['--live-sha', f.base, '--health-url', url, '--require-matching-live'])).code, 1);
});

test('one failed health observation prevents success even when other sources pass', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (req, res) => json(res, { sha: f.release }, req.url === '/good' ? 200 : 503));
  const result = await check(f.repo, ['--required-ref', 'release', '--health-url', `${url}/good`, '--health-url', `${url}/unavailable`]);
  assert.equal(result.code, 2);
  assert.equal(result.data.observations.length, 1);
});

test('a health commit ahead of the candidate is unsafe', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (_req, res) => json(res, { sha: f.candidate }));
  assert.equal((await check(f.repo, ['--candidate', f.base, '--health-url', url])).code, 1);
});

test('HTTP errors do not expose the response body', async (t) => {
  const f = await fixture(t);
  const secret = 'PRIVATE_BACKEND_ERROR_SECRET_47293';
  const url = await server(t, (_req, res) => json(res, { error: secret }, 503));
  const result = await check(f.repo, ['--health-url', url]);
  assert.equal(result.code, 2);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('malformed JSON and missing or non-string SHA fields are failed observations', async (t) => {
  const f = await fixture(t);
  const secret = 'PRIVATE_MALFORMED_BODY_SECRET_52321';
  const url = await server(t, (req, res) => {
    if (req.url === '/malformed') {
      res.end(`not json: ${secret}`);
    } else if (req.url === '/missing') {
      json(res, { other: f.release });
    } else if (req.url === '/object') {
      json(res, { sha: { secret } });
    } else {
      json(res, { sha: 'main' });
    }
  });
  for (const route of ['/malformed', '/missing', '/object', '/branch']) {
    const result = await check(f.repo, ['--health-url', url + route]);
    assert.equal(result.code, 2, route);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test('redirects are refused without following the Location header or printing it', async (t) => {
  const f = await fixture(t);
  let followed = 0;
  const secret = 'PRIVATE_REDIRECT_SECRET_18336';
  const url = await server(t, (req, res) => {
    if (req.url.startsWith('/target')) {
      followed += 1;
      json(res, { sha: f.release });
    } else {
      res.writeHead(302, { Location: `/target?token=${secret}` });
      res.end();
    }
  });
  const result = await check(f.repo, ['--health-url', url]);
  assert.equal(result.code, 2);
  assert.equal(followed, 0);
  assert.ok(!(result.stdout + result.stderr).includes(secret));
});

test('the timeout covers both response headers and a stalled body', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (req, res) => {
    if (req.url === '/body') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"sha":');
    }
    // Deliberately leave both requests open; cleanup forcibly closes sockets.
  });
  for (const route of ['/headers', '/body']) {
    const started = Date.now();
    const result = await check(f.repo, ['--health-url', url + route, '--timeout-ms', '100']);
    assert.equal(result.code, 2);
    assert.ok(Date.now() - started < 5000, 'timeout must terminate the whole observation promptly');
  }
});

test('oversized declared and streamed health responses are refused', async (t) => {
  const f = await fixture(t);
  const url = await server(t, (req, res) => {
    if (req.url === '/declared') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': 2 * 1024 * 1024 });
      res.end('{}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' });
      res.write('{"padding":"');
      res.write('x'.repeat(1024 * 1024));
      res.end(`","sha":"${f.release}"}`);
    }
  });
  for (const route of ['/declared', '/streamed']) {
    assert.equal((await check(f.repo, ['--health-url', url + route, '--timeout-ms', '500'])).code, 2);
  }
});

test('invalid health URL schemes and credential-bearing URLs are rejected without leaking secrets', async (t) => {
  const f = await fixture(t);
  const secret = 'PRIVATE_URL_SECRET_35219';
  const urls = [
    'http://example.com/api/health',
    'file:///etc/passwd',
    `https://user:${secret}@example.com/health`,
    `https://example.com/health?token=${secret}`,
    `https://example.com/health#${secret}`,
  ];
  for (const url of urls) {
    const result = await check(f.repo, ['--health-url', url]);
    assert.equal(result.code, 2);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
});

test('loopback URL validation rejects authentication, query strings and fragments before requests', async (t) => {
  const f = await fixture(t);
  let requests = 0;
  const url = await server(t, (_req, res) => { requests += 1; json(res, { sha: f.release }); });
  const secret = 'PRIVATE_LOCAL_SECRET_48112';
  for (const address of [`${url}/health?token=${secret}`, `${url}/health#${secret}`, url.replace('://', `://user:${secret}@`)]) {
    const result = await check(f.repo, ['--health-url', address]);
    assert.equal(result.code, 2);
    assert.ok(!(result.stdout + result.stderr).includes(secret));
  }
  assert.equal(requests, 0);
});

test('connection failures produce a failed observation', async (t) => {
  const f = await fixture(t);
  const instance = http.createServer();
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  const port = instance.address().port;
  await new Promise((resolve) => instance.close(resolve));
  assert.equal((await check(f.repo, ['--health-url', `http://127.0.0.1:${port}`, '--timeout-ms', '300'])).code, 2);
});
