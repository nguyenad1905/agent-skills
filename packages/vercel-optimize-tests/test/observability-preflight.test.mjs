import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyObservabilityPlusConfiguration } from '../../../skills/vercel-optimize/lib/vercel.mjs';

test('classifyObservabilityPlusConfiguration: enabled when configuration endpoint returns disabled-project list without this project', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: true,
    data: {
      disabledProjects: [{ id: 'prj_other', name: 'other', disabledAt: 123 }],
    },
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, true);
  assert.equal(r.blocker, null);
});

test('classifyObservabilityPlusConfiguration: project_disabled when this project is excluded', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: true,
    data: {
      disabledProjects: [{ id: 'prj_target', name: 'site', disabledAt: 123 }],
    },
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'project_disabled');
  assert.deepEqual(r.disabledProject, {
    id: 'prj_target',
    name: 'site',
    disabledAt: 123,
  });
});

test('classifyObservabilityPlusConfiguration: oplus_not_enabled on public API not-enabled response', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'not_found',
    message: 'Observability Plus is not enabled',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'oplus_not_enabled');
  assert.match(r.detail, /^The metrics API reported/);
  assert.match(r.detail, /not enabled/);
  assert.match(r.detail, /current Vercel scope/);
});

test('classifyObservabilityPlusConfiguration: oplus_not_enabled on CLI OPLUS_REQUIRED response', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'OPLUS_REQUIRED',
    stderr: 'Error: Observability Plus is not enabled (404)',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'oplus_not_enabled');
});

test('classifyObservabilityPlusConfiguration: project_disabled on project-level not-enabled response', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'OPLUS_REQUIRED',
    stderr: 'Observability Plus is not enabled for this project',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'project_disabled');
  assert.match(r.detail, /not enabled for this project/);
});

test('classifyObservabilityPlusConfiguration: project_disabled on project disabled wording', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'OPLUS_REQUIRED',
    stderr: 'Observability Plus is disabled for this project',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'project_disabled');
});

test('classifyObservabilityPlusConfiguration: project_disabled on does-not-have-enabled wording', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'OPLUS_REQUIRED',
    stderr: 'This project does not have Observability Plus enabled',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, true);
  assert.equal(r.access, false);
  assert.equal(r.blocker, 'project_disabled');
});

test('classifyObservabilityPlusConfiguration: generic Observability Plus failure is inconclusive', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'EXIT_1',
    stderr: 'Failed to query Observability Plus configuration endpoint.',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, false);
  assert.equal(r.access, null);
  assert.equal(r.blocker, 'unknown');
  assert.doesNotMatch(r.detail, /not enabled/i);
});

test('classifyObservabilityPlusConfiguration: generic 404 not-enabled text is inconclusive', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'not_found',
    message: 'This project is not enabled.',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, false);
  assert.equal(r.access, null);
  assert.equal(r.blocker, 'unknown');
});

test('classifyObservabilityPlusConfiguration: forbidden is inconclusive and keeps metrics fallback available', () => {
  const r = classifyObservabilityPlusConfiguration({
    ok: false,
    code: 'FORBIDDEN',
  }, { projectId: 'prj_target' });

  assert.equal(r.ok, false);
  assert.equal(r.access, null);
  assert.equal(r.blocker, 'forbidden');
});
