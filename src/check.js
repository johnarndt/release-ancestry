import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { devNull } from 'node:os';

const execFileAsync = promisify(execFile);
const MAX_HEALTH_BYTES = 1024 * 1024;
const SHA = /^[a-f\d]{7,64}$/i;

export function errorReport(message) {
  return {
    ok: false,
    exitCode: 2,
    candidate: null,
    checks: [{ name: 'usage', status: 'error', message }],
    observations: [],
  };
}

function revision(value) {
  return typeof value === 'string' && value.length > 0 && !value.startsWith('-') && !value.includes('\0');
}

function safeHealthUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Health URLs must be absolute HTTPS URLs (HTTP is allowed only for loopback).');
  }
  if (url.username || url.password || /^[a-z][a-z\d+.-]*:\/\/[^/?#]*@/i.test(value) || url.search || url.hash || String(value).includes('?') || String(value).includes('#')) {
    throw new Error('Health URLs must not contain credentials, a query, or a fragment.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Health URLs require HTTPS; HTTP is allowed only for loopback.');
  }
  return url.href;
}

function validate(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Options must be an object.');
  const o = {
    repo: '.', candidate: 'HEAD', requiredRefs: [], liveShas: [], healthUrls: [],
    shaPath: 'sha', timeoutMs: 5000, allowDirty: false, requireMatchingLive: false,
    ...options,
  };
  if (typeof o.repo !== 'string' || !o.repo || o.repo.includes('\0')) throw new Error('Repository path must be a nonempty string.');
  if (!revision(o.candidate)) throw new Error('Candidate must be a nonempty revision that does not start with a dash.');
  for (const field of ['requiredRefs', 'liveShas', 'healthUrls']) {
    if (!Array.isArray(o[field])) throw new Error(`${field} must be an array.`);
  }
  if (!o.requiredRefs.every(revision)) throw new Error('Required refs must be nonempty revisions that do not start with a dash.');
  if (!o.liveShas.every(value => typeof value === 'string' && SHA.test(value))) throw new Error('Live SHAs must contain 7–64 hexadecimal characters.');
  if (o.requiredRefs.length + o.liveShas.length + o.healthUrls.length === 0) throw new Error('Provide at least one required ref, live SHA, or health URL.');
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 1 || o.timeoutMs > 2147483647) throw new Error('Timeout must be an integer from 1 to 2147483647 milliseconds.');
  if (typeof o.shaPath !== 'string' || !o.shaPath || o.shaPath.split('.').some(part => !part || /[\x00-\x20\x7f]/.test(part))) throw new Error('SHA path must contain nonempty dotted property names without whitespace.');
  if (typeof o.allowDirty !== 'boolean' || typeof o.requireMatchingLive !== 'boolean') throw new Error('Boolean options must be true or false.');
  if (o.requireMatchingLive && o.liveShas.length + o.healthUrls.length < 2) throw new Error('Matching live SHAs requires at least two live SHA or health URL inputs.');
  if (!o.healthUrls.every(value => typeof value === 'string')) throw new Error('Health URLs must be strings.');
  o.healthUrls = o.healthUrls.map(safeHealthUrl);
  return o;
}

async function git(repo, args) {
  const env = { ...process.env };
  // A caller may be inside a Git hook. Its inherited repository/index overrides
  // must not redirect --repo or hide changes, shallow history, or real parents.
  for (const key of [
    'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT', 'GIT_OBJECT_DIRECTORY', 'GIT_DIR', 'GIT_WORK_TREE',
    'GIT_IMPLICIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_REPLACE_REF_BASE',
    'GIT_PREFIX', 'GIT_SHALLOW_FILE', 'GIT_COMMON_DIR',
  ]) delete env[key];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_GRAFT_FILE: devNull,
    GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1',
  });
  const { stdout } = await execFileAsync('git', [
    '--no-replace-objects', '--no-lazy-fetch', '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false', '-C', repo, ...args,
  ], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env,
  });
  return stdout.trim();
}

async function resolveCommit(repo, ref) {
  const sha = await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(sha)) throw new Error('Cannot resolve commit.');
  return sha;
}

async function resolveLive(repo, sha) {
  const normalized = sha.toLowerCase();
  // Disambiguate object IDs directly so hex-looking refs cannot shadow a SHA.
  const full = await git(repo, ['rev-parse', `--disambiguate=${normalized}`]);
  if (!/^(?:[a-f\d]{40}|[a-f\d]{64})$/.test(full) || !full.startsWith(normalized)) throw new Error('Observed SHA is not an unambiguous local object ID.');
  if (await git(repo, ['cat-file', '-t', full]) !== 'commit') throw new Error('Observed SHA is not a commit.');
  return full;
}

async function fetchSha(url, shaPath, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal, redirect: 'manual',
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    });
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}; a 2xx response is required.`);
    if (Number(response.headers.get('content-length')) > MAX_HEALTH_BYTES) throw new Error('Health response exceeds 1 MiB.');
    if (!response.body) throw new Error('Health endpoint returned an empty body.');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_HEALTH_BYTES) throw new Error('Health response exceeds 1 MiB.');
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      throw new Error('Health response is not valid JSON.');
    }
    for (const key of shaPath.split('.')) {
      if (data === null || typeof data !== 'object' || !Object.prototype.hasOwnProperty.call(data, key)) {
        throw new Error('Health response does not contain the configured SHA property.');
      }
      data = data[key];
    }
    if (typeof data !== 'string' || !SHA.test(data)) throw new Error('Health SHA must contain 7–64 hexadecimal characters.');
    return data;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Health request timed out.');
    // Never echo response bodies, request headers, or network-library error details.
    if (error.message.startsWith('Health ')) throw error;
    throw new Error('Health request failed. Check connectivity and TLS configuration.');
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** Resolve and check local Git ancestry. This function never fetches, writes, or deploys. */
export async function check(options = {}) {
  let o;
  try {
    o = validate(options);
  } catch (error) {
    return errorReport(error.message);
  }
  const report = { ok: false, exitCode: 2, candidate: null, checks: [], observations: [] };
  const add = (name, status, message, details = {}) => report.checks.push({ name, status, message, ...details });
  const finish = () => {
    report.exitCode = report.checks.some(item => item.status === 'error') ? 2 : report.checks.some(item => item.status === 'fail') ? 1 : 0;
    report.ok = report.exitCode === 0;
    return report;
  };
  try {
    await git(o.repo, ['rev-parse', '--git-dir']);
    add('repository', 'pass', 'Git repository is accessible.');
  } catch {
    add('repository', 'error', 'Cannot access Git repository. Verify the path and install Git with --no-lazy-fetch support.');
    return finish();
  }
  try {
    report.candidate = await resolveCommit(o.repo, o.candidate);
    add('candidate', 'pass', 'Candidate resolved to a local commit.', { sha: report.candidate });
  } catch {
    add('candidate', 'error', 'Candidate does not resolve unambiguously to a local commit.');
    return finish();
  }
  try {
    const shallow = await git(o.repo, ['rev-parse', '--is-shallow-repository']);
    if (shallow !== 'true' && shallow !== 'false') throw new Error('Cannot determine history.');
    add('history', shallow === 'true' ? 'fail' : 'pass', shallow === 'true' ? 'Shallow history is incomplete. Fetch full history before checking.' : 'Repository history is not shallow.');
  } catch {
    add('history', 'error', 'Cannot determine whether repository history is shallow.');
  }
  if (o.allowDirty) {
    add('working-tree', 'pass', 'Working tree check explicitly skipped with allow-dirty.');
  } else {
    try {
      const sparse = await git(o.repo, ['config', '--bool', '--default=false', '--get', 'core.sparseCheckout']);
      const entries = await git(o.repo, ['ls-files', '--cached', '-v', '-z']);
      const hidden = entries.split('\0').some(entry => entry && (entry[0] === 'S' || /^[a-z]/.test(entry)));
      if (sparse === 'true' || hidden) {
        add('working-tree', 'fail', 'Sparse checkout or assume-unchanged/skip-worktree flags can hide tracked changes. Use a full checkout with these flags cleared, or explicitly allow-dirty.');
      } else {
        const dirty = await git(o.repo, ['status', '--porcelain=v1', '--untracked-files=normal', '--ignore-submodules=none']);
        add('working-tree', dirty ? 'fail' : 'pass', dirty ? 'Working tree has tracked changes or untracked files.' : 'Working tree is clean.');
      }
    } catch {
      add('working-tree', 'error', 'Cannot inspect working tree. Bare repositories require allow-dirty.');
    }
  }
  const ancestry = async (name, sha, details) => {
    try {
      await git(o.repo, ['merge-base', '--is-ancestor', sha, report.candidate]);
      add(name, 'pass', 'Candidate contains the required commit.', { ...details, sha });
    } catch (error) {
      if (error.code === 1) add(name, 'fail', 'Candidate does not contain the required commit.', { ...details, sha });
      else add(name, 'error', 'Cannot determine commit ancestry.', { ...details, sha });
    }
  };
  for (const ref of o.requiredRefs) {
    try {
      const sha = await resolveCommit(o.repo, ref);
      await ancestry('required-ref', sha, { ref });
    } catch {
      add('required-ref', 'error', 'Required ref does not resolve unambiguously to a local commit. Fetch the intended refs before checking.', { ref });
    }
  }
  const observe = async (sha, source) => {
    let full;
    try {
      full = await resolveLive(o.repo, sha);
    } catch {
      add('live-sha', 'error', 'Observed SHA does not resolve unambiguously to a local commit. Fetch its history before checking.', { source });
      return;
    }
    report.observations.push({ source, sha: full });
    await ancestry('live-sha', full, { source });
  };
  for (const sha of o.liveShas) await observe(sha, `sha:${sha.toLowerCase()}`);
  for (const url of o.healthUrls) {
    try {
      const sha = await fetchSha(url, o.shaPath, o.timeoutMs);
      add('health', 'pass', 'Health endpoint returned a valid SHA.', { source: url });
      await observe(sha, url);
    } catch (error) {
      add('health', 'error', error.message, { source: url });
    }
  }
  if (o.requireMatchingLive) {
    if (report.observations.length !== o.liveShas.length + o.healthUrls.length) {
      add('matching-live', 'error', 'Cannot compare live SHAs because at least one observation failed.');
    } else {
      const matches = new Set(report.observations.map(item => item.sha)).size === 1;
      add('matching-live', matches ? 'pass' : 'fail', matches ? 'All live observations resolve to the same commit.' : 'Live observations resolve to different commits.');
    }
  }
  return finish();
}
