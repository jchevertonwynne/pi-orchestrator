import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

// Pi can expose in-memory branch entries before its first transcript flush.
// Index only durable receipt IDs, incrementally and with bounded reads per tick.
export class ReceiptIndex {
  private path?: string;
  private inode?: string;
  private offset = 0;
  private partial = '';
  private skipping = false;
  private ids = new Set<string>();

  clear() {
    this.path = this.inode = undefined;
    this.offset = 0; this.partial = ''; this.skipping = false; this.ids.clear();
  }

  scan(path?: string): void {
    if (!path) { this.clear(); return; }
    let fd: number;
    try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: any) { this.clear(); if (error.code === 'ENOENT') return; throw error; }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) { this.clear(); throw new Error('Transcript is not a regular file'); }
      const inode = `${stat.dev}:${stat.ino}`;
      if (this.path !== path || this.inode !== inode || stat.size < this.offset) {
        this.clear(); this.path = path; this.inode = inode;
      }
      const buffer = Buffer.alloc(Math.min(4 * 1024 * 1024, stat.size - this.offset));
      if (!buffer.length) return;
      const size = readSync(fd, buffer, 0, buffer.length, this.offset);
      this.offset += size;
      // Relevant receipt fields are ASCII; UTF-8 splits in message text do not alter IDs.
      const lines = (this.partial + buffer.subarray(0, size).toString('utf8')).split('\n');
      this.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (this.skipping) { this.skipping = false; continue; }
        if (line.length > 1024 * 1024) continue;
        try {
          const entry = JSON.parse(line);
          if (typeof entry.id === 'string' && ['custom_message', 'custom'].includes(entry.type)
            && typeof entry.customType === 'string' && entry.customType.startsWith('pi-orchestrator-')) this.ids.add(entry.id);
        } catch { /* A malformed line is not a delivery receipt. */ }
      }
      if (this.partial.length > 1024 * 1024) { this.partial = ''; this.skipping = true; }
    } finally { closeSync(fd); }
  }

  has(entry: { id?: string }): boolean { return !!entry.id && this.ids.has(entry.id); }
}
