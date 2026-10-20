import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { Markdown } from '@earendil-works/pi-tui';
// Keep runtime helpers in .ts: Pi can reload them without Node's native ESM cache.
import { Worktrees, words, options, canonicalPath, currentWorktree, checkCancelled } from './manager.ts';
import { humanResult } from './format.ts';
import { createMailbox, returnToParent } from './navigation.ts';

const HELP = `Worktrees — /worktree or /wt

create [name] [--base REF] [--branch BRANCH | --prefix PREFIX] [--existing] [--switch]
  Random unused world city when omitted; branch uses saved prefix (default pi/).
  --existing requires --branch and checks out that existing local branch.
prefix [value]               Show/save repository branch prefix; trailing / optional
list                         List paths, branches, locks and stale entries
switch [name|branch|path]     Pick a worktree and open/resume Pi there
status [selector]            Git status (defaults to this checkout)
path [selector]              Show an absolute path
rename <selector> <name>     Move directory; branch name is preserved
branch <selector> <branch>   Rename its branch without forcing
remove <selector> [--force] [--delete-branch]
  Confirms first. Branch preserved unless --delete-branch (Git -d, never -D).
lock <selector> [--reason TEXT]
unlock <selector>
prune [--apply]              Preview stale registration cleanup; confirm to apply
help

Selectors: directory name, branch, absolute path, or 'main' (primary checkout).
Switch opens an isolated Pi session; /quit returns to the previous session.
Switching to a suspended parent resumes it, closing intervening sessions.
Use switch --fresh <selector> for a new session instead of --continue (not a suspended parent).
No files, dependencies, secrets, hooks or uncommitted changes are copied.

Output is human-readable by default. Add --json to any command for raw JSON.
/wt --json lists worktrees without opening a menu. The agent tool always returns
structured results, with a readable display in the terminal.
Menus follow Pi selection keybindings: Up/Down to move; Enter selects, Esc cancels.`;

async function selected(manager: Worktrees, ctx: ExtensionContext, title: string) {
  if (!ctx.hasUI) throw new Error('Supply a worktree selector in non-interactive mode.');
  const trees = await manager.list();
  const labels = trees.filter(w => !w.bare && !w.prunable).map(w => `${w.branch ?? '(detached)'} — ${w.path}`);
  const choice = await ctx.ui.select(title, labels);
  return choice ? trees.find(w => `${w.branch ?? '(detached)'} — ${w.path}` === choice)?.path : undefined;
}

async function openWorktree(path: string, fresh: boolean, ctx: ExtensionCommandContext) {
  if (ctx.mode !== 'tui') throw new Error(`Switch requires Pi's terminal UI. Start Pi with cwd ${path}.`);
  const manager = new Worktrees(ctx.cwd);
  const item = await manager.find(path);
  if (item.bare || item.prunable) throw new Error('Cannot open a bare or missing worktree.');
  path = canonicalPath(item.path);
  const current = await manager.current();
  if (!current) throw new Error('No current worktree.');
  const currentPath = canonicalPath(current.path);
  if (path === currentPath) throw new Error('You are already in this worktree.');
  const trees = await manager.list();
  const parents: string[] = JSON.parse(process.env.PI_WORKTREE_PARENTS || '[]')
    .map((parent: string) => canonicalPath(currentWorktree(trees, parent)?.path ?? parent));
  const suspended = parents.includes(path);
  if (suspended && fresh) throw new Error('That worktree has a suspended session. Omit --fresh to resume it.');
  if (returnToParent(path, parents, process.env.PI_WORKTREE_RETURN)) {
    ctx.shutdown();
    return;
  }
  const mailbox = createMailbox();
  let returnTarget = '';
  // A session's tools capture cwd at construction. chdir() would silently leave them behind.
  const code = await ctx.ui.custom<number | null>((tui, _theme, _keys, done) => {
    tui.stop();
    let code: number | null = 1;
    try {
      process.stdout.write('\x1b[2J\x1b[H');
      const args = fresh ? [] : ['--continue'];
      // The installed CLI entry point is preserved across Pi upgrades and avoids a shell.
      const result = spawnSync(process.execPath, [process.argv[1], ...args], {
        cwd: path, stdio: 'inherit', env: { ...process.env, PI_WORKTREE_PARENTS: JSON.stringify([...parents, currentPath]), PI_WORKTREE_RETURN: mailbox.path },
      });
      if (result.error) throw result.error;
      code = result.status;
    } finally {
      try { returnTarget = mailbox.read(); }
      finally {
        mailbox.dispose();
        tui.start();
        tui.requestRender(true);
        done(code);
      }
    }
    return { render: () => [], invalidate() {} };
  });
  if (returnTarget && canonicalPath(returnTarget) !== currentPath) {
    if (!returnToParent(returnTarget, parents, process.env.PI_WORKTREE_RETURN)) {
      throw new Error('The requested suspended session is no longer in this process chain.');
    }
    ctx.shutdown();
    return;
  }
  if (code !== 0) ctx.ui.notify(`Worktree Pi exited with status ${code ?? 'signal'}.`, 'warning');
}

async function run(args: string[], ctx: ExtensionContext, commandCtx?: ExtensionCommandContext, signal?: AbortSignal): Promise<unknown> {
  checkCancelled(signal);
  const manager = new Worktrees(ctx.cwd, { signal });
  const action = args.shift() || 'help';
  const definitions: Record<string, Record<string, string>> = {
    help: {}, list: {}, create: { base: 'value', branch: 'value', prefix: 'value', existing: 'flag', switch: 'flag' },
    switch: { fresh: 'flag' }, status: {}, path: {}, rename: {}, branch: {}, prefix: {},
    remove: { force: 'flag', 'delete-branch': 'flag' }, lock: { reason: 'value' }, unlock: {}, prune: { apply: 'flag' },
  };
  if (!definitions[action]) throw new Error(`Unknown action: ${action}. Use /wt help.`);
  const { positional: pos, flags } = options(args, definitions[action]);
  const valueFlag = (name: string) => {
    const value = flags[name];
    return typeof value === 'string' ? value : undefined;
  };
  const arity: Record<string, [number, number]> = { help: [0, 0], list: [0, 0], prefix: [0, 1], create: [0, 1], switch: [0, 1], status: [0, 1], path: [0, 1], rename: [2, 2], branch: [2, 2], remove: [1, 1], lock: [1, 1], unlock: [1, 1], prune: [0, 0] };
  if (pos.length < arity[action][0] || pos.length > arity[action][1]) throw new Error(`Wrong arguments for ${action}. Use /wt help.`);
  if (action === 'help') return HELP;
  if (action === 'list') return manager.list();
  if (action === 'prefix') return `Repository branch prefix: ${JSON.stringify(await manager.prefix(pos[0]))}`;
  if (action === 'create') {
    if (flags.existing && (!flags.branch || flags.base !== undefined)) throw new Error('--existing requires --branch and cannot combine with --base.');
    if (flags.switch && !commandCtx) throw new Error('Use /wt create --switch in the terminal; tools cannot switch sessions.');
    const item = await manager.create({ name: pos[0], base: valueFlag('base'), branch: valueFlag('branch'), prefix: valueFlag('prefix'), existing: !!flags.existing });
    ctx.ui.notify(`Created ${item.branch} at ${item.path}`, 'info');
    if (flags.switch) await openWorktree(item.path, false, commandCtx!);
    return item;
  }
  if (action === 'switch') {
    if (!commandCtx) throw new Error('Use /wt switch in the terminal. Tools cannot switch the user’s session.');
    const selector = pos[0] ?? await selected(manager, ctx, 'Switch worktree (/quit to return)');
    if (!selector) return 'Cancelled.';
    const item = await manager.find(selector);
    if (item.bare || item.prunable) throw new Error('Cannot open a bare or missing worktree.');
    await openWorktree(item.path, !!flags.fresh, commandCtx);
    return `Returned from ${item.path}`;
  }
  if (action === 'status' || action === 'path') {
    const current = await manager.current();
    const selector = pos[0] ?? current?.path;
    if (!selector) throw new Error('No current worktree. Supply a selector.');
    return action === 'path' ? (await manager.find(selector)).path : manager.status(selector);
  }
  if (action === 'rename') return manager.rename(pos[0], pos[1]);
  if (action === 'branch') return manager.renameBranch(pos[0], pos[1]);
  if (action === 'lock') return manager.lock(pos[0], valueFlag('reason'));
  if (action === 'unlock') return manager.unlock(pos[0]);
  if (action === 'remove') {
    const item = await manager.find(pos[0]);
    await manager.protect(item);
    if (!ctx.hasUI) throw new Error('Removal requires interactive confirmation. No files were removed.');
    const confirmed = await ctx.ui.confirm('Remove worktree?', `${item.path}\nBranch: ${item.branch ?? '(detached)'}\n${flags.force ? 'WARNING: tracked AND untracked changes may be permanently lost.' : 'Git will refuse dirty worktrees.'}\n${flags['delete-branch'] ? 'Also try to delete the merged branch.' : 'Keep the branch.'}`);
    checkCancelled(signal);
    if (!confirmed) return 'Cancelled.';
    if (flags.force) {
      const typed = await ctx.ui.input('Type the directory name to confirm permanent deletion', basename(item.path));
      checkCancelled(signal);
      if (typed !== basename(item.path)) return 'Cancelled.';
    }
    return manager.remove(item.path, { force: !!flags.force, deleteBranch: !!flags['delete-branch'] });
  }
  if (action === 'prune') {
    const preview = await manager.prune();
    if (!flags.apply) return preview || 'No stale worktree registrations eligible for pruning.';
    if (!ctx.hasUI) return 'Cancelled; no registrations removed.';
    const confirmed = await ctx.ui.confirm('Prune stale worktree registrations?', preview || 'Git will apply its default expiry policy.');
    checkCancelled(signal);
    if (!confirmed) return 'Cancelled; no registrations removed.';
    return await manager.prune(true) || 'Pruning complete.';
  }
}

export default function (pi: ExtensionAPI) {
  // Tools and commands can arrive concurrently; serialise Git mutations and confirmations.
  let queue = Promise.resolve();
  let knownTrees: Awaited<ReturnType<Worktrees['list']>> | undefined;
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work);
    queue = next.then(() => undefined, () => undefined);
    return next;
  }
  async function refresh(ctx: ExtensionContext) {
    try {
      const manager = new Worktrees(ctx.cwd);
      const trees = await manager.list();
      const current = await manager.current();
      knownTrees = trees;
      ctx.ui.setStatus('worktree', `wt: ${current?.branch ?? '(detached)'} · ${trees.length} checkouts`);
      return trees;
    } catch {
      knownTrees = undefined;
      ctx.ui.setStatus('worktree', undefined);
    }
  }
  pi.on('session_start', async (_event, ctx) => { await refresh(ctx); });
  const handler = async (input: string, ctx: ExtensionCommandContext) => {
    let json = false;
    try {
      const parsed = words(input);
      json = parsed.includes('--json');
      const args = parsed.filter(arg => arg !== '--json');
      if (!args.length && json) args.push('list');
      if (!args.length && ctx.hasUI) {
        const action = await ctx.ui.select('Worktrees', ['switch', 'create', 'list', 'status', 'help']);
        if (!action) return;
        args.push(action);
      }
      const action = args[0] || 'help';
      if (action === 'switch' || (action === 'create' && args.includes('--switch'))) {
        if (ctx.mode !== 'tui') throw new Error('Switch requires Pi’s terminal UI.');
        // The active turn may still need this queue to finish its tools.
        await ctx.waitForIdle();
      }
      const result = await serial(() => run(args, ctx, ctx));
      const trees = await refresh(ctx);
      pi.sendMessage({ customType: 'worktree', content: json ? JSON.stringify(result, null, 2) : humanResult(action, result, ctx.cwd, trees), display: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (json) pi.sendMessage({ customType: 'worktree', content: JSON.stringify({ error: message }), display: true });
      else ctx.ui.notify(message, 'error');
      await refresh(ctx);
    }
  };
  const completions = (prefix: string) => ['create', 'list', 'switch', 'status', 'path', 'rename', 'branch', 'prefix', 'remove', 'lock', 'unlock', 'prune', 'help'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
  for (const name of ['worktree', 'wt']) pi.registerCommand(name, { description: 'Manage Git worktrees (create, switch, list, rename, remove)', getArgumentCompletions: completions, handler });
  pi.registerTool({
    name: 'worktree', label: 'Worktrees',
    description: 'Manage Git worktrees using argv, never shell text. Actions: help, list, create [name] [--base REF] [--branch BRANCH | --prefix PREFIX] [--existing], prefix [value] (show/save repository default, initially pi/), status [selector], path [selector], rename selector name (directory only), branch selector branch, remove selector [--force] [--delete-branch], lock selector [--reason TEXT], unlock selector, prune [--apply]. Results are structured JSON for agents; no flag is required. --json is also accepted for parity with slash commands. Random unused names from 200 world cities by default. Removal/pruning require user confirmation; primary/current worktrees are protected. Switching is user-only via /wt switch; creating does NOT change your cwd. Run help for details.',
    parameters: Type.Object({ args: Type.Array(Type.String(), { description: 'Argument tokens, e.g. ["create", "--base", "main"]. No shell quoting inside tokens.' }) }),
    async execute(_id, { args }, signal, _update, ctx) {
      const result = await serial(async () => {
        return run(args.filter(arg => arg !== '--json'), ctx, undefined, signal);
      }).finally(() => refresh(ctx));
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }], details: result };
    },
    renderResult(result, _options, _theme, context) {
      const args = (context.args as { args?: string[] })?.args ?? [];
      const action = args.find(arg => arg !== '--json') || 'help';
      const fallback = result.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const text = result.details === undefined ? fallback : humanResult(action, result.details, context.cwd, knownTrees);
      return new Markdown(text, 0, 0, getMarkdownTheme());
    },
  });
}
