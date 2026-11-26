import type { ProcessRunner } from './contracts.ts';
import { run } from './runtime.ts';

// Best-effort local feedback only; never delay monitoring or surface player errors.
export async function playAlertSound(level: 'info' | 'warning', options: {
  platform?: string; env?: NodeJS.ProcessEnv; runner?: ProcessRunner;
} = {}): Promise<void> {
  if ((options.platform ?? process.platform) !== 'darwin' || (options.env ?? process.env).PI_ORCHESTRATOR_SOUNDS === '0') return;
  const file = level === 'warning' ? '/System/Library/Sounds/Ping.aiff' : '/System/Library/Sounds/Hero.aiff';
  try { await (options.runner ?? run)('/usr/bin/afplay', [file], { timeout: 5_000 }); }
  catch { /* Missing player/sound, timeout and playback failures are intentionally silent. */ }
}
