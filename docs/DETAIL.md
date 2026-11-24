# Session reaper

DSH ships archiving but no deletion: archiving is a durable id set in the Workspace registry, and the
persistence seam documents "no deletion or retention API — pruning stored sessions is out-of-band
backend maintenance". This plugin supplies that missing operation and a place to use it.

## What it does

- **Lists every stored session**, archived or not, with its id, created time, project directory,
  artifact size, and a best-effort title.
- **Deletes a session for real.** Deletion removes the session's stored log files from disk; it is not
  an archive flag, and nothing restores it afterwards.
- **Manages archived sessions**: restores one back into its workspace, or deletes archived sessions in
  bulk.

## Where to use it

**Session row button.** Every Session row in the sidebar carries a trash icon in its hover strip,
beside the built-in archive and pin icons. Clicking it opens the confirmation dialog for that row's
Session; confirming deletes it and reports the result. This is the shortcut for the common case, so
managing one session does not require opening the panel.

**Sessions panel.** A `Sessions` row in the sidebar opens a panel that lists stored sessions and offers
per-row **Restore** (archived rows only) and **Delete**, plus **Delete all archived**. Delete asks for
an inline confirmation; the row's own `open now` badge means the session cannot be deleted until it is
closed. The panel talks to the Host through the `/session-admin` command, so it needs one open session to
address: with no session open it says so instead of guessing.

**Agent tool.** `session_admin` exposes the same operations to the model:

**Slash command.** `/session-admin` runs the same operations from the composer:

```text
/session-admin list [archived|active] [--json]
/session-admin restore <session-id>
/session-admin delete <session-id> --yes [--force]
/session-admin purge --yes [--force]
```

The `--json` flag returns the machine payload the panel renders; without it the command returns a
human-readable table or summary.


| `action` | Meaning | Required arguments |
|---|---|---|
| `list` | Rows of stored sessions | optional `filter`: `all`, `archived`, `active` |
| `restore` | Unarchive one session | `sessionId` |
| `delete` | Permanently delete one session | `sessionId`, `confirm: true` |
| `purge_archived` | Permanently delete every archived session | `confirm: true` |

`force: true` skips the running-activity check; it never deletes a session that is open in this process.

## What a deletion actually removes

1. **Bookkeeping.** The session is detached from every workspace record that accounts for it, dropped
   from the archive set, and unpinned — all through the registry's public API, so no in-memory cache is
   written underneath its owner.
2. **The stored log.** Every file in the session's own storage directory (`session*.jsonl`,
   `session*.jsonl.zstd`, and the POSIX `session.lock`) is removed, then the directory itself when it is
   empty. A directory holding anything that is not a session artifact is refused untouched.
3. **A report.** Which files went, how many bytes were freed, and which workspaces were detached.

## Usage notes and limits

- **Not a recycle bin.** There is no undo. The confirmation exists because the bytes are gone.
- **Open sessions are refused.** A session with a live agent in this process cannot be deleted; close it
  first. A session another DSH process is writing is not detected — do not delete from one process what
  another process is using.
- **Archived sessions are the safe target.** They are closed by definition, which is why bulk purge only
  ever looks at the archive set.
- **Per-session caches and attachments are not pruned.** Session search and the projection cache rebuild
  from stored logs, so a deleted session disappears from both, but orphaned attachment files and cache
  rows may remain until other tooling collects them. This plugin handles the session log itself.
- **The panel loads over the command plane.** Each panel refresh runs one `/session-admin list --json`
  against the open session, which the Host records in that session's log as an ordinary command
  lifecycle (`command/run`, `command/done`). Nothing is polled: the panel loads when it opens and when
  you press **Refresh** or run an action.
