# Session reaper

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that **permanently deletes sessions** — not just archives them — and lets you manage the archived ones.

DSH ships archiving: a session is hidden behind a durable id set in the Workspace registry, and its log stays on disk forever. The persistence seam documents this explicitly ("no deletion or retention API — pruning stored sessions is out-of-band backend maintenance"). This plugin supplies the missing operation.

English | [中文](#中文说明)

## What it does

- **Lists every stored session**, archived or not, with id, created time, project directory, artifact size, and title.
- **Deletes a session for real.** The stored log files are removed from disk; nothing restores it afterwards.
- **Manages archived sessions**: restore one back into its workspace, or delete archived sessions in bulk.

## Install

The plugin is a plain ESM bundle with no build step and no runtime dependencies.

**Desktop app:** Settings → Plugins → **Add plugin** → pick this directory.

**Agent or CLI** (with `plugin_manager` available):

```text
plugin_manager install_bundle  target: <absolute path to this directory>
```

Then restart the plugin row (disable → enable) if the Host was already running, and reload the page so the browser bundle is fetched.

## Usage

### Session row icon

Every session row in the sidebar gets a trash icon in its hover strip, next to the built-in archive and pin icons. Click it, confirm in the dialog, and the session is deleted. This is the shortcut for the common case.

### Sessions panel

A **Sessions** entry in the sidebar opens a panel with the whole store: filter by *all / archived / not archived*, per-row **Restore** (archived rows only) and **Delete**, and **Delete all archived**. Delete asks for an inline confirmation; a row marked *open now* cannot be deleted until it is closed.

### Slash command

```text
/session-admin list [archived|active] [--json]
/session-admin restore <session-id>
/session-admin delete <session-id> --yes [--force]
/session-admin purge --yes [--force]
```

### Agent tool

`session_admin` exposes the same operations to the model:

| `action` | Meaning | Required arguments |
|---|---|---|
| `list` | Rows of stored sessions | optional `filter`: `all`, `archived`, `active` |
| `restore` | Unarchive one session | `sessionId` |
| `delete` | Permanently delete one session | `sessionId`, `confirm: true` |
| `purge_archived` | Permanently delete every archived session | `confirm: true` |

`force: true` skips the running-activity check; a session this process still holds open is archived and removed on release either way.

## What a deletion actually removes

1. **Bookkeeping.** The session is detached from every workspace record that accounts for it, dropped from the archive set, and unpinned — all through the registry's public API, so no in-memory cache is written underneath its owner.
2. **The stored log.** Every file in the session's own storage directory (`session*.jsonl`, `session*.jsonl.zstd`, and the POSIX `session.lock`) is removed, then the directory itself when it is empty. A directory holding anything that is not a session artifact is refused untouched.
3. **A report.** Which files went, how many bytes were freed, and which workspaces were detached.

## Limitations

- **Not a recycle bin.** There is no undo; the confirmation exists because the bytes are gone.
- **Open sessions are force-closed, not skipped.** Deleting a session the Host still holds open stops its
  running work, archives it (an archived session runs no further agent steps) and then removes its log
  immediately. Until the process releases it, the plugin keeps the log removed, so a disposal flush cannot
  resurrect it; the ids live in `~/.dsh/session-reaper/tombstones.json` so a restart finishes the cleanup.
- **A session another DSH process is writing is not detected** — do not delete from one process what another is using.
- **Archived sessions are the safe target.** They are closed by definition, which is why bulk purge only ever looks at the archive set.
- **Images and files sent in the session are not deleted.** Attachments live in a global, content-addressed
  store (`~/.dsh/attachments/v1/objects/…`): one object per unique byte sequence, shared by every session
  that referenced it, and DSH offers no garbage collection for it. Deleting a session therefore leaves its
  attachments behind as unreferenced objects, and removing them safely would mean scanning every other
  session for references — which this plugin deliberately does not do. Session search and the projection
  cache, by contrast, rebuild from stored logs, so a deleted session disappears from both.
- **The panel needs one open session.** The browser bundle talks to the Host over the session command plane, which is the only client→host channel available to a third-party plugin in the Web client. The row icon has the same requirement; both report it rather than guessing.
- **The row icon is hidden on hoverless devices.** That strip is hidden by the host there; use the panel instead.
- **Host APIs move.** This was built and exercised against DSH `0.2.2-rc.5` (DSH Desktop Next `2.0.24-next`); a later release may rename the slots, services, or registry methods it uses.

## Repository layout

```text
package.json           manifest; dsh.bundle + dsh.client declarations
index.js               Host half: deletion service, session_admin tool, /session-admin command
client.js              browser half: Sessions panel, row icon, confirm dialog
cordis.patch.yml       Loader row inserted by the bundle
icon.svg               plugin icon shown in Plugin Manager
locale/en.json         localized title, description, detail entry point
locale/zh.json         localized title, description, detail entry point
docs/DETAIL.md         plugin detail page content
```

## License

MIT — see [LICENSE](LICENSE).

---

## 中文说明

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件：**真正删除会话**（不只是归档），并能管理已归档的会话。

DSH 只提供"归档"——把会话 id 放进 Workspace 注册表的一个持久集合里隐藏起来，日志文件永远留在磁盘上。持久化层明确写了"没有删除或保留 API，清理属于带外维护"。这个插件补上了这个缺口。

### 用法

- **会话行图标**：左侧每个会话行悬停时，行尾（归档/置顶图标旁）出现垃圾桶图标，点击 → 确认框 → 永久删除。
- **会话管理面板**：侧边栏「会话管理」→ 列出全部会话，可按「全部 / 已归档 / 未归档」筛选；归档行可「恢复」，所有行可「删除」；右上角可「删除全部归档」。
- **斜杠命令**：`/session-admin list|restore|delete|purge [--json] [--yes]`
- **Agent 工具**：`session_admin`（`list` / `restore` / `delete` / `purge_archived`）

### 删除到底做了什么

1. 从工作区记录中移除该会话的归属、从归档集合移除、取消置顶（全部走注册表公开 API）
2. 删除磁盘上该会话自己的存储目录（`session*.jsonl`、`session*.jsonl.zstd`、`session.lock`），目录为空后一并删除；若目录里出现不属于会话日志的文件，整体拒绝、一个字节都不删
3. 返回删除了哪些文件、释放多少字节、解除了哪些工作区归属

### 注意

- **没有回收站**，不可撤销
- **打开中的会话会被强制关闭**：删除一个仍被 Host 持有的会话时，会先停止它正在运行的工作、把它归档（已归档会话不再执行 agent 步骤），随后立即删除日志。在进程释放它之前，插件会持续保持日志不存在，避免释放时的刷写把文件写回来；这些 id 记在 `~/.dsh/session-reaper/tombstones.json`，重启后会继续清理完。因此删除你正在使用的对话会当场关闭它。
- **会话里的图片/文件不会被删**：附件存放在全局的内容寻址仓库（`~/.dsh/attachments/v1/objects/…`），按内容去重、被所有引用它的会话共享，且 DSH 没有提供回收接口。因此删掉会话后，它的附件会变成无人引用的孤儿对象留在磁盘上；要安全清理必须先扫描全部其它会话确认无引用，本插件有意不做这件事。会话搜索与投影缓存则会从日志重建，删掉的会话会从两处消失。
- **面板需要一个打开的会话**作为命令通道（第三方插件在 Web 端唯一可用的客户端→Host 通道）
- **触摸设备上无行内图标**，请用面板
- 基于 DSH `0.2.2-rc.5` 开发验证，后续版本可能重命名相关插槽/服务
