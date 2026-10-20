import { basename } from 'node:path';
import { canonicalPath, currentWorktree } from './manager.mjs';

// Git paths and branch names are data, not Markdown (or terminal escape sequences).
const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ');
const escape = value => clean(value).replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&');
const code = value => `\`${clean(value).replace(/`/g, '\\`')}\``;

function describe(item, current, primary = false) {
  const labels = [];
  if (current) labels.push('current');
  if (primary) labels.push('primary');
  if (item.locked) labels.push('locked');
  if (item.prunable) labels.push('stale');
  if (item.bare) labels.push('bare repository');
  const branch = item.branch ? escape(item.branch) : `detached${item.head ? ` at ${escape(item.head.slice(0, 8))}` : ''}`;
  const lines = [`**${escape(basename(item.path))}** — ${branch}${labels.length ? ` · ${labels.join(' · ')}` : ''}`, code(item.path)];
  if (item.locked && item.lockReason) lines.push(`Lock: ${escape(item.lockReason)}`);
  return lines.join('  \n');
}

export function humanResult(action, result, cwd, trees) {
  if (typeof result === 'string') return result === 'Cancelled.' ? 'Cancelled — no changes made.' : result;
  if (Array.isArray(result)) {
    if (!result.length) return 'No worktrees found.';
    const current = cwd ? currentWorktree(result, cwd) : undefined;
    return `**${result.length} worktree${result.length === 1 ? '' : 's'}**\n\n` + result.map((item, index) => describe(item, item === current, index === 0)).join('\n\n');
  }
  if (result?.removed) return `**Worktree removed**\n\n${code(result.removed)}\n\nBranch: ${escape(result.branch ?? '(detached)')}  \n${escape(result.note)}`;
  if (result?.path) {
    const titles = { create: 'Worktree created', rename: 'Worktree renamed', branch: 'Branch renamed', lock: 'Worktree locked', unlock: 'Worktree unlocked', status: 'Worktree status' };
    const current = cwd ? currentWorktree(trees ?? [result], cwd) : undefined;
    const isCurrent = !!current && canonicalPath(current.path) === canonicalPath(result.path);
    const lines = [`**${titles[action] ?? 'Worktree'}**`, describe(result, isCurrent)];
    if ('status' in result) {
      const tracking = result.summary?.split('\n')[0]?.replace(/^## /, '');
      if (tracking) lines.push(`Git: ${escape(tracking)}`);
      if (!result.status.trim()) lines.push('Working tree is clean.');
      else lines.push(`Local changes:\n\n\`\`\`text\n${result.status.replace(/\x1b/g, '').replace(/`/g, '\u02cb').trimEnd()}\n\`\`\``);
    }
    if (result.note) lines.push(escape(result.note));
    if (action === 'create') lines.push(`Open it with /wt switch ${escape(basename(result.path))}`);
    return lines.join('\n\n');
  }
  return result == null ? 'Done.' : escape(String(result));
}
