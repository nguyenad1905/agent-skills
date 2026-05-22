import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const COLLECT = join(HERE, '..', '..', '..', 'skills', 'vercel-optimize', 'scripts', 'collect-signals.mjs');

test('collect-signals: unsupported framework stops before Observability and usage calls', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'vo-framework-preflight-'));
  const bin = join(scratch, 'bin');
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(join(scratch, '.vercel'), { recursive: true });
    await writeFile(join(scratch, 'package.json'), JSON.stringify({
      dependencies: { hono: '^4.7.0' },
    }), 'utf-8');
    await writeFile(join(scratch, '.vercel', 'project.json'), JSON.stringify({
      projectId: 'prj_test',
      orgId: 'team_test',
    }), 'utf-8');
    const fakeVercel = join(bin, 'vercel');
    await writeFile(fakeVercel, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "53.0.0"
  exit 0
fi
if [ "$1" = "whoami" ]; then
  echo "test-user"
  exit 0
fi
if [ "$1" = "teams" ] && [ "$2" = "list" ]; then
  echo '{"teams":[{"id":"team_test","slug":"test-team"}]}'
  exit 0
fi
echo "unexpected vercel call: $*" >&2
exit 66
`, 'utf-8');
    await chmod(fakeVercel, 0o755);

    const { stdout, stderr } = await exec('node', [COLLECT], {
      cwd: scratch,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERCEL_PROJECT_ID: '', VERCEL_ORG_ID: '' },
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = JSON.parse(stdout);
    assert.equal(out.stack.framework, 'hono');
    assert.equal(out.frameworkSupportBlocker, 'unsupported_framework');
    assert.equal(out.observabilityPlus, null);
    assert.equal(out.usageError, 'NOT_COLLECTED_UNSUPPORTED_FRAMEWORK');
    assert.match(stderr, /framework=hono@4\.7\.0 support=unsupported/);
    assert.doesNotMatch(stderr, /unexpected vercel call/);
    assert.doesNotMatch(stderr, /checking Observability Plus configuration/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('collect-signals: ambiguous multi-project link stops before framework and metric calls', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'vo-scope-preflight-'));
  const bin = join(scratch, 'bin');
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(join(scratch, '.vercel'), { recursive: true });
    await writeFile(join(scratch, 'package.json'), JSON.stringify({
      dependencies: { next: '^16.1.6' },
    }), 'utf-8');
    await writeFile(join(scratch, '.vercel', 'repo.json'), JSON.stringify({
      projects: [
        { id: 'prj_web', orgId: 'team_test', name: 'web' },
        { id: 'prj_docs', orgId: 'team_test', name: 'docs' },
      ],
    }), 'utf-8');
    const fakeVercel = join(bin, 'vercel');
    await writeFile(fakeVercel, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "53.0.0"
  exit 0
fi
if [ "$1" = "whoami" ]; then
  echo "test-user"
  exit 0
fi
echo "unexpected vercel call: $*" >&2
exit 66
`, 'utf-8');
    await chmod(fakeVercel, 0o755);

    const { stdout, stderr } = await exec('node', [COLLECT], {
      cwd: scratch,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERCEL_PROJECT_ID: '', VERCEL_ORG_ID: '' },
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = JSON.parse(stdout);
    assert.equal(out.scopeBlocker, 'ambiguous_project');
    assert.equal(out.usageError, 'NOT_COLLECTED_SCOPE_BLOCKED');
    assert.equal(out.scopeChoices.length, 2);
    assert.match(stderr, /scope resolution blocked: ambiguous_project/);
    assert.doesNotMatch(stderr, /unexpected vercel call/);
    assert.doesNotMatch(stderr, /checking framework support/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test('collect-signals: repo-linked project rootDirectory drives framework detection', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'vo-repo-root-framework-'));
  const bin = join(scratch, 'bin');
  try {
    await mkdir(bin, { recursive: true });
    await mkdir(join(scratch, '.vercel'), { recursive: true });
    await mkdir(join(scratch, 'apps', 'web'), { recursive: true });
    await writeFile(join(scratch, 'package.json'), JSON.stringify({
      private: true,
      workspaces: ['apps/*'],
    }), 'utf-8');
    await writeFile(join(scratch, 'apps', 'web', 'package.json'), JSON.stringify({
      dependencies: { next: '^16.1.6' },
    }), 'utf-8');
    await writeFile(join(scratch, '.vercel', 'repo.json'), JSON.stringify({
      orgId: 'team_test',
      projects: {
        'apps/web': 'prj_web',
        'apps/docs': 'prj_docs',
      },
    }), 'utf-8');
    const fakeVercel = join(bin, 'vercel');
    await writeFile(fakeVercel, `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "53.0.0"
  exit 0
fi
if [ "$1" = "whoami" ]; then
  echo "test-user"
  exit 0
fi
if [ "$1" = "teams" ] && [ "$2" = "list" ]; then
  echo '{"teams":[{"id":"team_test","slug":"test-team"}]}'
  exit 0
fi
if [ "$1" = "api" ]; then
  echo '{"error":{"code":"not_found","message":"Observability Plus is not enabled"}}'
  exit 1
fi
echo "unexpected vercel call: $*" >&2
exit 66
`, 'utf-8');
    await chmod(fakeVercel, 0o755);

    const { stdout, stderr } = await exec('node', [COLLECT, 'prj_web'], {
      cwd: scratch,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VERCEL_PROJECT_ID: '', VERCEL_ORG_ID: '' },
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = JSON.parse(stdout);
    assert.equal(out.scopeBlocker, null);
    assert.equal(out.stack.framework, 'next');
    assert.equal(out.stack.rootDirectory, 'apps/web');
    assert.equal(out.observabilityPlusBlocker, 'oplus_not_enabled');
    assert.match(stderr, /framework=next@16\.1\.6 support=supported/);
    assert.doesNotMatch(stderr, /unexpected vercel call/);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
