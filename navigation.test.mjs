import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, statSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMailbox, returnToParent } from './navigation.ts';

test('a return request unwinds to the requested ancestor without reopening its session', () => {
  const outer = createMailbox();
  const inner = createMailbox();
  try {
    assert.equal(returnToParent('/repo/main', ['/repo/main', '/repo/kyoto'], inner.path), true);
    assert.equal(inner.read(), '/repo/main');
    assert.equal(returnToParent(inner.read(), ['/repo/main'], outer.path), true);
    assert.equal(outer.read(), '/repo/main');
    assert.equal(statSync(inner.path).mode & 0o777, 0o600);
  } finally {
    inner.dispose();
    outer.dispose();
  }
  assert.equal(existsSync(inner.path), false);
  assert.equal(existsSync(outer.path), false);
});

test('unrelated checkouts do not request a return', () => {
  const mailbox = createMailbox();
  try {
    assert.equal(returnToParent('/repo/main-other', ['/repo/main'], mailbox.path), false);
    assert.equal(mailbox.read(), '');
  } finally { mailbox.dispose(); }
});

test('return matching uses checkout identity, not containment, and resolves aliases', () => {
  const temp = mkdtempSync(join(tmpdir(), 'pi-worktree-alias-'));
  const mailbox = createMailbox();
  try {
    const root = join(temp, 'repo');
    const nested = join(root, 'nested');
    const alias = join(temp, 'alias');
    mkdirSync(nested, { recursive: true });
    symlinkSync(root, alias, 'dir');
    assert.equal(returnToParent(root, [nested], mailbox.path), false);
    assert.equal(mailbox.read(), '');
    assert.equal(returnToParent(root, [alias], mailbox.path), true);
    assert.equal(mailbox.read(), alias);
  } finally {
    mailbox.dispose();
    rmSync(temp, { recursive: true, force: true });
  }
});

test('older parents can be resumed directly but cannot forward a distant request', () => {
  assert.equal(returnToParent('/repo/kyoto', ['/repo/main', '/repo/kyoto']), true);
  assert.throws(() => returnToParent('/repo/main', ['/repo/main', '/repo/kyoto']), /Reload/);
});
