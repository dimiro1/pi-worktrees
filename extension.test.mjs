import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, realpath } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worktrees } from './manager.mjs';
import { createMailbox } from './navigation.mjs';

import { loadPiExtensions } from './test-support.mjs';

const loadExtensions = await loadPiExtensions();
const extensionPath = join(dirname(fileURLToPath(import.meta.url)), 'index.ts');

test('extension loads, exposes commands, and validates tools without an API call', async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktrees-extension-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const repo = join(cwd, 'repo');
  await mkdir(repo);
  const manager = new Worktrees(repo);
  await manager.git('init', '-b', 'main');
  await manager.git('config', 'user.name', 'Tests');
  await manager.git('config', 'user.email', 'tests@example.invalid');
  await manager.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial');
  const loaded = await loadExtensions([extensionPath], repo);
  assert.deepEqual(loaded.errors, []);
  const extension = loaded.extensions[0];
  assert.ok(extension.commands.has('wt'));
  assert.ok(extension.commands.has('worktree'));
  const tool = extension.tools.get('worktree').definition;
  const notices = [];
  const context = { cwd: repo, mode: 'json', hasUI: false, ui: { notify: (...args) => notices.push(args), setStatus() {} } };
  const call = args => tool.execute('test', { args }, new AbortController().signal, undefined, context);
  assert.equal((await call(['list'])).details.length, 1);
  assert.equal((await call(['list', '--json'])).details.length, 1);
  assert.match((await call(['help'])).content[0].text, /world city/);
  const messages = [];
  loaded.runtime.sendMessage = message => messages.push(message);
  const command = extension.commands.get('wt');
  await command.handler('list', context);
  assert.match(messages.at(-1).content, /1 worktree/);
  assert.match(messages.at(-1).content, /current.*primary/);
  assert.doesNotMatch(messages.at(-1).content, /"path":/);
  await command.handler('list --json', context);
  assert.equal(JSON.parse(messages.at(-1).content)[0].path, repo);
  await command.handler('--json', context);
  assert.equal(JSON.parse(messages.at(-1).content).length, 1);
  await command.handler('status', context);
  assert.match(messages.at(-1).content, /Working tree is clean/);
  await command.handler('list --unknown --json', context);
  assert.match(JSON.parse(messages.at(-1).content).error, /Unknown option/);
  const created = (await call(['create'])).details;
  assert.match(created.branch, /^pi\/[a-z-]+$/);
  assert.equal(context.cwd, repo, 'Creating a worktree must not pretend to change cwd');
  await assert.rejects(call(['switch', created.path]), /terminal/);
  await assert.rejects(call(['remove', created.path, '--force']), /interactive confirmation/);
  assert.equal((await manager.list()).length, 2);
  await assert.rejects(call(['create', '--existing']), /requires --branch/);
  await assert.rejects(call(['list', 'extra']), /Wrong arguments/);
  await assert.rejects(call(['prune', '--force']), /Unknown option/);
  await assert.rejects(call(['create', '--switch']), /cannot switch sessions/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tool.execute('cancelled', { args: ['create'] }, controller.signal, undefined, context), /Cancelled/);
  assert.equal((await manager.list()).length, 2);

  const previousParents = process.env.PI_WORKTREE_PARENTS;
  const previousReturn = process.env.PI_WORKTREE_RETURN;
  const mailbox = createMailbox();
  try {
    process.env.PI_WORKTREE_PARENTS = JSON.stringify([repo]);
    process.env.PI_WORKTREE_RETURN = mailbox.path;
    let shutdowns = 0;
    let waits = 0;
    const switching = { ...context, cwd: created.path, mode: 'tui', hasUI: true,
      waitForIdle: async () => { waits++; }, shutdown: () => { shutdowns++; } };
    await command.handler('switch main', switching);
    assert.equal(shutdowns, 1);
    assert.equal(waits, 1);
    assert.equal(mailbox.read(), repo);
    await command.handler('switch main --fresh', switching);
    assert.equal(shutdowns, 1, '--fresh must not silently resume an existing session');
    assert.match(notices.at(-1)[0], /Omit --fresh/);
    await command.handler(`switch ${created.path}`, switching);
    assert.equal(shutdowns, 1);
    assert.match(notices.at(-1)[0], /already in this worktree/);
  } finally {
    mailbox.dispose();
    if (previousParents === undefined) delete process.env.PI_WORKTREE_PARENTS;
    else process.env.PI_WORKTREE_PARENTS = previousParents;
    if (previousReturn === undefined) delete process.env.PI_WORKTREE_RETURN;
    else process.env.PI_WORKTREE_RETURN = previousReturn;
  }

  // Interactive destructive operations require both dialogs when forced.
  const prompts = [];
  const interactive = { ...context, hasUI: true, ui: { ...context.ui,
    confirm: async (...args) => { prompts.push(args); return true; },
    input: async () => 'wrong-name',
  } };
  const cancelled = await tool.execute('confirm', { args: ['remove', created.path, '--force'] }, undefined, undefined, interactive);
  assert.equal(cancelled.details, 'Cancelled.');
  assert.equal(prompts.length, 1);
  assert.equal((await manager.list()).length, 2);
});
