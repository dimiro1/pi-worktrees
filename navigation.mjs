import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalPath } from './manager.mjs';

// Each suspended parent owns a private mailbox. Children only ask it to return;
// no process changes cwd or opens a second copy of a suspended conversation.
export function returnToParent(target, parents, mailbox) {
  const path = canonicalPath(target);
  const index = parents.findIndex(parent => canonicalPath(parent) === path);
  if (index < 0) return false;
  if (mailbox) writeFileSync(mailbox, parents[index], { mode: 0o600 });
  else if (index !== parents.length - 1) {
    throw new Error('Reload the worktree extension in suspended sessions first, or use /quit to return.');
  }
  return true;
}

export function createMailbox() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-worktree-return-'));
  const path = join(directory, 'target');
  writeFileSync(path, '', { mode: 0o600 });
  return {
    path,
    read: () => readFileSync(path, 'utf8'),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}
