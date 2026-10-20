import { test } from 'node:test';
import assert from 'node:assert/strict';
import { humanResult } from './format.ts';

const primary = { path: '/repo', branch: 'master', locked: false, prunable: false, head: '123456789abcdef' };
const linked = { ...primary, path: '/worktrees/kyoto', branch: 'pi/kyoto' };

test('lists show branches, paths, current checkout and locks without JSON noise', () => {
  const output = humanResult('list', [primary, { ...linked, locked: true, lockReason: 'Other agent', prunable: true }], '/repo/src');
  assert.match(output, /2 worktrees/);
  assert.match(output, /current · primary/);
  assert.match(output, /pi\/kyoto.*locked · stale/);
  assert.match(output, /Lock: Other agent/);
  assert.match(output, /\/worktrees\/kyoto/);
  assert.doesNotMatch(output, /"head"|"bare"|false/);
});

test('only the deepest checkout is marked current in nested worktree lists', () => {
  const nested = { ...linked, path: '/repo/nested', branch: 'nested' };
  const output = humanResult('list', [primary, nested], '/repo/nested/src');
  assert.equal((output.match(/· current/g) ?? []).length, 1);
  assert.match(output, /\*\*nested\*\* — nested · current/);
  assert.doesNotMatch(output, /\*\*repo\*\*.*current/);
  const explicitParent = humanResult('status', { ...primary, status: '' }, '/repo/nested/src', [primary, nested]);
  assert.doesNotMatch(explicitParent, /· current/);
});

test('status distinguishes clean and modified checkouts', () => {
  assert.match(humanResult('status', { ...primary, status: '', summary: '## master...origin/master\n' }, '/repo'), /Working tree is clean/);
  const dirty = humanResult('status', { ...primary, status: ' M README\n?? new.txt\n', summary: '## master\n' }, '/repo');
  assert.match(dirty, /Local changes/);
  assert.match(dirty, / M README/);
  assert.match(dirty, /\?\? new.txt/);
});

test('mutations and cancellations have readable outcomes', () => {
  assert.match(humanResult('create', linked), /Worktree created/);
  assert.match(humanResult('create', linked), /\/wt switch kyoto/);
  assert.match(humanResult('rename', { ...linked, note: 'Branch unchanged.' }), /Branch unchanged/);
  assert.match(humanResult('remove', { removed: linked.path, branch: linked.branch, note: 'Branch preserved.' }), /Branch preserved/);
  assert.match(humanResult('switch', 'Cancelled.'), /no changes made/);
  assert.match(humanResult('list', []), /No worktrees/);
});

test('detached checkouts show short commits and unsafe data cannot inject styling', () => {
  const output = humanResult('list', [{ ...primary, branch: null }, { ...linked, branch: '*bold*\u001b[31m' }]);
  assert.match(output, /detached at 12345678/);
  assert.ok(output.includes('\\*bold\\*'));
  assert.ok(!output.includes('\u001b'));
});
