import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, access } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, relative, isAbsolute } from 'node:path';

const exec = promisify(execFile);
import { cities } from './cities.ts';
export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head?: string;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
  bare: boolean;
}
interface CreateOptions {
  name?: string;
  base?: string;
  branch?: string;
  prefix?: string;
  existing?: boolean;
}

export const randomName = () => cities[randomInt(cities.length)];
export function validateName(name) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(name)) throw new Error('Names must be 1–80 letters, digits, hyphens or underscores; no paths.');
  return name;
}
export function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel));
}
export function canonicalPath(path: string): string {
  path = resolve(path);
  try { return realpathSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    // A suspended session's subdirectory may have disappeared; its symlinked
    // ancestors still identify the checkout that must remain protected.
    const parent = dirname(path);
    return parent === path ? path : join(canonicalPath(parent), basename(path));
  }
}
export function currentWorktree(trees: WorktreeInfo[], cwd: string): WorktreeInfo | undefined {
  const path = canonicalPath(cwd);
  return trees.filter(w => !w.bare && inside(canonicalPath(w.path), path))
    .sort((a, b) => canonicalPath(b.path).length - canonicalPath(a.path).length)[0];
}
export function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Cancelled before worktree operation.');
}
export function parseWorktrees(text: string): WorktreeInfo[] {
  const result: WorktreeInfo[] = [];
  let item: WorktreeInfo | undefined;
  for (const field of text.split('\0')) {
    if (field.startsWith('worktree ')) { item = { path: field.slice(9), branch: null, locked: false, prunable: false, bare: false }; result.push(item); }
    else if (item && field.startsWith('branch ')) item.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (item && field.startsWith('HEAD ')) item.head = field.slice(5);
    else if (item && (field === 'locked' || field.startsWith('locked '))) { item.locked = true; item.lockReason = field.slice(7); }
    else if (item && (field === 'prunable' || field.startsWith('prunable '))) item.prunable = true;
    else if (item && field === 'bare') item.bare = true;
  }
  return result;
}
export class Worktrees {
  cwd: string;
  signal?: AbortSignal;
  constructor(cwd: string, { signal }: { signal?: AbortSignal } = {}) { this.cwd = cwd; this.signal = signal; }
  async git(...args: string[]): Promise<string> {
    // Do not interrupt a mutation already handed to Git: cancellation is not rollback.
    checkCancelled(this.signal);
    try {
      const { stdout, stderr } = await exec('git', ['-C', this.cwd, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      return args[0] === 'worktree' && args[1] === 'prune' ? stdout + stderr : stdout;
    } catch (error) {
      const failure = error as Error & { stderr?: string };
      throw new Error(failure.stderr?.trim() || failure.message);
    }
  }
  async list() { return parseWorktrees(await this.git('worktree', 'list', '--porcelain', '-z')); }
  async current() {
    const root = canonicalPath((await this.git('rev-parse', '--show-toplevel')).trim());
    return (await this.list()).find(w => !w.bare && canonicalPath(w.path) === root);
  }
  async root() {
    const common = (await this.git('rev-parse', '--path-format=absolute', '--git-common-dir')).trim();
    const first = (await this.list())[0];
    const hash = createHash('sha256').update(common).digest('hex').slice(0, 8);
    return join(dirname(first.path), '.pi-worktrees', `${basename(first.path).replace(/[^a-zA-Z0-9_-]/g, '-')}-${hash}`);
  }
  async find(selector) {
    const all = await this.list();
    if (selector === 'main') return all[0];
    const path = canonicalPath(resolve(this.cwd, selector));
    const exact = all.filter(w => canonicalPath(w.path) === path);
    if (exact.length === 1) return exact[0];
    const matches = all.filter(w => basename(w.path) === selector || w.branch === selector);
    if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous worktree: ${selector}. Use its absolute path.` : `No worktree matches: ${selector}`);
    return matches[0];
  }
  async protect(item) {
    const main = (await this.list())[0];
    if (item.path === main.path) throw new Error('The primary worktree cannot be moved or removed.');
    const cwd = canonicalPath(this.cwd);
    const path = canonicalPath(item.path);
    if (inside(path, cwd)) throw new Error('Cannot move or remove this session’s worktree. Switch back with /quit first.');
    const parents = JSON.parse(process.env.PI_WORKTREE_PARENTS || '[]');
    if (parents.some(parent => inside(path, canonicalPath(parent)))) throw new Error('A suspended parent Pi session uses this worktree. Return with /quit first.');
    if (item.locked) throw new Error('Worktree is locked. Unlock it explicitly first.');
  }
  async prefix(value?: string) {
    if (value === undefined) return (await this.git('config', '--local', '--default', 'pi/', '--get', 'pi.worktreeBranchPrefix')).trim();
    const prefix = value && !value.endsWith('/') ? `${value}/` : value;
    await this.git('check-ref-format', '--branch', `${prefix}example`);
    await this.git('config', '--local', 'pi.worktreeBranchPrefix', prefix);
    return prefix;
  }
  async create({ name, base = 'HEAD', branch, prefix, existing = false }: CreateOptions = {}) {
    if (existing && !branch) throw new Error('--existing requires --branch.');
    if (prefix !== undefined && (branch !== undefined || existing)) throw new Error('--prefix cannot combine with --branch or --existing.');
    if (branch === undefined) {
      prefix ??= await this.prefix();
      if (prefix && !prefix.endsWith('/')) prefix += '/';
      await this.git('check-ref-format', '--branch', `${prefix}example`);
    }
    const trees = await this.list();
    const root = await this.root();
    if (name === undefined) {
      const usedNames = new Set(trees.map(w => basename(w.path)));
      const branches = new Set((await this.git('for-each-ref', '--format=%(refname:short)', 'refs/heads/')).trim().split('\n'));
      const available = cities.filter(city => !usedNames.has(city) && (existing || branch || !branches.has(`${prefix}${city}`)));
      while (available.length) {
        const candidate = available.splice(randomInt(available.length), 1)[0];
        try { await access(join(root, candidate)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          name = candidate;
          break;
        }
      }
      if (!name) throw new Error('All 200 city names are in use. Supply a custom worktree name.');
    }
    validateName(name);
    if (trees.some(w => basename(w.path) === name)) throw new Error(`Worktree name already exists: ${name}`);
    const path = join(root, name);
    branch ??= `${prefix}${name}`;
    await this.git('check-ref-format', '--branch', branch);
    if (existing) {
      const ref = `refs/heads/${branch}`;
      const refs = (await this.git('for-each-ref', '--format=%(refname)', '--', ref)).trim().split('\n');
      if (!refs.includes(ref)) throw new Error(`--existing requires an existing local branch: ${branch}`);
    }
    checkCancelled(this.signal);
    await mkdir(root, { recursive: true });
    // Resolve the base before passing it to worktree add: it must be a commit, not an option.
    if (existing) await this.git('worktree', 'add', '--', path, branch);
    else {
      const commit = (await this.git('rev-parse', '--verify', '--end-of-options', `${base}^{commit}`)).trim();
      await this.git('worktree', 'add', '-b', branch, '--', path, commit);
    }
    return this.find(path);
  }
  async status(selector) {
    const item = await this.find(selector);
    const git = new Worktrees(item.path, { signal: this.signal });
    return { ...item, status: await git.git('status', '--short'), summary: await git.git('status', '--short', '--branch') };
  }
  async rename(selector, name) {
    validateName(name);
    const item = await this.find(selector);
    await this.protect(item);
    if ((await this.list()).some(w => basename(w.path) === name)) throw new Error(`Worktree name already exists: ${name}`);
    const target = join(dirname(item.path), name);
    await this.git('worktree', 'move', '--', item.path, target);
    return { ...(await this.find(target)), note: 'Directory renamed; branch name unchanged. Use branch to rename it separately.' };
  }
  async renameBranch(selector, name) {
    const item = await this.find(selector);
    if (!item.branch) throw new Error('Detached worktrees have no branch to rename.');
    await this.git('check-ref-format', '--branch', name);
    await this.git('branch', '-m', item.branch, name);
    return this.find(item.path);
  }
  async remove(selector, { force = false, deleteBranch = false } = {}) {
    const item = await this.find(selector);
    await this.protect(item);
    await this.git('worktree', 'remove', ...(force ? ['--force'] : []), '--', item.path);
    let note = 'Branch preserved.';
    if (deleteBranch && item.branch) {
      try { await this.git('branch', '-d', '--', item.branch); note = 'Merged branch deleted.'; }
      catch (error) { note = `Worktree removed; branch preserved: ${(error as Error).message}`; }
    }
    return { removed: item.path, branch: item.branch, note };
  }
  async lock(selector, reason) {
    const item = await this.find(selector);
    await this.git('worktree', 'lock', ...(reason ? ['--reason', reason] : []), '--', item.path);
    return this.find(item.path);
  }
  async unlock(selector) {
    const item = await this.find(selector);
    await this.git('worktree', 'unlock', '--', item.path);
    return this.find(item.path);
  }
  async prune(apply = false) { return this.git('worktree', 'prune', '--verbose', ...(apply ? [] : ['--dry-run'])); }
}

// Small argv reader, not a shell: quotes group paths; nothing is expanded or executed.
export function words(input: string): string[] {
  const result: string[] = [];
  let word = '', quote = '', started = false;
  for (const ch of input.trim()) {
    if (quote) { if (ch === quote) quote = ''; else word += ch; started = true; }
    else if (ch === '"' || ch === "'") { quote = ch; started = true; }
    else if (/\s/.test(ch)) { if (started) { result.push(word); word = ''; started = false; } }
    else { word += ch; started = true; }
  }
  if (quote) throw new Error('Unclosed quote.');
  if (started) result.push(word);
  return result;
}
export function options(args: string[], allowed: Record<string, string>) {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (!(key in allowed)) throw new Error(`Unknown option: ${arg}`);
    if (allowed[key] === 'value') {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}`);
      flags[key] = args[++i];
    } else flags[key] = true;
  }
  return { positional, flags };
}
