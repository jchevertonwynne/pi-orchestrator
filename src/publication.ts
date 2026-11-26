import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PublicationAction, PublicationGrant, PublicationObservation, PublicationProposal, PublicationScope, Registry, Store } from './contracts.ts';
import { hashPlan } from './workflow.ts';

function need(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function object(value: any, keys: string[]): void {
  need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), 'Invalid publication fields');
}
function text(value: unknown, max = 4096): asserts value is string {
  need(typeof value === 'string' && value.trim().length > 0 && Buffer.byteLength(value) <= max
    && !/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/u.test(value), 'Invalid publication text');
}
const proposalKeys = ['taskId', 'operation', 'commit', 'repoPath', 'repository', 'headBranch', 'baseBranch', 'pr', 'draft', 'findings'];
export function publicationPr(pr: unknown, repository: string): void {
  text(pr, 1024);
  need(new RegExp(`^https://github\\.com/${repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9][0-9]*$`).test(pr), 'PR must match exact GitHub repository');
}
export function validatePublicationProposal(p: PublicationProposal): void {
  object(p, proposalKeys);
  text(p.taskId, 128); need(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(p.taskId) && !['__proto__', 'constructor', 'prototype'].includes(p.taskId), 'Invalid publication task');
  need(p.operation === 'create' || p.operation === 'update', 'Only draft create/update publication is supported');
  need(p.draft === true, 'Publication must be draft WIP');
  need(typeof p.commit === 'string' && /^[a-f0-9]{40}$/.test(p.commit), 'Publication requires full lowercase Git SHA');
  text(p.repoPath); need(p.repoPath.startsWith('/') && resolve(p.repoPath) === p.repoPath, 'Publication requires absolute normalized repoPath');
  text(p.repository, 256); need(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(p.repository) && !p.repository.endsWith('/.') && !p.repository.endsWith('/..'), 'Expected exact GitHub owner/repository');
  for (const branch of [p.headBranch, p.baseBranch]) {
    text(branch, 256);
    need(/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(branch) && !branch.includes('..') && !branch.includes('//')
      && branch.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')), 'Invalid publication branch');
  }
  need(p.headBranch !== p.baseBranch, 'WIP head must differ from base');
  text(p.findings, 8192);
  if (p.operation === 'update') publicationPr(p.pr, p.repository);
  else need(p.pr === undefined, 'Create scope cannot name an existing PR; use update');
}
export function publicationProposal(scope: PublicationScope): PublicationProposal {
  return Object.fromEntries(proposalKeys.filter(k => (scope as any)[k] !== undefined).map(k => [k, (scope as any)[k]])) as PublicationProposal;
}
export function publicationScope(state: Registry, p: PublicationProposal): PublicationScope {
  validatePublicationProposal(p);
  need(Object.hasOwn(state.tasks, p.taskId), 'Unknown publication task');
  const task = state.tasks[p.taskId];
  need(task.ships !== false && ['implementing', 'ready', 'blocked'].includes(task.state), 'WIP requires implementing, ready or blocked shipping task');
  for (let current: typeof task | undefined = task; current; current = current.parentTask ? state.tasks[current.parentTask] : undefined) {
    const hash = hashPlan(current.planPath);
    need(current.approval?.hash === hash && current.planHash === hash, 'WIP requires current exact-plan human approval, including ancestors');
  }
  const blockers = JSON.stringify({ note: task.summary ?? null, result: task.result ?? null });
  return { ...publicationProposal(p as PublicationScope), title: task.title, planPath: task.planPath, planHash: task.planHash, taskState: task.state as PublicationScope['taskState'],
    contextHash: digest(task), blockers };
}
export function displayPublicationScope(root: string, scope: PublicationScope): string {
  return ['UNVERIFIED / WIP — DRAFT PUBLICATION ONLY', `Registry: ${JSON.stringify(root)}`,
    ...Object.entries(scope).map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    'Findings and blockers are explicit attestations, not automated discovery or proof of completeness.',
    'Permits only non-force snapshot push and draft PR create/update at this exact destination.',
    'Keep UNVERIFIED / WIP and the findings visible in the remote PR title/body.',
    'Reconcile actual remote draft status, repository, head/base and commit before effects and retries.',
    'No ordinary PR, verification, merge, deployment, installation or completion authority.'].join('\n');
}
function coordinator(state: Registry, who: string): void {
  need(Object.hasOwn(state.agents, who) && state.agents[who].role === 'coordinator' && state.agents[who].lifecycle === 'running', 'Current coordinator required for WIP publication');
}
// Historical recording retains the original scope and coordinator-generation identity,
// but does not require or restore permission to execute that snapshot now.
function historicalGrant(state: Registry, root: string, who: string, id: string, scope: PublicationProposal): PublicationGrant {
  coordinator(state, who);
  const grant = state.publicationGrants?.find(g => g.id === id);
  need(grant && grant.root === root && grant.confirmation.coordinator === who
    && grant.confirmation.generation === state.agents[who].generation
    && grant.confirmation.sessionId === state.agents[who].piSessionId
    && grant.confirmation.sessionFile === state.agents[who].sessionFile, 'Exact current-coordinator WIP grant required');
  validatePublicationProposal(scope);
  need(JSON.stringify(publicationProposal(scope as PublicationScope)) === JSON.stringify(publicationProposal(grant.scope)), 'WIP scope changed from original grant; historical recording cannot widen scope');
  return grant;
}
function grantFor(state: Registry, root: string, who: string, id: string, scope: PublicationProposal): PublicationGrant {
  const grant = historicalGrant(state, root, who, id, scope);
  need(state.publicationGrants?.filter(g => g.scope.taskId === grant.scope.taskId).at(-1)?.id === grant.id, 'WIP grant superseded; use fresh exact-scope confirmation');
  need(JSON.stringify(publicationScope(state, scope)) === JSON.stringify(grant.scope), 'WIP scope or task context changed; request fresh confirmation');
  return grant;
}
export function validatePublicationObservation(o: PublicationObservation, p: PublicationProposal): void {
  object(o, ['commit', 'repository', 'headBranch', 'baseBranch', 'pr', 'draft']);
  need(o.draft === true && o.commit === p.commit && o.repository === p.repository && o.headBranch === p.headBranch
    && o.baseBranch === p.baseBranch, 'Observed draft/head/base/repository/commit must match exact WIP scope');
  publicationPr(o.pr, p.repository);
  if (p.operation === 'update') need(o.pr === p.pr, 'Observed PR must match update destination');
}
function evidence(paths: unknown): string[] {
  need(Array.isArray(paths) && paths.length > 0 && paths.length <= 256, 'Publication record requires 1 to 256 existing evidence files');
  return [...new Set(paths.map(path => {
    text(path); const canonical = realpathSync(path);
    const fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { need(fstatSync(fd).isFile(), 'Publication evidence must be a regular file'); } finally { closeSync(fd); }
    return canonical;
  }))].sort();
}
// Checks are read-only authority attestations, never external-state checks or an executor.
export function publicationAction(store: Store, who: string, input: PublicationAction) {
  object(input, input.action === 'record' ? ['action', 'grantId', 'scope', 'observed', 'evidence'] : ['action', 'grantId', 'scope']);
  need(input.action === 'check' || input.action === 'record', 'Unknown publication action');
  const check = (state: Registry) => grantFor(state, store.root, who, input.grantId, input.scope);
  if (input.action === 'check') {
    const state = store.read(), grant = check(state);
    const recorded = state.publications?.find(r => r.grantId === grant.id);
    return { allowed: !recorded, unverified: true, draft: true, scope: grant.scope, recorded: recorded ?? null,
      next: recorded ? 'Already recorded: reconcile remote truth; do not repeat external effects.' : 'Reconcile remote truth before non-force draft publication; record observed facts afterward.' };
  }
  const files = evidence(input.evidence);
  return store.transact(state => {
    const grant = historicalGrant(state, store.root, who, input.grantId, input.scope);
    validatePublicationObservation(input.observed, grant.scope);
    const prior = state.publications?.find(r => r.grantId === grant.id);
    if (prior) {
      need(Object.keys(prior.observed).every(k => (prior.observed as any)[k] === (input.observed as any)[k]) && JSON.stringify(prior.evidence) === JSON.stringify(files), 'Conflicting publication record; reconcile externally, never overwrite audit history');
      return prior;
    }
    const record = { grantId: grant.id, by: who, at: Date.now(), observed: input.observed, evidence: files };
    (state.publications ??= []).push(record);
    return record;
  });
}

// Validate historical bytes without reading mutable plans, evidence or Git paths.
export function validatePublicationLedger(state: Registry): void {
  const grants = state.publicationGrants ?? [], records = state.publications ?? [];
  need(Array.isArray(grants) && grants.length <= 1000 && Array.isArray(records) && records.length <= 1000, 'Invalid WIP ledger');
  need(new Set(grants.map(g => g.id)).size === grants.length && new Set(records.map(r => r.grantId)).size === records.length, 'Duplicate WIP audit ID');
  for (const g of grants) {
    text(g.id, 128); text(g.root); need(g.root.startsWith('/'), 'Invalid WIP root');
    validatePublicationProposal(publicationProposal(g.scope));
    const s = g.scope, c = g.confirmation;
    text(s.title, 1024); text(s.planPath); text(s.blockers, 1024 * 1024);
    need(['implementing', 'ready', 'blocked'].includes(s.taskState) && /^[a-f0-9]{64}$/.test(s.planHash) && /^[a-f0-9]{64}$/.test(s.contextHash), 'Invalid WIP context');
    need(Object.hasOwn(state.tasks, s.taskId) && c.kind === 'tui' && c.origin === 'tool', 'Invalid WIP confirmation');
    for (const value of [c.coordinator, c.generation, c.sessionId, c.sessionFile, c.toolCallId]) text(value);
    need(Object.hasOwn(state.agents, c.coordinator) && (c.branchAnchor === null || typeof c.branchAnchor === 'string') && Number.isSafeInteger(c.at) && c.at >= 0, 'Invalid WIP audit identity');
    need(c.displayedScope === displayPublicationScope(g.root, s) && c.digest === createHash('sha256').update(c.displayedScope).digest('hex'), 'Invalid WIP displayed scope digest');
  }
  for (const r of records) {
    const g = grants.find(g => g.id === r.grantId);
    need(g && r.by === g.confirmation.coordinator && Number.isSafeInteger(r.at) && r.at >= 0, 'Invalid WIP observed record');
    validatePublicationObservation(r.observed, g.scope);
    need(Array.isArray(r.evidence) && r.evidence.length > 0 && r.evidence.length <= 256, 'Invalid WIP evidence');
    r.evidence.forEach(path => text(path));
  }
}
