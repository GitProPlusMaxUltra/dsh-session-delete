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

`force: true` skips the running-activity check; a session this process still holds open is archived and removed on release either way.

## What a deletion actually removes

1. **Bookkeeping.** The session is detached from every workspace record that accounts for it, dropped
   from the archive set, and unpinned — all through the registry's public API, so no in-memory cache is
   written underneath its owner.
2. **The stored log.** Every file in the session's own storage directory (`session*.jsonl`,
   `session*.jsonl.zstd`, and the POSIX `session.lock`) is removed, then the directory itself when it is
   empty. A directory holding anything that is not a session artifact is refused untouched. A session
   this process still holds open is force-closed first, then removed the same way.
3. **A report.** Which files went, how many bytes were freed, and which workspaces were detached.

## Usage notes and limits

- **Not a recycle bin.** There is no undo. The confirmation exists because the bytes are gone.
- **An open session is force-closed, not skipped.** Its running work is stopped, it is archived (an
  archived session runs no further agent steps), and its log is removed immediately. While the process
  still holds it the plugin keeps the log removed, so a disposal flush cannot resurrect it; those ids are
  recorded in `~/.dsh/session-reaper/tombstones.json`, so a restart finishes the cleanup. Deleting the
  conversation you are in therefore closes it on the spot.
- **A session another DSH process is writing is not detected** — do not delete from one process what
  another is using.
- **Archived sessions are the safe target.** They are closed by definition, which is why bulk purge only
  ever looks at the archive set.
- **Images and files sent in the session are not deleted.** Attachments live in a global,
  content-addressed store (`~/.dsh/attachments/v1/objects/…`): one object per unique byte sequence,
  shared by every session that referenced it, and DSH offers no garbage collection for it. Deleting a
  session therefore leaves its attachments behind as unreferenced objects. Removing them safely would mean
  scanning every other session for references, which this plugin deliberately does not do — the session
  log is the only thing it owns.
- **The panel loads over the command plane.** Each panel refresh runs one `/session-admin list --json`
  against the open session, which the Host records in that session's log as an ordinary command
  lifecycle (`command/run`, `command/done`). Nothing is polled: the panel loads when it opens and when
  you press **Refresh** or run an action.
