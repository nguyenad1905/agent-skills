#!/usr/bin/env node
// Emits signals.json: Vercel CLI capability probe + project config + plan +
// usage + codebase stack + metric queries. Status → stderr, JSON → stdout.
// Degrades gracefully when capabilities are missing.

import {
  checkCliVersion,
  checkAuth,
  resolveProjectId,
  resolveTeamScope,
  probeObservabilityPlusSchema,
  checkObservabilityPlusConfiguration,
  getMetricsSchema,
  getProjectConfig,
  getContract,
  getUsage,
  filterUsageByProject,
  inferPlan,
  queryMetric,
  detectStack,
  redactSensitiveText,
  classifyObservabilityPlusAccessText,
} from '../lib/vercel.mjs';
import { classifyFrameworkSupport } from '../lib/framework-support.mjs';
import { QUERIES, TIME_WINDOW, normalizerFor } from '../lib/queries.mjs';
import { join } from 'node:path';

const SCHEMA_VERSION = '1.2';

const log = (...args) => console.error('[collect-signals]', ...args);

function parseArgs(argv) {
  let explicitProjectId = null;
  let continueWithoutObservability = process.env.VERCEL_OPTIMIZE_CONTINUE_WITHOUT_OBSERVABILITY === '1';
  let continueUnsupportedFramework = process.env.VERCEL_OPTIMIZE_CONTINUE_UNSUPPORTED_FRAMEWORK === '1';

  for (const arg of argv) {
    if (arg === '--continue-without-observability') {
      continueWithoutObservability = true;
      continue;
    }
    if (arg === '--continue-unsupported-framework') {
      continueUnsupportedFramework = true;
      continue;
    }
    if (arg.startsWith('--')) {
      throw new Error(`UNKNOWN_ARG: ${arg}`);
    }
    if (!explicitProjectId) {
      explicitProjectId = arg;
      continue;
    }
    throw new Error(`UNKNOWN_ARG: ${arg}`);
  }

  return { explicitProjectId, continueWithoutObservability, continueUnsupportedFramework };
}

async function main() {
  const { explicitProjectId, continueWithoutObservability, continueUnsupportedFramework } = parseArgs(process.argv.slice(2));

  log('checking Vercel CLI version…');
  const cli = await checkCliVersion();
  log(`vercel CLI v${cli.join('.')} OK`);

  log('checking auth…');
  await checkAuth();
  log('auth OK');

  log('resolving project id…');
  const project = await resolveProjectId(explicitProjectId);
  if (!project?.ok) {
    log(`scope resolution blocked: ${project?.blocker ?? 'unknown'} (${project?.detail ?? 'no detail'})`);
    writeOutput(scopeBlockedOutput(project), { usable: true, blocker: null, detail: 'Scope was not resolved.' });
    return;
  }
  log(`project link resolved (source=${project.source}; teamScope=${project.orgId ? 'yes' : 'no'})`);

  const teamScope = project.orgSlug
    ? { ok: true, orgId: project.orgId, cliScope: project.orgSlug, source: 'link' }
    : await resolveTeamScope(project.orgId);
  if (!teamScope.ok) {
    log(`team scope blocked: ${teamScope.blocker} (${teamScope.detail})`);
    writeOutput(scopeBlockedOutput({ ...project, ...teamScope }), { usable: true, blocker: null, detail: 'Scope was not resolved.' });
    return;
  }
  const scope = teamScope.cliScope || project.orgId || undefined;
  log(`team scope resolved (source=${teamScope.source})`);

  log('checking framework support…');
  const stackRoot = projectRootCwd(project);
  const stack = await detectStack(stackRoot);
  stack.rootDirectory = project.rootDirectory ?? null;
  const frameworkSupport = classifyFrameworkSupport(stack);
  log(`framework=${stack.framework}@${stack.frameworkVersion ?? '?'} support=${frameworkSupport.status}`);

  if (!frameworkSupport.ok && !continueUnsupportedFramework) {
    writeOutput({
      schemaVersion: SCHEMA_VERSION,
      collectedAt: new Date().toISOString(),
      timeWindow: TIME_WINDOW,
      projectId: project.projectId,
      orgId: project.orgId,
      projectIdSource: project.source,
      ...scopeFields(project, teamScope),
      frameworkSupport,
      frameworkSupportBlocker: frameworkSupport.blocker,
      frameworkSupportDetail: frameworkSupport.detail,
      observabilityPlus: null,
      observabilityPlusPreflight: null,
      observabilityPlusUsable: null,
      observabilityPlusBlocker: null,
      observabilityPlusBlockerDetail: null,
      plan: {
        plan: 'uncertain',
        reason: 'not collected before unsupported-framework confirmation',
      },
      project: null,
      contract: null,
      usage: null,
      usageScope: null,
      usageTeamTotal: null,
      usageError: 'NOT_COLLECTED_UNSUPPORTED_FRAMEWORK',
      stack,
      metrics: {},
      metricsSchema: null,
    }, { usable: true, blocker: null, detail: 'Observability Plus was not checked.' }, frameworkSupport);
    return;
  }

  if (!frameworkSupport.ok && continueUnsupportedFramework) {
    log('continuing after unsupported framework blocker because --continue-unsupported-framework was set');
  }

  log('checking Observability Plus configuration…');
  const observabilityPlusConfig = await checkObservabilityPlusConfiguration({
    orgId: project.orgId,
    projectId: project.projectId,
  });
  log(`observabilityPlusPreflight=${observabilityPlusConfig.access === true ? 'enabled' : observabilityPlusConfig.blocker ?? 'unknown'} (${observabilityPlusConfig.source})`);

  let oplus = observabilityPlusConfig.access;
  let schemaProbe = null;
  if (observabilityPlusConfig.access == null) {
    log('Observability Plus configuration preflight inconclusive; falling back to metrics schema probe…');
    schemaProbe = await probeObservabilityPlusSchema(scope);
    oplus = schemaProbe.access === true ? true : schemaProbe.access === false ? false : null;
  }
  log(`observabilityPlus=${oplus}`);

  const schema = oplus === true
    ? (schemaProbe?.ok ? schemaProbe.data : await getMetricsSchema(scope))
    : null;
  if (oplus && schema) {
    const count = Array.isArray(schema) ? schema.length : (schema.metrics?.length ?? 0);
    log(`metric catalog: ${count} metrics available`);
  }

  // Check one cheap metric before pulling slower project context. If this fails,
  // the orchestrator can ask the user immediately instead of waiting on billing.
  let metrics = {};
  let metricsCanaryOk = false;
  if (oplus === true) {
    log(`checking Observability Plus metrics access (window=${TIME_WINDOW})…`);
    const t0 = Date.now();
    const canary = await queryMetric('vercel.request.count', {
      aggregation: 'sum',
      since: TIME_WINDOW,
      limit: 1,
      scope,
      projectId: project.projectId,
    });
    metricsCanaryOk = !!canary?.ok;
    if (!metricsCanaryOk) {
      metrics = {
        observabilityPlusCanary: {
          ...canary,
          metricId: 'vercel.request.count',
          aggregation: 'sum',
        },
      };
      log(`metrics access check failed: ${canary?.code ?? 'unknown'} — skipping full metrics fan-out`);
    } else {
      log(`metrics access check passed in ${Date.now() - t0}ms`);
    }
  } else {
    log('skipping metric queries (Observability Plus preflight did not confirm access)');
  }

  let oplusDiag = observabilityPlusConfig.access === false
    ? {
        usable: false,
        blocker: observabilityPlusConfig.blocker,
        detail: observabilityPlusConfig.detail,
      }
    : (metricsCanaryOk
        ? { usable: true, blocker: null, detail: 'Observability Plus metrics access check passed.' }
        : diagnoseObservabilityPlus(metrics, schemaProbe ?? oplus));

  if (!oplusDiag.usable && !continueWithoutObservability) {
    writeOutput({
      schemaVersion: SCHEMA_VERSION,
      collectedAt: new Date().toISOString(),
      timeWindow: TIME_WINDOW,
      projectId: project.projectId,
      orgId: project.orgId,
      projectIdSource: project.source,
      ...scopeFields(project, teamScope),
      observabilityPlus: oplus,
      observabilityPlusPreflight: observabilityPlusConfig,
      observabilityPlusUsable: oplusDiag.usable,
      observabilityPlusBlocker: oplusDiag.blocker,
      observabilityPlusBlockerDetail: oplusDiag.detail,
      frameworkSupport,
      frameworkSupportBlocker: frameworkSupport.blocker,
      frameworkSupportDetail: frameworkSupport.detail,
      plan: {
        plan: 'uncertain',
        reason: 'not collected before Observability Plus blocker confirmation',
      },
      project: null,
      contract: null,
      usage: null,
      usageScope: null,
      usageTeamTotal: null,
      usageError: 'NOT_COLLECTED_OBSERVABILITY_BLOCKED',
      stack,
      metrics,
      metricsSchema: schema,
    }, oplusDiag);
    return;
  }

  if (!oplusDiag.usable && continueWithoutObservability) {
    log('continuing after Observability Plus blocker because --continue-without-observability was set');
  }

  log('pulling project config + contract + usage in parallel…');
  const [projectCfg, contract, usageResult] = await Promise.all([
    getProjectConfig(project.projectId, project.orgId),
    getContract(scope),
    getUsage({ days: 14, scope }),
  ]);

  let usage = null;
  let usageContextMismatch = false;
  let usageTotalCost = null;
  let usageScope = 'team';
  let usageTeamTotal = null;
  if (usageResult?.ok) {
    usage = usageResult.data;
    const contractContext = contract?.context;
    const expectedContext = scope;
    if (usage?.context && expectedContext && !sameContext(usage.context, expectedContext)) {
      usageContextMismatch = true;
      log(`usage: WARNING context mismatch — returned context=${usage.context} but resolved team scope=${expectedContext}; treating usage as unavailable for this project`);
      usage = null;
    } else if (usage?.context && contractContext && !sameContext(usage.context, contractContext)) {
      usageContextMismatch = true;
      log(`usage: WARNING context mismatch — returned context=${usage.context} but project team=${contractContext}; treating usage as unavailable for this project`);
      usage = null;
    } else {
      // Capture team total pre-filter so the report can label "this project vs team-wide" honestly.
      usageTeamTotal = sumUsageCosts(usage);
      const filterResult = filterUsageByProject(usage, project.projectId, projectCfg?.name);
      if (filterResult.matched) {
        usage = filterResult.filtered;
        usageScope = 'project';
        usageTotalCost = sumUsageCosts(usage);
        log(`usage: filtered to project — ~$${usageTotalCost.toFixed(2)} (team-wide ~$${usageTeamTotal.toFixed(2)}; unattributed ~$${filterResult.unattributedTotal.toFixed(2)})`);
      } else {
        usageTotalCost = usageTeamTotal;
        log(`usage: ~$${usageTotalCost.toFixed(2)} billed across services (team-wide — no per-project usage rows matched the linked project; report will label this team-wide)`);
      }
    }
  } else {
    log(`usage: unavailable (${usageResult?.code ?? 'unknown'}) — degrading to scanner+metrics-only mode`);
  }

  // Hobby teams don't bill, so commitments=[] + usage>$0 ⇒ Pro pay-as-you-go.
  const planInfo = inferPlan(contract, { usageTotalCost });
  log(`plan=${planInfo.plan} (${planInfo.reason})`);

  if (projectCfg?.error) {
    log(`project config: failed (${projectCfg.error}) — gates that need it will skip`);
  }

  log(`stack: ${stack.framework}@${stack.frameworkVersion ?? '?'} ${stack.hasAppRouter ? 'app-router' : ''}${stack.hasPagesRouter ? ' pages-router' : ''}${stack.orm !== 'none' ? ` orm=${stack.orm}` : ''}`);

  // Each query is wrapped; one failure degrades only that metric.
  if (oplus === true && metricsCanaryOk) {
    log(`querying observability metrics (${QUERIES.length} metrics in parallel)…`);
    const t0 = Date.now();
    metrics = await collectMetrics(scope, project.projectId);
    const wallMs = Date.now() - t0;
    const counts = Object.fromEntries(
      Object.entries(metrics).map(([k, v]) => {
        if (!v) return [k, 'null'];
        if (!v.ok) return [k, `err:${v.code}`];
        const rows = Array.isArray(v.rows) ? v.rows.length : 0;
        return [k, `${rows} rows`];
      })
    );
    log(`metrics collected in ${wallMs}ms: ${JSON.stringify(counts)}`);
  }

  // The `vercel metrics schema` probe alone is NOT a reliable usability signal:
  // it can return OK while per-route queries fail with payment_required (metrics
  // unavailable for the team) or FORBIDDEN (auth-scope mismatch). Diagnose AFTER
  // running queries by counting failure codes so the orchestrator can PAUSE and
  // surface the choice before falling back to scanner-only mode.
  oplusDiag = observabilityPlusConfig.access === false
    ? {
        usable: false,
        blocker: observabilityPlusConfig.blocker,
        detail: observabilityPlusConfig.detail,
      }
    : diagnoseObservabilityPlus(metrics, schemaProbe ?? oplus);


  const output = {
    schemaVersion: SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    timeWindow: TIME_WINDOW,
    projectId: project.projectId,
    orgId: project.orgId,
    projectIdSource: project.source,
    ...scopeFields(project, teamScope),
    observabilityPlus: oplus,
    observabilityPlusPreflight: observabilityPlusConfig,
    observabilityPlusUsable: oplusDiag.usable,
    observabilityPlusBlocker: oplusDiag.blocker,
    observabilityPlusBlockerDetail: oplusDiag.detail,
    frameworkSupport,
    frameworkSupportBlocker: frameworkSupport.blocker,
    frameworkSupportDetail: frameworkSupport.detail,
    plan: planInfo,
    project: projectCfg,
    contract,
    usage,
    usageScope,
    usageTeamTotal,
    usageError: usageResult?.ok
      ? (usageContextMismatch ? 'USAGE_CONTEXT_MISMATCH' : null)
      : (usageResult?.code ?? 'UNKNOWN'),
    stack,
    metrics,
    metricsSchema: schema,
  };

  writeOutput(output, oplusDiag);
}

function sameContext(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

function projectRootCwd(project) {
  const root = String(project?.rootDirectory ?? '').trim();
  if (!root || root === '.') return process.cwd();
  return join(process.cwd(), root);
}

function writeOutput(output, oplusDiag, frameworkSupport = output.frameworkSupport) {
  if (output.scopeBlocker) {
    log(`⚠ Vercel project/team scope is not confirmed: blocker=${output.scopeBlocker} (${output.scopeBlockerDetail})`);
    log('   The orchestrator should PAUSE and ask the user to confirm the exact team and project before proceeding.');
  }
  if (frameworkSupport?.blocker) {
    log(`⚠ Framework is not supported for metric-backed route-to-file optimization: ${frameworkSupport.detail}`);
    log('   The orchestrator should PAUSE and ask whether to continue with a limited platform/scanner audit.');
  }
  if (!oplusDiag.usable) {
    log(`⚠ Observability Plus is NOT usable on this project: blocker=${oplusDiag.blocker} (${oplusDiag.detail})`);
    log('   The orchestrator should PAUSE and follow the blocker-specific remediation before proceeding.');
  }

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
  log('done');
}

function scopeFields(project, teamScope) {
  return {
    scopeResolution: {
      ok: true,
      projectId: project.projectId,
      orgId: project.orgId,
      orgSlug: project.orgSlug ?? null,
      cliScope: teamScope.cliScope ?? null,
      projectName: project.name ?? null,
      projectIdSource: project.source,
      inputProjectId: project.inputProjectId ?? null,
      inputProjectIdSource: project.inputProjectIdSource ?? null,
    },
    scopeBlocker: null,
    scopeBlockerDetail: null,
    scopeChoices: project.choices ?? [],
  };
}

function scopeBlockedOutput(resolution = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    collectedAt: new Date().toISOString(),
    timeWindow: TIME_WINDOW,
    projectId: resolution.projectId ?? null,
    orgId: resolution.orgId ?? null,
    projectIdSource: resolution.source ?? null,
    scopeResolution: {
      ok: false,
      blocker: resolution.blocker ?? 'unknown',
      detail: resolution.detail ?? 'Could not resolve Vercel project/team scope.',
      inputProjectId: resolution.inputProjectId ?? resolution.projectId ?? null,
      inputProjectIdSource: resolution.inputProjectIdSource ?? null,
      linkedProjectCount: Array.isArray(resolution.choices) ? resolution.choices.length : 0,
    },
    scopeBlocker: resolution.blocker ?? 'unknown',
    scopeBlockerDetail: resolution.detail ?? 'Could not resolve Vercel project/team scope.',
    scopeChoices: resolution.choices ?? [],
    frameworkSupport: null,
    frameworkSupportBlocker: null,
    frameworkSupportDetail: null,
    observabilityPlus: null,
    observabilityPlusPreflight: null,
    observabilityPlusUsable: null,
    observabilityPlusBlocker: null,
    observabilityPlusBlockerDetail: null,
    plan: {
      plan: 'uncertain',
      reason: 'not collected before project/team scope confirmation',
    },
    project: null,
    contract: null,
    usage: null,
    usageScope: null,
    usageTeamTotal: null,
    usageError: 'NOT_COLLECTED_SCOPE_BLOCKED',
    stack: null,
    metrics: {},
    metricsSchema: null,
  };
}

async function collectMetrics(scope, projectId) {
  const results = await Promise.all(
    QUERIES.map(async (entry) => {
      const r = await queryMetric(entry.metricId, {
        aggregation: entry.aggregation,
        groupBy: entry.groupBy,
        filter: entry.filter,
        since: TIME_WINDOW,
        limit: entry.limit,
        scope,
        projectId,
      });
      return [entry, r];
    })
  );

  const out = {};
  for (const [entry, result] of results) {
    out[entry.id] = enrichEntry(entry, result);
  }
  return out;
}

function enrichEntry(entry, result) {
  if (!result?.ok) {
    return {
      ...result,
      metricId: entry.metricId,
      aggregation: entry.aggregation,
      groupBy: entry.groupBy,
    };
  }
  const normalize = normalizerFor(entry);
  const { rows } = normalize(result.data);
  return {
    ...result,
    rows,
    metricId: entry.metricId,
    aggregation: entry.aggregation,
    groupBy: entry.groupBy,
  };
}

// `vercel usage --format json` shape is documented but not stable across CLI
// versions; try several roots, return null if none match.
function sumUsageCosts(usage) {
  if (!usage) return null;
  if (typeof usage.totalCost === 'number') return usage.totalCost;
  if (typeof usage.totals?.billedCost === 'number') return usage.totals.billedCost;
  if (Array.isArray(usage.services)) {
    return usage.services.reduce((s, x) => s + (x.billedCost ?? x.cost ?? 0), 0);
  }
  if (Array.isArray(usage.breakdown?.data)) {
    return usage.breakdown.data.reduce((s, d) => {
      if (Array.isArray(d.services)) {
        return s + d.services.reduce((ss, x) => ss + (x.billedCost ?? x.cost ?? 0), 0);
      }
      return s + (d.billedCost ?? d.cost ?? 0);
    }, 0);
  }
  return null;
}

// Returns { usable, blocker, detail }. `blocker` enum:
//   null | 'oplus_not_enabled' | 'oplus_probe_failed' |
//   'project_disabled' | 'payment_required' | 'forbidden' |
//   'daily_quota_exceeded' | 'project_not_found' | 'not_linked' |
//   'all_failed_other' | 'no_traffic'
export function diagnoseObservabilityPlus(metrics, oplusProbe) {
  const probe = normalizeObservabilityProbe(oplusProbe);
  if (!probe.confirmed) {
    const accessBlocker = explicitAccessBlocker(probe.result);
    if (accessBlocker) {
      return {
        usable: false,
        blocker: accessBlocker,
        detail: accessBlocker === 'project_disabled'
          ? 'The metrics probe reported that Observability Plus is not enabled for this project.'
          : 'The metrics probe reported that Observability Plus is not enabled for the current Vercel scope.',
      };
    }
    const code = probe.result?.code ? ` (code=${probe.result.code})` : '';
    return {
      usable: false,
      blocker: 'oplus_probe_failed',
      detail: `\`vercel metrics schema\` returned non-OK${code}. This does not prove Observability Plus is disabled; verify the linked project/team context and inspect collect.stderr.`,
    };
  }

  const entries = Object.values(metrics);
  if (entries.length === 0) {
    return {
      usable: false,
      blocker: 'oplus_probe_failed',
      detail: 'No per-route metric queries were attempted. This is an internal collection gap, not evidence that Observability Plus is disabled.',
    };
  }

  const failures = entries.filter((m) => m && m.ok === false);
  const successes = entries.filter((m) => m && m.ok !== false);

  if (successes.length === 0) {
    const codeCounts = new Map();
    for (const f of failures) {
      const code = String(f.code ?? 'unknown').toLowerCase();
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
    const top = [...codeCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const topCode = top?.[0] ?? 'unknown';
    if (/daily_quota_exceeded/.test(topCode)) {
      return {
        usable: false,
        blocker: 'daily_quota_exceeded',
        detail: `${top[1]}/${entries.length} metric queries hit the daily Observability query limit. Retry after the next UTC midnight reset.`,
      };
    }
    if (/payment_required/.test(topCode)) {
      const text = failures
        .map((f) => `${f.message ?? ''}\n${f.stderr ?? ''}`)
        .join('\n')
        .toLowerCase();
      const accessBlocker = classifyObservabilityPlusAccessText(text);
      if (accessBlocker) {
        return {
          usable: false,
          blocker: accessBlocker,
          detail: accessBlocker === 'project_disabled'
            ? `${top[1]}/${entries.length} metric queries reported that Observability Plus is not enabled for this project.`
            : `${top[1]}/${entries.length} metric queries reported that Observability Plus is not enabled for the current Vercel scope.`,
        };
      }
      return {
        usable: false,
        blocker: 'payment_required',
        detail: `${top[1]}/${entries.length} metric queries returned payment_required. Route-level metrics were recognized for this team, but these queries are not usable. Check the team's Observability Plus subscription or event quota.`,
      };
    }
    if (/forbidden|not_authorized|403/.test(topCode)) {
      return {
        usable: false,
        blocker: 'forbidden',
        detail: `${top[1]}/${entries.length} metric queries returned FORBIDDEN. Auth-scope mismatch — likely logged in to the wrong team (run \`vercel switch\`).`,
      };
    }
    if (/project_not_found/.test(topCode)) {
      return {
        usable: false,
        blocker: 'project_not_found',
        detail: `Project ID not visible to the auth'd team. Run \`vercel switch\` or verify the project ID.`,
      };
    }
    if (/not_linked/.test(topCode)) {
      return {
        usable: false,
        blocker: 'not_linked',
        detail: `${top[1]}/${entries.length} metric queries returned NOT_LINKED. Link the app directory first: \`vercel link --yes --project <project-name-or-id> --cwd <project-dir>\`; add \`--team <team-id-or-slug>\` when the team is known.`,
      };
    }
    return {
      usable: false,
      blocker: 'all_failed_other',
      detail: `Every metric query failed; top error code was \`${topCode}\` (${top?.[1]}/${entries.length}).`,
    };
  }

  // Some queries succeeded; zero rows across the board = "no traffic in window",
  // NOT an Observability Plus billing issue.
  const totalRows = successes.reduce((s, m) => s + (Array.isArray(m.rows) ? m.rows.length : 0), 0);
  if (totalRows === 0) {
    return {
      usable: true,
      blocker: 'no_traffic',
      detail: 'Observability Plus queries succeeded but every metric returned 0 rows. Either the project has no traffic in the 14-day window, or Observability Plus retention is limited (free tier = 1 day on Pro).',
    };
  }

  return { usable: true, blocker: null, detail: 'Observability Plus is usable; queries returned data.' };
}

function normalizeObservabilityProbe(probe) {
  if (probe === true) return { confirmed: true, result: null };
  if (probe && typeof probe === 'object') {
    return {
      confirmed: probe.access === true || probe.ok === true,
      result: probe,
    };
  }
  return { confirmed: false, result: null };
}

function explicitAccessBlocker(result) {
  if (result?.blocker === 'oplus_not_enabled' || result?.blocker === 'project_disabled') return result.blocker;
  const text = `${result?.message ?? ''}\n${result?.stderr ?? ''}`;
  return classifyObservabilityPlusAccessText(text);
}

// Run main() only as a CLI; the test suite imports diagnoseObservabilityPlus directly.
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('[collect-signals] FAILED:', redactSensitiveText(err.message));
    process.exit(1);
  });
}
