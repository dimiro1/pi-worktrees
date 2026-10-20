# Pi worktrees

[![CI](https://github.com/dimiro1/pi-worktrees/actions/workflows/ci.yml/badge.svg)](https://github.com/dimiro1/pi-worktrees/actions/workflows/ci.yml)

Manage Git worktrees and open isolated [Pi](https://pi.dev) sessions without leaving
your terminal. Includes `/wt` and `/worktree` commands and a model-callable
`worktree` tool.

- Create checkouts with random world-city names or your own names.
- Customize the default branch prefix per repository.
- Switch sessions, return to suspended parents, and resume previous work.
- Inspect status, rename directories or branches, lock, remove and prune worktrees.
- Keep destructive operations behind confirmations and checkout protections.

## Install

Requires Node.js **22.19+**, a modern Git (tested with 2.52), and Pi. This extension
targets `@earendil-works/pi-coding-agent` and is tested against **Pi 1.3.0**.

```sh
pi install git:github.com/dimiro1/pi-worktrees
```

Run `/reload` in an existing Pi session, or restart Pi. No separate dependency
installation is needed for normal use; Pi supplies the runtime APIs.

Alternatively, install manually:

```sh
git clone https://github.com/dimiro1/pi-worktrees.git ~/.pi/agent/extensions/worktrees
```

Choose **one** installation method. If you already have a personal copy, move it
outside `~/.pi/agent/extensions/` before using `pi install`, otherwise both copies
may register the same commands and tool.

To update a package installation:

```sh
pi update git:github.com/dimiro1/pi-worktrees
```

## A complete working session

```text
/wt create                      # Random unused city, e.g. kyoto; branch pi/kyoto
/wt create --base main --switch  # Create from main and open Pi there immediately
/wt list
/wt switch                      # Select a checkout
/wt switch kyoto                 # Open/resume Pi in that checkout
/wt status                      # Status of the current checkout
/quit                           # Close the nested Pi and return to the previous one
/wt rename kyoto lisbon          # Move the directory; branch remains pi/kyoto
/wt branch lisbon pi/lisbon      # Optionally rename its branch too
/wt path lisbon
/wt remove lisbon                # Confirm; keeps branch, refuses dirty files
/wt remove lisbon --delete-branch # Also try Git's safe branch deletion (-d)
```

Examples are independent operations; substitute the city reported by `create`.
`/worktree` is an alias for `/wt`. With no arguments, either opens an action menu.
Use `/wt help` for the complete syntax. Commands complete their action names.

## Navigation and output

Slash commands default to human-readable output: lists show each checkout's name,
branch, path, current/primary markers and any locks; status clearly says whether the
working tree is clean and shows local changes when present. Agent tool results are
also rendered readably in the terminal without changing the agent's structured data.

For machine-readable results, add `--json` anywhere in a slash command:

```text
/wt list --json
/wt status --json
/wt --json                       # Equivalent to list --json; no action menu
```

JSON mode emits the result as JSON, including quoted strings, and command failures
as `{"error":"..."}`. This flag changes presentation only: confirmation requirements
and destructive-operation protections are unchanged. It is still a Pi slash command,
not a standalone shell command or a replacement for Pi's JSON/RPC transport.

### Creating

```text
/wt create
/wt create kyoto --base main
/wt create --base origin/main
/wt create lisbon --branch feature/payments
/wt create porto --existing --branch existing-feature
```

The pool contains **200 unique world-city slugs**, such as `tokyo`, `lisbon`,
`kyoto`, `buenos-aires`, `cape-town` and `sao-paulo`. It is a curated worldwide
selection, **not a claimed population ranking** (city-proper and metropolitan
rankings are different). Names are ASCII and use hyphens for spaces.

Set a persistent **per-repository** default branch prefix (shared by its worktrees):

```text
/wt prefix dimiro1            # Save dimiro1/; trailing slash is optional
/wt prefix                    # Show the current default (initially pi/)
/wt create kyoto               # Branch dimiro1/kyoto
/wt create porto --prefix fix  # One-off fix/porto; default unchanged
/wt create plain --prefix ""   # One-off unprefixed branch
/wt prefix pi                  # Restore pi/
/wt prefix ""                  # No prefix: branch name equals worktree name
```

The value is stored in local Git config as `pi.worktreeBranchPrefix`, not in
tracked project files. Existing branches are never renamed by this setting.
Explicit `--branch` values bypass the default; `--prefix` cannot combine with
`--branch` or `--existing`. `--existing` requires an exact existing **local branch**;
remote refs, tags and other revisions are rejected rather than creating a detached
checkout.

Random selection skips names already registered in the repository, occupied
paths, and preserved `<prefix><city>` branches. There are no random numeric suffixes.
If all names are used, supply a custom name. Custom names may contain letters,
digits, underscores and hyphens (maximum 80 characters).

New checkouts live **outside the source checkout**, at:

```text
<primary-checkout-parent>/.pi-worktrees/<repo-name>-<repository-hash>/<city>
```

The hash separates repositories with identical folder names. Git itself is the
source of truth; worktrees created outside this extension also appear in lists.
Creating starts from `HEAD` unless `--base` is supplied. It never fetches remotes,
copies uncommitted files, installs dependencies, copies secrets, or executes setup
scripts. Git's own configured hooks still apply to Git commands.

### Switching and sessions

Pi's extension API does not support changing an existing session's cwd. Merely
calling `process.chdir()` would leave tools and instructions using the old checkout.
Instead, `/wt switch` suspends the current terminal UI and starts a child Pi process
with the selected checkout as its real cwd. Tools, project configuration and context
files are constructed afresh there.

- The child's `--continue` resumes the latest session for that directory.
- `/wt switch kyoto --fresh` starts a fresh session instead.
- `/quit` (not `/exit`) closes the child and restores the parent UI and conversation.
- `/wt switch main` (or any suspended parent's selector) resumes that exact session,
  rather than opening a duplicate or reporting an error. Intervening child sessions
  close cleanly; their conversations remain saved and can be continued later.
- `--fresh` is refused for suspended parents: omit it to resume the existing session.
- Parent checkouts remain protected from moving or deleting while suspended.
- After installing this update, run `/reload` in each existing parent session to
  enable switching across multiple levels. Returning to the immediate parent also
  works with older parents; `/quit` remains available at every level.
- Conversation history is not automatically handed off between checkouts.
- Pi groups sessions by directory. Renaming a checkout does not migrate its old Pi
  sessions; they remain in Pi's session storage. Start a fresh session at the new
  path, or use Pi's session commands to fork an old conversation if needed.
- The child uses normal Pi startup settings; parent-only CLI flags and dynamically
  selected models are not automatically forwarded.
- Switching requires the terminal UI. It is intentionally unavailable to the agent
  tool and in print/JSON/RPC mode.

Do not move/delete a worktree used by another terminal or application. The extension
protects this process and its suspended parents, but cannot track unrelated editors.

### Inspecting and finishing work

Selectors are a directory basename, branch name, absolute path, or `main` for the
primary checkout. Ambiguous names are rejected; supply an absolute path instead.
Quote selectors with spaces:

```text
/wt status "/some/path with spaces/checkout"
/wt lock kyoto --reason "Waiting for review"
/wt unlock kyoto
/wt prune                       # Preview stale registration cleanup
/wt prune --apply               # Confirm before applying Git's default expiry
```

Use normal Git commands to commit, push, review and merge. For example, after
committing in `kyoto`, return to the primary checkout and merge `pi/kyoto`; then
`/wt remove kyoto --delete-branch` can clean up the checkout and merged branch.
This extension does not auto-commit, auto-merge, push or resolve conflicts.

### Safety

- Primary, current and suspended-parent checkouts cannot be moved or removed.
  Protection resolves symlink aliases, including parent sessions started in a
  subdirectory. Nested worktrees are identified separately from their enclosing checkout.
- Locked checkouts must be explicitly unlocked before moving/removing them.
- Removal always requires a user confirmation dialog.
- `--force` additionally requires typing the directory name; it can permanently
  delete tracked modifications **and untracked files**. No automatic stash is made.
- Branches are preserved by default. `--delete-branch` uses `git branch -d`, never
  `-D`; if Git refuses deletion the checkout is removed but the branch is retained,
  with that fact reported explicitly.
- Pruning previews by default and requires confirmation to apply. It removes stale
  Git registrations, not branches or working directories.
- Non-interactive removal is refused. Git operations are serialised inside Pi.
  Switching waits for the active turn outside that queue, then revalidates its target.
- Tool cancellation is checked after confirmation dialogs and before each Git
  command. It prevents pending mutations, but does not roll back or interrupt a
  mutation already handed to Git.
- Git runs directly with argument arrays, never shell-interpolated commands.

## Agent tool

The `worktree` tool always returns structured results in `details` and JSON text
for object/array results in `content`; agents need no special flag. `--json` is also
accepted for parity with slash commands. The tool accepts argument tokens:

```json
{"args": ["create", "--base", "main"]}
{"args": ["list"]}
{"args": ["status", "kyoto"]}
```

Creating a worktree does **not** change the agent's cwd. Work in a different checkout
by explicitly using its path, or ask the user to `/wt switch` there. Destructive
operations retain the same confirmation rules as slash commands.

## Development and tests

```sh
git clone https://github.com/dimiro1/pi-worktrees.git
cd pi-worktrees
npm ci
npm test
npm run typecheck
```

`npm pack --dry-run` shows the installable package contents. The package manifest
exposes only `index.ts` as an extension; helper modules are not separate extensions.

Tests use throwaway repositories, not your project. `manager.test.mjs` tests Git
operations independently of Pi; `extension.test.mjs` and `regressions.test.mjs`
load the extension through the installed Pi loader and test command/tool dispatch,
confirmations, cancellation, queue progress, nested checkouts and aliases without
any model requests. Loader tests use the locally installed Pi development
dependency. `PI_PACKAGE_DIR` can override it; running from a personal extension
without local dependencies also supports Pi's managed-install layout.

The automated suite does not launch an interactive child Pi. For a terminal smoke
test in a throwaway repository, create two nested sessions with `create --switch`,
return to the original with `switch main`, reopen with `switch --fresh`, and check
both `/quit` and normal `switch` (which uses `--continue`). Confirm the actual cwd
in each session, not just the worktree listing.

## License

[MIT](LICENSE).
