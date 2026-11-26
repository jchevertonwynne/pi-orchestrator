import type { Registry, Task } from './contracts.ts';
import { approvalTag, historicalNote, needsPlanApproval, ownerOf, prLabel, sortTasks, statusLine, taskColumns, taskLine } from './board.ts';
import { bundledIn, deliveredBy } from './policy.ts';
import { retainsOnApproval } from './workflow.ts';

// Interactive coordinator board: pick a task, then a key names the action.
// Views only choose a target; the bridge performs every action,
// and approvals still go through their own human confirmation.
// Workers get a read-only board: browsing and jumping, but no approvals, messages, inspections or resumes,
// which carry the coordinator's authority.

export type BoardAction = 'details' | 'plan' | 'open-pr' | 'approve' | 'approve-all' | 'inspect' | 'go' | 'switch' | 'coordinator' | 'message' | 'resume';
export type BoardChoice = { action: BoardAction; taskId: string };
type Wrap = (text: string, width: number) => string[];
type ColumnMetrics = { visibleWidth(text: string): number; truncateToWidth(text: string, width: number): string };

// Share column widths across the board so scrolling and selection do not shift them.
// Keep a compact note budget while growing identifiers, then give notes the remainder.
function interactiveRows(state: Registry, tasks: Task[], width: number, metrics: ColumnMetrics): string[] {
  const { visibleWidth: measure, truncateToWidth: truncate } = metrics;
  const now = Date.now();
  const rows = tasks.map(task => Object.fromEntries(Object.entries(taskColumns(state, task, now))
    .map(([key, value]) => [key, clean(value).replace(/\n/g, ' ')])) as ReturnType<typeof taskColumns>);
  const fields = ['id', 'state', 'activity', 'pr'] as const;
  const widths = { id: 18, state: 12, activity: 34, pr: 6 };
  const desired = Object.fromEntries(fields.map(key => [key, Math.max(widths[key], ...rows.map(row => measure(row[key])))]));
  const flagWidth = Math.max(1, ...rows.map(row => measure(row.flag)));
  const annotationWidth = Math.max(0, ...rows.map(row => measure(row.annotation)));
  let extra = Math.max(0, width - (2 + flagWidth + 5 + annotationWidth + 70 + 42));
  while (extra > 0) {
    const growing = fields.filter(key => widths[key] < desired[key]);
    if (!growing.length) break;
    for (const key of growing) {
      if (extra === 0) break;
      widths[key]++;
      extra--;
    }
  }
  const pad = (text: string, size: number) => {
    const clipped = truncate(text, size);
    return clipped + ' '.repeat(Math.max(0, size - measure(clipped)));
  };
  return rows.map(row => {
    const prefix = `${pad(row.flag, flagWidth)} ${fields.map(key => pad(row[key], widths[key])).join(' ')}${row.annotation} `;
    const remaining = width - 2 - measure(prefix);
    return truncate(prefix + (remaining > 0 ? truncate(row.note, remaining) : ''), Math.max(1, width - 2));
  });
}

// Plans, notes and pane dumps are untrusted text; never pass terminal controls through.
export const clean = (text: string) => text.replace(/\t/g, '  ').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '\ufffd');

const live = ['registered', 'starting', 'running'];

// Overlays are only as tall as their lines, so short views let the transcript show through.
// Fill to the terminal height and pin the footer to the bottom row.
const fill = (body: string[], footer: string[], rows: number) =>
  [...body, ...Array(Math.max(0, rows - body.length - footer.length)).fill(''), ...footer];
const keys: Array<{ key: string; action: BoardAction; label: string }> = [
  { key: 'p', action: 'plan', label: 'p plan' },
  { key: 'o', action: 'open-pr', label: 'o open PR' },
  { key: 'a', action: 'approve', label: 'a approve' },
  { key: 'A', action: 'approve-all', label: 'A approve all' },
  { key: 'i', action: 'inspect', label: 'i inspect' },
  { key: 'g', action: 'go', label: 'g open tab in new window' },
  { key: 'G', action: 'switch', label: 'G switch to tab' },
  { key: 'c', action: 'coordinator', label: 'c go to coordinator' },
  { key: 'm', action: 'message', label: 'm message' },
  { key: 'r', action: 'resume', label: 'r resume' },
];

export function pendingApprovals(state: Registry): Task[] {
  return Object.values(state.tasks).filter((task) => task.state === 'planned');
}

// Verified shipping tasks without current approval whose late approval would keep their result, never clear it.
// planHash previews the current bytes; the bridge passes the actual file hash and rechecks it after confirmation.
export function retainedApprovals(state: Registry, hash: (task: Task) => string | undefined = (task) => task.planHash): Task[] {
  return Object.values(state.tasks).filter((task) => verifiedNeedsApproval(state, task) && retainsOnApproval(state, task, hash(task)));
}

// A verified task whose recorded approval does not match its plan hash, for example before a bundled local installation.
// Release records and bundles freeze it; approval itself clears the result and verification.
// Non-shipping work is never delivered, so it gets no delivery approval.
export function verifiedNeedsApproval(state: Registry, task: Task): boolean {
  return task.state === 'verified' && task.ships !== false && task.approval?.hash !== task.planHash
    && !Object.hasOwn(state.releases, task.id) && !bundledIn(state, task.id);
}

// Accept GitHub-style web PR links, including enterprise hosts, without a remote lookup.
export function validPrUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)
    || /[\s\u0000-\u001f\u007f-\u009f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password
      && /^\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(url.pathname);
  } catch { return false; }
}

// Which actions make sense for this task right now; the bridge revalidates before acting.
export function available(state: Registry, task: Task, readOnly = false): Set<BoardAction> {
  const owner = ownerOf(state, task);
  const actions = new Set<BoardAction>(['details', 'plan']);
  if (validPrUrl(state.releases[task.id]?.pr)) actions.add('open-pr');
  if (owner && live.includes(owner.lifecycle) && owner.zellijSession) { actions.add('go'); actions.add('switch'); }
  if (readOnly) {
    if (Object.values(state.agents).some((a) => a.role === 'coordinator' && a.lifecycle === 'running' && a.homeSession && a.homePaneId)) actions.add('coordinator');
    return actions;
  }
  if (task.state === 'planned' || verifiedNeedsApproval(state, task) || needsPlanApproval(state, task)) actions.add('approve');
  if (pendingApprovals(state).length || retainedApprovals(state).length) actions.add('approve-all');
  if (owner) actions.add('inspect');
  if (owner && live.includes(owner.lifecycle)) actions.add('message');
  if (owner && owner.lifecycle !== 'closed') actions.add('resume');
  return actions;
}

export function taskDetails(state: Registry, task: Task): string {
  const owner = ownerOf(state, task);
  const release = state.releases[task.id];
  const lines = [
    `${task.id} · ${task.state}${task.risky ? ' · risky' : ''}`,
    task.title,
    `Plan: ${task.planPath}`,
  ];
  const historical = historicalNote(task);
  if (historical) lines.push(historical);
  if (task.approval) lines.push(`Approved: ${task.approval.source} (SHA256 ${task.approval.hash.slice(0, 12)})`);
  const kept = task.approval?.retained;
  if (kept) lines.push(`Plan approved after verification: kept result ${kept.resultId} commit ${kept.commit} (not a review or re-verification)`);
  if (verifiedNeedsApproval(state, task) || needsPlanApproval(state, task)) {
    const missing = `${approvalTag[0].toUpperCase()}${approvalTag.slice(1)}`;
    lines.push(retainsOnApproval(state, task, task.planHash)
      ? `${missing}; approving keeps verified result ${task.result!.id} commit ${task.result!.commit} while the plan bytes are unchanged: retrospective plan approval, not a review or re-verification of the result, and not permission to install`
      : task.result || task.verification
        ? `${missing}; approving clears this result and verification, so it needs republishing and fresh verification (not permission to install)`
        : missing);
  }
  if (task.dependencies.length) lines.push(`Depends on: ${task.dependencies.join(', ')}`);
  if (task.parentTask) lines.push(`Parent: ${task.parentTask}`);
  lines.push(owner ? `Owner: ${owner.id} (${owner.role}, ${owner.lifecycle}${owner.activity ? `, ${owner.activity}` : ''})` : 'Owner: none');
  if (owner?.branch) lines.push(`Branch: ${owner.branch}`);
  if (owner?.worktree) lines.push(`Worktree: ${owner.worktree}`);
  if (task.summary) lines.push(`${historical ? 'Previous note' : task.summary.needsHuman ? 'Needs you' : 'Note'}: ${task.summary.text}`);
  if (task.result) lines.push(`${historical ? 'Previous result' : 'Result'}: ${task.result.status}; commit ${task.result.commit ?? 'unverified'}; report ${task.result.report}`);
  if (release) lines.push(`Release: ${release.stage}${release.pr ? ` ${prLabel(state, task)} ${release.pr}` : ''}`);
  if (release?.route === 'local-install') lines.push(`Local install: ${release.installedCommit ?? release.commit} -> ${JSON.stringify(release.installationTarget)}`);
  if (release?.included) lines.push(`Bundle (${release.installedCommit ? 'delivered' : 'claimed, not yet installed'}): ${release.included.map((entry) => `${entry.taskId} ${entry.commit.slice(0, 12)}`).join(', ')}`);
  if (release?.reconciliation) lines.push(`Bundle reconciled historically under grant ${release.reconciliation.grantId} by ${release.reconciliation.by}; no installation was repeated`);
  const via = deliveredBy(state, task);
  if (via) lines.push(`Delivered by: ${via.taskId} local install ${via.installedCommit} -> ${JSON.stringify(via.installationTarget)} (bundle receipt; no separate installation, PR or merge)`);
  else { const pending = bundledIn(state, task.id); if (pending && pending.taskId !== task.id) lines.push(`Bundled in: ${pending.taskId} local-install claim (frozen; not yet delivered)`); }
  const publication = state.publicationGrants?.filter(g => g.scope.taskId === task.id).at(-1);
  if (publication) {
    const observed = state.publications?.find(r => r.grantId === publication.id);
    lines.push(`UNVERIFIED / WIP draft snapshot: ${publication.scope.commit}`,
      `Publication: ${observed ? `recorded attestation ${observed.observed.pr}` : 'authorized only; no observed publication recorded'}`,
      `Destination: ${publication.scope.repository} ${publication.scope.headBranch} -> ${publication.scope.baseBranch}`,
      `Findings/limitations (attestation): ${publication.scope.findings}`,
      `Blocker context at confirmation: ${publication.scope.blockers}`,
      'Historical publication is not current authority, verification, release advancement or completion.');
  }
  return lines.join('\n');
}

export function boardView(read: () => Registry, tui: any, theme: any, kb: any, done: (choice: BoardChoice | undefined) => void,
  wrap: Wrap, initial?: string, readOnly = false, metrics?: ColumnMetrics) {
  let selected = initial, closed = false;
  const finish = (choice: BoardChoice | undefined) => { if (!closed) { closed = true; done(choice); } };
  const fit = (text: string, width: number) => wrap(clean(text), Math.max(1, width))[0] ?? '';
  const snapshot = () => {
    const state = read();
    const tasks = sortTasks(state);
    let index = tasks.findIndex((task) => task.id === selected);
    if (index < 0) index = 0;
    selected = tasks[index]?.id;
    return { state, tasks, index };
  };
  return {
    render(width: number): string[] {
      const { state, tasks, index } = snapshot();
      const rows = tui.terminal.rows;
      const lines = [theme.fg('accent', fit(`Orchestrator${readOnly ? ' (read-only)' : ''} — ${statusLine(state)}`, width))];
      if (!tasks.length) {
        return fill([...lines, 'No tasks yet.'], [theme.fg('dim', fit('esc close', width))], rows);
      }
      const task = tasks[index];
      const detail = clean(taskDetails(state, task)).split('\n').flatMap((line) => wrap(line, Math.max(1, width))).slice(0, 8);
      const actions = available(state, task, readOnly);
      const hint = ['↑↓ select', 'enter details', ...keys.filter((k) => actions.has(k.action)).map((k) => k.label), 'esc close'].join(' · ');
      const hints = wrap(hint, Math.max(1, width));
      // Header, two rules, detail and hints; the task list gets what remains, at least three rows.
      const listRows = Math.max(3, rows - 3 - detail.length - hints.length);
      const start = Math.min(Math.max(0, index - Math.floor(listRows / 2)), Math.max(0, tasks.length - listRows));
      const formatted = metrics && width > 120 ? interactiveRows(state, tasks, width, metrics) : undefined;
      for (const [offset, item] of tasks.slice(start, start + listRows).entries()) {
        const marker = start + offset === index ? '›' : ' ';
        const line = formatted
          ? metrics!.truncateToWidth(`${marker} ${formatted[start + offset]}`, width)
          : fit(`${marker} ${taskLine(state, item)}`, width);
        lines.push(start + offset === index ? theme.fg('accent', line) : line);
      }
      const rule = theme.fg('dim', '─'.repeat(Math.max(1, width)));
      lines.push(rule, ...detail, rule);
      return fill(lines, hints.map((line) => theme.fg('dim', line)), rows);
    },
    handleInput(data: string) {
      if (closed) return;
      if (kb.matches(data, 'tui.select.cancel')) { finish(undefined); return; }
      const { state, tasks, index } = snapshot();
      if (!tasks.length) return;
      if (kb.matches(data, 'tui.select.up')) selected = tasks[Math.max(0, index - 1)].id;
      else if (kb.matches(data, 'tui.select.down')) selected = tasks[Math.min(tasks.length - 1, index + 1)].id;
      else if (kb.matches(data, 'tui.select.confirm')) { finish({ action: 'details', taskId: tasks[index].id }); return; }
      else {
        const match = keys.find((k) => k.key === data);
        if (match && available(state, tasks[index], readOnly).has(match.action)) { finish({ action: match.action, taskId: tasks[index].id }); return; }
      }
      tui.requestRender();
    },
    invalidate() {},
    dispose() { closed = true; },
  };
}

// Generic text stays read-only; only a task-aware plan interaction supplies actions.
// The view selects an action; the bridge performs it after revalidation.
export function textView(title: string, body: string, tui: any, theme: any, kb: any, done: (action?: 'approve' | 'critique') => void, wrap: Wrap,
  plan?: { approve: boolean; critique?: boolean; position: { top: number; raw?: boolean }; markdown?: { render(width: number): string[]; invalidate(): void } }) {
  let top = plan?.position.top ?? 0, raw = plan?.position.raw ?? false, closed = false, width = 0, lines: string[] = [];
  body = clean(body);
  const finish = (action?: 'approve' | 'critique') => { if (!closed) { closed = true; if (plan) { plan.position.top = top; plan.position.raw = raw; } done(action); } };
  const fitsActions = () => width >= 12 && tui.terminal.columns >= 12 && tui.terminal.rows >= 4;
  const canApprove = () => plan?.approve && fitsActions();
  const canCritique = () => plan?.critique && fitsActions()
    && wrap(`${canApprove() ? 'a approve · ' : ''}c critique in Crit · esc back`, Math.max(1, width)).length <= tui.terminal.rows - 2;
  const actions = () => `${canApprove() ? 'a approve · ' : ''}${canCritique() ? 'c critique in Crit · ' : ''}`;
  const footer = () => {
    const hints = `${actions()}${plan?.markdown ? `m ${raw ? 'formatted' : 'raw source'} · ` : ''}↑↓ scroll · pgup/pgdn page · esc back`;
    const full = wrap(hints, Math.max(1, width));
    if (full.length <= Math.max(1, tui.terminal.rows - 2)) return full;
    return wrap(`${actions()}esc back`, Math.max(1, width)).slice(0, Math.max(1, tui.terminal.rows - 2));
  };
  const page = () => Math.max(1, tui.terminal.rows - 1 - footer().length);
  return {
    render(nextWidth: number): string[] {
      if (nextWidth !== width) {
        width = nextWidth;
        lines = plan?.markdown && !raw ? plan.markdown.render(Math.max(1, width)) : wrap(body, Math.max(1, width));
      }
      const hints = footer().map((line) => theme.fg('dim', line));
      if (tui.terminal.rows < 3) return fill([], hints.slice(0, tui.terminal.rows), tui.terminal.rows);
      top = Math.min(top, Math.max(0, lines.length - page()));
      const chunk = lines.slice(top, top + page());
      const position = lines.length > page() ? ` (${top + 1}-${top + chunk.length}/${lines.length})` : '';
      return fill([theme.fg('accent', (wrap(clean(title) + position, Math.max(1, width))[0] ?? '')), ...chunk],
        hints, tui.terminal.rows);
    },
    handleInput(data: string) {
      if (closed) return;
      if (kb.matches(data, 'tui.select.cancel') || kb.matches(data, 'tui.select.confirm')) { finish(); return; }
      if (data === 'a' && canApprove()) { finish('approve'); return; }
      if (data === 'c' && canCritique()) { finish('critique'); return; }
      if (data === 'm' && plan?.markdown) { raw = !raw; top = 0; width = 0; tui.requestRender(); return; }
      const last = Math.max(0, lines.length - page());
      if (kb.matches(data, 'tui.select.up')) top = Math.max(0, top - 1);
      else if (kb.matches(data, 'tui.select.down')) top = Math.min(last, top + 1);
      else if (kb.matches(data, 'tui.select.pageUp')) top = Math.max(0, top - page());
      else if (kb.matches(data, 'tui.select.pageDown')) top = Math.min(last, top + page());
      tui.requestRender();
    },
    invalidate() { width = 0; plan?.markdown?.invalidate(); },
    dispose() { closed = true; },
  };
}

// Pick items to remove: space toggles, enter continues to a separate confirmation, esc cancels.
// Only removable items can be toggled; the view itself removes nothing.
export type ChecklistItem = { label: string; detail: string; removable: boolean; checked: boolean };
export function checklistView(title: string, items: ChecklistItem[], tui: any, theme: any, kb: any,
  done: (selected: number[] | undefined) => void, wrap: Wrap, truncate?: (text: string, width: number) => string) {
  let index = Math.max(0, items.findIndex((item) => item.removable)), closed = false, detailTop = 0, detailPage = 1, detailLength = 0, usable = false;
  const checked = items.map((item) => item.removable && item.checked);
  const finish = (value: number[] | undefined) => { if (!closed) { closed = true; done(value); } };
  const fit = (text: string, width: number) => truncate ? truncate(clean(text), Math.max(1, width)) : wrap(clean(text), Math.max(1, width))[0] ?? '';
  return {
    render(width: number): string[] {
      const count = checked.filter(Boolean).length;
      const rows = Math.max(1, tui.terminal.rows);
      usable = width >= 40 && rows >= 10;
      if (!usable) return wrap('Enlarge terminal to 40x10; esc cancel', Math.max(1, width)).slice(0, rows);
      const current = items[index];
      const detail = current ? clean(`${current.label}\n${current.detail}${current.removable ? '' : '\nKept: not removable now.'}`).split('\n').flatMap((line) => wrap(line, Math.max(1, width))) : [];
      const rule = theme.fg('dim', '─'.repeat(Math.max(1, width)));
      const hints = wrap('↑↓ select · space toggle · pgup/pgdn detail · enter review · esc cancel', Math.max(1, width)).map((line) => theme.fg('dim', line));
      detailLength = detail.length;
      detailPage = Math.max(1, Math.min(detail.length, Math.floor((rows - hints.length - 3) / 2)));
      detailTop = Math.min(detailTop, Math.max(0, detailLength - detailPage));
      const listSize = Math.max(1, rows - hints.length - detailPage - 2);
      const start = Math.max(0, Math.min(index - Math.floor(listSize / 2), items.length - listSize));
      const range = items.length > listSize ? ` (${start + 1}–${Math.min(items.length, start + listSize)}/${items.length})` : '';
      const lines = [theme.fg('accent', fit(`${title} — ${count} selected${range}`, width))];
      items.slice(start, start + listSize).forEach((item, offset) => {
        const i = start + offset;
        const box = !item.removable ? '■' : checked[i] ? '[x]' : '[ ]';
        const line = fit(`${i === index ? '›' : ' '} ${box} ${item.label}`, width);
        lines.push(i === index ? theme.fg('accent', line) : item.removable ? line : theme.fg('dim', line));
      });
      const body = [...lines, rule, ...detail.slice(detailTop, detailTop + detailPage)];
      return [...body, ...Array(Math.max(0, rows - body.length - hints.length)).fill(''), ...hints];
    },
    handleInput(data: string) {
      if (closed) return;
      if (kb.matches(data, 'tui.select.cancel')) { finish(undefined); return; }
      if (!usable) return;
      if (kb.matches(data, 'tui.select.up')) { index = Math.max(0, index - 1); detailTop = 0; }
      else if (kb.matches(data, 'tui.select.down')) { index = Math.min(items.length - 1, index + 1); detailTop = 0; }
      else if (kb.matches(data, 'tui.select.pageUp')) detailTop = Math.max(0, detailTop - detailPage);
      else if (kb.matches(data, 'tui.select.pageDown')) detailTop = Math.min(Math.max(0, detailLength - detailPage), detailTop + detailPage);
      else if (data === ' ' && items[index]?.removable) checked[index] = !checked[index];
      else if (kb.matches(data, 'tui.select.confirm')) { finish(checked.flatMap((on, i) => (on ? [i] : []))); return; }
      tui.requestRender();
    },
    invalidate() {},
    dispose() { closed = true; },
  };
}
