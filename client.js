/**
 * Session reaper — browser half.
 *
 * A "Sessions" main panel plus its sidebar entry: lists every stored session,
 * shows which are archived, and permanently deletes sessions. Data and actions
 * travel over the Host's command plane (`/session-admin`), which is the
 * client-callable Host entry point this deployment exposes to a plugin; both
 * callers ultimately run the same Host operation the `session_admin` tool uses.
 */

window.__ModuleLoader__.load({
  id: '@gitproplusmaxultra/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useState } = React

    const NS = 'sessionReaper'
    const PANEL_ID = 'session-reaper'

    const EN = {
      panelTitle: 'Sessions',
      heading: 'Session storage',
      subtitle: 'Delete sessions for real — stored logs included — and manage archived ones.',
      refresh: 'Refresh',
      loading: 'Loading sessions…',
      failed: 'Could not load sessions',
      retry: 'Retry',
      noAgent: 'Open a session first: the Host answers this panel through the session command plane.',
      filterAll: 'All',
      filterArchived: 'Archived',
      filterVisible: 'Not archived',
      empty: 'No sessions in this view.',
      archived: 'archived',
      visible: 'visible',
      live: 'open now',
      closed: 'closed',
      untitled: '(untitled)',
      noCwd: '(no project directory)',
      sizeUnknown: 'size unknown',
      restore: 'Restore',
      delete: 'Delete',
      purge: 'Delete all archived',
      purgeAsk: (n) => `Permanently delete ${n} archived session(s)? This cannot be undone.`,
      deleteAsk: 'Delete this session permanently? Its stored log is removed; this cannot be undone.',
      confirmTitle: 'Delete this session?',
      deleteSession: 'Delete session permanently',
      confirm: 'Delete permanently',
      cancel: 'Cancel',
      working: 'Working…',
      deleted: (id) => `Deleted ${id}.`,
      restored: (id) => `Restored ${id}.`,
      purged: (n, failed) => (failed === 0 ? `Deleted ${n} archived session(s).` : `Deleted ${n}; ${failed} failed.`),
      totalNote: (shown, total) => `${shown} shown of ${total} stored`,
    }

    const ZH = {
      panelTitle: '会话管理',
      heading: '会话存储',
      subtitle: '真正删除会话（含本地日志文件），并管理已归档的会话。',
      refresh: '刷新',
      loading: '正在读取会话…',
      failed: '无法读取会话列表',
      retry: '重试',
      noAgent: '请先打开一个会话：Host 通过会话命令通道为本面板提供数据。',
      filterAll: '全部',
      filterArchived: '已归档',
      filterVisible: '未归档',
      empty: '这个视图里没有会话。',
      archived: '已归档',
      visible: '可见',
      live: '当前打开',
      closed: '已关闭',
      untitled: '（未命名）',
      noCwd: '（无项目目录）',
      sizeUnknown: '大小未知',
      restore: '恢复',
      delete: '删除',
      purge: '删除全部归档',
      purgeAsk: (n) => `永久删除 ${n} 个已归档会话？此操作不可撤销。`,
      deleteAsk: '永久删除这个会话？它的本地日志会被移除，且不可撤销。',
      confirmTitle: '删除这个会话？',
      deleteSession: '永久删除会话',
      confirm: '永久删除',
      cancel: '取消',
      working: '处理中…',
      deleted: (id) => `已删除 ${id}。`,
      restored: (id) => `已恢复 ${id}。`,
      purged: (n, failed) => (failed === 0 ? `已删除 ${n} 个已归档会话。` : `已删除 ${n} 个；${failed} 个失败。`),
      totalNote: (shown, total) => `显示 ${shown} 个，共 ${total} 个`,
    }

    const TOKEN = {
      text: 'var(--dsw-alias-label-primary)',
      dim: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      base: 'var(--dsw-alias-bg-base)',
      card: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))',
      border: 'var(--dsw-alias-border-l2)',
      hover: 'var(--dsw-alias-interactive-bg-hover)',
      danger: 'var(--dsw-alias-state-error-primary)',
      onDanger: 'var(--dsw-alias-label-primary-inverted, #ffffff)',
      accent: 'var(--dsw-alias-state-business-primary)',
      radius: 'var(--dsw-radius-md, 8px)',
      mono: 'var(--dsw-font-mono, ui-monospace, monospace)',
    }

    /**
     * The session this browser actually has open. `agentAvailable` on a catalog row is not a
     * reliable signal here (it can be false for every row), while an open conversation holds a
     * live client binding and one or more retain references.
     */
    function catalogAgentSession(ctx) {
      try {
        const service = ctx.sessions ?? ctx.get('sessions')
        const state = service?.list?.getSnapshot()
        if (!state?.ids) return undefined
        const candidates = []
        for (const id of state.ids) {
          let bound = false
          try {
            bound = service.binding(id) !== undefined
          } catch {
            bound = false
          }
          if (!bound) continue
          let references = 0
          try {
            references = service.retainInfo(id)?.getSnapshot()?.referenceCount ?? 0
          } catch {
            references = 0
          }
          candidates.push({
            id: String(id),
            references,
            updatedAt: state.byId?.[id]?.updatedAt ?? 0,
          })
        }
        if (candidates.length === 0) return undefined
        candidates.sort((left, right) => right.references - left.references
          || right.updatedAt - left.updatedAt)
        return candidates[0].id
      } catch {
        /* no catalog yet */
      }
      return undefined
    }

    /** Ask the Host for its session rows and pick any session whose agent is live. */
    async function hostAgentSession(ctx) {
      let namespace
      try {
        namespace = ctx.get('remote')?.session
      } catch {
        return undefined
      }
      if (namespace === undefined) return undefined
      const outcome = await namespace.list({})
      if (!outcome?.ok) return undefined
      for (const row of outcome.value?.items ?? []) {
        if (row.agentAvailable === true) return String(row.sessionId)
      }
      return undefined
    }

    const sleep = (ms) => new Promise(resolve => { setTimeout(resolve, ms) })

    async function findAgentSession(ctx) {
      // The catalog and the first binding are filled asynchronously after boot, so a panel
      // opened early waits a moment instead of reporting a false "no session".
      for (let attempt = 0; attempt < 12; attempt++) {
        const fromCatalog = catalogAgentSession(ctx)
        if (fromCatalog !== undefined) return fromCatalog
        if (attempt === 4) {
          const fromHost = await hostAgentSession(ctx).catch(() => undefined)
          if (fromHost !== undefined) return fromHost
        }
        await sleep(250)
      }
      return await hostAgentSession(ctx).catch(() => undefined)
    }

    /** Run one `/session-admin` line and return its JSON payload. */
    async function runHostCommand(ctx, line) {
      const sessionId = await findAgentSession(ctx)
      if (sessionId === undefined) {
        let detail = 'catalog=unavailable'
        try {
          const service = ctx.sessions ?? ctx.get('sessions')
          const state = service?.list?.getSnapshot()
          const ids = state?.ids ?? []
          let bound = 0
          let live = 0
          for (const id of ids) {
            if (state.byId?.[id]?.agentAvailable === true) live++
            try {
              if (service.binding(id) !== undefined) bound++
            } catch {
              /* ignore */
            }
          }
          detail = `catalog=${String(state?.phase ?? 'none')} rows=${ids.length} bound=${bound} live=${live}`
        } catch (cause) {
          detail = `catalog error: ${cause instanceof Error ? cause.message : String(cause)}`
        }
        throw new Error(`no open session to address (${detail})`)
      }
      const commands = ctx.remote?.commands ?? ctx.get('remote')?.commands
      if (commands === undefined) throw new Error('the Host command plane is unavailable')
      const outcome = await commands.execute(sessionId, line, [])
      if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`)
      const value = outcome.value
      if (value === undefined) throw new Error('the Host did not resolve that command')
      if (value.result.kind === 'error') throw new Error(value.result.text)
      const text = value.result.text ?? ''
      try {
        return JSON.parse(text)
      } catch {
        throw new Error(text.length === 0 ? 'the Host returned no data' : text)
      }
    }

    function formatBytes(bytes, t) {
      if (typeof bytes !== 'number') return t('sizeUnknown')
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    function formatTime(value) {
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return ''
      const pad = (n) => String(n).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
        + `${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function buttonStyle(kind, disabled) {
      const base = {
        font: 'inherit',
        fontSize: '12px',
        lineHeight: '20px',
        padding: '0 10px',
        borderRadius: 'var(--dsw-radius-sm, 6px)',
        border: `1px solid ${TOKEN.border}`,
        background: 'transparent',
        color: TOKEN.text,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
      }
      if (kind === 'primary') return { ...base, borderColor: TOKEN.danger, color: TOKEN.danger }
      if (kind === 'accent') return { ...base, borderColor: TOKEN.accent, color: TOKEN.accent }
      if (kind === 'dangerFilled') {
        return { ...base, borderColor: TOKEN.danger, background: TOKEN.danger, color: TOKEN.onDanger }
      }
      return base
    }

    function SessionsPanel(props) {
      const t = props.t ?? ((key) => key)
      const runCommand = props.runCommand
      const [rows, setRows] = useState([])
      const [total, setTotal] = useState(0)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [filter, setFilter] = useState('all')
      const [confirmId, setConfirmId] = useState(null)
      const [confirmPurge, setConfirmPurge] = useState(false)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)

      const load = useCallback(async (which) => {
        setPhase('loading')
        setError(null)
        try {
          const payload = await runCommand(`/session-admin list --json${which === 'all' ? '' : ` ${which}`}`)
          setRows(payload.sessions ?? [])
          setTotal(payload.total ?? 0)
          setPhase('ready')
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setPhase('error')
        }
      }, [runCommand])

      useEffect(() => { void load(filter) }, [filter, load])

      const run = useCallback(async (action) => {
        setBusy(action.sessionId ?? action.op)
        setNotice(null)
        try {
          if (action.op === 'delete') {
            const payload = await runCommand(`/session-admin delete ${action.sessionId} --yes --json`)
            setNotice(t('deleted')(payload.sessionId ?? action.sessionId))
          } else if (action.op === 'restore') {
            const payload = await runCommand(`/session-admin restore ${action.sessionId} --json`)
            setNotice(t('restored')(payload.sessionId ?? action.sessionId))
          } else if (action.op === 'purge') {
            const payload = await runCommand('/session-admin purge --yes --json')
            setNotice(t('purged')(payload.deleted?.length ?? 0, payload.failed?.length ?? 0))
          }
          setConfirmId(null)
          setConfirmPurge(false)
          await load(filter)
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause))
          setPhase('error')
        } finally {
          setBusy(null)
        }
      }, [filter, load, runCommand, t])

      const archivedCount = useMemo(() => rows.filter(row => row.archived).length, [rows])
      const filterTabs = [
        { id: 'all', label: t('filterAll') },
        { id: 'archived', label: t('filterArchived') },
        { id: 'active', label: t('filterVisible') },
      ]

      const header = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
        h('h1', { style: { margin: 0, fontSize: '18px', fontWeight: 600, color: TOKEN.text } }, t('heading')),
        h('p', { style: { margin: 0, fontSize: '13px', color: TOKEN.dim } }, t('subtitle')))

      const toolbar = h('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '16px' },
      },
      filterTabs.map(tab => h('button', {
        key: tab.id,
        type: 'button',
        onClick: () => { setFilter(tab.id); setConfirmId(null) },
        style: {
          ...buttonStyle(tab.id === filter ? 'accent' : 'plain', false),
          background: tab.id === filter ? TOKEN.hover : 'transparent',
        },
      }, tab.label)),
      h('span', { style: { flex: 1 } }),
      h('span', { style: { fontSize: '12px', color: TOKEN.faint } }, t('totalNote')(rows.length, total)),
      h('button', {
        type: 'button',
        onClick: () => { void load(filter) },
        disabled: busy !== null,
        style: buttonStyle('plain', busy !== null),
      }, t('refresh')),
      h('button', {
        type: 'button',
        onClick: () => setConfirmPurge(true),
        disabled: busy !== null || archivedCount === 0,
        style: buttonStyle('primary', busy !== null || archivedCount === 0),
      }, t('purge')))

      const noticeBar = notice === null ? null : h('div', {
        style: { marginTop: '12px', fontSize: '12px', color: TOKEN.dim },
      }, notice)

      const errorBar = error === null ? null : h('div', {
        style: {
          marginTop: '12px', padding: '8px 10px', borderRadius: TOKEN.radius,
          border: `1px solid ${TOKEN.danger}`, color: TOKEN.danger, fontSize: '12px',
        },
      }, h('div', null, `${t('failed')}: ${error}`),
      h('button', {
        type: 'button', onClick: () => { void load(filter) }, style: { ...buttonStyle('plain', false), marginTop: '6px' },
      }, t('retry')))

      const purgeAsk = confirmPurge ? h('div', {
        style: {
          marginTop: '12px', padding: '10px 12px', borderRadius: TOKEN.radius,
          border: `1px solid ${TOKEN.danger}`, background: TOKEN.card, fontSize: '12px', color: TOKEN.text,
          display: 'flex', flexDirection: 'column', gap: '8px',
        },
      }, h('span', null, t('purgeAsk')(archivedCount)),
      h('div', { style: { display: 'flex', gap: '8px' } },
        h('button', {
          type: 'button',
          onClick: () => { void run({ op: 'purge' }) },
          disabled: busy !== null,
          style: buttonStyle('primary', busy !== null),
        }, busy === 'purge' ? t('working') : t('confirm')),
        h('button', {
          type: 'button', onClick: () => setConfirmPurge(false), style: buttonStyle('plain', false),
        }, t('cancel')))) : null

      const body = phase === 'loading' && rows.length === 0
        ? h('div', { style: { marginTop: '24px', fontSize: '13px', color: TOKEN.dim } }, t('loading'))
        : phase === 'error' && rows.length === 0
          ? h('div', { style: { marginTop: '24px', fontSize: '13px', color: TOKEN.dim } },
            error !== null && error.includes('no open session') ? t('noAgent') : t('empty'))
          : rows.length === 0
            ? h('div', { style: { marginTop: '24px', fontSize: '13px', color: TOKEN.dim } }, t('empty'))
            : h('div', {
              style: { marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' },
            }, rows.map((row) => {
              const confirming = confirmId === row.sessionId
              const title = row.title ?? t('untitled')
              const badges = [
                { text: row.archived ? t('archived') : t('visible'), color: row.archived ? TOKEN.accent : TOKEN.faint },
                { text: row.live ? t('live') : t('closed'), color: row.live ? TOKEN.accent : TOKEN.faint },
              ]
              return h('div', {
                key: row.sessionId,
                style: {
                  border: `1px solid ${TOKEN.border}`,
                  borderRadius: TOKEN.radius,
                  background: TOKEN.card,
                  padding: '10px 12px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                },
              },
              h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' } },
                h('span', {
                  style: { fontSize: '13px', fontWeight: 600, color: TOKEN.text, overflowWrap: 'anywhere' },
                }, title),
                badges.map(badge => h('span', {
                  key: badge.text,
                  style: {
                    fontSize: '11px', color: badge.color, border: `1px solid ${TOKEN.border}`,
                    borderRadius: '999px', padding: '0 6px', lineHeight: '16px',
                  },
                }, badge.text)),
                h('span', { style: { flex: 1 } }),
                h('span', { style: { fontSize: '11px', color: TOKEN.faint } },
                  `${formatTime(row.createdAt)} · ${formatBytes(row.bytes, t)}`)),
              h('div', {
                style: { fontSize: '11px', color: TOKEN.dim, fontFamily: TOKEN.mono, overflowWrap: 'anywhere' },
              }, `${row.sessionId}  ${row.cwd ?? t('noCwd')}`),
              confirming
                ? h('div', {
                  style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', marginTop: '2px' },
                },
                h('span', { style: { fontSize: '12px', color: TOKEN.danger } }, t('deleteAsk')),
                h('button', {
                  type: 'button',
                  onClick: () => { void run({ op: 'delete', sessionId: row.sessionId }) },
                  disabled: busy !== null || row.live,
                  style: buttonStyle('primary', busy !== null || row.live),
                }, busy === row.sessionId ? t('working') : t('confirm')),
                h('button', {
                  type: 'button', onClick: () => setConfirmId(null), style: buttonStyle('plain', false),
                }, t('cancel')))
                : h('div', { style: { display: 'flex', gap: '8px', marginTop: '2px' } },
                  row.archived ? h('button', {
                    type: 'button',
                    onClick: () => { void run({ op: 'restore', sessionId: row.sessionId }) },
                    disabled: busy !== null,
                    style: buttonStyle('accent', busy !== null),
                  }, t('restore')) : null,
                  h('button', {
                    type: 'button',
                    onClick: () => { setNotice(null); setConfirmId(row.sessionId) },
                    disabled: busy !== null || row.live,
                    style: buttonStyle('primary', busy !== null || row.live),
                  }, t('delete')))
              )
            }))

      return h('div', {
        style: {
          height: '100%', overflowY: 'auto', boxSizing: 'border-box',
          padding: '20px 24px 32px', background: TOKEN.base,
        },
      }, header, toolbar, purgeAsk, errorBar, noticeBar, body)
    }

    function SessionsPanelIcon(props) {
      const size = props?.size ?? 16
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size, 'aria-hidden': true,
        style: { display: 'block', color: 'currentColor' },
      },
      h('path', {
        d: 'M5 2.5h6a.5.5 0 0 1 .5.5v1H8V3H6.5v1H4.5V3a.5.5 0 0 1 .5-.5Z',
        fill: 'currentColor', opacity: 0.55,
      }),
      h('path', {
        d: 'M3.5 4.5h9l-.8 8.2a1 1 0 0 1-1 .8H5.3a1 1 0 0 1-1-.8L3.5 4.5Zm2.4 1.6.4 6h.9l-.3-6h-1Zm3.4 0-.3 6h.9l.4-6h-1Z',
        fill: 'currentColor',
      }))
    }

    /** One pending destructive confirmation, shared by the row menu and the overlay dialog. */
    function createConfirmStore() {
      let value = null
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    function DeleteSessionConfirm(props) {
      const t = props.t ?? ((key) => key)
      const store = props.store
      const runCommand = props.runCommand
      const notify = props.notify
      const [pending, setPending] = useState(store.getSnapshot())
      const [busy, setBusy] = useState(false)
      const [failure, setFailure] = useState(null)

      useEffect(() => {
        setPending(store.getSnapshot())
        return store.subscribe(() => {
          setPending(store.getSnapshot())
          setFailure(null)
          setBusy(false)
        })
      }, [store])

      const close = useCallback(() => { store.set(null) }, [store])

      useEffect(() => {
        if (pending === null) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            close()
          }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [pending, close])

      if (pending === null) return null

      const confirm = async () => {
        setBusy(true)
        setFailure(null)
        try {
          const payload = await runCommand(`/session-admin delete ${pending.sessionId} --yes --json`)
          close()
          notify(t('deleted')(payload.sessionId ?? pending.sessionId), true)
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          setFailure(message)
          notify(`${t('failed')}: ${message}`, false)
          setBusy(false)
        }
      }

      const card = h('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'session-reaper-confirm-title',
        style: {
          width: 'min(440px, calc(100vw - 48px))', boxSizing: 'border-box',
          background: TOKEN.card, color: TOKEN.text,
          border: `1px solid ${TOKEN.border}`, borderRadius: 'var(--dsw-radius-lg, 12px)',
          boxShadow: '0 12px 32px rgba(0,0,0,0.28)', padding: '18px 20px',
          display: 'flex', flexDirection: 'column', gap: '10px',
        },
      },
      h('h2', {
        id: 'session-reaper-confirm-title',
        style: { margin: 0, fontSize: '15px', fontWeight: 600 },
      }, t('confirmTitle')),
      h('div', { style: { fontSize: '13px', color: TOKEN.dim, lineHeight: '20px' } }, t('deleteAsk')),
      h('div', {
        style: {
          fontSize: '12px', color: TOKEN.dim, fontFamily: TOKEN.mono,
          background: TOKEN.base, border: `1px solid ${TOKEN.border}`,
          borderRadius: TOKEN.radius, padding: '8px 10px', overflowWrap: 'anywhere',
        },
      }, pending.title ? `${pending.title}  ·  ${pending.sessionId}` : pending.sessionId),
      failure === null ? null : h('div', { style: { fontSize: '12px', color: TOKEN.danger } }, failure),
      h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '4px' } },
        h('button', {
          type: 'button', onClick: close, disabled: busy, style: buttonStyle('plain', busy),
        }, t('cancel')),
        h('button', {
          type: 'button', onClick: () => { void confirm() }, disabled: busy,
          style: buttonStyle('dangerFilled', busy),
        }, busy ? t('working') : t('confirm'))))

      return h('div', {
        style: {
          position: 'fixed', inset: 0, zIndex: 2147483000, pointerEvents: 'auto',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.35)',
        },
        onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) close() },
        role: 'presentation',
      }, card)
    }

    /**
     * Row hover button (order 300): the permanent-delete counterpart of the
     * built-in archive/pin icons, at the end of a Session row.
     */
    function DeleteSessionRowAction(props) {
      const t = props.t ?? ((key) => key)
      const store = props.store
      const sessionId = props.sessionId
      const [active, setActive] = useState(false)
      if (sessionId === undefined) return null
      const label = t('deleteSession')
      return h('button', {
        type: 'button',
        title: label,
        'aria-label': label,
        onMouseEnter: () => setActive(true),
        onMouseLeave: () => setActive(false),
        onFocus: () => setActive(true),
        onBlur: () => setActive(false),
        onClick: () => { store.set({ sessionId: String(sessionId), title: '' }) },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: '22px', height: '22px', padding: 0, margin: 0, border: 'none',
          borderRadius: 'var(--dsw-radius-sm, 6px)',
          background: active ? TOKEN.hover : 'transparent',
          color: active ? TOKEN.danger : TOKEN.faint,
          cursor: 'pointer', font: 'inherit',
        },
      }, h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        style: { display: 'block', color: 'currentColor' },
      },
      h('path', {
        d: 'M5.2 2h5.6a.6.6 0 0 1 .6.6V4h1.9a.6.6 0 0 1 0 1.2h-.6l-.7 8.1a1.2 1.2 0 0 1-1.2 1.1H5.2A1.2 1.2 0 0 1 4 13.3L3.3 5.2H2.7a.6.6 0 0 1 0-1.2h1.9V2.6A.6.6 0 0 1 5.2 2Zm.6 2h4.4V3.2H5.8V4Zm-.3 1.2.5 7.6h.9l-.4-7.6h-1Zm2.7 0-.4 7.6h.9l.5-7.6h-1Z',
        fill: 'currentColor',
      })))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { en: EN, zh: ZH }), 'session-reaper: dictionaries')
      const t = ctx.locale.bind(NS)
      const translate = (key) => {
        try {
          return t(key)
        } catch {
          return EN[key] ?? key
        }
      }

      const confirmStore = createConfirmStore()
      const runCommand = (line) => runHostCommand(ctx, line)
      const notify = (text, success) => {
        try {
          ctx.contextMenus?.notify?.(text, success)
        } catch {
          /* feedback is best-effort */
        }
      }

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        inject: () => ({ t: translate, runCommand }),
      }, SessionsPanel))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 2,
        label: () => translate('panelTitle'),
      }, SessionsPanelIcon))

      // The confirmation lives above every column, so the row menu can hand off to it.
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-reaper.confirm',
        inject: () => ({ t: translate, store: confirmStore, runCommand, notify }),
      }, DeleteSessionConfirm))

      // The permanent-delete icon sits in the row's hover strip, after archive and pin.
      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'session-reaper.delete',
        order: 300,
        inject: () => ({ t: translate, store: confirmStore }),
      }, DeleteSessionRowAction))
    }

    return { inject: ['slots', 'locale', 'sessions', 'remote', 'remote.commands', 'contextMenus'], apply }
  },
})
