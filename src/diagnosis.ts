import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { Agent, Registry, Task } from './contracts.ts';

// Optional Jev diagnosis of why an idle worker stopped.
// Requests go over the `jev:classify` event-bus channel to a separately installed Jev extension,
// which owns the API key; without it every request resolves to undefined and texts are unchanged.
// A diagnosis is advisory text for the parent and human, never a state transition or approval.

export type Diagnosis = { label: string; probability: number };
export type EventBus = { emit(channel: string, data: unknown): void };

export const DIAGNOSIS_TIMEOUT_MS = 25_000;
const TAIL_BYTES = 256 * 1024;
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max - 1) + '…' : value);

const QUESTIONS = {
  state: {
    type: 'choice',
    instructions: 'An orchestrated coding agent has been idle for `idle_minutes` while its task is unfinished. '
      + 'Using its task, latest note and `last_message`, why has it stopped?',
    criteria: {
      waiting_on_human: 'its last message asks a person a question, or for approval, credentials or a decision',
      done_unreported: 'its last message says the work is finished, but no result has been recorded',
      blocked_unrecorded: 'it hit an error, failing check or missing access and stopped without recording a blocker',
      paused_midway: 'the work is unfinished and it ended its turn without a blocker; a reminder of the next step should resume it',
    },
  },
} as const;

// One idle episode: a new activity timestamp or generation starts a new diagnosis.
export const episodeKey = (agent: Agent) => `${agent.id}:${agent.generation}:${agent.activityAt}`;

// Text of the last assistant message in a Pi session transcript, read from the file's tail.
export function lastAssistantText(sessionFile: string | undefined, maxChars = 1_500): string {
  if (!sessionFile) return '';
  let fd: number | undefined;
  try {
    fd = openSync(sessionFile, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: any;
      try { entry = JSON.parse(lines[i]); } catch { continue; }
      if (entry?.type !== 'message' || entry.message?.role !== 'assistant') continue;
      const content = entry.message.content;
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('\n') : '';
      if (text.trim()) return text.length > maxChars ? '…' + text.slice(-(maxChars - 1)) : text;
    }
  } catch { /* An unreadable transcript only weakens the diagnosis. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return '';
}

// Bounded, derived facts only: no registry paths, messages, tokens or release evidence.
export function idleFacts(state: Registry, agent: Agent, task: Task, idleMs: number, lastMessage: string) {
  return {
    role: agent.role,
    task_title: clip(task.title, 200),
    task_state: task.state,
    latest_note: clip(task.summary?.text ?? '', 300),
    recorded_result: task.result?.status ?? 'none',
    has_pr: Boolean(state.releases[task.id]?.pr),
    merged: Boolean(state.releases[task.id]?.mergedCommit),
    idle_minutes: Math.floor(idleMs / 60_000),
    last_message: lastMessage,
  };
}

export function diagnosisText(diagnosis: Diagnosis | null | undefined): string {
  return diagnosis ? ` Jev: likely ${diagnosis.label.replaceAll('_', ' ')} (p=${diagnosis.probability.toFixed(2)}); advisory only.` : '';
}

// Resolves undefined when no Jev listener accepts the request, it fails, or it times out.
export function requestDiagnosis(events: EventBus | undefined, facts: unknown, timeoutMs = DIAGNOSIS_TIMEOUT_MS): Promise<Diagnosis | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Diagnosis | undefined) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    const request = {
      accepted: false,
      state: facts,
      questions: QUESTIONS,
      reply(error: unknown, result?: { answers?: Record<string, any> }) {
        const answer = result?.answers?.state;
        if (error || answer?.type !== 'choice' || !(answer.choice in QUESTIONS.state.criteria)) return finish(undefined);
        const probability = answer.probabilities?.[answer.choice];
        finish({ label: answer.choice, probability: Number.isFinite(probability) ? probability : answer.confidence ?? 0 });
      },
    };
    try { events?.emit('jev:classify', request); } catch { /* Listener errors leave the diagnosis empty. */ }
    // Listeners accept synchronously, so an unaccepted request means Jev is not installed.
    if (!request.accepted) finish(undefined);
  });
}
