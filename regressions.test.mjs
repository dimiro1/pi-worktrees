import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, readFile, realpath, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worktrees } from './manager.ts';
import { createMailbox } from './navigation.ts';

import { loadPiExtensions } from './test-support.mjs';

const loadExtensions = await loadPiExtensions();

async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktrees-regression-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo');
  await mkdir(repo);
  const manager = new Worktrees(repo);
  await manager.git('init', '-b', 'main');
  await manager.git('config', 'user.name', 'Tests');
  await manager.git('config', 'user.email', 'tests@example.invalid');
  await manager.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial');
  const loaded = await loadExtensions([fileURLToPath(new URL('./index.ts', import.meta.url))], repo);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  const tool = extension.tools.get('worktree').definition;
  const command = extension.commands.get('wt');
  const messages = [], notices = [], statuses = [];
  loaded.runtime.sendMessage = message => messages.push(message);
  const context = { cwd: repo, mode: 'json', hasUI: false,
    ui: { notify: (...args) => notices.push(args), setStatus: (...args) => statuses.push(args) } };
  const call = (args, ctx = context, signal) => tool.execute('regression', { args }, signal, undefined, ctx);
  return { temp, repo, manager, command, messages, notices, statuses, context, call };
}

for (const action of ['switch target', 'create created --switch']) {
  test(`${action} waits outside the queue and revalidates after idle`, { timeout: 10000 }, async t => {
    const f = await fixture(t);
    await f.manager.create({ name: 'target' });
    let entered, release;
    const waiting = new Promise(resolve => { entered = resolve; });
    const idle = new Promise(resolve => { release = resolve; });
    let customCalls = 0;
    const ctx = { ...f.context, mode: 'tui', hasUI: true,
      waitForIdle: () => { entered(); return idle; },
      ui: { ...f.context.ui, custom: async () => { customCalls++; throw new Error('Unexpected child launch'); } } };
    const command = f.command.handler(action, ctx);
    await waiting;
    let timer;
    try {
      const result = await Promise.race([
        f.call(['list']),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Tool blocked behind idle waiter')), 1500); }),
      ]);
      assert.equal(result.details.length, 2);
      // Change the repository while the switch is waiting, then require fresh validation.
      if (action.startsWith('switch')) await f.manager.remove('target');
      else await f.manager.create({ name: 'created' });
    } finally {
      clearTimeout(timer);
      // Also prevents the old implementation from hanging the test after a failure.
      if (action.startsWith('switch') && (await f.manager.list()).length > 1) await f.manager.remove('target');
      release();
      await command;
    }
    assert.equal(customCalls, 0);
    assert.match(f.notices.at(-1)[0], action.startsWith('switch') ? /No worktree matches/ : /already exists/);
  });
}

test('nested worktrees and symlinked cwd use the actual current checkout', async t => {
  const f = await fixture(t);
  const nested = join(f.repo, 'nested');
  await f.manager.git('worktree', 'add', '-b', 'nested', '--', nested, 'HEAD');
  await mkdir(join(nested, 'src'));
  const alias = join(f.temp, 'nested-alias');
  await symlink(nested, alias, 'dir');
  for (const cwd of [nested, join(nested, 'src'), join(alias, 'src')]) {
    const ctx = { ...f.context, cwd };
    assert.equal((await f.call(['status'], ctx)).details.path, nested);
    assert.equal((await f.call(['path'], ctx)).details, nested);
    assert.match(f.statuses.at(-1)[1], /nested/);
    await f.command.handler('list', ctx);
    const blocks = f.messages.at(-1).content.split('\n\n');
    assert.equal(blocks.filter(block => block.includes('· current')).length, 1);
    assert.match(blocks.find(block => block.includes('· current')), /\*\*nested\*\*/);
    await f.command.handler('status main', ctx);
    assert.doesNotMatch(f.messages.at(-1).content, /· current/);
  }
  const mailbox = createMailbox();
  const previousParents = process.env.PI_WORKTREE_PARENTS;
  const previousReturn = process.env.PI_WORKTREE_RETURN;
  const primaryAlias = join(f.temp, 'primary-alias');
  await symlink(f.repo, primaryAlias, 'dir');
  process.env.PI_WORKTREE_PARENTS = JSON.stringify([join(primaryAlias, 'removed-subdir')]);
  process.env.PI_WORKTREE_RETURN = mailbox.path;
  try {
    let shutdowns = 0;
    const ctx = { ...f.context, cwd: nested, mode: 'tui', hasUI: true,
      waitForIdle: async () => {}, shutdown: () => { shutdowns++; } };
    await f.command.handler('switch main', ctx);
    assert.equal(shutdowns, 1);
    assert.equal(mailbox.read(), f.repo);
    await f.command.handler('switch nested', ctx);
    assert.equal(shutdowns, 1);
    assert.match(f.notices.at(-1)[0], /already in this worktree/);
  } finally {
    mailbox.dispose();
    if (previousParents === undefined) delete process.env.PI_WORKTREE_PARENTS;
    else process.env.PI_WORKTREE_PARENTS = previousParents;
    if (previousReturn === undefined) delete process.env.PI_WORKTREE_RETURN;
    else process.env.PI_WORKTREE_RETURN = previousReturn;
  }
});

test('empty prefixes work through slash parsing and tool dispatch', async t => {
  const f = await fixture(t);
  await f.command.handler('prefix custom', f.context);
  await f.command.handler('create plain --prefix ""', f.context);
  assert.equal((await f.manager.find('plain')).branch, 'plain');
  assert.equal((await f.call(['create', 'tool-plain', '--prefix', ''])).details.branch, 'tool-plain');
  assert.equal(await f.manager.prefix(), 'custom/');
  await f.command.handler('prefix ""', f.context);
  assert.equal(await f.manager.prefix(), '');
});

for (const stage of ['confirm', 'input']) {
  test(`abort during ${stage} preserves checkout and untracked files`, async t => {
    const f = await fixture(t);
    const item = await f.manager.create({ name: 'precious' });
    const file = join(item.path, 'untracked.txt');
    await writeFile(file, 'do not delete');
    const controller = new AbortController();
    let inputs = 0;
    const ctx = { ...f.context, hasUI: true, ui: { ...f.context.ui,
      confirm: async () => { if (stage === 'confirm') controller.abort(); return true; },
      input: async () => { inputs++; if (stage === 'input') controller.abort(); return 'precious'; },
    } };
    await assert.rejects(f.call(['remove', 'precious', '--force'], ctx, controller.signal), /Cancelled/);
    assert.equal(inputs, stage === 'input' ? 1 : 0);
    assert.equal(await readFile(file, 'utf8'), 'do not delete');
    assert.equal((await f.call(['list'])).details.length, 2, 'A failed operation must release the queue');
  });
}

test('abort during prune confirmation does not apply pruning', async t => {
  const f = await fixture(t);
  const stale = await f.manager.create({ name: 'stale' });
  await rm(stale.path, { recursive: true });
  const controller = new AbortController();
  const ctx = { ...f.context, hasUI: true, ui: { ...f.context.ui,
    confirm: async () => { controller.abort(); return true; } } };
  await assert.rejects(f.call(['prune', '--apply'], ctx, controller.signal), /Cancelled/);
  assert.equal((await f.manager.list()).length, 2);
});

test('confirmation refusal preserves files; successful forced removal preserves branch', async t => {
  const f = await fixture(t);
  const item = await f.manager.create({ name: 'remove-me' });
  const file = join(item.path, 'untracked.txt');
  await writeFile(file, 'local changes');
  let inputs = 0;
  const ctx = { ...f.context, hasUI: true, ui: { ...f.context.ui,
    confirm: async () => false,
    input: async () => { inputs++; return 'remove-me'; } } };
  assert.equal((await f.call(['remove', 'remove-me', '--force'], ctx)).details, 'Cancelled.');
  assert.equal(inputs, 0);
  assert.equal(await readFile(file, 'utf8'), 'local changes');
  ctx.ui.confirm = async () => true;
  const result = await f.call(['remove', 'remove-me', '--force'], ctx);
  assert.equal(result.details.removed, item.path);
  assert.equal(inputs, 1);
  assert.match(await f.manager.git('branch', '--list', 'pi/remove-me'), /pi\/remove-me/);
  assert.equal((await f.manager.list()).length, 1);
});
