import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worktrees, randomName, validateName, words, options, parseWorktrees } from './manager.ts';
import { cities } from './cities.ts';

async function repository(t) {
  const temp = await mkdtemp(join(tmpdir(), 'pi-worktrees-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const cwd = join(temp, 'repo with spaces');
  await mkdir(cwd);
  const git = new Worktrees(cwd);
  await git.git('init', '-b', 'main');
  await git.git('config', 'user.name', 'Worktree Tests');
  await git.git('config', 'user.email', 'worktree@example.invalid');
  await git.git('config', 'commit.gpgsign', 'false');
  await writeFile(join(cwd, 'README'), 'initial\n');
  await git.git('add', '.');
  await git.git('commit', '-m', 'Initial');
  return git;
}

test('random names are valid and path traversal is rejected', () => {
  assert.equal(cities.length, 200);
  assert.equal(new Set(cities).size, 200);
  for (const city of cities) validateName(city);
  for (let i = 0; i < 100; i++) assert.ok(cities.includes(validateName(randomName())));
  for (const name of ['../escape', '-bad', '', 'two words', 'x/y', 'x\\y']) assert.throws(() => validateName(name));
});
test('argv parsing supports quoted paths and rejects unknown flags', () => {
  assert.deepEqual(words('rename "path with spaces" new-name'), ['rename', 'path with spaces', 'new-name']);
  assert.throws(() => words('"unclosed'));
  assert.throws(() => options(['--nope'], {}));
  assert.throws(() => options(['--base'], { base: 'value' }));
  assert.deepEqual(options(words('create plain --prefix ""'), { prefix: 'value' }).flags, { prefix: '' });
});
test('porcelain parsing preserves spaces and newlines in paths', () => {
  const [item] = parseWorktrees('worktree /tmp/a b\nc\0HEAD abc\0branch refs/heads/pi/test\0locked reason\0\0');
  assert.equal(item.path, '/tmp/a b\nc');
  assert.equal(item.branch, 'pi/test');
  assert.equal(item.locked, true);
});
test('create, find, rename directory, rename branch and remove preserve Git state', async t => {
  const git = await repository(t);
  const created = await git.create({ name: 'silver-otter' });
  assert.equal(created.branch, 'pi/silver-otter');
  assert.equal((await git.find('pi/silver-otter')).path, created.path);
  assert.equal((await git.list()).length, 2);
  assert.equal((await git.status('silver-otter')).status, '');
  const moved = await git.rename('silver-otter', 'amber-fern');
  assert.equal(moved.branch, 'pi/silver-otter');
  assert.equal((await git.renameBranch('amber-fern', 'feature/new')).branch, 'feature/new');
  await git.remove('amber-fern');
  assert.equal((await git.list()).length, 1);
  assert.match(await git.git('branch', '--list', 'feature/new'), /feature\/new/);
});
test('branch prefixes persist across worktrees and allow one-off overrides', async t => {
  const git = await repository(t);
  assert.equal(await git.prefix(), 'pi/');
  assert.equal(await git.prefix('dimiro1'), 'dimiro1/');
  const item = await git.create({ name: 'custom' });
  assert.equal(item.branch, 'dimiro1/custom');
  assert.equal(await new Worktrees(item.path).prefix(), 'dimiro1/');
  assert.equal((await git.create({ name: 'once', prefix: 'feature' })).branch, 'feature/once');
  assert.equal(await git.prefix(), 'dimiro1/');
  assert.equal((await git.create({ name: 'explicit', branch: 'exact-name' })).branch, 'exact-name');
  await assert.rejects(git.prefix('bad prefix'), /./);
  assert.equal(await git.prefix(), 'dimiro1/');
  await assert.rejects(git.create({ name: 'conflict', prefix: 'x', branch: 'y' }), /cannot combine/);
  await git.prefix('');
  assert.equal((await git.create({ name: 'plain' })).branch, 'plain');
});
test('random names skip preserved branches under the configured prefix', async t => {
  const git = await repository(t);
  await git.prefix('custom');
  for (const city of cities.slice(1)) await git.git('branch', `custom/${city}`);
  assert.equal((await git.create()).branch, `custom/${cities[0]}`);
});
test('primary and current checkouts are protected even with force', async t => {
  const git = await repository(t);
  await assert.rejects(git.remove('main', { force: true }), /primary/);
  await assert.rejects(git.rename('main', 'bad'), /primary/);
  const item = await git.create({ name: 'current' });
  const current = new Worktrees(item.path);
  await assert.rejects(current.remove('current', { force: true }), /session/);
  await assert.rejects(current.rename('current', 'bad'), /session/);
});
test('dirty deletion is refused, force is explicit, and branches survive by default', async t => {
  const git = await repository(t);
  const item = await git.create({ name: 'dirty' });
  await writeFile(join(item.path, 'untracked'), 'do not lose me');
  await assert.rejects(git.remove('dirty'), /modified|untracked/);
  await git.remove('dirty', { force: true });
  assert.match(await git.git('branch', '--list', 'pi/dirty'), /pi\/dirty/);
});
test('locks protect worktrees and can be explicitly released', async t => {
  const git = await repository(t);
  await git.create({ name: 'locked' });
  assert.equal((await git.lock('locked', 'Keep this')).locked, true);
  await assert.rejects(git.remove('locked', { force: true }), /locked/);
  await assert.rejects(git.rename('locked', 'new'), /locked/);
  await git.unlock('locked');
  await git.remove('locked', { deleteBranch: true });
  assert.equal((await git.git('branch', '--list', 'pi/locked')).trim(), '');
});
test('existing branches and explicit base commits are supported', async t => {
  const git = await repository(t);
  await git.git('branch', 'existing');
  const item = await git.create({ name: 'reuse', branch: 'existing', existing: true });
  assert.equal(item.branch, 'existing');
  await assert.rejects(git.create({ name: 'again', branch: 'existing', existing: true }), /already/);
  await git.create({ name: 'from-main', base: 'main' });
  await assert.rejects(git.create({ name: 'unsafe', base: '--orphan' }));
  await assert.rejects(git.create({ name: 'reuse' }), /already exists/);
});
test('random city names skip preserved branches, existing worktrees and occupied directories', async t => {
  const git = await repository(t);
  for (const city of cities.filter(city => !['kyoto', 'porto', 'oslo'].includes(city))) await git.git('branch', `pi/${city}`);
  await git.create({ name: 'kyoto' });
  await mkdir(join(await git.root(), 'porto'));
  assert.equal((await git.create()).branch, 'pi/oslo');
  await assert.rejects(git.create(), /All 200 city names/);
});
test('suspended parents remain protected through symlink aliases and subdirectories', async t => {
  const git = await repository(t);
  const parent = await git.create({ name: 'parent' });
  const child = await git.create({ name: 'child' });
  await mkdir(join(parent.path, 'src'));
  const alias = join(git.cwd, 'parent-alias');
  await symlink(parent.path, alias, 'dir');
  const previous = process.env.PI_WORKTREE_PARENTS;
  process.env.PI_WORKTREE_PARENTS = JSON.stringify([join(alias, 'src')]);
  try {
    const current = new Worktrees(child.path);
    await assert.rejects(current.remove('parent', { force: true }), /suspended parent/);
    await assert.rejects(current.rename('parent', 'moved'), /suspended parent/);
    await rm(join(parent.path, 'src'), { recursive: true });
    await assert.rejects(current.remove('parent', { force: true }), /suspended parent/);
    assert.equal((await git.list()).length, 3);
  } finally {
    if (previous === undefined) delete process.env.PI_WORKTREE_PARENTS;
    else process.env.PI_WORKTREE_PARENTS = previous;
  }
});
test('--existing requires an exact local branch, not a remote, tag or revision', async t => {
  const git = await repository(t);
  await git.git('update-ref', 'refs/remotes/origin/topic', 'HEAD');
  await git.git('tag', 'release');
  for (const branch of ['origin/topic', 'release', 'missing']) {
    await assert.rejects(git.create({ name: 'invalid', existing: true, branch }), /existing local branch/);
    assert.equal((await git.list()).length, 1);
  }
  await assert.rejects(git.create({ name: 'invalid', existing: true }), /requires.*branch/);
  await git.git('branch', 'local');
  await git.git('tag', 'local');
  assert.equal((await git.create({ name: 'valid', existing: true, branch: 'local' })).branch, 'local');
});
test('branch rename never overwrites an existing branch', async t => {
  const git = await repository(t);
  const item = await git.create({ name: 'source' });
  await git.git('branch', 'taken');
  const before = await git.git('rev-parse', 'taken');
  await assert.rejects(git.renameBranch('source', 'taken'), /already exists/);
  assert.equal((await git.find(item.path)).branch, 'pi/source');
  assert.equal(await git.git('rev-parse', 'taken'), before);
});
test('unmerged branches survive a failed safe deletion after checkout removal', async t => {
  const git = await repository(t);
  const item = await git.create({ name: 'unmerged' });
  const linked = new Worktrees(item.path);
  await linked.git('config', 'commit.gpgsign', 'false');
  await writeFile(join(item.path, 'unmerged.txt'), 'unique work\n');
  await linked.git('add', '.');
  await linked.git('commit', '-m', 'Unmerged work');
  const commit = await linked.git('rev-parse', 'HEAD');
  const result = await git.remove('unmerged', { deleteBranch: true });
  assert.match(result.note, /Worktree removed; branch preserved/);
  assert.equal(await git.git('rev-parse', 'pi/unmerged'), commit);
  assert.equal((await git.list()).length, 1);
});
test('an aborted manager refuses mutations and preserves untracked files', async t => {
  const git = await repository(t);
  const item = await git.create({ name: 'abort' });
  const file = join(item.path, 'precious.txt');
  await writeFile(file, 'keep me');
  const controller = new AbortController();
  controller.abort();
  const cancelled = new Worktrees(git.cwd, { signal: controller.signal });
  await assert.rejects(cancelled.remove('abort', { force: true }), /Cancelled/);
  assert.equal(await readFile(file, 'utf8'), 'keep me');
});
test('prune previews without mutating registrations', async t => {
  const git = await repository(t);
  const item = await git.create({ name: 'stale' });
  await rm(item.path, { recursive: true });
  await git.prune();
  assert.equal((await git.list()).length, 2);
  await git.prune(true);
  assert.equal((await git.list()).length, 1);
});
