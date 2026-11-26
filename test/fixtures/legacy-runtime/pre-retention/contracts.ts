// Shared protocol: no persisted credentials and no product-specific deployment commands.
export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export const SCHEMA_VERSION = 1;
// Only WIP-bearing snapshots advance; older runtimes reject them instead of dropping authority.
export const PUBLICATION_VERSION = 2;
// Only snapshots carrying local-install bundles advance; older runtimes reject them
// instead of installing a bundle as a singleton or dropping its delivery receipt.
// Bundle-aware snapshots also accept the WIP ledger.
export const BUNDLE_VERSION = 3;
export type Role = 'coordinator' | 'planner' | 'implementer' | 'reviewer' | 'release';
// light: feature owners ship their own work; strict: coordinator-verified serial releases.
// Registries created before profiles existed are strict.
export type Profile = 'light' | 'strict';
// Live subagents per orchestrator, orchestrators per fork family,
// idle thresholds for nudging a parent then alerting the human,
// and how long a busy agent may go without progress, or leave a delivered message unacknowledged, before both are told.
export const LIMITS = { agents: 10, family: 3, idleMs: 10 * 60_000, escalateMs: 20 * 60_000, stallMs: 10 * 60_000, ackMs: 5 * 60_000 } as const;
// An independent orchestrator started in its own tab; the parent keeps only this pointer.
export type Fork = { name: string; root: string; session: string; tabId: number; createdAt: number };
export type Summary = { text: string; needsHuman: boolean; by: string; at: number };
export type TaskState = 'planned' | 'approved' | 'implementing' | 'blocked' | 'ready' | 'verified' | 'merged' | 'deployed' | 'skipped';
export type Result = { id: string; status: 'ready' | 'blocked' | 'failed'; commit?: string; report: string; evidence: string[]; createdAt: number };
// ships: false marks design, research, review or investigation work: it finishes at ready (light) or verified (gated) and is never released.
export type Task = { id: string; title: string; state: TaskState; planPath: string; planHash: string; dependencies: string[]; parentTask?: string; risky?: boolean; ships?: false; summary?: Summary; approval?: { hash: string; source: string; at: number }; result?: Result; verification?: { commit?: string; planHash: string; evidence: string[]; at: number }; history: Array<{ state: TaskState; at: number; note: string }> };
// progressAt: the worker's latest turn, tool, streamed tool output or message event; currentTool: its longest-running tool call, if any.
// currentTool.until: when that call's own declared timeout expires, so a long call within its budget is not a stall.
export type Agent = { id: string; role: Role; parentId?: string; taskId?: string; model: string; thinking?: Thinking; generation: string; lifecycle: 'registered' | 'starting' | 'running' | 'exited' | 'collected' | 'closed'; repo?: string; base?: string; branch?: string; worktree: string; sessionDir: string; piSessionId: string; sessionFile?: string; zellijSession?: string; tabId?: number; paneId?: string; homeSession?: string; homePaneId?: string; pid?: number; heartbeatAt?: number; activity?: 'busy' | 'idle'; activityAt?: number; progressAt?: number; currentTool?: { name: string; since: number; until?: number }; collectedReport?: string; launchError?: string };
// resultId: the sender declares this message a redundant handoff of its own task's exact current result.
// Older runtimes ignore the field and treat the message as ordinary, which only costs an extra wake.
export type Message = { id: string; from: string; to: string; generation: string; kind: 'message' | 'shutdown'; mode: 'followUp' | 'steer'; body: string; resultId?: string; createdAt: number; deliveredAt?: number; acknowledgedAt?: number };
export type Resource = { id: string; kind: 'migration' | 'port' | 'compose' | 'file'; scope: string; value: string; taskId: string; releasedAt?: number };
// One exact verified shipping result that another task's single local installation delivers.
// The coordinator names each one; nothing is inferred from dependencies or ancestry.
export type IncludedResult = { taskId: string; resultId: string; commit: string };
export type IncludedScope = IncludedResult & { title: string; planPath: string; planHash: string };
// included: the bundle frozen at claim (or attached by a confirmed historical reconciliation);
// with installedCommit it is the receipt that those results were delivered, counted once each.
export type Release = { taskId: string; owner: string; token: string; commit: string; stage: 'claimed' | 'pr' | 'merged' | 'deployed' | 'installed' | 'cleaned' | 'blocked'; route?: 'pr' | 'local-install'; installationTarget?: string; installedCommit?: string; included?: IncludedScope[]; reconciliation?: { grantId: string; by: string; at: number; evidence: string[] }; pr?: string; mergedCommit?: string; deployedCommit?: string; evidence: string[]; updatedAt: number };
export type ReleaseOperation = 'pr' | 'merge' | 'deploy' | 'local-install';
// reconcile-install attaches included results to an existing installed receipt; it is never an operation.
// repoPath names the canonical checkout whose history supports each included commit.
export type ReleaseProposal = { taskId: string; action: ReleaseOperation | 'reconcile-install'; deploymentTarget?: string; installationTarget?: string; commit?: string; repoPath?: string; includes?: IncludedResult[] };
export type ReleaseScope = Omit<ReleaseProposal, 'includes'> & { title: string; planPath: string; planHash: string; includes?: IncludedScope[] };
export type ReleaseGrant = {
  id: string; root: string; scope: ReleaseScope[]; source?: string;
  confirmation: { kind: 'tui'; coordinator: string; generation: string; sessionId: string; sessionFile: string; branchAnchor: string | null;
    origin: 'slash' | 'tool'; toolCallId?: string; at: number; displayedScope: string; digest: string };
  continuation?: { acknowledgedAt?: number };
};
export type PublicationProposal = {
  taskId: string; operation: 'create' | 'update'; commit: string; repoPath: string; repository: string;
  headBranch: string; baseBranch: string; pr?: string; draft: true; findings: string;
};
export type PublicationScope = PublicationProposal & {
  title: string; planPath: string; planHash: string; taskState: 'implementing' | 'ready' | 'blocked';
  contextHash: string; blockers: string;
};
export type PublicationGrant = {
  id: string; root: string; scope: PublicationScope;
  confirmation: Omit<ReleaseGrant['confirmation'], 'origin'> & { origin: 'tool'; toolCallId: string };
};
export type PublicationObservation = {
  commit: string; repository: string; headBranch: string; baseBranch: string; pr: string; draft: true;
};
export type PublicationRecord = { grantId: string; by: string; at: number; observed: PublicationObservation; evidence: string[] };
export type PublicationAction =
  | { action: 'check'; grantId: string; scope: PublicationProposal }
  | { action: 'record'; grantId: string; scope: PublicationProposal; observed: PublicationObservation; evidence: string[] };
export type Registry = { version: number; publicationGrants?: PublicationGrant[]; publications?: PublicationRecord[]; revision: number; createdAt: number; profile?: Profile; family?: string; forks?: Fork[]; tasks: Record<string, Task>; agents: Record<string, Agent>; messages: Message[]; resources: Resource[]; releases: Record<string, Release>; releaseAuthorization?: { source: string; at: number }; releaseGrants?: ReleaseGrant[]; releaseLock?: { owner: string; token: string; taskId: string }; notifications: Record<string, string[]>; sharedSession?: { name: string; ownerId: string; closedAt?: number } };
export interface Store { root: string; read(): Registry; transact<T>(fn: (state: Registry) => T): T; close(): void }
export type TaskAction =
  // planText: the runtime writes it to <run>/plans/<task>.md instead of reading planPath.
  | { action: 'create'; id: string; title: string; planPath?: string; planText?: string; dependencies?: string[]; parentTask?: string; risky?: boolean; ships?: boolean }
  | { action: 'note'; id: string; summary: string; needsHuman?: boolean }
  | { action: 'approve'; id: string; source: string; expectedHash?: string }
  | { action: 'start'; id: string }
  | { action: 'skip'; id: string; reason: string }
  // reportText: the runtime writes it to <run>/reports/<task>/report.md, so read-only roles can report without repository writes.
  | { action: 'result'; id: string; status: 'ready' | 'blocked' | 'failed'; commit?: string; report?: string; reportText?: string; evidence?: string[] }
  | { action: 'verify'; id: string; commit: string; evidence: string[] };
export type ResourceAction = { action: 'reserve'; kind: Resource['kind']; scope?: string; value: string; taskId: string } | { action: 'release'; id: string };
// Light registries may pass taskIds instead of taskId to check, claim or record several releases at once.
export type ReleaseAction =
  | { action: 'claim'; taskId: string; taskIds?: string[]; operation?: 'local-install'; installationTarget?: string; commit?: string; includes?: IncludedResult[] }
  | { action: 'check'; taskId: string; taskIds?: string[]; token?: string; operation: ReleaseOperation; deploymentTarget?: string; installationTarget?: string; commit?: string }
  | { action: 'lock'; taskId: string; token?: string; deploymentTarget?: string }
  | { action: 'record'; taskId: string; taskIds?: string[]; token?: string; deploymentTarget?: string; installationTarget?: string; installedCommit?: string; stage: 'pr' | 'merged' | 'deployed' | 'installed' | 'cleaned' | 'blocked'; pr?: string; mergedCommit?: string; deployedCommit?: string; evidence: string[] }
  | { action: 'unlock'; taskId: string; token?: string; reason: string }
  // Records historical delivery under a confirmed reconcile-install grant; executes and authorizes nothing.
  | { action: 'reconcile'; taskId: string; grantId: string; includes: IncludedResult[]; evidence: string[] };
export type SpawnInput = { id: string; taskId: string; role: Exclude<Role, 'coordinator'>; repo: string; base: string; branch: string; worktree: string; prompt: string; model?: string; thinking?: Thinking };
export type ProcessRunner = (command: string, args: string[], options?: { cwd?: string; timeout?: number; maxBuffer?: number }) => Promise<{ stdout: string; stderr: string }>;
