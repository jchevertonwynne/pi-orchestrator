import { LIMITS } from './contracts.ts';
import type { Agent, Message, Registry, Task } from './contracts.ts';
import { bundledIn, deliveredBy, gated, profileOf } from './policy.ts';
import { diagnosisText, episodeKey } from './diagnosis.ts';
import type { Diagnosis } from './diagnosis.ts';

// Human-facing views computed from the registry without model calls.
// They summarize recorded state; they are not proof of external facts.

const rank: Record<string, number> = { blocked: 1, implementing: 2, approved: 3, planned: 4, ready: 5, verified: 6, merged: 7, deployed: 8, skipped: 9 };
const ended = ['exited', 'collected', 'closed'];
const minutes = (ms: number) => `${Math.floor(ms / 60_000)}m`;

export function ownerOf(state: Registry, task: Task): Agent | undefined {
  const agents = Object.values(state.agents).filter((agent) => agent.taskId === task.id && agent.role !== 'coordinator');
  return agents.find((agent) => !ended.includes(agent.lifecycle)) ?? agents.at(-1);
}
// Only a running worker can be sent its next step; one awaiting verification is waiting on its parent, not idle.
export function idleFor(agent: Agent | undefined, now: number): number | undefined {
  return agent && agent.lifecycle === 'running' && agent.activity === 'idle' && agent.activityAt !== undefined
    ? Math.max(0, now - agent.activityAt) : undefined;
}
// Busy with no recorded turn, tool or message event for stallMs: a long tool call such as an interactive prompt, or a silent turn.
// Agents that never recorded progress (older extensions) report nothing rather than a guess.
// since identifies the episode; tool names the longest-running tool call, if one is open.
// A call still within its own declared timeout is legitimate work, not a stall.
// No event proves an interactive prompt, so alerts only suggest one.
export function stuckFor(agent: Agent | undefined, now: number): { since: number; ms: number; tool?: { name: string; ms: number } } | undefined {
  if (!agent || ended.includes(agent.lifecycle) || agent.activity !== 'busy' || agent.progressAt === undefined) return undefined;
  const since = Math.max(agent.progressAt, agent.activityAt ?? 0);
  if (now - since < LIMITS.stallMs || (agent.currentTool?.until !== undefined && now < agent.currentTool.until)) return undefined;
  return { since, ms: now - since, ...(agent.currentTool ? { tool: { name: agent.currentTool.name, ms: Math.max(0, now - agent.currentTool.since) } } : {}) };
}
export function stuckText(stuck: NonNullable<ReturnType<typeof stuckFor>>, short = false): string {
  if (short) return stuck.tool ? `in ${stuck.tool.name} ${minutes(stuck.tool.ms)}` : `no progress ${minutes(stuck.ms)}`;
  return stuck.tool ? `blocked in ${stuck.tool.name} ${minutes(stuck.tool.ms)}` : `busy ${minutes(stuck.ms)} without progress`;
}
// Messages handed to a live recipient's current generation that it has not consumed within ackMs.
export function unacknowledged(state: Registry, now: number): Message[] {
  return (state.messages ?? []).filter((message) => {
    const to = state.agents[message.to];
    return message.deliveredAt !== undefined && message.acknowledgedAt === undefined && now - message.deliveredAt >= LIMITS.ackMs
      && to && to.generation === message.generation && !ended.includes(to.lifecycle);
  });
}
export const unacknowledgedText = (message: Message, now: number) =>
  `${message.to}: ${message.mode} message from ${message.from} delivered ${minutes(now - message.deliveredAt!)} ago and still unacknowledged; it may be blocked mid-tool.`;

// Work the owner itself should be moving; blocked results and human questions are legitimate waits.
export function ownerActionable(state: Registry, task: Task): boolean {
  if (task.summary?.needsHuman || task.result?.status === 'blocked' || task.result?.status === 'failed') return false;
  if (finished(state, task)) return false;
  if (['planned', 'approved', 'implementing'].includes(task.state)) return true;
  // A child's ready or verified work is handed to its parent task, which integrates and ships it.
  if (task.parentTask) return false;
  // Light owners also verify and ship their own ready work.
  return profileOf(state) === 'light' && ['ready', 'verified'].includes(task.state) && !state.releases[task.id]?.mergedCommit;
}

const clip = (value: string, width: number) => (value.length > width ? value.slice(0, width - 1) + '…' : value.padEnd(width));
export function prLabel(state: Registry, task: Task): string {
  const url = state.releases[task.id]?.pr;
  if (!url) return '-';
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `#${match[1]}` : 'PR';
}
// Child tasks ship inside their top-level task's release, so they never reach merged themselves.
function rootOf(state: Registry, task: Task): Task {
  const seen = new Set([task.id]);
  let current = task;
  while (current.parentTask && state.tasks[current.parentTask] && !seen.has(current.parentTask)) {
    current = state.tasks[current.parentTask];
    seen.add(current.id);
  }
  return current;
}
const releasedState = (state: Registry, task: Task) => ['merged', 'deployed'].includes(task.state) || deliveredBy(state, task) !== undefined;
// Skipped work never shipped, even when its top-level task did.
// A result named by an attested bundle receipt shipped through that installation, never through inference.
export function shipped(state: Registry, task: Task): boolean {
  return task.state !== 'skipped' && task.ships !== false && (releasedState(state, task) || releasedState(state, rootOf(state, task)));
}
// How the task shipped, for display: a bundle delivery, or its own local installation and what it delivered.
function deliveryText(state: Registry, task: Task): string {
  const via = deliveredBy(state, task);
  if (via) return `delivered by ${via.taskId} local install ${via.installedCommit!.slice(0, 7)}${via.reconciliation ? ' (reconciled)' : ''}`;
  const own = state.releases[task.id];
  if (own?.route === 'local-install' && own.installedCommit) return `${task.state} · local install ${own.installedCommit.slice(0, 7)}${own.included ? ` +${own.included.length} bundled` : ''}`;
  return task.state;
}
// Non-shipping work is done once its result is accepted: ready in light, verified when gated.
export function done(state: Registry, task: Task): boolean {
  return task.ships === false && (task.state === 'verified' || (task.state === 'ready' && task.result?.status === 'ready' && !gated(state, task)));
}
const finished = (state: Registry, task: Task) => shipped(state, task) || done(state, task);

// Light shipping work runs without plan approval, but local installation, bundles and draft WIP still need current approval.
// A reminder only: it grants nothing.
// Tasks with a release record or bundle are omitted: they are frozen, or already on a route that cannot be installed or bundled.
export const approvalTag = 'no plan approval (needed for local install, bundle or WIP)';
export function needsPlanApproval(state: Registry, task: Task): boolean {
  return task.ships !== false && !gated(state, task) && task.approval?.hash !== task.planHash
    && !['merged', 'deployed', 'skipped'].includes(task.state) && !finished(state, task)
    && !Object.hasOwn(state.releases, task.id) && !bundledIn(state, task.id);
}

// Only a recorded skip makes a task historical. Do not infer it from a worker's note.
export function historicalNote(task: Task): string | undefined {
  if (task.state !== 'skipped') return undefined;
  const skip = task.history.findLast(entry => entry.state === 'skipped');
  const reason = skip?.note.replace(/^Skipped by [\w.-]+: /, '').replace(/[\s\u0000-\u001f\u007f-\u009f]+/g, ' ').trim();
  return `Historical: ${reason || 'skipped'}`;
}

function flag(state: Registry, task: Task): string {
  if (task.state === 'skipped') return '–';
  if (finished(state, task)) return '✓';
  if (task.summary?.needsHuman) return '⚠';
  if (task.state === 'blocked') return '✖';
  if (['ready', 'verified'].includes(task.state)) return '●';
  return '▶';
}

// Shipped counts top-level tasks only; other counts cover child tasks until their top-level task ships.
export function counts(state: Registry, now = Date.now()) {
  const all = Object.values(state.tasks).filter((task) => task.state !== 'skipped');
  const topLevel = all.filter((task) => rootOf(state, task) === task);
  const tasks = all.filter((task) => !finished(state, task));
  const idle = tasks.filter((task) => ownerActionable(state, task) && (idleFor(ownerOf(state, task), now) ?? 0) >= LIMITS.idleMs).length;
  return {
    total: topLevel.filter((task) => task.ships !== false).length,
    shipped: topLevel.filter((task) => shipped(state, task)).length,
    done: all.filter((task) => done(state, task)).length,
    building: tasks.filter((task) => ['planned', 'approved', 'implementing'].includes(task.state)).length,
    ready: tasks.filter((task) => ['ready', 'verified'].includes(task.state)).length,
    blocked: tasks.filter((task) => task.state === 'blocked').length,
    needsHuman: tasks.filter((task) => task.summary?.needsHuman).length,
    idle,
    stuck: tasks.filter((task) => stuckFor(ownerOf(state, task), now)).length,
  };
}

export function statusLine(state: Registry, now = Date.now()): string {
  const c = counts(state, now);
  const parts = [`⚙ ${profileOf(state)} ${c.shipped}/${c.total} shipped`];
  if (c.done) parts.push(`${c.done} done`);
  if (c.building) parts.push(`${c.building} building`);
  if (c.ready) parts.push(`${c.ready} ready`);
  if (c.blocked) parts.push(`${c.blocked} blocked`);
  if (c.idle) parts.push(`${c.idle} idle`);
  if (c.stuck) parts.push(`${c.stuck} stuck`);
  if (c.needsHuman) parts.push(`⚠ ${c.needsHuman} need you`);
  return parts.join(' · ');
}

// Bundle-delivered work sorts with deployed work, not with work still waiting to ship.
const rankOf = (state: Registry, task: Task) => (deliveredBy(state, task) ? rank.deployed : rank[task.state] ?? 99);
// Human decisions first, then by lifecycle stage, so the widget and interactive board agree.
export function sortTasks(state: Registry): Task[] {
  return Object.values(state.tasks).sort((a, b) =>
    Number(a.state === 'skipped') - Number(b.state === 'skipped')
    || Number(Boolean(b.summary?.needsHuman)) - Number(Boolean(a.summary?.needsHuman))
    || (rankOf(state, a) - rankOf(state, b)) || a.id.localeCompare(b.id));
}

// Flag, task, state, owner activity, PR and the owner's latest one-line note.
export function taskColumns(state: Registry, task: Task, now = Date.now()) {
  const agent = ownerOf(state, task);
  const idle = idleFor(agent, now);
  const stuck = stuckFor(agent, now);
  const activity = !agent ? '-' : ended.includes(agent.lifecycle) ? `${agent.id} ${agent.lifecycle}`
    : idle !== undefined ? `${agent.id} idle ${minutes(idle)}` : stuck ? `${agent.id} ${stuckText(stuck, true)}` : `${agent.id} ${agent.activity ?? agent.lifecycle}`;
  const note = historicalNote(task) ?? task.summary?.text ?? (task.result ? `${task.result.status}: ${task.result.report}` : task.title);
  const publication = state.publicationGrants?.filter(g => g.scope.taskId === task.id).at(-1);
  const wip = publication ? ` WIP UNVERIFIED ${publication.scope.commit} (${state.publications?.some(r => r.grantId === publication.id) ? 'recorded' : 'not recorded'})` : '';
  // The exact WIP snapshot remains separate from ordinary PR and shipped status.
  const shown = deliveredBy(state, task) ? 'delivered' : task.state;
  const unapproved = needsPlanApproval(state, task) ? ` [${approvalTag}]` : '';
  return { flag: flag(state, task), id: task.id, state: shown, activity, pr: prLabel(state, task), annotation: wip + unapproved, note };
}

export function taskLine(state: Registry, task: Task, now = Date.now()): string {
  const row = taskColumns(state, task, now);
  return `${row.flag} ${clip(row.id, 18)} ${clip(row.state, 12)} ${clip(row.activity, 34)} ${clip(row.pr, 6)}${row.annotation} ${clip(row.note, 42).trimEnd()}`;
}

// One line per task.
export function board(state: Registry, now = Date.now(), limit = 20): string[] {
  const tasks = sortTasks(state);
  const lines = [`Orchestrator board — ${statusLine(state, now)}`];
  for (const task of tasks.slice(0, limit)) lines.push(taskLine(state, task, now));
  if (tasks.length > limit) lines.push(`… ${tasks.length - limit} more; use orchestrator_status for details.`);
  if (!tasks.length) lines.push('No tasks yet.');
  // Forks are independent; this is only where to find them.
  for (const fork of state.forks ?? []) lines.push(`⑂ forked ${fork.name} → tab ${fork.tabId} in ${fork.session}`);
  return lines;
}

export function sessionClosure(state: Registry): { key: string; text: string } | undefined {
  const shared = state.sharedSession;
  const workers = Object.values(state.agents).filter((agent) => agent.role !== 'coordinator');
  if (shared && !shared.closedAt && workers.length && workers.every((agent) => agent.lifecycle === 'closed')
    && Object.values(state.tasks).every((task) => ['merged', 'deployed', 'skipped'].includes(task.state) || shipped(state, task) || done(state, task))) {
    return { key: `session-done:${shared.name}`, text: `All tasks ended and every agent is closed; close worker session ${shared.name} with orchestrator_agent action close-session. Safe cleanup runs automatically when the coordinator is idle in the TUI and every worker PID is gone; volume deletion still requires explicit confirmation. Use orchestrator_cleanup for retained items or earlier runs.` };
  }
}

// Deduplicated human alerts for the coordinator's UI: decisions, failures, shipped work and escalated stalls.
// Warning alerts request attention (Ping); info alerts mark completion (Hero).
export function alerts(state: Registry, now = Date.now(), diagnoses?: ReadonlyMap<string, Diagnosis | null>): Array<{ key: string; text: string; level: 'info' | 'warning' }> {
  const output: Array<{ key: string; text: string; level: 'info' | 'warning' }> = [];
  for (const task of Object.values(state.tasks)) {
    if (task.state !== 'skipped' && task.summary?.needsHuman) output.push({ key: `ui:human:${task.id}:${task.summary.at}`, level: 'warning', text: `⚠ ${task.id} needs you: ${task.summary.text}` });
    if (task.state !== 'skipped' && task.result && task.result.status !== 'ready') output.push({ key: `ui:${task.result.status}:${task.id}:${task.result.id}`, level: 'warning', text: `✖ ${task.id} ${task.result.status}; report ${task.result.report}` });
    const release = state.releases[task.id];
    if (release?.mergedCommit) output.push({ key: `ui:merged:${task.id}:${release.mergedCommit}`, level: 'info', text: `✓ ${task.id} merged ${prLabel(state, task) === '-' ? release.mergedCommit.slice(0, 12) : prLabel(state, task)}` });
    if (release?.deployedCommit) output.push({ key: `ui:deployed:${task.id}:${release.deployedCommit}`, level: 'info', text: `✓ ${task.id} deployed ${release.deployedCommit.slice(0, 12)}` });
    const agent = ownerOf(state, task);
    const idle = idleFor(agent, now);
    if (agent && idle !== undefined && idle >= LIMITS.escalateMs && ownerActionable(state, task)) {
      output.push({ key: `ui:stalled:${agent.id}:${agent.generation}:${agent.activityAt}`, level: 'warning', text: `${agent.id} idle ${minutes(idle)} on ${task.id} (${task.state}) after the coordinator was nudged; check its pane.${diagnosisText(diagnoses?.get(episodeKey(agent)))}` });
    }
  }
  // Stuck workers and unconsumed messages reach the human at once: an interactive prompt may wait for them, not the coordinator.
  for (const agent of Object.values(state.agents)) {
    const stuck = agent.role === 'coordinator' ? undefined : stuckFor(agent, now);
    if (stuck) output.push({ key: `ui:stuck:${agent.id}:${agent.generation}:${stuck.since}`, level: 'warning', text: `${agent.id} ${stuckText(stuck)}${agent.taskId ? ` on ${agent.taskId}` : ''}; check its pane.` });
  }
  for (const message of unacknowledged(state, now)) output.push({ key: `ui:unacked:${message.id}`, level: 'warning', text: unacknowledgedText(message, now) });
  const closure = sessionClosure(state);
  if (closure) output.push({ ...closure, key: `ui:${closure.key}`, level: 'info' });
  return output;
}

// The /orchestrator status card: what needs the human, what is wrong, what is moving and what shipped.
// Recorded registry state only; workers' own progress beyond their notes needs inspection.
export type StatusSection = { title: string; tone: 'warning' | 'error' | 'accent' | 'success' | 'dim'; lines: string[]; note?: string };
const span = (ms: number) => ms < 60 * 60_000 ? minutes(ms) : ms < 48 * 60 * 60_000 ? `${Math.floor(ms / 3_600_000)}h` : `${Math.floor(ms / 86_400_000)}d`;
const ago = (now: number, at?: number) => (at === undefined ? '' : ` (${span(Math.max(0, now - at))} ago)`);
export function statusDigest(state: Registry, now = Date.now()): StatusSection[] {
  const tasks = sortTasks(state).filter((task) => task.state !== 'skipped');
  const open = tasks.filter((task) => !finished(state, task));
  const needs: string[] = [], problems: string[] = [], moving: string[] = [], ready: string[] = [];
  for (const task of open) {
    const owner = ownerOf(state, task);
    const idle = idleFor(owner, now);
    if (task.summary?.needsHuman) needs.push(`${task.id}: ${task.summary.text}${ago(now, task.summary.at)}`);
    if (task.state === 'planned' && gated(state, task)) needs.push(`${task.id}: plan awaits approval → /o approve ${task.id}`);
    if (task.state === 'blocked' || (task.result && task.result.status !== 'ready')) problems.push(`${task.id}: ${task.result?.status ?? task.state}; report ${task.result?.report ?? 'none'}`);
    else if (owner && ['exited', 'collected'].includes(owner.lifecycle) && ownerActionable(state, task)) problems.push(`${task.id}: owner ${owner.id} ${owner.lifecycle} while ${task.state}`);
    else if (owner?.heartbeatAt && !ended.includes(owner.lifecycle) && now - owner.heartbeatAt > 90_000) problems.push(`${task.id}: ${owner.id} heartbeat stale ${minutes(now - owner.heartbeatAt)}`);
    else if (idle !== undefined && idle >= LIMITS.idleMs && ownerActionable(state, task)) problems.push(`${task.id}: ${owner!.id} idle ${minutes(idle)} with no blocker recorded`);
    else if (stuckFor(owner, now)) problems.push(`${task.id}: ${owner!.id} ${stuckText(stuckFor(owner, now)!)}`);
    const note = task.summary && !task.summary.needsHuman ? ` · ${task.summary.text}${ago(now, task.summary.at)}` : '';
    const stuck = stuckFor(owner, now);
    const who = !owner ? 'no owner' : idle !== undefined ? `${owner.id} idle ${minutes(idle)}` : stuck ? `${owner.id} ${stuckText(stuck)}` : `${owner.id} ${owner.activity ?? owner.lifecycle}`;
    if (['approved', 'implementing'].includes(task.state) || (task.state === 'planned' && !gated(state, task))) moving.push(`${task.id} · ${task.state} · ${who}${note}`);
    if (task.ships === false && task.state === 'ready') moving.push(`${task.id} · ready, awaits verification · ${who}${note}`);
    else if (['ready', 'verified'].includes(task.state)) {
      const pr = prLabel(state, task);
      ready.push(`${task.id} · ${task.state}${task.result?.commit ? ` ${task.result.commit.slice(0, 7)}` : ''}${pr === '-' ? '' : ` · ${pr}`}${note}`);
    }
  }
  const released = tasks.filter((task) => shipped(state, task)).map((task) => {
    const pr = prLabel(state, task);
    return `${task.id} · ${deliveryText(state, task)}${pr === '-' ? '' : ` · ${pr}`}`;
  });
  const accepted = tasks.filter((task) => done(state, task)).map((task) => `${task.id} · ${task.result?.report ?? task.state}`);
  const skipped = Object.values(state.tasks).filter((task) => task.state === 'skipped').length;
  const sections: StatusSection[] = [
    { title: 'Needs you', tone: 'warning', lines: needs },
    { title: 'Problems', tone: 'error', lines: problems },
    { title: 'In flight', tone: 'accent', lines: moving },
    { title: 'Ready to ship', tone: 'success', lines: ready },
    { title: 'Shipped', tone: 'dim', lines: released, ...(skipped ? { note: `${skipped} skipped` } : {}) },
    { title: 'Done, nothing to ship', tone: 'dim', lines: accepted },
  ];
  return sections.filter((section) => section.lines.length);
}
