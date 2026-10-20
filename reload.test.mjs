import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worktrees } from './manager.ts';
import { loadPiLoader } from './test-support.mjs';

const { loadExtensionsCached, clearExtensionCache } = await loadPiLoader();
const source = fileURLToPath(new URL('./', import.meta.url));

test('updating helpers and reloading preserves agent tool and slash command calls in the same process', async t => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'pi-worktrees-reload-')));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const repo = join(temp, 'repo'), extension = join(temp, 'extension');
  await mkdir(repo);
  await mkdir(extension);
  const manager = new Worktrees(repo);
  await manager.git('init', '-b', 'main');
  await manager.git('config', 'user.name', 'Reload Tests');
  await manager.git('config', 'user.email', 'reload@example.invalid');
  await manager.git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'Initial');
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const runtime = manifest.files.filter(file => /\.(ts|mjs)$/.test(file));
  for (const file of runtime) await copyFile(join(source, file), join(extension, file));
  const entry = join(extension, 'index.ts');
  const originalEntry = await readFile(entry, 'utf8');
  const managerFile = join(extension, originalEntry.match(/from ['"]\.\/(manager\.[a-z]+)['"]/)[1]);
  const originalManager = await readFile(managerFile, 'utf8');
  // Model the actual update: a new entry point imports a newly exported helper.
  // An entry-point-only reload must not retain the old helper module namespace.
  assert.ok(originalManager.includes('export function checkCancelled('));
  await writeFile(managerFile, originalManager.replace('export function checkCancelled(', 'function checkCancelled('));
  await writeFile(entry, originalEntry.replace(', checkCancelled }', ' }') + '\nfunction checkCancelled() {}\n');
  const ctx = { cwd: repo, mode: 'json', hasUI: false, ui: { notify() {}, setStatus() {} } };
  async function load() {
    const loaded = await loadExtensionsCached([entry], repo);
    assert.deepEqual(loaded.errors, []);
    return loaded;
  }
  async function list(loaded) {
    return loaded.extensions[0].tools.get('worktree').definition.execute('reload', { args: ['list'] }, undefined, undefined, ctx);
  }
  const initial = await load();
  assert.equal((await list(initial)).details.length, 1);
  await writeFile(managerFile, originalManager);
  await writeFile(entry, originalEntry);
  clearExtensionCache();
  const reloaded = await load();
  assert.equal((await list(reloaded)).details[0].branch, 'main');
  const messages = [];
  reloaded.runtime.sendMessage = message => messages.push(message);
  await reloaded.extensions[0].commands.get('wt').handler('list --json', ctx);
  assert.equal(JSON.parse(messages.at(-1).content)[0].path, repo);
  // Existing exports must also refresh on subsequent reloads, not just new names.
  await writeFile(managerFile, originalManager.replace('Cancelled before worktree operation.', 'Updated cancellation helper.'));
  clearExtensionCache();
  const updated = await load();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(updated.extensions[0].tools.get('worktree').definition.execute('updated', { args: ['list'] }, controller.signal, undefined, ctx), /Updated cancellation helper/);
});
