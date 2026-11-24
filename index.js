/**
 * Session reaper — Host half.
 *
 * DSH archives sessions (a durable id set in the Workspace registry) but ships no
 * deletion API: the persistence seam explicitly leaves pruning "out-of-band". This
 * plugin adds the missing capability as one operation with two callers:
 *
 *  - the `session_admin` agent tool, and
 *  - the `/session-admin` slash command the Sessions panel drives.
 *
 * Deleting a session means three things, in this order:
 *   1. drop its bookkeeping (workspace accounting, archive set, pin set),
 *   2. remove its session-owned storage directory (only files that belong to a
 *      session log; anything foreign aborts before a single byte is deleted),
 *   3. report what was removed.
 */

import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export const name = 'session-reaper'

/** Command the panel and the user drive; also the tool's operation names. */
export const COMMAND_NAME = 'session-admin'

export const inject = ['tools', 'commands', 'sessionPersistence', 'workspaceRegistry']

/** Files a session-owned directory may contain: the log generations plus the POSIX lease. */
const SESSION_FILE = /^session(\.[A-Za-z0-9._-]+)*\.jsonl(\.zstd)?$/

const ACTIONS = ['list', 'delete', 'restore', 'purge_archived']

const DESCRIPTION = [
  'Inspect and permanently delete sessions (not archive them), and manage archived sessions.',
  'list: rows of stored sessions with archived/live flags, size, directory and best-effort title.',
  'restore: unarchive a session so it returns to its workspace.',
  'delete: permanently remove one session: bookkeeping entries plus its stored log files.',
  'purge_archived: delete every archived session.',
  'Deletion is irreversible. delete and purge_archived require confirm=true; an open (live) session is always refused.',
].join(' ')

const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ACTIONS,
      description: 'list | restore | delete | purge_archived',
    },
    sessionId: {
      type: 'string',
      description: 'Exact session id. Required by restore and delete.',
    },
    filter: {
      type: 'string',
      enum: ['all', 'archived', 'active'],
      description: 'list only: which sessions to return. Defaults to all.',
    },
    confirm: {
      type: 'boolean',
      description: 'Must be true for delete and purge_archived; otherwise the call is refused.',
    },
    force: {
      type: 'boolean',
      description: 'delete/purge only: skip the running-activity check. Never deletes an open session.',
    },
  },
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** Read the registry's archive set as a plain string set. */
function archivedIds(ctx) {
  try {
    return new Set(ctx.workspaceRegistry.archivedSessionIds.map(id => String(id)))
  } catch {
    return new Set()
  }
}

/** Best-effort title for a stored session, from the projection cache; never throws. */
function titleOf(ctx, header) {
  try {
    const cache = ctx.get('sessionProjectionCache')
    if (cache === undefined) return undefined
    const block = cache.cachedSnapshot(header, ['title'])
    const value = block?.values?.title
    if (typeof value === 'string' && value.length > 0) return value
  } catch {
    /* a missing or unreadable cache column only costs the label */
  }
  return undefined
}

/** Every stored session, newest first, with the facts the panel and the tool report. */
async function collectSessions(ctx) {
  const archived = archivedIds(ctx)
  const snapshots = await ctx.sessionPersistence.list()
  const liveIds = new Set()
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    for (const session of sessions.list()) liveIds.add(String(session.id))
  }
  const rows = snapshots.map((snapshot) => {
    const id = String(snapshot.header.id)
    return {
      sessionId: id,
      title: titleOf(ctx, snapshot.header) ?? null,
      cwd: snapshot.header.cwd ?? null,
      createdAt: snapshot.header.createdAt,
      parentSessionId: snapshot.header.parentSession === undefined ? null : String(snapshot.header.parentSession),
      origin: snapshot.header.origin ?? null,
      bytes: snapshot.sizeBytes ?? null,
      archived: archived.has(id),
      live: liveIds.has(id),
      path: snapshot.location?.path ?? null,
      formatStatus: snapshot.formatStatus ?? null,
    }
  })
  rows.sort((left, right) => right.createdAt - left.createdAt || left.sessionId.localeCompare(right.sessionId))
  return rows
}

/** Directory holding one session's artifacts, or undefined for an unmaterialized session. */
function sessionDirOf(snapshot) {
  const file = snapshot?.location?.path
  if (typeof file !== 'string' || file.length === 0) return undefined
  return { dir: dirname(file), file }
}

/**
 * A directory is safe to prune only when every entry belongs to a session log.
 * A foreign entry means the location is not session-owned, and nothing is removed.
 */
async function inspectSessionDir(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const foreign = []
  const removable = []
  for (const entry of entries) {
    if (entry.isFile() && (SESSION_FILE.test(entry.name) || entry.name === 'session.lock')) {
      removable.push(join(dir, entry.name))
    } else {
      foreign.push(entry.name)
    }
  }
  return { removable, foreign }
}

/** Detach a session from every workspace record that still accounts it. */
async function detachFromWorkspaces(ctx, sessionId) {
  const detached = []
  for (const workspace of ctx.workspaceRegistry.list()) {
    if (!workspace.sessionIds.includes(sessionId)) continue
    await workspace.detachSession(sessionId)
    detached.push(String(workspace.id))
  }
  return detached
}

/** Ask the composed providers whether anything still runs for this session. */
async function activityOf(ctx, sessionId) {
  try {
    return await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]))
  } catch {
    return []
  }
}

function describeActivity(activity) {
  return activity
    .map(entry => (Array.isArray(entry.items) && entry.items.length > 0
      ? `${String(entry.kind)}(${entry.items.map(item => item.label ?? item.id).join(', ')})`
      : String(entry.kind)))
    .join(', ')
}

/**
 * Permanently delete one session: bookkeeping first, then its stored log.
 * Workspace accounting, the archive set, and the pin set are cleared through
 * their public registry API, so no in-memory registry cache is written
 * underneath its owner.
 */
async function deleteSession(ctx, sessionId, options = {}) {
  const id = String(sessionId)
  const sessions = ctx.get('sessions')
  if (sessions?.get(id) !== undefined) {
    throw new Error(`session ${id} is open in this process; close or leave it before deleting it`)
  }
  if (options.force !== true) {
    const activity = await activityOf(ctx, id)
    if (activity.length > 0) {
      throw new Error(`session ${id} is still active (${describeActivity(activity)}); stop it or pass force`)
    }
  }

  const snapshot = await ctx.sessionPersistence.stat(id)
  const target = sessionDirOf(snapshot)
  let removal = { files: [], bytes: 0 }
  if (target !== undefined) {
    const plan = await inspectSessionDir(target.dir)
    if (plan.foreign.length > 0) {
      throw new Error(
        `refusing to delete ${target.dir}: it holds entries that are not session artifacts `
        + `(${plan.foreign.slice(0, 5).join(', ')})`,
      )
    }
    removal = { files: plan.removable, bytes: 0 }
  }

  const detached = await detachFromWorkspaces(ctx, id)
  await ctx.workspaceRegistry.unarchiveSession(id)
  await ctx.workspaceRegistry.unpinSession(id)

  const removed = []
  for (const file of removal.files) {
    try {
      const info = await stat(file)
      removal.bytes += info.size
    } catch {
      /* a missing file simply frees nothing */
    }
    await rm(file, { force: true })
    removed.push(basename(file))
  }
  if (target !== undefined) {
    await rmdir(target.dir).catch(() => {})
  }

  return {
    sessionId: id,
    existed: snapshot !== undefined,
    files: removed,
    bytes: removal.bytes,
    detachedWorkspaces: detached,
  }
}

/** Delete every archived session, reporting per-id failures instead of aborting the sweep. */
async function purgeArchived(ctx, options = {}) {
  const ids = ctx.workspaceRegistry.archivedSessionIds.map(id => String(id))
  const deleted = []
  const failed = []
  for (const id of ids) {
    try {
      const result = await deleteSession(ctx, id, options)
      deleted.push({ sessionId: id, files: result.files.length, bytes: result.bytes })
    } catch (error) {
      failed.push({ sessionId: id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { requested: ids.length, deleted, failed }
}

async function runOperation(ctx, request) {
  const action = String(request.action ?? '')
  switch (action) {
    case 'list': {
      const filter = request.filter ?? 'all'
      const rows = await collectSessions(ctx)
      const sessions = rows.filter(row => (filter === 'archived' ? row.archived
        : filter === 'active' ? !row.archived
        : true))
      return { ok: true, action, filter, total: rows.length, sessions }
    }
    case 'restore': {
      const id = String(request.sessionId ?? '')
      if (id.length === 0) throw new Error('restore requires sessionId')
      await ctx.workspaceRegistry.unarchiveSession(id)
      return { ok: true, action, sessionId: id, restored: true }
    }
    case 'delete': {
      if (request.confirm !== true) throw new Error('delete is irreversible: pass confirm=true')
      const id = String(request.sessionId ?? '')
      if (id.length === 0) throw new Error('delete requires sessionId')
      const result = await deleteSession(ctx, id, { force: request.force === true })
      return { ok: true, action, ...result }
    }
    case 'purge_archived': {
      if (request.confirm !== true) throw new Error('purge_archived is irreversible: pass confirm=true')
      const result = await purgeArchived(ctx, { force: request.force === true })
      return { ok: true, action, ...result }
    }
    default:
      throw new Error(`unknown action ${JSON.stringify(action)}; expected one of ${ACTIONS.join(', ')}`)
  }
}

function summarizeRow(row) {
  const flags = [row.archived ? 'archived' : 'visible', row.live ? 'live' : 'closed']
  const size = typeof row.bytes === 'number' ? `${row.bytes} B` : 'size unknown'
  const when = new Date(row.createdAt).toISOString()
  const where = row.cwd ?? '(no cwd)'
  const title = row.title ?? '(untitled)'
  return `${row.sessionId}  ${flags.join('/')}  ${size}  ${when}  ${title}  ${where}`
}

/** Human-facing text for one operation result; `--json` callers get the payload instead. */
function renderResult(result) {
  if (result.action === 'list') {
    return [
      `sessions: ${result.sessions.length} of ${result.total} (filter: ${result.filter})`,
      ...result.sessions.map(summarizeRow),
    ].join('\n')
  }
  if (result.action === 'restore') {
    return `restored ${result.sessionId} (unarchived)`
  }
  if (result.action === 'delete') {
    if (!result.existed) return `session ${result.sessionId} had no stored log; bookkeeping was cleared`
    return `deleted ${result.sessionId}: ${result.files.length} file(s), ${result.bytes} B`
  }
  const failures = result.failed.length === 0
    ? 'no failures'
    : `${result.failed.length} failure(s): ${result.failed.map(entry => `${entry.sessionId} (${entry.error})`).join('; ')}`
  return `purged ${result.deleted.length} of ${result.requested} archived session(s); ${failures}`
}

/**
 * Parse the slash-command grammar: `list [--json] [archived|active]`,
 * `restore <id>`, `delete <id> --yes [--force]`, `purge --yes [--force]`.
 */
function parseCommandLine(rawInput, sessionId) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  const flags = new Set(tokens.filter(token => token.startsWith('--')).map(token => token.slice(2)))
  const words = tokens.filter(token => !token.startsWith('--'))
  const verb = (words[0] ?? 'list').toLowerCase()
  const json = flags.has('json')
  if (verb === 'list') {
    const wanted = words.find(word => word === 'archived' || word === 'active')
    return { request: { action: 'list', filter: wanted ?? 'all' }, json }
  }
  if (verb === 'restore') {
    return { request: { action: 'restore', sessionId: words[1] ?? sessionId }, json }
  }
  if (verb === 'delete') {
    if (words[1] === undefined) throw new Error('usage: /session-admin delete <session-id> --yes')
    return { request: { action: 'delete', sessionId: words[1], confirm: flags.has('yes'), force: flags.has('force') }, json }
  }
  if (verb === 'purge') {
    return { request: { action: 'purge_archived', confirm: flags.has('yes'), force: flags.has('force') }, json }
  }
  throw new Error('usage: /session-admin list|restore|delete|purge [--json] [--yes] [--force]')
}

export function apply(ctx, _config) {
  ctx.effect(() => ctx.tools.register({
    name: 'session_admin',
    description: DESCRIPTION,
    parameters: PARAMETERS,
    output: TEXT_OUTPUT,
    execute: async (args) => renderResult(await runOperation(ctx, args)),
  }), 'session-reaper: session_admin tool')

  ctx.effect(() => ctx.commands.register({
    name: COMMAND_NAME,
    description: 'List, restore, or permanently delete sessions (including archived ones)',
    input: { hint: 'list | restore <id> | delete <id> --yes | purge --yes' },
    handler: async ({ rawInput, agent, signal }) => {
      try {
        signal?.throwIfAborted()
        const fallbackSession = agent === undefined ? '' : String(agent.session.id)
        const { request, json } = parseCommandLine(rawInput, fallbackSession)
        const result = await runOperation(ctx, request)
        signal?.throwIfAborted()
        return { kind: 'success', text: json ? JSON.stringify(result) : renderResult(result) }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  }), 'session-reaper: /session-admin command')
}
