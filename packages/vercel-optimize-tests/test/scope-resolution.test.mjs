import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readProjectJson,
  resolveProjectId,
} from '../../../skills/vercel-optimize/lib/vercel.mjs';

async function withScratch(fn) {
  const scratch = await mkdtemp(join(tmpdir(), 'vo-scope-'));
  try {
    await mkdir(join(scratch, '.vercel'), { recursive: true });
    return await fn(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function withEnv(env, fn) {
  const prev = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    if (env[key] == null) delete process.env[key];
    else process.env[key] = env[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(env)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

async function writeRepoJson(cwd, projects, extra = {}) {
  await writeFile(join(cwd, '.vercel', 'repo.json'), JSON.stringify({ ...extra, projects }), 'utf-8');
}

async function writeProjectJson(cwd, project) {
  await writeFile(join(cwd, '.vercel', 'project.json'), JSON.stringify(project), 'utf-8');
}

test('resolveProjectId: blocks multi-project repo.json without an explicit project', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_web', orgId: 'team_a', name: 'web' },
    { id: 'prj_docs', orgId: 'team_a', name: 'docs' },
  ]);

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'ambiguous_project');
  assert.equal(r.choices.length, 2);
}));

test('resolveProjectId: explicit project selects the matching repo.json project and team', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_web', orgId: 'team_a', name: 'web' },
    { id: 'prj_docs', orgId: 'team_b', name: 'docs', rootDirectory: 'apps/docs' },
  ]);

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId('prj_docs', cwd));

  assert.equal(r.ok, true);
  assert.equal(r.projectId, 'prj_docs');
  assert.equal(r.orgId, 'team_b');
  assert.equal(r.rootDirectory, 'apps/docs');
}));

test('resolveProjectId: repo.json project map inherits top-level team scope', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, {
    'apps/web': 'prj_web',
    'apps/docs': { id: 'prj_docs', name: 'docs' },
  }, { orgId: 'team_a', teamSlug: 'acme' });

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId('prj_docs', cwd));

  assert.equal(r.ok, true);
  assert.equal(r.projectId, 'prj_docs');
  assert.equal(r.orgId, 'team_a');
  assert.equal(r.orgSlug, 'acme');
  assert.equal(r.rootDirectory, 'apps/docs');
}));

test('resolveProjectId: repo.json project array inherits top-level team scope', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_docs', name: 'docs', rootDirectory: 'apps/docs' },
  ], { orgId: 'team_a', teamSlug: 'acme' });

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, true);
  assert.equal(r.projectId, 'prj_docs');
  assert.equal(r.orgId, 'team_a');
  assert.equal(r.orgSlug, 'acme');
}));

test('resolveProjectId: generic repo.json slug is not treated as a team slug', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_docs', orgId: 'team_b', slug: 'docs-project-slug' },
  ]);

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, true);
  assert.equal(r.orgId, 'team_b');
  assert.equal(r.orgSlug, null);
}));

test('resolveProjectId: explicit project mismatch blocks instead of mixing API and metrics scope', async () => withScratch(async (cwd) => {
  await writeProjectJson(cwd, { projectId: 'prj_linked', orgId: 'team_a' });

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId('prj_requested', cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'project_link_mismatch');
  assert.equal(r.choices[0].projectId, 'prj_linked');
}));

test('resolveProjectId: env project ID must match the linked project', async () => withScratch(async (cwd) => {
  await writeProjectJson(cwd, { projectId: 'prj_linked', orgId: 'team_a' });

  const r = await withEnv({ VERCEL_PROJECT_ID: 'prj_other', VERCEL_ORG_ID: null }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'project_link_mismatch');
}));

test('resolveProjectId: VERCEL_ORG_ID conflict with linked team blocks collection', async () => withScratch(async (cwd) => {
  await writeProjectJson(cwd, { projectId: 'prj_linked', orgId: 'team_a' });

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: 'team_b' }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'team_scope_conflict');
}));

test('resolveProjectId: missing linked team blocks even when VERCEL_ORG_ID is set', async () => withScratch(async (cwd) => {
  await writeProjectJson(cwd, { projectId: 'prj_linked' });

  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: 'team_from_env' }, () => resolveProjectId(null, cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'team_scope_missing');
  assert.match(r.detail, /cannot verify/);
}));

test('resolveProjectId: unlinked cwd blocks even when project ID was supplied', async () => withScratch(async (cwd) => {
  const r = await withEnv({ VERCEL_PROJECT_ID: null, VERCEL_ORG_ID: null }, () => resolveProjectId('prj_requested', cwd));

  assert.equal(r.ok, false);
  assert.equal(r.blocker, 'not_linked');
  assert.match(r.detail, /project ID alone is not enough/);
}));

test('readProjectJson: multi-project repo returns exact match when projectId is supplied', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_web', orgId: 'team_a', name: 'web' },
    { id: 'prj_docs', orgId: 'team_b', name: 'docs' },
  ]);

  const r = await readProjectJson(cwd, { projectId: 'prj_docs' });

  assert.equal(r.projectId, 'prj_docs');
  assert.equal(r.orgId, 'team_b');
}));

test('readProjectJson: multi-project repo without projectId is intentionally ambiguous', async () => withScratch(async (cwd) => {
  await writeRepoJson(cwd, [
    { id: 'prj_web', orgId: 'team_a', name: 'web' },
    { id: 'prj_docs', orgId: 'team_b', name: 'docs' },
  ]);

  assert.equal(await readProjectJson(cwd), null);
}));
