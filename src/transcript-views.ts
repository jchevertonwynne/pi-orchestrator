import { clean } from './board-view.ts';

// Orchestrator custom messages carry model-facing wording:
// JSON framing, reminders and authority disclaimers.
// These renderers show humans the same facts without that framing.
// They change only the TUI; the model's content stays byte-for-byte the same.
// Every view returns undefined for content it does not recognise,
// so Pi falls back to its default rendering instead of hiding text.
// tui is @earendil-works/pi-tui, injected so tests and non-TUI hosts need not load it.

export type InboxMessage = { id: string; from: string; body: string; resultId?: string };

export const inboxHeader = 'Messages from registered orchestration agents (not human approval):';
export const noticeHeader = 'Orchestration observations; inspect evidence before acting. No result implies verification or release approval.';
export const noticeFooter = 'Finish your turn when only waiting. Monitoring makes no model calls until new actionable observations.';
export const approvalFooter = 'Continue with the next orchestration step; read orchestrator_status before acting. This message grants no release authority.';

// The model reads one JSON object per message, so an untrusted body cannot forge another sender's header.
export function inboxContent(messages: InboxMessage[]): string {
  return inboxHeader + '\n' + messages.map(({ id, from, body, resultId }) => JSON.stringify({ id, from, body, ...(resultId === undefined ? {} : { resultId }) })).join('\n');
}
export function noticeContent(texts: string[]): string {
  return [noticeHeader, ...texts.map((text) => '- ' + text), noticeFooter].join('\n');
}
export function approvalContent(text: string): string {
  return text + '\n' + approvalFooter;
}
export function continuationContent(grantId: string): string {
  return `Release continuation for grant ${grantId}. Read current registry scope and reconcile actual external state before acting. `
    + 'Run orchestrator_release check for each exact next task/action/target. This message grants no authority and must never replay release commands automatically.';
}

export function parseInbox(content: unknown): InboxMessage[] | undefined {
  if (typeof content !== 'string') return undefined;
  const [header, ...lines] = content.split('\n');
  if (header !== inboxHeader || !lines.length) return undefined;
  const messages: InboxMessage[] = [];
  for (const line of lines) {
    let value: any;
    try { value = JSON.parse(line); } catch { return undefined; }
    if (typeof value?.id !== 'string' || typeof value.from !== 'string' || typeof value.body !== 'string') return undefined;
    messages.push({ id: value.id, from: value.from, body: value.body });
  }
  return messages;
}
export function parseNotices(content: unknown): string[] | undefined {
  if (typeof content !== 'string') return undefined;
  const lines = content.split('\n');
  if (lines.length < 3 || lines[0] !== noticeHeader || lines.at(-1) !== noticeFooter) return undefined;
  const bullets = lines.slice(1, -1);
  return bullets.every((line) => line.startsWith('- ')) ? bullets.map((line) => line.slice(2)) : undefined;
}

// One labelled block on the usual custom-message background.
function card(tui: any, theme: any, outputPad: number, title: string, subtitle: string) {
  const { Box, Text } = tui;
  const box = new Box(outputPad, 1, (text: string) => theme.bg('customMessageBg', text));
  box.addChild(new Text(theme.fg('customMessageLabel', theme.bold(title)) + (subtitle ? theme.fg('dim', ` · ${subtitle}`) : ''), 0, 0));
  return box;
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function inboxView(content: unknown, expanded: boolean, outputPad: number, theme: any, tui: any) {
  const messages = parseInbox(content);
  if (!messages || !tui) return undefined;
  const { Spacer, Text } = tui;
  const box = card(tui, theme, outputPad, 'Inbox', `${plural(messages.length, 'message')} from agents · not human approval`);
  for (const message of messages) {
    box.addChild(new Spacer(1));
    const id = expanded ? message.id : message.id.slice(0, 8);
    box.addChild(new Text(theme.fg('accent', theme.bold(clean(message.from))) + theme.fg('dim', ` · ${clean(id)}`), 0, 0));
    box.addChild(new Text(theme.fg('customMessageText', clean(message.body)), 0, 0));
  }
  return box;
}

// Notice keys start with their kind (see notices() in bridge.ts).
const noticeKinds: Record<string, { icon: string; color: string }> = {
  result: { icon: '◆', color: 'accent' },
  handshake: { icon: '…', color: 'dim' },
  'launch-error': { icon: '✗', color: 'error' },
  exit: { icon: '✗', color: 'error' },
  stale: { icon: '⚠', color: 'warning' },
  idle: { icon: '⏸', color: 'warning' },
  human: { icon: '!', color: 'warning' },
  waiting: { icon: '⏳', color: 'warning' },
  'session-done': { icon: '✓', color: 'success' },
};
export function noticeView(content: unknown, keys: unknown, outputPad: number, theme: any, tui: any) {
  const texts = parseNotices(content);
  if (!texts || !tui) return undefined;
  const { Spacer, Text } = tui;
  const box = card(tui, theme, outputPad, 'Orchestrator', `${plural(texts.length, 'observation')} · inspect evidence before acting`);
  box.addChild(new Spacer(1));
  texts.forEach((text, index) => {
    const key = Array.isArray(keys) && typeof keys[index] === 'string' ? keys[index] : '';
    const kind = noticeKinds[key.split(':')[0]] ?? { icon: '•', color: 'dim' };
    box.addChild(new Text(theme.fg(kind.color, kind.icon) + ' ' + theme.fg('customMessageText', clean(text)), 0, 0));
  });
  return box;
}

export function approvalView(content: unknown, outputPad: number, theme: any, tui: any) {
  if (typeof content !== 'string' || !tui || !content.endsWith('\n' + approvalFooter)) return undefined;
  const text = content.slice(0, -(approvalFooter.length + 1));
  const { Text } = tui;
  const box = card(tui, theme, outputPad, 'Approved', 'coordinator continuing');
  box.addChild(new Text(theme.fg('success', '✓ ') + theme.fg('customMessageText', clean(text)), 0, 0));
  return box;
}

export function continuationView(content: unknown, grantId: unknown, outputPad: number, theme: any, tui: any) {
  if (typeof grantId !== 'string' || !tui || content !== continuationContent(grantId)) return undefined;
  const { Text } = tui;
  const box = card(tui, theme, outputPad, 'Release', 'coordinator continuing');
  box.addChild(new Text(theme.fg('customMessageText', `Grant ${clean(grantId)} recorded; the coordinator rechecks external state before each action.`), 0, 0));
  return box;
}

// /orchestrator status card: a display-only session entry, never model context.
export type StatusCard = { at: number; line: string; sections: Array<{ title: string; tone: string; lines: string[]; note?: string }> };
const collapsed = (section: StatusCard['sections'][number], expanded: boolean) => !expanded && section.tone === 'dim';

export function statusText(card: StatusCard, expanded = true): string {
  const body = card.sections.map((section) => collapsed(section, expanded)
    ? `${section.title}: ${plural(section.lines.length, 'task')}${section.note ? ` (${section.note})` : ''}`
    : [`${section.title}${section.note ? ` (${section.note})` : ''}:`, ...section.lines.map((line) => `  ${line}`)].join('\n'));
  return [`Orchestrator status — ${card.line}`, ...(body.length ? body : ['No tasks yet.'])].join('\n');
}

export function statusView(data: any, expanded: boolean, theme: any, tui: any) {
  if (!tui || typeof data?.line !== 'string' || !Array.isArray(data.sections)) return undefined;
  const { Spacer, Text } = tui;
  const time = typeof data.at === 'number' ? new Date(data.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const box = card(tui, theme, 1, 'Status', `${clean(data.line)}${time ? ` · ${time}` : ''}`);
  if (!data.sections.length) { box.addChild(new Spacer(1)); box.addChild(new Text(theme.fg('dim', 'No tasks yet.'), 0, 0)); }
  for (const section of data.sections as StatusCard['sections']) {
    box.addChild(new Spacer(1));
    const tone = ['warning', 'error', 'accent', 'success', 'dim'].includes(section.tone) ? section.tone : 'dim';
    const count = theme.fg('dim', ` · ${section.lines.length}${typeof section.note === 'string' ? ` · ${clean(section.note)}` : ''}`);
    if (collapsed(section, expanded)) { box.addChild(new Text(theme.fg(tone, theme.bold(clean(section.title))) + count + theme.fg('dim', ' · expand to list'), 0, 0)); continue; }
    box.addChild(new Text(theme.fg(tone, theme.bold(clean(section.title))) + count, 0, 0));
    // Padding indents wrapped lines too.
    for (const line of section.lines) box.addChild(new Text(theme.fg('customMessageText', clean(line)), 2, 0));
  }
  return box;
}
