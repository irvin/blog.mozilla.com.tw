import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BUILD_DIR = path.join(ROOT, 'blog');
const DEFAULT_WORKTREE = path.join('/private/tmp', `${path.basename(ROOT)}-gh-pages-deploy`);

const args = parseArgs(process.argv.slice(2));
const explicitWorktree = args.worktree || process.env.GH_PAGES_WORKTREE || '';
let worktreePath = path.resolve(explicitWorktree || existingGhPagesWorktree() || DEFAULT_WORKTREE);
const shouldPush = !args.noPush;
const commitMessage = args.message || 'Publish static site';

async function main() {
  run('npm', ['run', 'site:build'], ROOT);
  await ensureWorktree();
  await syncBuild();
  run('git', ['add', '.'], worktreePath);

  const status = run('git', ['status', '--porcelain'], worktreePath, { capture: true });
  if (!status.trim()) {
    console.log('gh-pages worktree has no changes to commit.');
  } else {
    run('git', ['commit', '-m', commitMessage, '-m', 'Made-with: Codex'], worktreePath);
  }

  if (shouldPush) {
    run('git', ['push', 'origin', 'gh-pages'], worktreePath);
  } else {
    console.log('Skipped push because --no-push was provided.');
  }
}

async function ensureWorktree() {
  if (await isGitWorktree(worktreePath)) {
    return;
  }
  if (await exists(worktreePath)) {
    throw new Error(`${worktreePath} exists but is not a git worktree. Remove it or pass --worktree <path>.`);
  }

  const hasLocalBranch = commandOk('git', ['show-ref', '--verify', '--quiet', 'refs/heads/gh-pages'], ROOT);
  if (!hasLocalBranch && commandOk('git', ['ls-remote', '--exit-code', '--heads', 'origin', 'gh-pages'], ROOT)) {
    run('git', ['fetch', 'origin', 'gh-pages:gh-pages'], ROOT);
  }

  if (commandOk('git', ['show-ref', '--verify', '--quiet', 'refs/heads/gh-pages'], ROOT)) {
    run('git', ['worktree', 'add', worktreePath, 'gh-pages'], ROOT);
  } else {
    run('git', ['worktree', 'add', '--orphan', '-b', 'gh-pages', worktreePath], ROOT);
  }
}

async function syncBuild() {
  await mkdir(worktreePath, { recursive: true });
  for (const entry of await readdir(worktreePath)) {
    if (entry === '.git') {
      continue;
    }
    await rm(path.join(worktreePath, entry), { recursive: true, force: true });
  }

  for (const entry of await readdir(BUILD_DIR)) {
    if (entry === '.DS_Store') {
      continue;
    }
    await cp(path.join(BUILD_DIR, entry), path.join(worktreePath, entry), { recursive: true });
  }
}

async function isGitWorktree(target) {
  return exists(path.join(target, '.git'));
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, commandArgs, cwd, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} failed with exit code ${result.status}`);
  }
  return result.stdout || '';
}

function commandOk(command, commandArgs, cwd) {
  const result = spawnSync(command, commandArgs, { cwd, stdio: 'ignore' });
  return result.status === 0;
}

function existingGhPagesWorktree() {
  const result = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.status !== 0) {
    return '';
  }

  const records = result.stdout.trim().split(/\n\n+/);
  for (const record of records) {
    const lines = record.split('\n');
    const worktree = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length);
    if (worktree && branch === 'refs/heads/gh-pages') {
      return worktree;
    }
  }
  return '';
}

function parseArgs(values) {
  const parsed = {};
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === '--no-push') {
      parsed.noPush = true;
    } else if (value === '--worktree') {
      parsed.worktree = values[++i];
    } else if (value === '--message') {
      parsed.message = values[++i];
    }
  }
  return parsed;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
