window.__ModuleLoader__.load({
  id: 'dsh-sync-hub',
  factory: (require) => {
    'use strict'

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    const NS = 'dsh-sync-hub'
    const APP_TITLE = '数据同步'
    /** Set to true to re-enable the sidebar shortcut button beside the footer actions. */
    const SHOW_SIDEBAR_SETTINGS_SHORTCUT = false
    const RIGHT_TAB_ID = 'dsh-sync-hub'
    const RIGHT_TAB_KIND = 'dsh-sync-hub'

    /**
     * Reads DSH's own session list (display titles + last activity) and workspace
     * pin set, keyed by session id. Replaced once both client services mount; an
     * empty map keeps the sessions tab functional without them.
     */
    let dshSessionMetaReader = () => new Map()
    const API_BASE = '/dsh-sync/'
    const DEFAULT_PREFIX = 'dsh-sync/v1'
    const POLL_INTERVAL_MS = 1000
    const MAX_ACTION_ROWS = 300

    const DIRECTIONS = [
      { value: 'both', label: '双向' },
      { value: 'push', label: '仅备份到目标' },
      { value: 'pull', label: '仅从目标恢复' },
    ]

    const DIRECTION_HINTS = {
      both: '比较本地与目标，按同步策略合并两侧变更。',
      push: '只把本地变更写入目标，不修改本地文件。',
      pull: '只把目标上的变更恢复到本地，不修改目标。',
    }

    const PROFILE_OPTIONS = [
      { value: 'web', label: 'Web' },
      { value: 'desktop', label: '桌面端' },
    ]

    const SCOPE_FALLBACK_NAMES = {
      'plugin-settings': '插件设置',
      'plugin-files': '插件文件',
      skills: '全局 Skills',
      memes: '表情包',
      skins: '外观皮肤',
      pets: '宠物外观',
      sessions: '会话数据',
      attachments: '会话附件',
      storages: '工作区与统计',
      'agents-md': '全局 AGENTS.md',
      settings: '全局设置',
      presets: 'Agent 预设',
    }

    const RUN_STATES = {
      idle: { label: '空闲', tone: 'muted' },
      running: { label: '进行中', tone: 'brand' },
      cancelling: { label: '取消中', tone: 'muted' },
      succeeded: { label: '已完成', tone: 'success' },
      failed: { label: '失败', tone: 'error' },
      cancelled: { label: '已取消', tone: 'neutral' },
    }

    const PHASE_LABELS = {
      scan: '扫描文件',
      scanning: '扫描文件',
      plan: '生成计划',
      planning: '生成计划',
      download: '下载',
      downloading: '下载',
      upload: '上传',
      uploading: '上传',
      merge: '合并',
      merging: '合并',
      manifest: '写入清单',
      writing: '写入清单',
      clean: '清理',
      cleaning: '清理',
      done: '完成',
    }

    const PREVIEW_SUMMARY_ITEMS = [
      { label: '待上传', tone: 'success', keys: ['upload'] },
      { label: '待下载', tone: 'brand', keys: ['download'] },
      { label: '冲突', tone: 'error', keys: ['conflict'] },
      { label: '待决定', tone: 'muted', keys: ['choice'] },
      { label: '删除', tone: 'error', keys: ['delete'] },
      { label: '跳过', tone: 'muted', keys: ['skipped', 'skip'] },
      { label: '相同', tone: 'muted', keys: ['identical'] },
    ]

    const ACTION_GROUPS = [
      { type: 'conflict', label: '冲突', tone: 'error' },
      { type: 'choice', label: '待决定（删除）', tone: 'muted' },
      { type: 'upload', label: '上传', tone: 'success' },
      { type: 'download', label: '下载', tone: 'brand' },
      { type: 'delete', label: '删除', tone: 'error' },
      { type: 'skip', label: '跳过', tone: 'muted' },
      { type: 'identical', label: '相同（跳过）', tone: 'muted' },
    ]

    const DEFAULT_OPEN_GROUPS = {
      conflict: true,
      choice: true,
      upload: true,
      download: true,
      delete: true,
      skip: true,
      identical: false,
    }

    const SUMMARY_LABELS = {
      files: '文件',
      upload: '计划上传',
      download: '计划下载',
      conflict: '计划冲突',
      skip: '跳过',
      uploaded: '已上传',
      downloaded: '已下载',
      identical: '相同跳过',
      conflicts: '冲突',
      skipped: '跳过',
      deleted: '删除',
      failed: '失败',
      bytes: '传输字节',
      bytesUploaded: '上传字节',
      bytesDownloaded: '下载字节',
      total: '总计',
    }

    const TONES = {
      neutral: {
        color: 'var(--dsw-alias-label-secondary)',
        border: 'var(--dsw-alias-border-l2)',
      },
      muted: {
        color: 'var(--dsw-alias-label-tertiary)',
        border: 'var(--dsw-alias-border-l2)',
      },
      brand: {
        color: 'var(--dsw-alias-brand-primary)',
        border: 'var(--dsw-alias-brand-primary)',
      },
      success: {
        color: 'var(--dsw-alias-state-success)',
        border: 'var(--dsw-alias-state-success)',
      },
      error: {
        color: 'var(--dsw-alias-state-error)',
        border: 'var(--dsw-alias-state-error)',
      },
    }

    const styles = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        maxWidth: 1040,
        color: 'var(--dsw-alias-label-primary)',
        fontSize: 13,
        lineHeight: 1.6,
        fontFamily: 'inherit',
      },
      card: {
        background: 'var(--dsw-alias-bg-l2)',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        padding: '12px 14px',
      },
      sectionTitle: {
        margin: 0,
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      hint: {
        fontSize: 11,
        lineHeight: 1.5,
        color: 'var(--dsw-alias-label-tertiary)',
      },
      muted: {
        fontSize: 12,
        color: 'var(--dsw-alias-label-secondary)',
      },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: 11,
        wordBreak: 'break-all',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '6px 9px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontFamily: 'inherit',
        fontSize: 12,
        lineHeight: '20px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
      },
      wrapRow: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
      },
      tabs: {
        display: 'flex',
        gap: 3,
        padding: 3,
        alignSelf: 'flex-start',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-l2)',
      },
    }

    // ---------------------------------------------------------------------
    // 基础工具
    // ---------------------------------------------------------------------

    function errorText(error) {
      if (error && typeof error.message === 'string' && error.message) return error.message
      if (typeof error === 'string' && error) return error
      return '未知错误'
    }

    function errorInfo(error) {
      const info = { message: errorText(error) }
      if (error && typeof error.code === 'string' && error.code) info.code = error.code
      return info
    }

    function makeError(message, code) {
      const error = new Error(message)
      if (code) error.code = code
      return error
    }

    /**
     * 与宿主通信的唯一通道。宿主返回 { ok: true, value } 或
     * { ok: false, code, message }，失败统一抛 Error，由 UI 顶层错误条展示。
     */
    async function api(endpoint, payload) {
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const slowEndpoint =
        endpoint === 'preview'
        || endpoint === 'scopes.estimate'
        || endpoint === 'targets.test'
        // Session compare/transfer hashes whole session logs and may copy
        // hundreds of megabytes on a first restore.
        || endpoint === 'sessions.compare'
        || endpoint === 'sessions.backup.list'
        || endpoint === 'sessions.sync'
        || endpoint === 'sessions.restore'
        || endpoint === 'sessions.overwrite'
      const timer = controller ? setTimeout(() => controller.abort(), slowEndpoint ? 120000 : 30000) : null
      let response
      try {
        response = await fetch(API_BASE + endpoint, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload == null ? {} : payload),
          signal: controller ? controller.signal : undefined,
        })
      } catch (error) {
        if (error && error.name === 'AbortError') {
          throw makeError('请求超时，请稍后重试', 'timeout')
        }
        throw makeError('无法连接 DSH 宿主，请确认插件宿主服务正在运行', 'network')
      } finally {
        if (timer) clearTimeout(timer)
      }

      let data = null
      try {
        data = await response.json()
      } catch (error) {
        data = null
      }

      if (!data || typeof data !== 'object') {
        throw makeError('宿主返回了无法解析的响应（HTTP ' + response.status + '）', 'bad_response')
      }
      if (data.ok !== true) {
        const message =
          typeof data.message === 'string' && data.message
            ? data.message
            : '请求失败（HTTP ' + response.status + '）'
        throw makeError(message, data.code || 'http_' + response.status)
      }
      return data.value
    }

    function isObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    function textOf(value, fallback) {
      return typeof value === 'string' && value ? value : fallback
    }

    function normalizeDirection(value) {
      return value === 'push' || value === 'pull' ? value : 'both'
    }

    function isActiveRunState(state) {
      return state === 'running' || state === 'cancelling'
    }

    function firstSummaryValue(summary, keys) {
      if (!isObject(summary)) return 0
      for (const key of keys) {
        if (summary[key] !== undefined && summary[key] !== null) return summary[key]
      }
      return 0
    }

    function formatRunError(value) {
      if (value == null) return ''
      if (typeof value === 'string') return value
      if (isObject(value)) {
        const message = textOf(value.message, '')
        const code = textOf(value.code, '')
        if (message && code) return message + '（' + code + '）'
        if (message) return message
        if (code) return code
      }
      return summaryValue(value)
    }

    function summaryDisplayValue(key, value) {
      if (typeof value === 'number' && /bytes/i.test(key)) return formatBytes(value)
      return summaryValue(value)
    }

    function normalizeTargetList(value) {
      if (!Array.isArray(value)) return []
      return value.filter((target) => isObject(target) && typeof target.id === 'string' && target.id)
    }

    function normalizeEstimateList(value) {
      if (!Array.isArray(value)) return []
      return value.filter((scope) => isObject(scope) && typeof scope.id === 'string' && scope.id)
    }

    function formatNumber(value) {
      const number = Number(value)
      if (!Number.isFinite(number)) return '0'
      try {
        return number.toLocaleString('zh-CN')
      } catch (error) {
        return String(number)
      }
    }

    function formatBytes(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB', 'TB']
      let amount = number
      let index = 0
      while (amount >= 1024 && index < units.length - 1) {
        amount = amount / 1024
        index += 1
      }
      const digits = amount >= 100 ? 0 : amount >= 10 ? 1 : 2
      const text = amount.toFixed(digits).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')
      return text + ' ' + units[index]
    }

    function toDate(value) {
      if (value == null || value === '') return null
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
      let normalized = value
      if (typeof normalized === 'number' && normalized > 0 && normalized < 1000000000000) {
        normalized = normalized * 1000
      }
      const date = new Date(normalized)
      return Number.isNaN(date.getTime()) ? null : date
    }

    function formatDate(value, withSeconds) {
      const date = toDate(value)
      if (!date) return '—'
      const options = {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }
      if (withSeconds) options.second = '2-digit'
      try {
        return date.toLocaleString('zh-CN', options)
      } catch (error) {
        return date.toISOString()
      }
    }

    function scopeSetting(settings, id) {
      const entry = settings && isObject(settings.scopes) ? settings.scopes[id] : null
      const profiles =
        entry && Array.isArray(entry.profiles) && entry.profiles.length
          ? entry.profiles.slice()
          : ['web']
      return {
        enabled: !entry || entry.enabled !== false,
        profiles,
      }
    }

    function scopeDisplayName(scope) {
      if (scope && typeof scope.name === 'string' && scope.name) return scope.name
      if (scope && typeof scope.id === 'string' && SCOPE_FALLBACK_NAMES[scope.id]) {
        return SCOPE_FALLBACK_NAMES[scope.id]
      }
      return scope && scope.id ? scope.id : '未知同步项'
    }

    function normalizeScopeRow(scope) {
      return {
        id: scope.id,
        name: scopeDisplayName(scope),
        files: Number.isFinite(Number(scope.files)) ? Number(scope.files) : 0,
        bytes: Number.isFinite(Number(scope.bytes)) ? Number(scope.bytes) : 0,
        error: textOf(scope.error, ''),
        custom: scope.custom === true || (typeof scope.id === 'string' && scope.id.startsWith('custom:')),
        measured: true,
      }
    }

    /**
     * 宿主的 scopes.estimate 可能只返回已启用的项（当前实现如此），因此用
     * settings.scopes 补齐未启用的项，否则用户无法在 UI 里重新启用它们。
     */
    function buildScopeRows(estimates, settings) {
      const measured = new Map()
      if (Array.isArray(estimates)) {
        estimates.forEach((scope) => {
          if (isObject(scope) && typeof scope.id === 'string' && scope.id) {
            measured.set(scope.id, normalizeScopeRow(scope))
          }
        })
      }
      const rows = []
      const seen = new Set()
      const configured = isObject(settings.scopes) ? settings.scopes : {}
      Object.keys(configured).forEach((id) => {
        const row = measured.get(id)
        if (row) {
          rows.push(row)
        } else {
          rows.push({
            id: id,
            name: SCOPE_FALLBACK_NAMES[id] || id,
            files: 0,
            bytes: 0,
            error: '',
            measured: false,
          })
        }
        seen.add(id)
      })
      measured.forEach((row, id) => {
        if (!seen.has(id)) rows.push(row)
      })
      return rows
    }

    function lastRunState(status) {
      const run = status && isObject(status.lastRun) ? status.lastRun : null
      return run && typeof run.state === 'string' ? run.state : 'idle'
    }

    function lastRunText(status) {
      const run = status && isObject(status.lastRun) ? status.lastRun : null
      if (!run) return '尚未同步'
      const state = RUN_STATES[run.state] || { label: run.state || '未知' }
      const time = formatDate(run.finishedAt || run.startedAt)
      return state.label + ' · ' + time
    }

    function formatPhase(phase) {
      if (!phase) return '准备中'
      return PHASE_LABELS[phase] || String(phase)
    }

    function progressPercent(progress) {
      if (!progress || typeof progress !== 'object') return null
      const total = Number(progress.total)
      const done = Number(progress.done)
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return null
      return Math.max(0, Math.min(100, Math.round((done / total) * 100)))
    }

    /** Transfer speed label; null hides the line instead of showing 0 B/s. */
    function formatSpeed(bytesPerSecond) {
      const value = Number(bytesPerSecond)
      if (!Number.isFinite(value) || value <= 0) return null
      return formatBytes(value) + '/s'
    }

    /** Rough remaining time for the current transfer, from bytes and speed. */
    function formatEta(progress) {
      if (!progress || typeof progress !== 'object') return null
      const speed = Number(progress.speedBytesPerSec)
      const total = Number(progress.bytesTotal)
      const done = Number(progress.bytesDone)
      if (!Number.isFinite(speed) || speed <= 0) return null
      if (!Number.isFinite(total) || !Number.isFinite(done) || total <= done) return null
      const seconds = Math.ceil((total - done) / speed)
      if (!Number.isFinite(seconds) || seconds <= 0) return null
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒'
      return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分'
    }

    /** Duration label for a finished run. */
    function formatDurationMs(ms) {
      const value = Number(ms)
      if (!Number.isFinite(value) || value < 0) return null
      if (value < 1000) return Math.round(value) + ' 毫秒'
      const seconds = Math.round(value / 1000)
      if (seconds < 60) return seconds + ' 秒'
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒'
      return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分'
    }

    function summaryValue(value) {
      if (value == null) return '—'
      if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : String(value)
      if (typeof value === 'boolean') return value ? '是' : '否'
      if (typeof value === 'string') return value
      try {
        const text = JSON.stringify(value)
        return text && text.length > 140 ? text.slice(0, 137) + '…' : text || '—'
      } catch (error) {
        return String(value)
      }
    }

    function groupActions(actions) {
      const buckets = new Map()
      ACTION_GROUPS.forEach((group) => buckets.set(group.type, []))
      const extra = []
      const list = Array.isArray(actions) ? actions : []
      list.forEach((action) => {
        if (!isObject(action)) return
        const type = typeof action.type === 'string' ? action.type : 'skip'
        if (buckets.has(type)) {
          buckets.get(type).push(action)
        } else {
          extra.push(Object.assign({}, action, { type: type }))
        }
      })
      const groups = ACTION_GROUPS.map((group) => ({
        type: group.type,
        label: group.label,
        tone: group.tone,
        items: buckets.get(group.type),
      })).filter((group) => group.items.length > 0)
      if (extra.length) {
        groups.push({ type: 'other', label: '其它', tone: 'muted', items: extra })
      }
      return groups
    }

    function newTargetId() {
      return 'local-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    }

    function deriveTargetName(targetPath) {
      const clean = String(targetPath || '').replace(/[\\/]+$/, '')
      const parts = clean.split(/[\\/]/).filter(Boolean)
      return parts.length ? parts[parts.length - 1] : '本地备份'
    }

    function targetKindLabel(kind) {
      if (kind === 'local') return '本地目录'
      return kind ? String(kind) : '本地目录'
    }

    function targetLastSync(target) {
      if (!isObject(target)) return '—'
      const value =
        target.lastSyncAt ||
        target.lastSyncedAt ||
        (isObject(target.lastRun) ? target.lastRun.finishedAt : null) ||
        (isObject(target.lastSync) ? target.lastSync.finishedAt : target.lastSync)
      return value ? formatDate(value) : '—'
    }

    function DirectionSelect(props) {
      return h(
        'select',
        {
          value: props.value,
          onChange: (event) => props.onChange(event.target.value),
          disabled: props.disabled,
          style: Object.assign({}, styles.input, { cursor: props.disabled ? 'not-allowed' : 'pointer' }),
          'aria-label': '同步方向',
        },
        DIRECTIONS.map((direction) =>
          h('option', { key: direction.value, value: direction.value }, direction.label)
        )
      )
    }

    function TargetSelect(props) {
      const targets = Array.isArray(props.targets) ? props.targets : []
      const disabled = props.disabled || targets.length === 0
      return h(
        'select',
        {
          value: props.value || '',
          onChange: (event) => props.onChange(event.target.value),
          disabled: disabled,
          style: Object.assign({}, styles.input, { cursor: disabled ? 'not-allowed' : 'pointer' }),
          'aria-label': props.label || '同步目标',
        },
        targets.length === 0 ? h('option', { value: '' }, '暂无目标') : null,
        targets.map((target) =>
          h(
            'option',
            { key: target.id, value: target.id },
            String(target.name || target.id) + (target.enabled === false ? '（已停用）' : '')
          )
        )
      )
    }

    // ---------------------------------------------------------------------
    // 展示组件
    // ---------------------------------------------------------------------

    function Icon(props) {
      const paths = props.paths || []
      return h(
        'svg',
        {
          width: props.size || 14,
          height: props.size || 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { flex: '0 0 auto', display: 'inline-block' },
        },
        paths.map((path, index) => h('path', { key: index, d: path }))
      )
    }

    function RefreshIcon(props) {
      return h(Icon, {
        size: props && props.size,
        paths: ['M21 12a9 9 0 1 1-3-6.7', 'M21 3v6h-6'],
      })
    }

    function FolderIcon(props) {
      return h(Icon, {
        size: (props && props.size) || 16,
        paths: ['M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
      })
    }

    function PlusIcon() {
      return h(Icon, { paths: ['M12 5v14', 'M5 12h14'] })
    }

    function PlayIcon() {
      return h(Icon, { paths: ['M8 5v14l11-7z'] })
    }

    function TrashIcon() {
      return h(Icon, { paths: ['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14', 'M10 11v6', 'M14 11v6'] })
    }

    function EditIcon() {
      return h(Icon, { paths: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'] })
    }

    function ChevronIcon(props) {
      return h(Icon, {
        paths: ['M9 18l6-6-6-6'],
        size: 12,
      })
    }

    function Button(props) {
      const variant = props.variant || 'secondary'
      const variants = {
        primary: {
          background: 'var(--dsw-alias-brand-primary)',
          borderColor: 'var(--dsw-alias-brand-primary)',
          color: 'var(--dsw-alias-bg-base)',
        },
        secondary: {
          background: 'transparent',
          borderColor: 'var(--dsw-alias-border-l2)',
          color: 'var(--dsw-alias-label-primary)',
        },
        ghost: {
          background: 'transparent',
          borderColor: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
        },
        danger: {
          background: 'transparent',
          borderColor: 'var(--dsw-alias-state-error)',
          color: 'var(--dsw-alias-state-error)',
        },
      }
      const disabled = !!(props.disabled || props.loading)
      return h(
        'button',
        {
          type: props.type || 'button',
          onClick: props.onClick,
          disabled: disabled,
          title: props.title,
          'aria-busy': props.loading ? 'true' : undefined,
          style: Object.assign(
            {
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              padding: props.small ? '3px 9px' : '6px 12px',
              borderRadius: 6,
              border: '1px solid',
              fontSize: props.small ? 11 : 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              lineHeight: '18px',
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              whiteSpace: 'nowrap',
            },
            variants[variant] || variants.secondary,
            props.style
          ),
        },
        props.icon || null,
        props.loading ? '处理中…' : props.children
      )
    }

    function Checkbox(props) {
      const disabled = !!props.disabled
      return h(
        'label',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.6 : 1,
            userSelect: 'none',
          },
          title: props.title,
        },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: disabled,
          onChange: (event) => {
            if (typeof props.onChange === 'function') props.onChange(event.target.checked)
          },
          style: {
            width: 15,
            height: 15,
            margin: 0,
            accentColor: 'var(--dsw-alias-brand-primary)',
            cursor: disabled ? 'not-allowed' : 'pointer',
          },
        }),
        props.label ? h('span', { style: { fontSize: 12 } }, props.label) : null
      )
    }

    function Field(props) {
      return h(
        'label',
        {
          style: Object.assign(
            { display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 },
            props.style
          ),
        },
        h(
          'span',
          { style: { fontSize: 12, fontWeight: 500, color: 'var(--dsw-alias-label-secondary)' } },
          props.label,
          props.required
            ? h('span', { style: { color: 'var(--dsw-alias-state-error)' }, 'aria-hidden': 'true' }, ' *')
            : null
        ),
        props.children,
        props.hint ? h('span', { style: styles.hint }, props.hint) : null
      )
    }

    function Badge(props) {
      const tone = TONES[props.tone] || TONES.neutral
      return h(
        'span',
        {
          title: props.title,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '0 7px',
            borderRadius: 999,
            border: '1px solid ' + tone.border,
            color: tone.color,
            fontSize: 10,
            lineHeight: '18px',
            whiteSpace: 'nowrap',
          },
        },
        props.children
      )
    }

    function StateBadge(props) {
      const state =
        RUN_STATES[props.state] ||
        { label: props.state ? String(props.state) : '未知', tone: 'neutral' }
      return h(Badge, { tone: state.tone }, state.label)
    }

    function SpinnerText(props) {
      return h(
        'span',
        { style: Object.assign({ color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 }, props.style) },
        props.children || '加载中…'
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        {
          style: Object.assign({}, styles.card, {
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: '26px 16px',
            textAlign: 'center',
          }),
        },
        props.icon
          ? h('div', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, props.icon)
          : null,
        h('div', { style: { fontSize: 13, fontWeight: 600 } }, props.title),
        props.description ? h('div', { style: Object.assign({ maxWidth: 440 }, styles.hint) }, props.description) : null,
        props.action || null
      )
    }

    function InlineError(props) {
      return h(
        'div',
        {
          role: 'alert',
          style: {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 8,
            padding: '6px 9px',
            border: '1px solid var(--dsw-alias-state-error)',
            borderRadius: 6,
            color: 'var(--dsw-alias-state-error)',
            fontSize: 12,
            lineHeight: 1.5,
          },
        },
        h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, props.message),
        props.onRetry
          ? h(Button, { variant: 'ghost', small: true, onClick: props.onRetry }, '重试')
          : null
      )
    }

    function Notice(props) {
      if (!props.message) return null
      return h(
        'div',
        {
          role: 'status',
          style: {
            color: 'var(--dsw-alias-state-success)',
            border: '1px solid var(--dsw-alias-state-success)',
            borderRadius: 6,
            padding: '5px 9px',
            fontSize: 12,
          },
        },
        props.message
      )
    }

    function SummaryChips(props) {
      const summary = props.summary
      if (!isObject(summary)) {
        return h('div', { style: styles.hint }, summary == null ? '—' : summaryValue(summary))
      }
      const entries = Object.keys(summary).filter((key) => summary[key] !== undefined && summary[key] !== null)
      if (!entries.length) return h('div', { style: styles.hint }, '没有可展示的统计。')
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
        entries.map((key) =>
          h(
            'div',
            {
              key: key,
              style: {
                display: 'inline-flex',
                alignItems: 'baseline',
                gap: 5,
                padding: '2px 8px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 6,
                background: 'var(--dsw-alias-bg-base)',
              },
            },
            h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-tertiary)' } }, SUMMARY_LABELS[key] || key),
            h('span', { style: { fontSize: 12, fontWeight: 600 } }, summaryDisplayValue(key, summary[key]))
          )
        )
      )
    }

    // ---------------------------------------------------------------------
    // 错误边界：任何渲染异常只影响本插槽，不白屏整页
    // ---------------------------------------------------------------------

    class PanelErrorBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: error }
      }

      componentDidCatch(error, info) {
        console.error('[dsh-sync-hub] 设置页渲染失败', error, info)
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
            h('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-state-error)' } }, '设置页渲染失败'),
            h('div', { style: styles.hint }, errorText(this.state.error)),
            h(
              'button',
              {
                type: 'button',
                onClick: () => this.setState({ error: null }),
                style: {
                  alignSelf: 'flex-start',
                  padding: '4px 10px',
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  cursor: 'pointer',
                },
              },
              '重试'
            )
          )
        }
        return this.props.children
      }
    }

    function SettingsPage(props) {
      return h(PanelErrorBoundary, null, h(Panel, props))
    }

    // ---------------------------------------------------------------------
    // 同步页
    // ---------------------------------------------------------------------

    function ScopeCard(props) {
      const scope = props.scope
      const setting = props.setting
      const enabled = setting.enabled
      const custom = scope.custom === true
      return h(
        'div',
        {
          style: Object.assign({}, styles.card, {
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            opacity: enabled ? 1 : 0.62,
          }),
        },
        h('div', { style: { paddingTop: 2 } }, h(Checkbox, {
          checked: enabled,
          disabled: props.saving || custom,
          onChange: (checked) => props.onToggle(checked),
          title: custom ? '自定义同步项的启停在「自定义」页管理' : (enabled ? '取消同步这一项' : '勾选后同步这一项'),
        })),
        h(
          'div',
          { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 13, fontWeight: 500 } }, scope.name),
            h('span', { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) }, scope.id),
            props.saving ? h(SpinnerText, { style: { fontSize: 11 } }, '保存中…') : null
          ),
          scope.error
            ? h(
                'div',
                { style: { fontSize: 11, color: 'var(--dsw-alias-state-error)' } },
                '预估失败：' + scope.error
              )
            : scope.measured === false
              ? h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, '暂未估算')
              : h(
                  'div',
                  { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } },
                  formatNumber(scope.files) + ' 个文件',
                  h('span', { style: { margin: '0 5px', color: 'var(--dsw-alias-label-tertiary)' } }, '/'),
                  formatBytes(scope.bytes)
                ),
          scope.id === 'plugin-settings'
            ? h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 3 } },
                h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' } }, 'Profile'),
                PROFILE_OPTIONS.map((profile) => {
                  const checked = setting.profiles.indexOf(profile.value) >= 0
                  const onlyOne = checked && setting.profiles.length <= 1
                  return h(Checkbox, {
                    key: profile.value,
                    checked: checked,
                    disabled: props.saving || !enabled || onlyOne,
                    onChange: (next) => props.onProfileToggle(profile.value, next),
                    label: profile.label,
                    title: onlyOne ? '至少保留一个 profile' : undefined,
                  })
                }),
                setting.profiles
                  .filter((value) => !PROFILE_OPTIONS.some((option) => option.value === value))
                  .map((value) =>
                    h(Badge, { key: value, tone: 'muted', title: '未知 profile，已保留原值' }, value)
                  )
              )
            : null
        ),
        h('div', { style: { alignSelf: 'center' } }, h(Badge, { tone: custom ? 'brand' : (enabled ? 'brand' : 'muted') }, custom ? '自定义' : (enabled ? '已启用' : '未启用')))
      )
    }

    /**
     * Human-readable label for a session preview path, mirroring the left
     * sidebar's `<workspace>-<session title>` form. Non-session paths return ''.
     */
    function previewSessionLabel(pathValue) {
      const parts = String(pathValue || '').split('/')
      if (parts[0] !== 'sessions' || parts.length < 3) return ''
      const projectDir = parts[1]
      const sessionId = parts[2]
      const meta = dshSessionMetaReader().get(sessionId) || {}
      const title = String(meta.name || '').trim() || shortSessionId(sessionId)
      let workspace = ''
      const cwd = String(meta.cwd || '').trim().replace(/[\\/]+$/, '')
      if (cwd) {
        const segments = cwd.split(/[\\/]+/)
        workspace = segments[segments.length - 1] || ''
      }
      if (!workspace) workspace = projectDir
      return workspace + '-' + title
    }

    function PreviewSection(props) {
      const preview = props.preview
      const [openGroups, setOpenGroups] = useState(DEFAULT_OPEN_GROUPS)
      const [confirmDelete, setConfirmDelete] = useState(false)

      if (props.loading) {
        return h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', alignItems: 'center', gap: 8 }) },
          h(SpinnerText, null, '正在比较本地与目标…')
        )
      }
      if (props.error) {
        return h(
          'div',
          { style: styles.card },
          h(InlineError, { message: props.error, onRetry: props.onRetry })
        )
      }
      if (!preview) return null

      const summary = isObject(preview.summary) ? preview.summary : {}
      const groups = groupActions(preview.actions)
      const actionCount = Array.isArray(preview.actions) ? preview.actions.length : 0

      return h(
        'div',
        { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 10 }) },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: styles.sectionTitle }, '变更预览'),
          h('span', { style: styles.hint }, '按动作分组；相同项默认折叠。')
        ),
        h(
          'div',
          { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          PREVIEW_SUMMARY_ITEMS.map((item) =>
            h(
              'div',
              {
                key: item.label,
                style: {
                  display: 'inline-flex',
                  alignItems: 'baseline',
                  gap: 5,
                  padding: '2px 8px',
                  border: '1px solid ' + (TONES[item.tone] || TONES.neutral).border,
                  borderRadius: 6,
                },
              },
              h('span', { style: { fontSize: 10, color: (TONES[item.tone] || TONES.neutral).color } }, item.label),
              h('span', { style: { fontSize: 12, fontWeight: 600 } }, formatNumber(firstSummaryValue(summary, item.keys)))
            )
          )
        ),
        actionCount === 0
          ? h('div', { style: styles.hint }, '没有需要执行的变更。')
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              groups.map((group) => {
                const open = openGroups[group.type] !== false
                const shown = group.items.slice(0, MAX_ACTION_ROWS)
                return h(
                  'div',
                  {
                    key: group.type,
                    style: {
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 8,
                      overflow: 'hidden',
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 0 } },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => setOpenGroups(Object.assign({}, openGroups, { [group.type]: !open })),
                        'aria-expanded': open ? 'true' : 'false',
                        style: {
                          display: 'flex',
                          alignItems: 'center',
                          gap: 7,
                          flex: 1,
                          minWidth: 0,
                          padding: '6px 10px',
                          border: 'none',
                          background: 'transparent',
                          color: 'var(--dsw-alias-label-primary)',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          cursor: 'pointer',
                          textAlign: 'left',
                        },
                      },
                      h('span', {
                        style: {
                          display: 'inline-flex',
                          transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform .12s ease',
                          color: 'var(--dsw-alias-label-tertiary)',
                        },
                      }, h(ChevronIcon)),
                      h('span', { style: { fontWeight: 500 } }, group.label),
                      h(Badge, { tone: group.tone }, formatNumber(group.items.length))
                    ),
                    group.type === 'choice'
                      ? h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 6, flex: 'none', paddingRight: 8 } },
                          h(
                            Button,
                            {
                              variant: 'secondary',
                              small: true,
                              title: '把待决定的删除项恢复/覆盖回来',
                              disabled: props.decisionBusy,
                              onClick: () => props.onDecision && props.onDecision('restore'),
                            },
                            '确定'
                          ),
                          h(
                            Button,
                            {
                              variant: 'danger',
                              small: true,
                              title: '按删除处理：把另一侧对应文件也删除（镜像）',
                              disabled: props.decisionBusy,
                              onClick: () => {
                                if (!confirmDelete) {
                                  setConfirmDelete(true)
                                  return
                                }
                                setConfirmDelete(false)
                                if (props.onDecision) props.onDecision('mirror')
                              },
                            },
                            confirmDelete ? '确认删除' : '删除'
                          )
                        )
                      : null
                  ),
                  open
                    ? h(
                        'div',
                        {
                          style: {
                            maxHeight: 260,
                            overflow: 'auto',
                            borderTop: '1px solid var(--dsw-alias-border-l2)',
                            padding: '2px 10px 6px',
                          },
                        },
                        shown.map((action, index) => {
                          const sessionLabel = previewSessionLabel(action.path)
                          return h(
                            'div',
                            {
                              key: index,
                              style: {
                                display: 'flex',
                                alignItems: 'baseline',
                                gap: 8,
                                padding: '4px 0',
                                borderBottom:
                                  index === shown.length - 1
                                    ? 'none'
                                    : '1px solid var(--dsw-alias-border-l2)',
                              },
                            },
                            h(
                              'div',
                              { style: { flex: 1, minWidth: 0 } },
                              h('div', { style: styles.mono }, sessionLabel || (action.path ? String(action.path) : '（未知路径）')),
                              sessionLabel
                                ? h('div', { style: Object.assign({}, styles.hint, { marginTop: 1 }) }, String(action.path))
                                : null,
                              action.reason
                                ? h('div', { style: Object.assign({}, styles.hint, { marginTop: 1 }) }, String(action.reason))
                                : null
                            ),
                            action.scope
                              ? h(Badge, { tone: 'muted', title: String(action.scope) }, String(action.scope))
                              : null
                          )
                        }),
                        group.items.length > MAX_ACTION_ROWS
                          ? h(
                              'div',
                              { style: Object.assign({}, styles.hint, { padding: '4px 0' }) },
                              '仅显示前 ' + MAX_ACTION_ROWS + ' 条，另有 ' + (group.items.length - MAX_ACTION_ROWS) + ' 条未显示。'
                            )
                          : null
                      )
                    : null
                )
              })
            )
      )
    }

    function RunSection(props) {
      const run = props.run
      if (!run || !run.id) return null
      const status = RUN_STATES[run.state] || RUN_STATES.idle
      const percent = progressPercent(run.progress)
      const active = isActiveRunState(run.state)
      const canCancel = run.state === 'running'
      const runErrorText = formatRunError(run.error)
      return h(
        'div',
        { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h('h3', { style: styles.sectionTitle }, '同步任务'),
          h(StateBadge, { state: run.state || 'running' }),
          h('span', { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) }, String(run.id)),
          h('div', { style: { flex: 1 } }),
          canCancel
            ? h(
                Button,
                {
                  variant: 'danger',
                  small: true,
                  onClick: props.onCancel,
                  loading: props.cancelling,
                  disabled: props.cancelRequested,
                },
                props.cancelRequested ? '正在取消…' : '取消同步'
              )
            : null
        ),
        active
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              h(
                'div',
                { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } },
                formatPhase(run.progress && run.progress.phase),
                run.progress && Number.isFinite(Number(run.progress.total))
                  ? h(
                      'span',
                      { style: { marginLeft: 8, color: 'var(--dsw-alias-label-tertiary)' } },
                      formatNumber(run.progress.done || 0) + ' / ' + formatNumber(run.progress.total)
                    )
                  : null
              ),
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    gap: 12,
                    flexWrap: 'wrap',
                    fontSize: 12,
                    color: 'var(--dsw-alias-label-tertiary)',
                  },
                },
                formatSpeed(run.progress && run.progress.speedBytesPerSec)
                  ? h('span', null, '速度 ' + formatSpeed(run.progress.speedBytesPerSec))
                  : null,
                run.progress && Number.isFinite(Number(run.progress.bytesTotal)) && Number(run.progress.bytesTotal) > 0
                  ? h(
                      'span',
                      null,
                      '流量 ' + formatBytes(Number(run.progress.bytesDone) || 0) + ' / ' + formatBytes(Number(run.progress.bytesTotal))
                    )
                  : null,
                formatEta(run.progress) ? h('span', null, '剩余约 ' + formatEta(run.progress)) : null
              ),
              h(
                'div',
                {
                  style: {
                    height: 6,
                    borderRadius: 999,
                    background: 'var(--dsw-alias-bg-base)',
                    border: '1px solid var(--dsw-alias-border-l2)',
                    overflow: 'hidden',
                  },
                },
                h('div', {
                  style: {
                    height: '100%',
                    width: percent == null ? '30%' : percent + '%',
                    background: 'var(--dsw-alias-brand-primary)',
                    transition: 'width .3s ease',
                  },
                })
              )
            )
          : null,
        props.pollError
          ? h(
              'div',
              { style: { fontSize: 12, color: 'var(--dsw-alias-state-error)' } },
              props.pollError,
              active
                ? h(Button, { variant: 'ghost', small: true, onClick: props.onRetryPoll }, '重试获取进度')
                : null
            )
          : null,
        runErrorText
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error)', whiteSpace: 'pre-wrap' } }, runErrorText)
          : null,
        run.summary != null
          ? h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              h('div', { style: styles.hint }, '结果摘要'),
              h(SummaryChips, { summary: run.summary }),
              formatSpeed(run.summary.avgBytesPerSec) || formatDurationMs(run.summary.durationMs)
                ? h(
                    'div',
                    { style: styles.hint },
                    formatSpeed(run.summary.avgBytesPerSec) ? '平均速度 ' + formatSpeed(run.summary.avgBytesPerSec) : '',
                    formatSpeed(run.summary.avgBytesPerSec) && formatDurationMs(run.summary.durationMs) ? ' · ' : '',
                    formatDurationMs(run.summary.durationMs) ? '用时 ' + formatDurationMs(run.summary.durationMs) : ''
                  )
                : null
            )
          : null,
        run.startedAt || run.finishedAt
          ? h(
              'div',
              { style: styles.hint },
              '开始：' + formatDate(run.startedAt),
              run.finishedAt ? ' · 结束：' + formatDate(run.finishedAt) : ''
            )
          : null,
        status.tone === 'error' && !runErrorText && run.state === 'failed'
          ? h('div', { style: styles.hint }, '任务失败但没有返回错误详情。')
          : null
      )
    }

    /**
     * Sidebar footer indicator.
     *
     * While a run is active it shows progress; while a deletion decision is
     * pending it hides the progress bar and shows the conflict summary with the
     * resolve buttons. When idle it renders nothing.
     */
    function SidebarProgress(props) {
      const [snapshot, setSnapshot] = useState({ pending: null, run: null, mode: 'running', lastRun: null, targetId: '', targetCount: 0, sessionPathPending: 0 })
      const [changes, setChanges] = useState(null)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const wide = props && props.wide !== false
      const pendingKeyRef = useRef('')
      const pendingTickRef = useRef(0)
      const pendingFetchedTickRef = useRef(0)
      const pendingInFlightRef = useRef(false)

      useEffect(() => {
        let stopped = false
        let timer = null
        const poll = async () => {
          try {
            const value = await api('status')
            if (!stopped) {
              const active = value && value.activeRun ? value.activeRun : null
              const decision = value && value.pendingDecision ? value.pendingDecision : null
              const lastRun = value && value.lastRun ? value.lastRun : null
              const targetId = value && typeof value.defaultTargetId === 'string' ? value.defaultTargetId : ''
              setSnapshot({
                pending: decision,
                run: active,
                mode: value && typeof value.sidebarProgressMode === 'string' ? value.sidebarProgressMode : 'running',
                lastRun,
                targetId,
                targetCount: value && Number.isFinite(Number(value.targetCount)) ? Number(value.targetCount) : 0,
                sessionPathPending: value && Number.isFinite(Number(value.sessionPathPending)) ? Number(value.sessionPathPending) : 0,
              })
              // Pending transfer counts are a read-only plan; refresh when a run
              // finishes and then at the user-configured interval while idle.
              pendingTickRef.current += 1
              if (targetId && !active && !decision && !pendingInFlightRef.current) {
                const refreshSeconds = Number.isFinite(Number(value.pendingRefreshSeconds))
                  ? Number(value.pendingRefreshSeconds)
                  : 600
                const refreshTicks = refreshSeconds <= 0
                  ? 0
                  : Math.max(1, Math.round(refreshSeconds / 1.5))
                const key = targetId + ':' + (lastRun && lastRun.finishedAt ? lastRun.finishedAt : '')
                const due = key !== pendingKeyRef.current
                  || (refreshTicks > 0 && pendingTickRef.current - pendingFetchedTickRef.current >= refreshTicks)
                if (due) {
                  pendingKeyRef.current = key
                  pendingFetchedTickRef.current = pendingTickRef.current
                  pendingInFlightRef.current = true
                  api('changes.pending', { targetId }).then((counts) => {
                    if (!stopped) setChanges(counts && isObject(counts) ? counts : null)
                  }).catch(() => {
                    if (!stopped) setChanges(null)
                  }).finally(() => {
                    pendingInFlightRef.current = false
                  })
                }
              }
            }
          } catch (error) {
            if (!stopped) setSnapshot((previous) => ({ pending: null, run: null, mode: previous.mode, lastRun: previous.lastRun, targetId: previous.targetId, targetCount: previous.targetCount, sessionPathPending: previous.sessionPathPending }))
          }
          if (!stopped) timer = setTimeout(poll, 1500)
        }
        poll()
        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
        }
      }, [])

      async function resolveDecision(choice) {
        if (busy) return
        setBusy(true)
        try {
          if (choice) {
            await api('sync', {
              targetId: snapshot.pending.targetId,
              scopeIds: snapshot.pending.scopeIds,
              direction: snapshot.pending.direction,
              deleteChoice: choice,
            })
          } else {
            await api('decision.clear', {})
          }
          setSnapshot({ pending: null, run: snapshot.run, mode: snapshot.mode })
        } catch (error) {
          // The next poll will re-read the host state; nothing to do here.
        } finally {
          setBusy(false)
        }
      }

      /**
       * Start a sync straight from the sidebar: first enabled target, current
       * direction and the enabled scopes. Deletion differences still go through
       * the shared pending-decision card instead of writing blindly.
       */
      async function startQuickSync() {
        if (busy || snapshot.run) return
        setBusy(true)
        setNotice('')
        try {
          const settingsValue = await api('settings.get')
          const settings = settingsValue && isObject(settingsValue.settings) ? settingsValue.settings : {}
          const targetsValue = await api('targets.list')
          const list = targetsValue && Array.isArray(targetsValue.targets)
            ? targetsValue.targets
            : (Array.isArray(settings.targets) ? settings.targets : [])
          const target = list.find((item) => item && item.enabled !== false) || list[0]
          if (!target) throw makeError('请先在「目标」页添加同步目标', 'no-target')
          const direction = settings.direction === 'push' || settings.direction === 'pull' ? settings.direction : 'both'
          const estimate = await api('scopes.estimate', { targetId: target.id })
          const scopeIds = (estimate && Array.isArray(estimate.scopes) ? estimate.scopes : [])
            .filter((scope) => scope && scope.id && scope.enabled !== false)
            .map((scope) => scope.id)
          if (scopeIds.length === 0) throw makeError('没有启用任何同步项', 'no-scope')
          const deleteMode = settings.deleteMode || 'ask'
          if (!settings.force && deleteMode === 'ask') {
            const plan = await api('preview', { targetId: target.id, scopeIds: scopeIds, direction: direction })
            const choices = plan && Array.isArray(plan.choices) ? plan.choices : []
            if (choices.length > 0) {
              await api('decision.set', {
                targetId: target.id,
                scopeIds: scopeIds,
                direction: direction,
                total: choices.length,
                localMissing: choices.filter((item) => item.side === 'local-missing').length,
                remoteMissing: choices.filter((item) => item.side === 'remote-missing').length,
              })
              return
            }
          }
          await api('sync', { targetId: target.id, scopeIds: scopeIds, direction: direction })
        } catch (error) {
          setNotice(errorText(error))
        } finally {
          setBusy(false)
        }
      }

      /** Re-read the pending-count plan for the current default target. */
      async function refreshPendingCounts() {
        if (busy || !snapshot.targetId) return
        setBusy(true)
        setNotice('')
        try {
          const counts = await api('changes.pending', { targetId: snapshot.targetId })
          setChanges(counts && isObject(counts) ? counts : null)
        } catch (error) {
          setNotice(errorText(error))
        } finally {
          setBusy(false)
        }
      }

      const pending = snapshot.pending
      if (pending) {
        if (!wide) {
          return h(
            'div',
            {
              title: '需要决定：删除差异 ' + pending.total + ' 项',
              style: {
                width: 34,
                height: 34,
                margin: '0 auto 4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--dsw-alias-state-error)',
                border: '1px solid var(--dsw-alias-state-error)',
                borderRadius: 999,
                background: 'var(--dsw-alias-bg-l2)',
              },
            },
            '!'
          )
        }
        return h(
          'div',
          {
            style: {
              margin: '0 8px 4px 2px',
              flex: '1 1 auto',
              minWidth: 0,
              padding: '6px 6px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              border: '1px solid var(--dsw-alias-state-error)',
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-l2)',
              fontSize: 13,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          h('span', { style: { fontWeight: 600, fontSize: 14, color: 'var(--dsw-alias-label-primary)' } }, '需要决定：删除差异 ' + pending.total + ' 项'),
          pending.localMissing > 0 ? h('span', null, '本地缺失 ' + pending.localMissing + ' 个文件（可恢复）') : null,
          pending.remoteMissing > 0 ? h('span', null, '目标缺失 ' + pending.remoteMissing + ' 个文件（可补传）') : null,
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, marginTop: 2 } },
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => resolveDecision('restore'),
                style: {
                  width: '100%',
                  minHeight: 34,
                  border: 0,
                  borderRadius: 7,
                  padding: '8px 10px',
                  cursor: busy ? 'default' : 'pointer',
                  background: 'var(--dsw-alias-brand-primary)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                },
              },
              busy ? '处理中…' : '恢复缺失文件（覆盖）'
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => resolveDecision('ignore'),
                style: {
                  width: '100%',
                  minHeight: 32,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 7,
                  padding: '7px 10px',
                  cursor: busy ? 'default' : 'pointer',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  fontSize: 13,
                },
              },
              '跳过删除，继续同步其它变更'
            ),
            h(
              'button',
              {
                type: 'button',
                disabled: busy,
                onClick: () => resolveDecision(null),
                style: {
                  width: '100%',
                  border: 0,
                  borderRadius: 7,
                  padding: '5px 10px',
                  cursor: busy ? 'default' : 'pointer',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-tertiary)',
                  fontSize: 12,
                  textAlign: 'center',
                },
              },
              '取消'
            )
          )
        )
      }

      const mode = snapshot.mode === 'always' || snapshot.mode === 'hidden' ? snapshot.mode : 'running'
      const currentRun = snapshot.run
      const lastRun = snapshot.lastRun && isObject(snapshot.lastRun) ? snapshot.lastRun : null
      const progress = currentRun && isObject(currentRun.progress) ? currentRun.progress : {}
      const percent = progressPercent(progress)
      const speed = formatSpeed(progress.speedBytesPerSec)
      const pendingCounts = changes && isObject(changes) ? changes : null
      let idleText = '尚未同步'
      if (snapshot.targetCount === 0) {
        idleText = '未配置目标'
      } else if (pendingCounts) {
        const upload = Number(pendingCounts.upload) || 0
        const download = Number(pendingCounts.download) || 0
        const conflicts = Number(pendingCounts.conflict) || 0
        const choices = Number(pendingCounts.choice) || 0
        const parts = []
        if (upload > 0) parts.push('待传 ' + formatNumber(upload))
        if (download > 0) parts.push('待下 ' + formatNumber(download))
        if (conflicts > 0) parts.push('冲突 ' + formatNumber(conflicts))
        if (choices > 0) parts.push('待定 ' + formatNumber(choices))
        idleText = parts.length > 0 ? parts.join(' · ') : '已同步'
      } else if (lastRun) {
        idleText = '正在统计…'
      }
      const activeText = currentRun
        ? (Number(progress.total) > 0
          ? formatNumber(Number(progress.done) || 0) + '/' + formatNumber(Number(progress.total) || 0) + ' 文件'
          : (progress.phase ? formatPhase(progress.phase) : '同步中'))
        : idleText

      /**
       * One consistent row for idle and running states: file/component counts on
       * the left, the sync icon button on the right.
       */
      function renderRow(text, iconNode, showBar) {
        const needsConfirm = !currentRun && pendingCounts && (Number(pendingCounts.choice) || 0) > 0
        const workTotal = pendingCounts
          ? (Number(pendingCounts.upload) || 0)
            + (Number(pendingCounts.download) || 0)
            + (Number(pendingCounts.conflict) || 0)
            + (Number(pendingCounts.choice) || 0)
          : null
        const idleRefresh = !currentRun && !needsConfirm && workTotal === 0
        const refreshIcon = h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M20 12a8 8 0 1 1-2.34-5.66',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
          }),
          h('path', {
            d: 'M20 4v5h-5',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeLinejoin: 'round',
          })
        )
        const buttonTitle = notice
          || (needsConfirm
            ? '有待确定文件，点击打开数据同步设置页确认'
            : (currentRun
              ? '同步中' + (percent == null ? '' : ' ' + percent + '%') + (speed ? ' · ' + speed : '')
              : (idleRefresh ? '刷新待同步统计' : '立即同步（' + text + '）')))
        /** Pending choices are confirmed on the sync settings surface, not inline. */
        const openConfirmPanel = () => {
          if (props && typeof props.openDataSync === 'function') {
            try {
              props.openDataSync()
              return
            } catch (error) {
              // Fall through to the inline preview/decision flow.
            }
          }
          startQuickSync()
        }
        const buttonContent = busy
          ? '…'
          : (needsConfirm
            ? h('span', { style: { fontWeight: 700, whiteSpace: 'nowrap' } }, '!')
            : (idleRefresh ? refreshIcon : iconNode))
        const narrowContent = busy ? '…' : (needsConfirm ? '!' : (idleRefresh ? refreshIcon : iconNode))
        const confirmStyle = needsConfirm
          ? {
              border: '1px solid var(--dsw-alias-brand-primary)',
              background: 'var(--dsw-alias-brand-primary)',
              color: '#fff',
            }
          : {}
        const activate = () => {
          if (idleRefresh) {
            refreshPendingCounts()
            return
          }
          if (needsConfirm) openConfirmPanel()
          else startQuickSync()
        }
        if (!wide) {
          return h(
            'button',
            {
              type: 'button',
              title: buttonTitle,
              disabled: !!currentRun || busy,
              onClick: activate,
              style: Object.assign({
                width: 34,
                height: 34,
                margin: '0 auto 4px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 999,
                background: 'var(--dsw-alias-bg-l2)',
                color: 'var(--dsw-alias-brand-primary)',
                cursor: currentRun || busy ? 'default' : 'pointer',
                fontSize: 11,
                fontWeight: 600,
              }, confirmStyle),
            },
            narrowContent
          )
        }
        const progressBar = showBar
          ? h(
              'div',
              { style: { height: 6, borderRadius: 999, background: 'var(--dsw-alias-bg-base)', overflow: 'hidden' } },
              h('div', {
                style: {
                  height: '100%',
                  width: currentRun ? (percent == null ? '30%' : percent + '%') : '0%',
                  background: 'var(--dsw-alias-brand-primary)',
                  transition: 'width .3s ease',
                },
              })
            )
          : null
        return h(
          'div',
          {
            style: {
              margin: '0 8px 4px 2px',
              flex: '1 1 auto',
              minWidth: 0,
              padding: '6px 6px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 10,
              background: 'var(--dsw-alias-bg-l2)',
              fontSize: 13,
              color: 'var(--dsw-alias-label-secondary)',
            },
          },
          h(
            'div',
            { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 } },
            h(
              'button',
              {
                type: 'button',
                title: '打开数据同步设置',
                onClick: () => {
                  try {
                    if (props && typeof props.openSettings === 'function') {
                      props.openSettings()
                      return
                    }
                    if (props && typeof props.openDataSync === 'function') props.openDataSync()
                  } catch (error) {
                    // Opening the settings surface must never break the footer.
                  }
                },
                style: {
                  width: '100%',
                  margin: 0,
                  padding: 0,
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  font: 'inherit',
                  textAlign: 'left',
                  whiteSpace: 'normal',
                  wordBreak: 'break-word',
                  lineHeight: 1.35,
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dotted',
                  textUnderlineOffset: 2,
                },
              },
              text
            ),
            progressBar,
            notice ? h('span', { style: { color: 'var(--dsw-alias-state-error)', fontSize: 10, whiteSpace: 'normal' } }, notice) : null
          ),
          h(
            'button',
            {
              type: 'button',
              title: buttonTitle,
              disabled: !!currentRun || busy,
              onClick: activate,
              style: Object.assign({
                flex: 'none',
                width: 32,
                height: 32,
                minWidth: 32,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                background: 'transparent',
                color: 'var(--dsw-alias-brand-primary)',
                cursor: currentRun || busy ? 'default' : 'pointer',
                fontSize: 10,
                fontWeight: 600,
                whiteSpace: 'nowrap',
              }, confirmStyle),
            },
            buttonContent
          )
        )
      }

      const runIcon = currentRun
        ? h('span', { style: { fontWeight: 600 } }, percent == null ? '…' : percent + '%')
        : h(
            'svg',
            { width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true },
            h('path', { d: 'M8 5v14l11-7z', fill: 'currentColor' })
          )

      if (!currentRun) {
        const row = renderRow(idleText, runIcon, mode === 'always')
        const sessionPending = Number(snapshot.sessionPathPending) || 0
        if (!wide || sessionPending <= 0) return row
        return h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          h(
            'div',
            {
              style: {
                margin: '0 2px',
                padding: '5px 6px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                border: '1px solid var(--dsw-alias-state-warning, var(--dsw-alias-state-error))',
                borderRadius: 8,
                background: 'var(--dsw-alias-bg-l2)',
                fontSize: 12,
                color: 'var(--dsw-alias-label-secondary)',
              },
            },
            h('span', { style: { flex: 1, minWidth: 0 } }, '会话路径待确认 ' + formatNumber(sessionPending)),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  if (props && typeof props.openSessionsTab === 'function') props.openSessionsTab()
                },
                style: {
                  flex: 'none',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 6,
                  padding: '3px 8px',
                  background: 'transparent',
                  color: 'var(--dsw-alias-brand-primary)',
                  fontSize: 12,
                  cursor: 'pointer',
                },
              },
              '去确认'
            )
          ),
          row
        )
      }

      return renderRow(activeText, runIcon, mode !== 'hidden')
    }

    /**
     * Sidebar footer shortcut: opens the DSH settings sheet on the Plugins page,
     * where the "数据同步" tab lives.
     */
    function SettingsShortcutButton(props) {
      const wide = props && props.wide !== false
      const label = '打开数据同步设置'
      return h(
        'button',
        {
          type: 'button',
          title: label,
          'aria-label': label,
          onClick: () => {
            try {
              if (props && typeof props.open === 'function') props.open()
            } catch (error) {
              // Opening settings is a convenience; never throw from the shell.
            }
          },
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
            height: 32,
            minWidth: wide ? 36 : 32,
            padding: wide ? '0 8px' : 0,
            margin: '0 4px 4px 0',
            border: '1px solid var(--dsw-alias-border-l2)',
            borderRadius: 8,
            background: 'transparent',
            color: 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: 11,
          },
        },
        h(
          'svg',
          { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
          h('path', {
            d: 'M4 7h9M17 7h3M4 17h3M11 17h9',
            stroke: 'currentColor',
            strokeWidth: 2,
            strokeLinecap: 'round',
          }),
          h('circle', { cx: 15, cy: 7, r: 2.5, stroke: 'currentColor', strokeWidth: 2 }),
          h('circle', { cx: 9, cy: 17, r: 2.5, stroke: 'currentColor', strokeWidth: 2 })
        ),
        wide ? h('span', { style: { whiteSpace: 'nowrap' } }, '数据同步') : null
      )
    }

    /** Body rendered inside the right Sidebar tab: the same settings page. */
    function RightTabBody() {
      return h(
        'div',
        { style: { height: '100%', overflow: 'auto', padding: '10px 12px', boxSizing: 'border-box' } },
        h(SettingsPage, null)
      )
    }

    /** Scope selection tab: choose which data categories participate in sync. */
    function ScopesTab(props) {
      const { settings, estimates, estimatesLoading, targetId, onRefreshEstimates, onSaveSettings, onError, onGoTargets } = props
      const [savingScope, setSavingScope] = useState('')
      const scopeRows = useMemo(() => buildScopeRows(estimates, settings), [estimates, settings])

      async function updateScope(scopeId, changes) {
        if (savingScope) return
        setSavingScope(scopeId)
        try {
          const scopes = Object.assign({}, isObject(settings.scopes) ? settings.scopes : {})
          const current = scopes[scopeId] || { enabled: true, profiles: ['web'] }
          scopes[scopeId] = Object.assign({}, current, changes)
          await onSaveSettings({ scopes: scopes })
          if (changes.enabled !== undefined && onRefreshEstimates) onRefreshEstimates()
        } catch (error) {
          onError(error)
        } finally {
          setSavingScope('')
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }) },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h3', { style: styles.sectionTitle }, '同步项'),
            h('span', { style: styles.hint }, '勾选需要参与同步的数据类别；预估基于当前目标。')
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            h(
              Button,
              {
                variant: 'secondary',
                onClick: onRefreshEstimates,
                disabled: !targetId || estimatesLoading,
                loading: estimatesLoading,
                icon: h(RefreshIcon),
              },
              '刷新预估'
            ),
            !targetId ? h(Button, { variant: 'ghost', onClick: onGoTargets }, '去选择目标') : null
          )
        ),
        estimatesLoading && scopeRows.length === 0
          ? h('div', { style: styles.card }, h(SpinnerText, null, '正在计算同步项预估…'))
          : scopeRows.length === 0
            ? h(
                'div',
                { style: styles.card },
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
                  h('span', { style: styles.hint }, targetId ? '宿主没有返回同步项预估。' : '选择目标后显示同步项预估。'),
                  targetId ? h(Button, { variant: 'ghost', small: true, onClick: onRefreshEstimates }, '重新获取') : null
                )
              )
            : scopeRows.map((scope) =>
                h(ScopeCard, {
                  key: scope.id,
                  scope: scope,
                  setting: scopeSetting(settings, scope.id),
                  saving: savingScope === scope.id,
                  onToggle: (checked) => updateScope(scope.id, { enabled: checked }),
                  onProfileToggle: (profile, checked) => {
                    const current = scopeSetting(settings, scope.id).profiles
                    let next
                    if (checked) {
                      next = current.indexOf(profile) >= 0 ? current : current.concat(profile)
                    } else {
                      next = current.filter((item) => item !== profile)
                      if (next.length === 0) return
                    }
                    updateScope(scope.id, { profiles: next })
                  },
                })
              )
      )
    }

    function SyncTab(props) {
      const {
        settings,
        targets,
        estimates,
        estimatesLoading,
        status,
        targetId,
        direction,
        onTargetChange,
        onDirectionChange,
        onSaveSettings,
        onRefreshEstimates,
        onRefreshStatus,
        onRunFinished,
        onError,
        onGoTargets,
      } = props

      const [preview, setPreview] = useState(null)
      const [previewLoading, setPreviewLoading] = useState(false)
      const [previewError, setPreviewError] = useState('')
      const [starting, setStarting] = useState(false)
      const [run, setRun] = useState(null)
      const [runError, setRunError] = useState('')
      const [runPollError, setRunPollError] = useState('')
      const [pollNonce, setPollNonce] = useState(0)
      const [cancelling, setCancelling] = useState(false)
      const [cancelRequested, setCancelRequested] = useState(false)

      const previewSeq = useRef(0)
      const onFinishedRef = useRef(onRunFinished)
      const handlePreviewRef = useRef(null)
      const manualRunIdRef = useRef('')
      const lastActiveRunIdRef = useRef('')

      useEffect(() => {
        onFinishedRef.current = onRunFinished
      }, [onRunFinished])

      const scopeRows = useMemo(() => buildScopeRows(estimates, settings), [estimates, settings])

      const enabledScopeIds = useMemo(
        () =>
          scopeRows
            .filter((scope) => scopeSetting(settings, scope.id).enabled)
            .map((scope) => scope.id),
        [scopeRows, settings]
      )

      const scopeKey = enabledScopeIds.join(',')

      // 目标、方向或勾选项变化后，旧预估已经不再有效。
      useEffect(() => {
        previewSeq.current += 1
        setPreview(null)
        setPreviewError('')
        setPreviewLoading(false)
      }, [targetId, direction, scopeKey])

      useEffect(
        () => () => {
          previewSeq.current += 1
        },
        []
      )

      // 轮询同步任务；卸载、切换 tab 或任务结束后立即清理定时器。
      useEffect(() => {
        if (!run || !run.id || !isActiveRunState(run.state)) return undefined
        let cancelled = false
        let timer = null
        let failures = 0

        const tick = async () => {
          try {
            const value = await api('runs.get', { id: run.id })
            if (cancelled) return
            failures = 0
            setRunPollError('')
            setRun((previous) => {
              if (!previous || previous.id !== run.id) return previous
              return Object.assign({}, previous, value && isObject(value) ? value : {})
            })
            const nextState = value && typeof value.state === 'string' ? value.state : ''
            if (nextState && !isActiveRunState(nextState)) {
              setCancelRequested(false)
              if (onFinishedRef.current) onFinishedRef.current(value)
              // Same target/scope selection: refresh the preview so it reflects
              // what just got transferred instead of the pre-sync plan.
              if (manualRunIdRef.current === run.id) handlePreviewRef.current?.()
            } else {
              timer = setTimeout(tick, POLL_INTERVAL_MS)
            }
          } catch (error) {
            if (cancelled) return
            failures += 1
            if (failures < 3) {
              setRunPollError(errorText(error))
              timer = setTimeout(tick, POLL_INTERVAL_MS)
            } else {
              setRunPollError(errorText(error) + '（已停止自动刷新）')
            }
          }
        }

        timer = setTimeout(tick, POLL_INTERVAL_MS)
        return () => {
          cancelled = true
          if (timer) clearTimeout(timer)
        }
      }, [run && run.id, run && run.state, pollNonce])

      const noTargets = !Array.isArray(targets) || targets.length === 0
      const canRun = !!targetId && enabledScopeIds.length > 0
      const isRunning = isActiveRunState(run && run.state)
      const canStart = canRun && !isRunning
      const canPreview = canRun
      const pendingDecision = status && isObject(status.pendingDecision) ? status.pendingDecision : null

      let disabledReason = ''
      if (noTargets) {
        disabledReason = '还没有同步目标，请先到「目标」页添加一个本地目录。'
      } else if (!targetId) {
        disabledReason = '请选择一个同步目标。'
      } else if (enabledScopeIds.length === 0) {
        disabledReason = '请至少勾选一个同步项。'
      } else if (isRunning) {
        disabledReason = '同步任务正在进行中，请等待完成或取消后再开始新的同步。'
      }

      async function handlePreview() {
        if (!canPreview || previewLoading) return
        const seq = previewSeq.current + 1
        previewSeq.current = seq
        setPreviewLoading(true)
        setPreviewError('')
        try {
          const value = await api('preview', {
            targetId: targetId,
            scopeIds: enabledScopeIds,
            direction: direction,
          })
          if (seq !== previewSeq.current) return
          setPreview({
            summary: value && isObject(value.summary) ? value.summary : {},
            actions: value && Array.isArray(value.actions) ? value.actions : [],
          })
        } catch (error) {
          if (seq !== previewSeq.current) return
          setPreviewError(errorText(error))
          onError(error)
        } finally {
          if (seq === previewSeq.current) setPreviewLoading(false)
        }
      }

      handlePreviewRef.current = handlePreview

      // Preview is resident on this tab: load it on entry and refresh it when
      // the target, direction or enabled scope set changes.
      const scopeSignature = enabledScopeIds.join('|')
      useEffect(() => {
        if (!canPreview) return undefined
        const timer = setTimeout(() => {
          handlePreviewRef.current?.()
        }, 250)
        return () => clearTimeout(timer)
      }, [targetId, direction, scopeSignature, canPreview])

      // Runs started outside this panel (auto-sync, sidebar decision buttons)
      // refresh the preview when their active run disappears from status.
      useEffect(() => {
        const activeId = status && status.activeRun && status.activeRun.id ? status.activeRun.id : ''
        const previous = lastActiveRunIdRef.current
        lastActiveRunIdRef.current = activeId
        if (previous && previous !== activeId && previous !== manualRunIdRef.current) {
          handlePreviewRef.current?.()
        }
      }, [status && status.activeRun ? status.activeRun.id : ''])

      /** Start the actual run once a deletion decision (if any) is settled. */
      async function submitSync(deleteChoice, context) {
        const request = context && context.targetId
          ? context
          : { targetId: targetId, scopeIds: enabledScopeIds, direction: direction }
        setStarting(true)
        setRunError('')
        setRunPollError('')
        setCancelRequested(false)
        setRun(null)
        try {
          const value = await api('sync', {
            targetId: request.targetId,
            scopeIds: request.scopeIds,
            direction: request.direction,
            deleteChoice: deleteChoice,
          })
          const id = value && typeof value.runId === 'string' ? value.runId : ''
          if (!id) throw makeError('宿主没有返回同步任务 ID', 'bad_run')
          manualRunIdRef.current = id
          setRun({ id: id, state: 'running', startedAt: Date.now() })
          if (onRefreshStatus) onRefreshStatus()
        } catch (error) {
          setRunError(errorText(error))
          onError(error)
        } finally {
          setStarting(false)
        }
      }

      async function cancelPendingDecision() {
        try {
          await api('decision.clear', {})
        } catch (error) {
          onError(error)
        }
        if (onRefreshStatus) onRefreshStatus()
      }

      async function handleStartSync() {
        if (!canStart || starting) return
        if (settings.force) {
          const confirmed =
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            window.confirm(
              '已启用「强制覆盖」。同步会用本地内容覆盖目标上的差异文件，可能导致目标端数据丢失。\n\n确定继续吗？'
            )
          if (!confirmed) return
        }
        setStarting(true)
        setRunError('')
        try {
          // Deletion decision: with deleteMode "ask", plan first and publish the
          // decision to the host so the settings panel and the sidebar widget
          // can both render it. Nothing is written until the user answers.
          const deleteMode = settings.deleteMode || 'ask'
          if (!settings.force && deleteMode === 'ask') {
            const plan = await api('preview', {
              targetId: targetId,
              scopeIds: enabledScopeIds,
              direction: direction,
            })
            const choices = plan && Array.isArray(plan.choices) ? plan.choices : []
            if (choices.length > 0) {
              await api('decision.set', {
                targetId: targetId,
                scopeIds: enabledScopeIds,
                direction: direction,
                total: choices.length,
                localMissing: choices.filter((item) => item.side === 'local-missing').length,
                remoteMissing: choices.filter((item) => item.side === 'remote-missing').length,
              })
              setStarting(false)
              if (onRefreshStatus) onRefreshStatus()
              return
            }
          }
          await submitSync(undefined)
        } catch (error) {
          setRunError(errorText(error))
          onError(error)
          setStarting(false)
        }
      }

      async function handleCancel() {
        if (!run || run.state !== 'running' || cancelling) return
        setCancelling(true)
        setCancelRequested(true)
        try {
          await api('runs.cancel', { id: run.id })
        } catch (error) {
          setCancelRequested(false)
          setRunError(errorText(error))
          onError(error)
        } finally {
          setCancelling(false)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            {
              style: {
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                gap: 12,
                alignItems: 'end',
              },
            },
            h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
              h('span', { style: styles.hint }, '本机设备'),
              h('span', { style: { fontSize: 13, fontWeight: 500 } }, textOf(status && status.deviceName, textOf(settings.deviceName, '未知设备'))),
              status && status.version
                ? h('span', { style: Object.assign({}, styles.hint, styles.mono) }, 'v' + status.version)
                : null
            ),
            h(
              Field,
              { label: '同步目标' },
              h(TargetSelect, {
                targets: targets,
                value: targetId,
                onChange: onTargetChange,
                disabled: noTargets,
              })
            ),
            h(
              Field,
              { label: '同步方向' },
              h(DirectionSelect, {
                value: direction,
                onChange: onDirectionChange,
              })
            ),
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' } },
              h(
                Button,
                {
                  variant: 'secondary',
                  onClick: onRefreshEstimates,
                  disabled: !targetId || estimatesLoading,
                  loading: estimatesLoading,
                  icon: h(RefreshIcon),
                  title: targetId ? '重新计算各同步项的文件数与体积' : '请先选择同步目标',
                },
                '刷新预估'
              )
            )
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 } },
            h(StateBadge, { state: lastRunState(status) }),
            h('span', { style: styles.hint }, lastRunText(status)),
            h('span', { style: styles.hint }, DIRECTION_HINTS[direction] || '')
          )
        ),
        noTargets
          ? h(EmptyState, {
              icon: h(FolderIcon, { size: 20 }),
              title: '还没有同步目标',
              description: '先添加一个本地目录作为备份目标，再选择要同步的数据。备份目录可以是移动硬盘、NAS 或同步盘中的文件夹。',
              action: h(
                Button,
                { variant: 'primary', onClick: onGoTargets },
                '去添加目标'
              ),
            })
          : null,
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h(
              Button,
              {
                variant: 'secondary',
                onClick: handlePreview,
                loading: previewLoading,
                disabled: !canPreview,
                icon: h(RefreshIcon),
              },
              '刷新预览'
            ),
            h(
              Button,
              {
                variant: 'primary',
                onClick: handleStartSync,
                loading: starting,
                disabled: !canStart,
                icon: h(PlayIcon),
              },
              '开始同步'
            ),
            run && run.state === 'running'
              ? h(
                  Button,
                  {
                    variant: 'danger',
                    onClick: handleCancel,
                    loading: cancelling,
                    disabled: cancelRequested,
                  },
                  cancelRequested ? '正在取消…' : '取消同步'
                )
              : null
          ),
          disabledReason
            ? h('div', { style: styles.hint }, disabledReason)
            : h('div', { style: styles.hint }, '建议先预览变更，确认影响范围后再开始同步。')
        ),
        runError ? h(InlineError, { message: runError }) : null,
        pendingDecision
          ? h(
              'div',
              {
                style: Object.assign({}, styles.card, {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  borderColor: 'var(--dsw-alias-brand-primary)',
                }),
              },
              h('h3', { style: styles.sectionTitle }, '检测到删除差异，需要你决定'),
              pendingDecision.targetName
                ? h('div', { style: styles.hint }, '目标：' + pendingDecision.targetName)
                : null,
              pendingDecision.localMissing > 0
                ? h('div', { style: styles.hint }, '本地缺失 ' + pendingDecision.localMissing + ' 个文件（目标端仍存在）')
                : null,
              pendingDecision.remoteMissing > 0
                ? h('div', { style: styles.hint }, '目标端缺失 ' + pendingDecision.remoteMissing + ' 个文件（本地仍存在）')
                : null,
              h(
                'div',
                { style: styles.hint },
                '恢复：用另一侧内容把缺失文件补回来（会覆盖缺失项）。跳过：保留现状，本次不处理删除，其余变更照常同步。'
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(Button, { variant: 'primary', onClick: () => submitSync('restore', pendingDecision), loading: starting }, '恢复缺失文件（覆盖）'),
                h(Button, { variant: 'secondary', onClick: () => submitSync('ignore', pendingDecision), loading: starting }, '跳过删除，继续同步其它变更'),
                h(Button, { variant: 'ghost', onClick: cancelPendingDecision, disabled: starting }, '取消')
              )
            )
          : null,
        h(RunSection, {
          run: run,
          cancelling: cancelling,
          cancelRequested: cancelRequested,
          pollError: runPollError,
          onRetryPoll: () => setPollNonce((value) => value + 1),
          onCancel: handleCancel,
        }),
        h(PreviewSection, {
          preview: preview,
          loading: previewLoading,
          error: previewError,
          onRetry: handlePreview,
          decisionBusy: starting || isRunning,
          onDecision: (choice) => submitSync(choice),
        })
      )
    }

    // ---------------------------------------------------------------------
    // 目标页
    // ---------------------------------------------------------------------

    /** Directory chooser backed by the host's read-only fs.listDirs endpoint. */
    function DirPicker(props) {
      const [current, setCurrent] = useState(props.initialPath || '')
      const [listing, setListing] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [manual, setManual] = useState(props.initialPath || '')

      const load = useCallback(
        async (nextPath) => {
          setLoading(true)
          setError('')
          try {
            const value = await api('fs.listDirs', nextPath ? { path: nextPath } : {})
            setListing(value)
            setCurrent(value && value.path ? value.path : '')
            setManual(value && value.path ? value.path : '')
          } catch (loadError) {
            setError(errorText(loadError))
          } finally {
            setLoading(false)
          }
        },
        []
      )

      useEffect(() => {
        load(props.initialPath || '')
      }, [load, props.initialPath])

      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') props.onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props.onClose])

      const list = listing && Array.isArray(listing.dirs) ? listing.dirs : []
      const folderIcon = h(
        'svg',
        { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { flex: 'none' } },
        h('path', {
          d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinejoin: 'round',
        })
      )
      return h(
        'div',
        {
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': '选择目录',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 2000,
            background: 'rgba(0,0,0,.62)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          },
        },
        h(
          'div',
          {
            style: Object.assign({}, styles.card, {
              width: 'min(720px, 94vw)',
              maxHeight: '86vh',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              padding: 18,
              background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base))',
              border: '1px solid var(--dsw-alias-border-l2)',
              borderRadius: 12,
              boxShadow: '0 18px 50px rgba(0,0,0,.5)',
            }),
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
            h('h3', { style: Object.assign({}, styles.sectionTitle, { margin: 0 }) }, '选择目录'),
            h(Button, { variant: 'ghost', small: true, onClick: props.onClose }, '关闭')
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
            h('input', {
              style: Object.assign({}, styles.input, { flex: 1, minWidth: 240, fontSize: 13 }),
              value: manual,
              placeholder: '可直接输入绝对路径，例如 D:\\backup',
              onChange: (event) => setManual(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') load(manual)
              },
            }),
            h(Button, { variant: 'secondary', small: true, onClick: () => load(manual) }, '跳转'),
            listing && listing.parent
              ? h(Button, { variant: 'ghost', small: true, onClick: () => load(listing.parent) }, '上一级')
              : null,
            h(Button, { variant: 'ghost', small: true, onClick: () => load('') }, '主目录'),
            h(Button, { variant: 'ghost', small: true, onClick: () => load(current) }, '刷新')
          ),
          current
            ? h('span', { style: Object.assign({}, styles.hint, { wordBreak: 'break-all' }) }, '当前：' + current)
            : null,
          error ? h(InlineError, { message: error }) : null,
          h(
            'div',
            {
              style: {
                flex: 1,
                minHeight: 220,
                maxHeight: '52vh',
                overflow: 'auto',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: 8,
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                background: 'var(--dsw-alias-bg-base)',
              },
            },
            loading ? h('div', { style: styles.hint }, '正在读取目录…') : null,
            !loading && list.length === 0 ? h('div', { style: styles.hint }, '这个目录下没有子目录。') : null,
            list.map((dir) =>
              h(
                'button',
                {
                  key: dir.path,
                  type: 'button',
                  onClick: () => load(dir.path),
                  onDoubleClick: () => props.onPick(dir.path),
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    textAlign: 'left',
                    border: 0,
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-primary)',
                    padding: '7px 8px',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                  },
                  onMouseEnter: (event) => { event.currentTarget.style.background = 'var(--dsw-alias-bg-l2)' },
                  onMouseLeave: (event) => { event.currentTarget.style.background = 'transparent' },
                },
                folderIcon,
                h(
                  'span',
                  { style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  dir.name
                )
              )
            )
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', justifyContent: 'flex-end' } },
            h(
              'span',
              { style: Object.assign({}, styles.hint, { flex: 1, minWidth: 200 }) },
              '单击进入目录，双击直接选择；底部「选择此目录」确认。'
            ),
            h(Button, { variant: 'primary', small: true, onClick: () => props.onPick(current), disabled: !current }, '选择此目录'),
            h(Button, { variant: 'ghost', small: true, onClick: props.onClose }, '取消')
          )
        )
      )
    }

    /** Editable per-device path map shared by target and custom-item forms. */
    function DevicePathsEditor({ value, currentDeviceName, onChange, deviceLabel }) {
      const map = isObject(value) ? value : {}
      const [device, setDevice] = useState('')
      const [path, setPath] = useState('')
      const others = Object.keys(map).filter((name) => name !== currentDeviceName)

      const setEntry = (name, nextPath) => {
        const next = Object.assign({}, map)
        if (nextPath) next[name] = nextPath
        else delete next[name]
        onChange(next)
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, deviceLabel || '其它电脑的目录（可选）'),
        others.length === 0
          ? h('span', { style: styles.hint }, '还没有其它电脑的目录。添加后，同一份配置在对应电脑上会使用该目录。')
          : others.map((name) =>
              h(
                'div',
                { key: name, style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h('span', { style: Object.assign({}, styles.mono, { minWidth: 120 }) }, name),
                h('span', { style: Object.assign({}, styles.hint, { flex: 1, wordBreak: 'break-all' }) }, map[name]),
                h(Button, { variant: 'ghost', small: true, onClick: () => setEntry(name, '') }, '删除')
              )
            ),
        h(
          'div',
          { style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
          h('input', {
            style: Object.assign({}, styles.input, { width: 150 }),
            value: device,
            placeholder: '电脑名，例如 PC-B',
            onChange: (event) => setDevice(event.target.value),
          }),
          h('input', {
            style: Object.assign({}, styles.input, { flex: 1, minWidth: 220 }),
            value: path,
            placeholder: '该电脑上的目录路径',
            onChange: (event) => setPath(event.target.value),
          }),
          h(
            Button,
            {
              variant: 'ghost',
              small: true,
              onClick: () => {
                const name = device.trim()
                const nextPath = path.trim()
                if (!name || !nextPath) return
                setEntry(name, nextPath)
                setDevice('')
                setPath('')
              },
            },
            '添加'
          )
        ),
        currentDeviceName
          ? h('span', { style: styles.hint }, '当前电脑：' + currentDeviceName + '（使用上方主路径）')
          : null
      )
    }

    /** User-defined directory/file sync items. */
    function CustomTab(props) {
      const { settings, onSaveSettings, onError, onRefreshEstimates, status } = props
      const items = Array.isArray(settings.customItems) ? settings.customItems : []
      const deviceName = status && status.deviceName ? status.deviceName : ''
      const [form, setForm] = useState(null)
      const [saving, setSaving] = useState(false)
      const [notice, setNotice] = useState('')
      const [pickerOpen, setPickerOpen] = useState(false)

      const effectivePath = (item) => {
        const mapped = item.devicePaths && deviceName ? item.devicePaths[deviceName] : ''
        return mapped || item.path || ''
      }

      const updateForm = (field, value) => {
        setForm((previous) => Object.assign({}, previous, { [field]: value }))
      }

      const save = async () => {
        if (!form || saving) return
        const name = String(form.name || '').trim()
        const path = String(form.path || '').trim()
        if (!name) {
          onError(makeError('请填写自定义项名称', 'bad_form'))
          return
        }
        if (!path) {
          onError(makeError('请填写路径', 'bad_form'))
          return
        }
        setSaving(true)
        try {
          const item = {
            id: form.id || 'c_' + Math.random().toString(16).slice(2, 12),
            name,
            type: form.type === 'file' ? 'file' : 'dir',
            path,
            devicePaths: Object.assign({}, form.devicePaths || {}),
            enabled: form.enabled !== false,
          }
          const next = items.filter((entry) => entry.id !== item.id).concat(item)
          await onSaveSettings({ customItems: next })
          setNotice('已保存自定义项「' + item.name + '」。')
          setForm(null)
          if (onRefreshEstimates) onRefreshEstimates()
        } catch (error) {
          onError(error)
        } finally {
          setSaving(false)
        }
      }

      const remove = async (item) => {
        const confirmed = typeof window === 'undefined' || typeof window.confirm !== 'function'
          ? true
          : window.confirm('删除自定义同步项「' + item.name + '」？\n\n只删除配置，不会删除已备份的数据或本地文件。')
        if (!confirmed) return
        setSaving(true)
        try {
          await onSaveSettings({ customItems: items.filter((entry) => entry.id !== item.id) })
          setNotice('已删除「' + item.name + '」。')
          if (onRefreshEstimates) onRefreshEstimates()
        } catch (error) {
          onError(error)
        } finally {
          setSaving(false)
        }
      }

      const toggle = async (item, checked) => {
        setSaving(true)
        try {
          const next = items.map((entry) => entry.id === item.id ? Object.assign({}, entry, { enabled: checked }) : entry)
          await onSaveSettings({ customItems: next })
          if (onRefreshEstimates) onRefreshEstimates()
        } catch (error) {
          onError(error)
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: styles.sectionTitle }, '自定义同步项'),
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h(Button, { variant: 'primary', small: true, onClick: () => setForm({ id: '', name: '', type: 'dir', path: '', devicePaths: {}, enabled: true }) }, '新增目录/文件'),
              h(Button, { variant: 'ghost', small: true, onClick: () => onRefreshEstimates && onRefreshEstimates() }, '刷新预估')
            )
          ),
          h('span', { style: styles.hint }, '把任意目录或单个文件加入同步；每一项都有独立名称，可按电脑设置不同路径。'),
          notice ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success)' } }, notice) : null,
          items.length === 0
            ? h('span', { style: styles.hint }, '还没有自定义同步项。')
            : items.map((item) =>
                h(
                  'div',
                  {
                    key: item.id,
                    style: {
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: '8px 10px',
                      border: '1px solid var(--dsw-alias-border-l2)',
                      borderRadius: 8,
                      opacity: item.enabled === false ? 0.62 : 1,
                    },
                  },
                  h(
                    'div',
                    { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                    h(Checkbox, {
                      checked: item.enabled !== false,
                      disabled: saving,
                      onChange: (checked) => toggle(item, checked),
                    }),
                    h('span', { style: { fontSize: 13, fontWeight: 500 } }, item.name),
                    h(Badge, { tone: item.type === 'file' ? 'muted' : 'brand' }, item.type === 'file' ? '文件' : '目录'),
                    h('span', { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) }, item.id)
                  ),
                  h('span', { style: Object.assign({}, styles.hint, { wordBreak: 'break-all' }) }, effectivePath(item) || '（未设置路径）'),
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6 } },
                    h(
                      Button,
                      {
                        variant: 'ghost',
                        small: true,
                        disabled: saving,
                        onClick: () => setForm(Object.assign({}, item, { devicePaths: Object.assign({}, item.devicePaths || {}) })),
                      },
                      '编辑'
                    ),
                    h(Button, { variant: 'ghost', small: true, disabled: saving, onClick: () => remove(item) }, '删除')
                  )
                )
              )
        ),
        form
          ? h(
              'div',
              { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 10, borderColor: 'var(--dsw-alias-brand-primary)' }) },
              h('h3', { style: styles.sectionTitle }, form.id ? '编辑自定义项' : '新增自定义项'),
              h(
                'div',
                { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 } },
                h(Field, { label: '名称', required: true }, h('input', {
                  style: styles.input,
                  value: form.name || '',
                  placeholder: '例如：项目源码',
                  onChange: (event) => updateForm('name', event.target.value),
                })),
                h(Field, { label: '类型' }, h('select', {
                  style: Object.assign({}, styles.input, { cursor: 'pointer' }),
                  value: form.type || 'dir',
                  onChange: (event) => updateForm('type', event.target.value),
                },
                  h('option', { value: 'dir' }, '目录'),
                  h('option', { value: 'file' }, '单个文件')
                )),
                h(
                  Field,
                  { label: '路径（当前电脑）', required: true, style: { gridColumn: '1 / -1' }, hint: '支持绝对路径或 UNC；不同电脑可在下方单独配置。' },
                  h(
                    'div',
                    { style: { display: 'flex', gap: 6 } },
                    h('input', {
                      style: Object.assign({}, styles.input, { flex: 1 }),
                      value: form.path || '',
                      placeholder: form.type === 'file' ? 'D:\\notes\\todo.md' : 'D:\\projects\\demo',
                      onChange: (event) => updateForm('path', event.target.value),
                    }),
                    h(Button, { variant: 'secondary', small: true, onClick: () => setPickerOpen(true) }, '浏览…')
                  )
                ),
                h(
                  'div',
                  { style: { gridColumn: '1 / -1' } },
                  h(DevicePathsEditor, {
                    value: form.devicePaths,
                    currentDeviceName: deviceName,
                    onChange: (next) => updateForm('devicePaths', next),
                  })
                ),
                h(Checkbox, {
                  checked: form.enabled !== false,
                  onChange: (checked) => updateForm('enabled', checked),
                  label: '启用这个自定义项',
                })
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                h(Button, { variant: 'primary', onClick: save, loading: saving }, '保存'),
                h(Button, { variant: 'ghost', onClick: () => setForm(null), disabled: saving }, '取消')
              )
            )
          : null,
        pickerOpen
          ? h(DirPicker, {
              initialPath: form && form.path ? form.path : '',
              onPick: (picked) => {
                updateForm('path', picked)
                setPickerOpen(false)
              },
              onClose: () => setPickerOpen(false),
            })
          : null
      )
    }

    function TargetForm(props) {
      const form = props.form
      const [testing, setTesting] = useState(false)
      const [saving, setSaving] = useState(false)
      const [formError, setFormError] = useState('')
      const [testResult, setTestResult] = useState(null)
      const [pickerOpen, setPickerOpen] = useState(false)

      function update(field, value) {
        setTestResult(null)
        if (formError) setFormError('')
        props.onChange(Object.assign({}, form, { [field]: value }))
      }

      function buildTarget() {
        const path = String(form.path || '').trim()
        const name = String(form.name || '').trim() || deriveTargetName(path)
        return {
          id: form.id || newTargetId(),
          name: name,
          kind: form.kind || 'local',
          enabled: form.enabled !== false,
          path: path,
          devicePaths: Object.assign({}, form.devicePaths || {}),
          prefix: String(form.prefix || '').trim() || DEFAULT_PREFIX,
        }
      }

      function validate() {
        const path = String(form.path || '').trim()
        if (!path) {
          setFormError('请填写本地目录路径。')
          return false
        }
        if (form.kind && form.kind !== 'local') {
          setFormError('v0.1 只支持「本地目录」目标。')
          return false
        }
        setFormError('')
        return true
      }

      async function handleTest() {
        if (testing) return
        if (!validate()) return
        setTesting(true)
        setTestResult(null)
        try {
          const testTarget = Object.assign({}, buildTarget(), { id: '' })
          const value = await api('targets.test', { target: testTarget })
          const detail = value && typeof value.detail === 'string' && value.detail ? value.detail : ''
          setTestResult({
            ok: true,
            detail: detail ? '连接成功：' + detail : '连接成功，目录可写。',
          })
        } catch (error) {
          setTestResult({ ok: false, detail: errorText(error) })
        } finally {
          setTesting(false)
        }
      }

      async function handleSave() {
        if (saving) return
        if (!validate()) return
        setSaving(true)
        try {
          await api('targets.upsert', { target: buildTarget() })
          await props.onSaved()
        } catch (error) {
          setFormError(errorText(error))
          props.onError(error)
        } finally {
          setSaving(false)
        }
      }

      return h(
        'div',
        {
          style: Object.assign({}, styles.card, {
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            borderColor: 'var(--dsw-alias-brand-primary)',
          }),
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          h('h3', { style: styles.sectionTitle }, form.id ? '编辑同步目标' : '新增同步目标'),
          h('span', { style: styles.hint }, 'v0.1 仅支持本地目录')
        ),
        h(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 10,
            },
          },
          h(
            Field,
            { label: '名称' },
            h('input', {
              style: styles.input,
              value: form.name || '',
              placeholder: '例如：移动硬盘备份',
              onChange: (event) => update('name', event.target.value),
            })
          ),
          h(
            Field,
            { label: '类型' },
            h(
              'select',
              {
                style: Object.assign({}, styles.input, { cursor: 'pointer' }),
                value: form.kind || 'local',
                onChange: (event) => update('kind', event.target.value),
              },
              h(
                'option',
                { value: 'local' },
                '本地目录'
              ),
              form.kind && form.kind !== 'local'
                ? h('option', { value: form.kind }, targetKindLabel(form.kind) + '（暂不支持）')
                : null
            )
          ),
          h(
            Field,
            {
              label: '路径（当前电脑）',
              required: true,
              hint: '支持绝对路径、UNC 路径或同步盘中的本地文件夹；不同电脑可在下方分别配置。',
              style: { gridColumn: '1 / -1' },
            },
            h(
              'div',
              { style: { display: 'flex', gap: 6 } },
              h('input', {
                style: Object.assign({}, styles.input, { flex: 1 }),
                value: form.path || '',
                placeholder: 'D:\\dsh-backup 或 \\\\nas\\share\\dsh',
                onChange: (event) => update('path', event.target.value),
              }),
              h(Button, { variant: 'secondary', small: true, onClick: () => setPickerOpen(true) }, '浏览…')
            )
          ),
          h(
            'div',
            { style: { gridColumn: '1 / -1' } },
            h(DevicePathsEditor, {
              value: form.devicePaths,
              currentDeviceName: props.deviceName || form.deviceName || '',
              onChange: (next) => update('devicePaths', next),
              deviceLabel: '其它电脑的目标目录（可选）',
            })
          ),
          h(
            Field,
            {
              label: '前缀',
              hint: '备份数据在目标目录下的子路径，留空使用 ' + DEFAULT_PREFIX + '。',
              style: { gridColumn: '1 / -1' },
            },
            h('input', {
              style: styles.input,
              value: form.prefix || '',
              placeholder: DEFAULT_PREFIX,
              onChange: (event) => update('prefix', event.target.value),
            })
          )
        ),
        h(Checkbox, {
          checked: form.enabled !== false,
          onChange: (checked) => update('enabled', checked),
          label: '启用这个目标',
        }),
        formError ? h(InlineError, { message: formError }) : null,
        testResult
          ? h(
              'div',
              {
                style: {
                  fontSize: 12,
                  wordBreak: 'break-word',
                  color: testResult.ok
                    ? 'var(--dsw-alias-state-success)'
                    : 'var(--dsw-alias-state-error)',
                },
              },
              testResult.detail
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
          h(Button, { variant: 'secondary', onClick: handleTest, loading: testing }, '测试连接'),
          h(Button, { variant: 'primary', onClick: handleSave, loading: saving }, '保存'),
          h(Button, { variant: 'ghost', onClick: props.onCancel, disabled: saving }, '取消')
        ),
        pickerOpen
          ? h(DirPicker, {
              initialPath: form.path || '',
              onPick: (picked) => {
                update('path', picked)
                setPickerOpen(false)
              },
              onClose: () => setPickerOpen(false),
            })
          : null
      )
    }

    function TargetsTab(props) {
      const { targets, currentTargetId, onRefreshTargets, onError } = props
      const [form, setForm] = useState(null)
      const [notice, setNotice] = useState('')
      const [busyId, setBusyId] = useState('')

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      async function refresh() {
        try {
          await onRefreshTargets()
        } catch (error) {
          onError(error)
        }
      }

      function startCreate() {
        setNotice('')
        setForm({
          id: '',
          name: '',
          kind: 'local',
          enabled: true,
          path: '',
          devicePaths: {},
          prefix: '',
        })
      }

      function startEdit(target) {
        setNotice('')
        setForm({
          id: target.id,
          name: target.name || '',
          kind: target.kind || 'local',
          enabled: target.enabled !== false,
          path: target.effectivePath || target.path || '',
          devicePaths: Object.assign({}, target.devicePaths || {}),
          prefix: target.prefix || '',
        })
      }

      async function handleSaved() {
        const name = String(form.name || '').trim() || deriveTargetName(form.path)
        setForm(null)
        setNotice('已保存同步目标「' + name + '」。')
        await refresh()
      }

      async function handleToggle(target, checked) {
        if (busyId) return
        setBusyId(target.id)
        try {
          await api('targets.upsert', { target: Object.assign({}, target, { enabled: checked }) })
          await refresh()
        } catch (error) {
          onError(error)
          await refresh()
        } finally {
          setBusyId('')
        }
      }

      async function handleDelete(target) {
        if (busyId) return
        const confirmed =
          typeof window !== 'undefined' &&
          typeof window.confirm === 'function' &&
          window.confirm(
            '确定删除同步目标「' +
              (target.name || target.id) +
              '」吗？\n\n只会删除这条目标配置，不会删除目录中已经备份的数据。'
          )
        if (!confirmed) return
        setBusyId(target.id)
        try {
          await api('targets.remove', { id: target.id })
          if (form && form.id === target.id) setForm(null)
          setNotice('已删除同步目标「' + (target.name || target.id) + '」。')
          await refresh()
        } catch (error) {
          onError(error)
          await refresh()
        } finally {
          setBusyId('')
        }
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h3', { style: styles.sectionTitle }, '同步目标'),
            h('span', { style: styles.hint }, '目标决定备份写到哪里；本地目录可位于移动硬盘、NAS 或同步盘中。')
          ),
          h(Button, { variant: 'primary', onClick: startCreate, icon: h(PlusIcon) }, '添加目标')
        ),
        h(Notice, { message: notice }),
        form
          ? h(TargetForm, {
              form: form,
              deviceName: props.deviceName || '',
              onChange: setForm,
              onSaved: handleSaved,
              onCancel: () => setForm(null),
              onError: onError,
            })
          : null,
        targets.length === 0
          ? h(EmptyState, {
              icon: h(FolderIcon, { size: 22 }),
              title: '还没有同步目标',
              description: '先添加一个本地目录作为备份目标。建议选择独立于 DSH 数据目录的位置，避免把备份目录本身也同步进去。',
              action: h(Button, { variant: 'primary', onClick: startCreate, icon: h(PlusIcon) }, '添加本地目录'),
            })
          : h(
              'div',
              { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              targets.map((target) => {
                const busy = busyId === target.id
                return h(
                  'div',
                  { key: target.id, style: Object.assign({}, styles.card, { display: 'flex', gap: 10 }) },
                  h('div', { style: { paddingTop: 1, color: 'var(--dsw-alias-label-secondary)' } }, h(FolderIcon)),
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 } },
                    h(
                      'div',
                      { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                      h('span', { style: { fontSize: 13, fontWeight: 600 } }, textOf(target.name, target.id)),
                      h(Badge, { tone: 'muted' }, targetKindLabel(target.kind)),
                      target.id === currentTargetId
                        ? h(Badge, { tone: 'brand' }, '当前同步目标')
                        : null,
                      target.enabled === false ? h(Badge, { tone: 'muted' }, '已停用') : null
                    ),
                    h('div', { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-secondary)' }) }, target.effectivePath || target.path || '（未填写路径）'),
                    h(
                      'div',
                      { style: styles.hint },
                      '前缀：' + (target.prefix || DEFAULT_PREFIX),
                      h('span', { style: { margin: '0 6px' } }, '·'),
                      '上次同步：' + targetLastSync(target),
                      Object.keys(target.devicePaths || {}).length > 0
                        ? h('span', { style: { marginLeft: 8 } }, '· 已配置 ' + Object.keys(target.devicePaths).length + ' 台电脑目录')
                        : null
                    )
                  ),
                  h(
                    'div',
                    {
                      style: {
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        gap: 6,
                        justifyContent: 'space-between',
                      },
                    },
                    h(Checkbox, {
                      checked: target.enabled !== false,
                      disabled: busy,
                      onChange: (checked) => handleToggle(target, checked),
                      label: '启用',
                    }),
                    h(
                      'div',
                      { style: styles.row },
                      h(
                        Button,
                        { variant: 'ghost', small: true, onClick: () => startEdit(target), disabled: busy, icon: h(EditIcon) },
                        '编辑'
                      ),
                      h(
                        Button,
                        { variant: 'danger', small: true, onClick: () => handleDelete(target), disabled: busy, icon: h(TrashIcon) },
                        '删除'
                      )
                    )
                  )
                )
              })
            )
      )
    }

    // ---------------------------------------------------------------------
    // 历史页
    // ---------------------------------------------------------------------

    /**
     * Session-workspace tab: lists the stored session project directories with
     * their decoded cwd and lets the user relocate one to a local path. A red dot
     * marks records whose directory does not exist on this machine (usually a
     * session restored from another computer).
     */
    /** Advanced synchronization policy, kept out of the main sync tab. */
    function AdvancedTab(props) {
      const { settings, status, onSaveSettings, onError } = props
      const [savingForce, setSavingForce] = useState(false)
      const [savingAuto, setSavingAuto] = useState(false)
      const [savingDelete, setSavingDelete] = useState(false)
      const [savingSidebarProgress, setSavingSidebarProgress] = useState(false)
      const [savingPendingRefresh, setSavingPendingRefresh] = useState(false)
      const [autoTriggering, setAutoTriggering] = useState(false)
      const [autoMessage, setAutoMessage] = useState('')
      const autoSyncSettings = settings && isObject(settings.autoSync) ? settings.autoSync : {}
      const [autoInterval, setAutoInterval] = useState(String(autoSyncSettings.intervalMinutes || 60))

      useEffect(() => {
        const minutes = settings && isObject(settings.autoSync) ? settings.autoSync.intervalMinutes : null
        if (minutes != null) setAutoInterval(String(minutes))
      }, [settings && settings.autoSync ? settings.autoSync.intervalMinutes : null])

      async function handleForceChange(checked) {
        if (savingForce) return
        if (checked) {
          const confirmed =
            typeof window !== 'undefined' &&
            typeof window.confirm === 'function' &&
            window.confirm('强制覆盖会忽略目标端较新的改动，直接用本地内容覆盖差异文件。\n\n确定启用吗？')
          if (!confirmed) return
        }
        setSavingForce(true)
        try {
          await onSaveSettings({ force: checked })
        } catch (error) {
          onError(error)
        } finally {
          setSavingForce(false)
        }
      }

      async function handleAutoToggle(checked) {
        if (savingAuto) return
        setSavingAuto(true)
        try {
          await onSaveSettings({ autoSync: Object.assign({}, autoSyncSettings, { enabled: checked }) })
        } catch (error) {
          onError(error)
        } finally {
          setSavingAuto(false)
        }
      }

      async function handleAutoIntervalSave() {
        if (savingAuto) return
        const minutes = Math.max(15, Math.min(1440, Math.round(Number(autoInterval) || 60)))
        setAutoInterval(String(minutes))
        setSavingAuto(true)
        try {
          await onSaveSettings({ autoSync: Object.assign({}, autoSyncSettings, { intervalMinutes: minutes }) })
        } catch (error) {
          onError(error)
        } finally {
          setSavingAuto(false)
        }
      }

      async function handleAutoRunNow() {
        if (autoTriggering) return
        setAutoTriggering(true)
        setAutoMessage('')
        try {
          const value = await api('autoSync.runNow', {})
          if (value && value.run === true) {
            setAutoMessage('已开始一次定时同步，可在左侧栏或上方任务卡查看进度。')
          } else {
            const reasons = {
              busy: '当前有同步任务在运行，请稍后再试。',
              disabled: '请先开启定时自动同步。',
              'no-targets': '没有已启用的同步目标。',
            }
            setAutoMessage((value && reasons[value.reason]) || '没有启动定时同步。')
          }
        } catch (error) {
          onError(error)
        } finally {
          setAutoTriggering(false)
        }
      }

      async function handleDeleteModeChange(event) {
        const value = event && event.target ? event.target.value : ''
        if (savingDelete || !value) return
        setSavingDelete(true)
        try {
          await onSaveSettings({ deleteMode: value })
        } catch (error) {
          onError(error)
        } finally {
          setSavingDelete(false)
        }
      }

      async function handleSidebarProgressModeChange(event) {
        const value = event && event.target ? event.target.value : ''
        if (savingSidebarProgress || !value) return
        setSavingSidebarProgress(true)
        try {
          await onSaveSettings({ sidebarProgressMode: value })
        } catch (error) {
          onError(error)
        } finally {
          setSavingSidebarProgress(false)
        }
      }

      async function handlePendingRefreshChange(event) {
        const value = Number(event && event.target ? event.target.value : NaN)
        if (savingPendingRefresh || !Number.isFinite(value)) return
        setSavingPendingRefresh(true)
        try {
          await onSaveSettings({ pendingRefreshSeconds: value })
        } catch (error) {
          onError(error)
        } finally {
          setSavingPendingRefresh(false)
        }
      }

      const excludeExtra =
        settings && isObject(settings.exclude) && Array.isArray(settings.exclude.extra)
          ? settings.exclude.extra
          : []
      const selectStyle = {
        padding: '4px 6px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h('h3', { style: styles.sectionTitle }, '危险操作'),
          h(Checkbox, {
            checked: settings.force === true,
            disabled: savingForce,
            onChange: handleForceChange,
            label: '强制覆盖（危险）',
            title: '忽略目标端较新的改动，直接用本地内容覆盖差异文件',
          }),
          h(
            'span',
            { style: styles.hint },
            '开启后不比较目标端时间戳，直接以本地内容为准；目标端独有的较新文件可能因此丢失。每次开始同步仍会二次确认。'
          )
        ),
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h('h3', { style: styles.sectionTitle }, '定时自动同步'),
          h(Checkbox, {
            checked: autoSyncSettings.enabled === true,
            disabled: savingAuto,
            onChange: handleAutoToggle,
            label: '定时自动同步',
            title: '按设定间隔自动同步所有已启用目标',
          }),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '间隔（分钟）'),
            h('input', {
              type: 'number',
              min: 15,
              max: 1440,
              value: autoInterval,
              disabled: savingAuto,
              onChange: (event) => setAutoInterval(event.target.value),
              style: Object.assign({}, selectStyle, { width: 88 }),
            }),
            h(Button, { variant: 'ghost', small: true, onClick: handleAutoIntervalSave, loading: savingAuto }, '保存间隔'),
            h(Button, { variant: 'ghost', small: true, onClick: handleAutoRunNow, loading: autoTriggering }, '立即执行一次'),
            h('span', { style: styles.hint }, '范围 15–1440 分钟。')
          ),
          autoMessage ? h('span', { style: styles.hint }, autoMessage) : null,
          status && isObject(status.autoSync)
            ? h(
                'span',
                { style: styles.hint },
                '定时同步：' + (status.autoSync.enabled ? '已开启' : '已关闭'),
                ' · 上次：' + (status.autoSync.lastRunAt ? formatDate(status.autoSync.lastRunAt) : '—'),
                status.autoSync.nextAt ? ' · 下次：' + formatDate(status.autoSync.nextAt) : ''
              )
            : null
        ),
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h('h3', { style: styles.sectionTitle }, '删除处理'),
          h(
            'select',
            { value: settings.deleteMode || 'ask', disabled: savingDelete, onChange: handleDeleteModeChange, style: selectStyle },
            h('option', { value: 'ask' }, '每次询问（推荐）'),
            h('option', { value: 'restore' }, '恢复缺失文件（用另一侧覆盖）'),
            h('option', { value: 'mirror' }, '镜像删除（两侧保持一致）'),
            h('option', { value: 'ignore' }, '忽略删除')
          ),
          h('span', { style: styles.hint }, '每次询问：点「开始同步」时如果检测到删除差异，会先弹确认（跳过 / 恢复覆盖）。定时同步无人值守时按「忽略删除」处理。')
        ),
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h('h3', { style: styles.sectionTitle }, '左侧栏'),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '左侧栏显示设置'),
            h(
              'select',
              { value: settings.sidebarProgressMode || 'running', disabled: savingSidebarProgress, onChange: handleSidebarProgressModeChange, style: selectStyle },
              h('option', { value: 'running' }, '只在同步时显示'),
              h('option', { value: 'always' }, '一直显示'),
              h('option', { value: 'hidden' }, '隐藏')
            ),
            h('span', { style: styles.hint }, '只在同步时显示 = 仅同步时出现进度条；一直显示 = 空闲也保留计数与数据行，进度条只在同步时出现；隐藏 = 不显示进度条与速度，仅保留计数与同步图标。')
          ),
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
            h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '待上传/待下载自动统计间隔'),
            h(
              'select',
              { value: String(settings.pendingRefreshSeconds ?? 600), disabled: savingPendingRefresh, onChange: handlePendingRefreshChange, style: selectStyle },
              h('option', { value: '0' }, '关闭自动统计（同步后仍刷新一次）'),
              h('option', { value: '30' }, '30 秒'),
              h('option', { value: '60' }, '1 分钟'),
              h('option', { value: '300' }, '5 分钟'),
              h('option', { value: '600' }, '10 分钟（推荐）'),
              h('option', { value: '900' }, '15 分钟'),
              h('option', { value: '1800' }, '30 分钟'),
              h('option', { value: '3600' }, '60 分钟')
            ),
            h('span', { style: styles.hint }, '左栏「待上传 / 待下载 / 待确定」计数是只读扫描，默认每 10 分钟刷新一次；同步完成后总会立即刷新。')
          )
        ),
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h('h3', { style: styles.sectionTitle }, '自定义排除规则（只读）'),
          excludeExtra.length === 0
            ? h('span', { style: styles.hint }, '未添加自定义排除规则。内置排除（凭据、node_modules、缓存、日志等）始终生效且不可取消。')
            : h(
                'div',
                {
                  style: {
                    border: '1px solid var(--dsw-alias-border-l2)',
                    borderRadius: 6,
                    padding: '5px 8px',
                    background: 'var(--dsw-alias-bg-base)',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  },
                },
                excludeExtra.map((rule, index) => h('span', { key: index, style: styles.mono }, String(rule)))
              ),
          h('span', { style: styles.hint }, '用户排除规则叠加在内置硬排除之上，不能取消硬排除。')
        )
      )
    }

    /** Display metadata for the session compare statuses returned by the host. */
    const SESSION_STATUS_META = {
      same: { label: '已一致', tone: 'muted' },
      'local-ahead': { label: '本机追加', tone: 'success' },
      'backup-ahead': { label: '备份追加', tone: 'brand' },
      'local-newer': { label: '本机较新', tone: 'success' },
      'backup-newer': { label: '备份较新', tone: 'brand' },
      divergent: { label: '分叉', tone: 'error' },
      'local-only': { label: '仅本机', tone: 'success' },
      'backup-only': { label: '仅备份', tone: 'brand' },
    }

    /** Shorten a long session id for the compact rows; the full id is a title. */
    function shortSessionId(id) {
      const value = String(id || '')
      if (value.length <= 30) return value
      return value.slice(0, 14) + '…' + value.slice(-10)
    }

    function sessionStatusMeta(status) {
      return SESSION_STATUS_META[status] || { label: status || '未知', tone: 'muted' }
    }

    /** True for an absolute path on Windows (drive/UNC) or POSIX. */
    function isAbsolutePathInput(value) {
      const text = String(value || '').trim()
      if (!text) return false
      return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]/.test(text) || text.startsWith('/')
    }

    /** Extract `C:\Users\<name>` from a workspace path (Windows only). */
    function userRootInClient(cwd) {
      const match = /^([A-Za-z]:[\\/]Users[\\/][^\\/]+)([\\/]|$)/i.exec(String(cwd || ''))
      return match ? match[1] : ''
    }

    /**
     * Sessions tab.
     *
     * Sections: sync selection, per-session paths for the current
     * device|user, local-vs-backup compare with sync/overwrite actions, restore
     * from the newest target manifest, then the historical directory relocation
     * and duplicate-cleanup tools.
     */
    function SessionsTab(props) {
      const { onError, settings, onSaveSettings } = props
      const [state, setState] = useState({
        loading: true,
        groups: [],
        duplicates: [],
        userHome: '',
        homeUserRoot: '',
        deviceName: '',
        osUser: '',
        sessionPathKey: '',
        autoReplaceUserFolder: false,
        sessionPaths: {},
        selection: { mode: 'all', selectedSessionIds: [], selectedCount: 0, totalCount: 0, unselectedCount: 0, missingSelected: [] },
        error: '',
      })
      const [targets, setTargets] = useState([])
      const [targetId, setTargetId] = useState('')
      const [compare, setCompare] = useState({ loading: false, rows: [], counts: null, error: '' })
      const [backup, setBackup] = useState({ loading: false, sessions: [], error: '' })
      const [restoreSelected, setRestoreSelected] = useState({})
      const [restorePath, setRestorePath] = useState('')
      const [restoreBusy, setRestoreBusy] = useState('')
      const [restoreResult, setRestoreResult] = useState(null)
      const [actionBusy, setActionBusy] = useState('')
      const [pendingDanger, setPendingDanger] = useState('')
      const [notice, setNotice] = useState('')
      const [selectionBusy, setSelectionBusy] = useState(false)
      const [edits, setEdits] = useState({})
      const [saving, setSaving] = useState('')
      const [picker, setPicker] = useState(null)
      const [reload, setReload] = useState(0)
      const [dedupeConfirm, setDedupeConfirm] = useState(false)
      const [metaTick, setMetaTick] = useState(0)
      const [filterText, setFilterText] = useState('')
      const [dirSort, setDirSort] = useState('activity')
      const [dirSortAsc, setDirSortAsc] = useState(false)
      const [syncFilter, setSyncFilter] = useState('all')
      const [syncState, setSyncState] = useState({ ids: new Set(), loading: false })

      // DSH session titles and pins live in client-side services; refresh the
      // merged view periodically without re-listing the host session files.
      useEffect(() => {
        const timer = setInterval(() => setMetaTick((value) => value + 1), 3000)
        return () => clearInterval(timer)
      }, [])
      const sessionMeta = useMemo(() => dshSessionMetaReader(), [metaTick, state.groups])

      // Every session list sorts by latest activity (client-provided updatedAt,
      // then the log file mtime/size as a fallback) in descending order.
      const sortedGroups = useMemo(() => {        const updatedAtOf = (session) => {
          const meta = sessionMeta.get(session.id)
          return Number(meta && meta.updatedAt) || Number(session.mtimeMs) || Number(session.createdAt) || 0
        }
        const pinnedOf = (session) => {
          const meta = sessionMeta.get(session.id)
          return !!(meta && meta.pinned === true)
        }
        const compareSessions = (left, right) => {
          const pinDiff = Number(pinnedOf(right)) - Number(pinnedOf(left))
          if (pinDiff !== 0) return pinDiff
          return updatedAtOf(right) - updatedAtOf(left)
        }
        return state.groups.map((group) => {
          const sessions = Array.isArray(group.sessions)
            ? [...group.sessions].sort(compareSessions)
            : []
          return Object.assign({}, group, { sessions })
        })
      }, [state.groups, sessionMeta])

      // Directory filter + ordering over the already activity-sorted groups.
      // Sync status per session: a session counts as synced once the selected
      // target's latest manifest contains its id (recency is irrelevant here).
      useEffect(() => {
        let cancelled = false
        if (!targetId) {
          setSyncState({ ids: new Set(), loading: false })
          return undefined
        }
        setSyncState((previous) => ({ ids: previous.ids, loading: true }))
        api('sessions.compare', { targetId }).then((value) => {
          if (cancelled) return
          const ids = new Set()
          const rows = value && Array.isArray(value.rows) ? value.rows : []
          for (const row of rows) {
            if (row && row.sessionId && row.status && row.status !== 'local-only') ids.add(row.sessionId)
          }
          setSyncState({ ids, loading: false })
        }).catch(() => {
          if (!cancelled) setSyncState({ ids: new Set(), loading: false })
        })
        return () => {
          cancelled = true
        }
      }, [targetId, reload])

      const filteredGroups = useMemo(() => {
        const query = filterText.trim().toLowerCase()
        const matchesSync = (sessionId) => syncFilter === 'all'
          || (syncFilter === 'synced' ? syncState.ids.has(sessionId) : !syncState.ids.has(sessionId))
        const rows = []
        for (const group of sortedGroups) {
          const groupPath = String(group.cwd || '').toLowerCase()
          const pathHit = !!query && groupPath.includes(query)
          let sessions = group.sessions
          if (query && !pathHit) {
            sessions = group.sessions.filter((session) => {
              const meta = sessionMeta.get(session.id)
              const text = [
                meta && meta.name ? meta.name : '',
                session.id,
                session.cwd || '',
                group.cwd || '',
              ].join(' ').toLowerCase()
              return text.includes(query)
            })
          }
          if (syncFilter !== 'all') sessions = sessions.filter((session) => matchesSync(session.id))
          if (!pathHit && sessions.length === 0 && (query || syncFilter !== 'all')) continue
          rows.push(Object.assign({}, group, { sessions }))
        }
        const activityOf = (group) => {
          let newest = 0
          for (const session of group.sessions) {
            const meta = sessionMeta.get(session.id)
            const time = Number(meta && meta.updatedAt) || Number(session.mtimeMs) || Number(session.createdAt) || 0
            if (time > newest) newest = time
          }
          return newest
        }
        const unsyncedOf = (group) => group.sessions.filter((session) => !syncState.ids.has(session.id)).length
        rows.sort((left, right) => {
          let compared = 0
          if (dirSort === 'name') {
            compared = String(left.cwd || '').localeCompare(String(right.cwd || ''))
          } else if (dirSort === 'count') {
            compared = left.sessions.length - right.sessions.length
          } else if (dirSort === 'sync') {
            compared = unsyncedOf(left) - unsyncedOf(right)
          } else {
            compared = activityOf(left) - activityOf(right)
          }
          return dirSortAsc ? compared : -compared
        })
        return rows
      }, [sortedGroups, sessionMeta, filterText, dirSort, dirSortAsc, syncFilter, syncState])
      const visibleAllIds = useMemo(
        () => filteredGroups.flatMap((group) => group.sessions.map((session) => session.id)),
        [filteredGroups],
      )

      const load = useCallback(async () => {
        setState((previous) => Object.assign({}, previous, { loading: true }))
        try {
          const [sessionValue, targetValue] = await Promise.all([
            api('sessions.list'),
            api('targets.list').catch(() => ({ targets: [] })),
          ])
          const nextTargets = normalizeTargetList(targetValue && targetValue.targets)
          const preferred = nextTargets.find((target) => target.enabled !== false) || nextTargets[0]
          setTargets(nextTargets)
          setTargetId((previous) => {
            if (previous && nextTargets.some((target) => target.id === previous)) return previous
            return preferred ? preferred.id : ''
          })
          setState({
            loading: false,
            groups: sessionValue && Array.isArray(sessionValue.groups) ? sessionValue.groups : [],
            duplicates: sessionValue && Array.isArray(sessionValue.duplicates) ? sessionValue.duplicates : [],
            userHome: sessionValue && typeof sessionValue.userHome === 'string' ? sessionValue.userHome : '',
            homeUserRoot: sessionValue && typeof sessionValue.homeUserRoot === 'string' ? sessionValue.homeUserRoot : '',
            deviceName: sessionValue && typeof sessionValue.deviceName === 'string' ? sessionValue.deviceName : '',
            osUser: sessionValue && typeof sessionValue.osUser === 'string' ? sessionValue.osUser : '',
            sessionPathKey: sessionValue && typeof sessionValue.sessionPathKey === 'string' ? sessionValue.sessionPathKey : '',
            autoReplaceUserFolder: !!(sessionValue && sessionValue.autoReplaceUserFolder),
            sessionPaths: sessionValue && isObject(sessionValue.sessionPaths) ? sessionValue.sessionPaths : {},
            selection: sessionValue && isObject(sessionValue.selection)
              ? {
                  mode: sessionValue.selection.mode === 'selected' ? 'selected' : 'all',
                  selectedSessionIds: Array.isArray(sessionValue.selection.selectedSessionIds) ? sessionValue.selection.selectedSessionIds : [],
                  selectedCount: Number(sessionValue.selection.selectedCount) || 0,
                  totalCount: Number(sessionValue.selection.totalCount) || 0,
                  unselectedCount: Number(sessionValue.selection.unselectedCount) || 0,
                  missingSelected: Array.isArray(sessionValue.selection.missingSelected) ? sessionValue.selection.missingSelected : [],
                }
              : { mode: 'all', selectedSessionIds: [], selectedCount: 0, totalCount: 0, unselectedCount: 0, missingSelected: [] },
            error: '',
          })
        } catch (error) {
          setState((previous) => Object.assign({}, previous, { loading: false, error: errorText(error) }))
          if (onError) onError(error)
        }
      }, [onError])

      useEffect(() => {
        load()
      }, [load, reload])

      const allSessions = useMemo(() => {
        const rows = []
        for (const group of state.groups) {
          for (const session of group.sessions) {
            rows.push({ group, session })
          }
        }
        return rows
      }, [state.groups])
      const allIds = useMemo(() => allSessions.map((row) => row.session.id), [allSessions])
      const selectedSet = useMemo(() => {
        if (state.selection.mode === 'all') return new Set(allIds)
        return new Set(state.selection.selectedSessionIds)
      }, [state.selection, allIds])
      const sessionCwdById = useMemo(() => {
        const map = new Map()
        for (const row of allSessions) map.set(row.session.id, row.session.cwd || row.group.cwd || '')
        for (const row of backup.sessions) if (!map.has(row.sessionId)) map.set(row.sessionId, row.cwd || '')
        return map
      }, [allSessions, backup.sessions])

      async function saveSelection(mode, ids) {
        if (selectionBusy || !onSaveSettings) return
        setSelectionBusy(true)
        setNotice('')
        try {
          const scopes = Object.assign({}, isObject(settings.scopes) ? settings.scopes : {})
          scopes.sessions = Object.assign({}, scopes.sessions || {}, {
            mode: mode === 'selected' ? 'selected' : 'all',
            selectedSessionIds: ids,
          })
          await onSaveSettings({ scopes: scopes })
          setReload((value) => value + 1)
        } catch (error) {
          if (onError) onError(error)
        } finally {
          setSelectionBusy(false)
        }
      }

      function toggleSession(sessionId, checked) {
        const currentSelected = new Set(state.selection.mode === 'all' ? allIds : state.selection.selectedSessionIds)
        if (checked) currentSelected.add(sessionId)
        else currentSelected.delete(sessionId)
        saveSelection('selected', [...currentSelected])
      }

      async function selectAllSessions() {
        await saveSelection('selected', visibleAllIds)
      }

      /** Add every session of one project group to the selected set. */
      async function selectGroupSessions(group) {
        const current = new Set(state.selection.mode === 'all' ? allIds : state.selection.selectedSessionIds)
        for (const session of group.sessions) current.add(session.id)
        await saveSelection('selected', [...current])
      }

      async function invertSessions() {
        await saveSelection('selected', allIds.filter((id) => !selectedSet.has(id)))
      }

      async function clearSessions() {
        await saveSelection('selected', [])
      }

      async function saveAutoReplace(checked) {
        try {
          await onSaveSettings({ autoReplaceUserFolder: checked })
          setState((previous) => Object.assign({}, previous, { autoReplaceUserFolder: checked }))
        } catch (error) {
          if (onError) onError(error)
        }
      }

      async function runCompare() {
        if (!targetId) {
          if (onError) onError(makeError('请先在「目标」页添加并选择同步目标', 'no_target'))
          return
        }
        setCompare({ loading: true, rows: [], counts: null, error: '' })
        try {
          const value = await api('sessions.compare', { targetId: targetId })
          setCompare({
            loading: false,
            rows: value && Array.isArray(value.rows) ? value.rows : [],
            counts: value && isObject(value.counts) ? value.counts : null,
            error: '',
          })
        } catch (error) {
          setCompare({ loading: false, rows: [], counts: null, error: errorText(error) })
          if (onError) onError(error)
        }
      }

      async function loadBackupSessions() {
        if (!targetId) {
          if (onError) onError(makeError('请先选择同步目标', 'no_target'))
          return
        }
        setBackup({ loading: true, sessions: [], error: '' })
        setRestoreSelected({})
        setRestoreResult(null)
        try {
          const value = await api('sessions.backup.list', { targetId: targetId })
          setBackup({
            loading: false,
            sessions: value && Array.isArray(value.sessions) ? value.sessions : [],
            error: '',
          })
        } catch (error) {
          setBackup({ loading: false, sessions: [], error: errorText(error) })
          if (onError) onError(error)
        }
      }

      async function runSessionAction(sessionId, action) {
        if (!targetId || actionBusy) return
        const key = action + ':' + sessionId
        setActionBusy(key)
        setNotice('')
        try {
          let result = null
          if (action === 'sync') {
            result = await api('sessions.sync', { targetId: targetId, sessionIds: [sessionId], confirm: true })
            setNotice('已把 ' + shortSessionId(sessionId) + ' 同步到备份（' + formatNumber(result && result.files ? result.files : 0) + ' 个文件）')
          } else if (action === 'restore') {
            result = await api('sessions.restore', { targetId: targetId, sessionIds: [sessionId], confirm: true })
            setNotice('已从备份恢复 ' + shortSessionId(sessionId) + ' 到 ' + ((result.sessions && result.sessions[0] && result.sessions[0].cwd) || '本机'))
            setRestoreResult(result)
          } else if (action === 'overwrite-local') {
            result = await api('sessions.overwrite', { targetId: targetId, sessionIds: [sessionId], side: 'local', confirm: true })
            setNotice('已用备份覆盖本机 ' + shortSessionId(sessionId) + '（本机旧副本已备份）')
            setRestoreResult(result)
          } else if (action === 'overwrite-backup') {
            result = await api('sessions.overwrite', { targetId: targetId, sessionIds: [sessionId], side: 'backup', confirm: true })
            setNotice('已用本机覆盖备份 ' + shortSessionId(sessionId))
          }
          setPendingDanger('')
          setReload((value) => value + 1)
          if (compare.rows.length > 0) runCompare()
        } catch (error) {
          setPendingDanger('')
          if (onError) onError(error)
        } finally {
          setActionBusy('')
        }
      }

      async function runDangerAction(sessionId, action, label) {
        const key = action + ':' + sessionId
        if (pendingDanger !== key) {
          setPendingDanger(key)
          setNotice('危险操作：再次点击「' + label + '」才会执行（会覆盖一侧会话，另一侧会先备份）')
          return
        }
        await runSessionAction(sessionId, action)
      }

      async function restoreSelectedSessions(pathOverride) {
        const ids = Object.keys(restoreSelected).filter((id) => restoreSelected[id])
        if (ids.length === 0) {
          if (onError) onError(makeError('请先勾选要恢复的会话', 'no_sessions'))
          return
        }
        if (!targetId) {
          if (onError) onError(makeError('请先选择同步目标', 'no_target'))
          return
        }
        const path = String(pathOverride !== undefined ? pathOverride : restorePath || '').trim()
        if (path && !isAbsolutePathInput(path)) {
          if (onError) onError(makeError('目标路径必须是绝对路径', 'bad_path'))
          return
        }
        setRestoreBusy('restore')
        setPendingDanger('')
        setNotice('')
        try {
          const result = await api('sessions.restore', {
            targetId: targetId,
            sessionIds: ids,
            targetPath: path,
            autoReplaceUserFolder: state.autoReplaceUserFolder,
            confirm: true,
          })
          setRestoreResult(result)
          setNotice('已恢复 ' + formatNumber(result && result.restored ? result.restored : 0) + ' 个会话')
          setReload((value) => value + 1)
          if (compare.rows.length > 0) runCompare()
        } catch (error) {
          if (onError) onError(error)
        } finally {
          setRestoreBusy('')
        }
      }

      function quickReplaceUserRoot() {
        const ids = Object.keys(restoreSelected).filter((id) => restoreSelected[id])
        if (ids.length === 1) {
          const row = backup.sessions.find((session) => session.sessionId === ids[0])
          const oldCwd = row && row.cwd ? row.cwd : ''
          const oldRoot = userRootInClient(oldCwd)
          const homeRoot = state.homeUserRoot || state.userHome
          if (oldRoot && homeRoot) {
            setRestorePath(homeRoot + oldCwd.slice(oldRoot.length))
            setNotice('已把旧用户目录替换为当前用户目录：' + homeRoot)
            return
          }
        }
        setRestorePath(state.homeUserRoot || state.userHome || '')
        setNotice('目标路径已设为当前用户目录（多个会话会保留其相对结构）')
      }

      const dedupe = async () => {
        if (!dedupeConfirm) {
          setDedupeConfirm(true)
          return
        }
        setDedupeConfirm(false)
        try {
          const result = await api('sessions.dedupe')
          setNotice('已清理 ' + formatNumber(result && result.moved ? result.moved : 0) + ' 个重复会话副本' + (result && result.backupRoot ? '，备份在 ' + result.backupRoot : ''))
          setReload((value) => value + 1)
        } catch (error) {
          if (onError) onError(error)
        }
      }

      const move = async (group) => {
        if (saving) return
        const nextCwd = String(valueFor(group) || '').trim()
        if (!nextCwd) {
          if (onError) onError(makeError('请填写本机会话目录', 'bad_form'))
          return
        }
        setSaving(group.dirName)
        setNotice('')
        try {
          const result = await api('sessions.relocate', { dirName: group.dirName, newCwd: nextCwd, confirm: true })
          if (onSaveSettings && state.sessionPathKey) {
            const nextPaths = JSON.parse(JSON.stringify(state.sessionPaths || {}))
            const perSession = Object.assign({}, nextPaths[state.sessionPathKey] || {})
            const original = state.groups.find((item) => item.dirName === group.dirName) || group
            for (const session of original.sessions) perSession[session.id] = nextCwd
            nextPaths[state.sessionPathKey] = perSession
            await onSaveSettings({ sessionPaths: nextPaths }).catch(() => {})
          }
          setNotice('已迁移 ' + formatNumber(result && result.moved ? result.moved : 0) + ' 个会话到 ' + nextCwd)
          setEdits((previous) => {
            const next = Object.assign({}, previous)
            delete next[group.dirName]
            return next
          })
          setReload((value) => value + 1)
        } catch (error) {
          if (onError) onError(error)
        } finally {
          setSaving('')
        }
      }

      const suggestedFor = (group) => group.suggestedCwd || group.cwd || ''
      const valueFor = (group) => (
        edits[group.dirName] !== undefined ? edits[group.dirName] : suggestedFor(group)
      )
      const renderPicker = () => {
        if (!picker) return null
        const initialPath = picker.kind === 'group'
          ? ((state.groups.find((group) => group.dirName === picker.key) || {}).cwd || '')
          : restorePath
        return h(DirPicker, {
          initialPath: initialPath,
          onPick: (picked) => {
            setPicker(null)
            if (picker.kind === 'group') {
              setEdits((previous) => Object.assign({}, previous, { [picker.key]: picked }))
            } else if (picker.kind === 'restore') {
              setRestorePath(picked)
              if (picker.autoRestore) restoreSelectedSessions(picked)
            }
          },
          onClose: () => setPicker(null),
        })
      }

      const selection = state.selection

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        notice
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-success)' } }, notice)
          : null,
        state.error
          ? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-state-error)' } }, state.error)
          : null,

        // 1. Sync selection -------------------------------------------------
        h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', flexDirection: 'column', gap: 8 }) },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' } },
            h('h3', { style: styles.sectionTitle }, '同步范围（会话选择）'),
            h(Button, { variant: 'ghost', small: true, onClick: () => setReload((value) => value + 1), loading: state.loading }, '刷新'),
          ),
          h(
            'span',
            { style: styles.hint },
            '「全部会话」会同步现有的以及以后新建的会话；「仅选中的会话」只同步下面勾选的会话，新会话默认不加入，需要你手动勾选。每个项目分组右侧可「选择目录…」为本机指定会话目录，确认后执行迁移（改写会话头 cwd 并重命名目录，不复制文件），同时把该组会话的本机路径写入映射。迁移前请先关闭对应会话。',
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(
              Button,
              {
                variant: selection.mode === 'all' ? 'primary' : 'secondary',
                small: true,
                disabled: selectionBusy,
                onClick: () => saveSelection('all', selection.selectedSessionIds),
              },
              '全部会话',
            ),
            h(
              Button,
              {
                variant: selection.mode === 'selected' ? 'primary' : 'secondary',
                small: true,
                disabled: selectionBusy,
                onClick: () => saveSelection('selected', selection.selectedSessionIds.length ? selection.selectedSessionIds : allIds),
              },
              '仅选中的会话',
            ),
            h(Badge, { tone: 'muted' }, '已选 ' + formatNumber(selection.selectedCount) + ' / 共 ' + formatNumber(selection.totalCount)),
            selection.mode === 'selected' && selection.unselectedCount > 0
              ? h(Badge, { tone: 'error' }, '未勾选 ' + formatNumber(selection.unselectedCount) + ' 个（不会同步）')
              : null,
            selection.missingSelected && selection.missingSelected.length > 0
              ? h(Badge, { tone: 'error', title: selection.missingSelected.join(', ') }, '已选但本机不存在 ' + formatNumber(selection.missingSelected.length) + ' 个')
              : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h(Button, { variant: 'secondary', small: true, disabled: selectionBusy, onClick: selectAllSessions }, '全选（当前列表）'),
            h(Button, { variant: 'secondary', small: true, disabled: selectionBusy, onClick: invertSessions }, '反选'),
            h(Button, { variant: 'ghost', small: true, disabled: selectionBusy, onClick: clearSessions }, '清空选择'),
            selectionBusy ? h(SpinnerText, null, '保存中…') : null,
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' } },
            h('input', {
              type: 'text',
              value: filterText,
              placeholder: '筛选：会话名称 / sessionID / 目录路径',
              onChange: (event) => setFilterText(event && event.target ? event.target.value : ''),
              style: Object.assign({}, styles.input, { flex: '1 1 240px' }),
            }),
            filterText ? h(Button, { variant: 'ghost', small: true, onClick: () => setFilterText('') }, '清除筛选') : null,
            h('span', { style: styles.hint }, '同步状态'),
            h(
              'select',
              {
                value: syncFilter,
                onChange: (event) => setSyncFilter(event && event.target ? event.target.value : 'all'),
                style: {
                  padding: '4px 6px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                },
              },
              h('option', { value: 'all' }, '全部'),
              h('option', { value: 'synced' }, '已同步'),
              h('option', { value: 'unsynced' }, '未同步')
            ),
            h('span', { style: styles.hint }, '目录排序'),
            h(
              'select',
              {
                value: dirSort,
                onChange: (event) => setDirSort(event && event.target ? event.target.value : 'activity'),
                style: {
                  padding: '4px 6px',
                  fontSize: 12,
                  borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-base)',
                  color: 'var(--dsw-alias-label-primary)',
                },
              },
              h('option', { value: 'activity' }, '最近活动'),
              h('option', { value: 'name' }, '目录名称'),
              h('option', { value: 'count' }, '会话数量'),
              h('option', { value: 'sync' }, '同步状态')
            ),
            h(Button, { variant: 'secondary', small: true, onClick: () => setDirSortAsc((value) => !value) }, dirSortAsc ? '升序' : '降序'),
            h(
              'span',
              { style: styles.hint },
              '同步状态基于目标：'
                + (((targets.find((target) => target.id === targetId) || {}).name) || '未选择同步目标')
                + (syncState.loading ? '（读取中…）' : '')
            ),
          ),
          state.loading && state.groups.length === 0
            ? h(SpinnerText, null, '正在读取会话…')
            : state.groups.length === 0
              ? h('span', { style: styles.hint }, '没有找到会话目录。')
              : filteredGroups.length === 0
                ? h('span', { style: styles.hint }, '没有匹配的会话或目录。')
                : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 320, overflow: 'auto', paddingRight: 4 } },
                  filteredGroups.map((group) =>
                    h(
                      'div',
                      { key: group.dirName, style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8 } },
                      h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        h('span', {
                          title: group.exists ? '目录存在' : '本机不存在该目录',
                          style: {
                            flex: 'none',
                            width: 9,
                            height: 9,
                            borderRadius: '50%',
                            background: group.exists ? 'var(--dsw-alias-state-success)' : 'var(--dsw-alias-state-error)',
                            display: 'inline-block',
                          },
                        }),
                        h('span', { style: Object.assign({}, styles.mono, { fontSize: 12, wordBreak: 'break-all' }) }, group.cwd || '（未记录工作区）'),
                        h(Badge, { tone: 'muted' }, group.sessions.length + ' 个会话'),
                        h(
                          Button,
                          {
                            variant: 'ghost',
                            small: true,
                            disabled: selectionBusy
                              || state.selection.mode === 'all'
                              || group.sessions.every((session) => selectedSet.has(session.id)),
                            onClick: () => selectGroupSessions(group),
                          },
                          '全选本组'
                        ),
                        group.exists || group.noCwd
                          ? null
                          : h(
                              Button,
                              {
                                variant: 'secondary',
                                small: true,
                                disabled: saving !== '',
                                onClick: () => setPicker({ kind: 'group', key: group.dirName }),
                              },
                              '选择目录…'
                            ),
                        group.exists || group.noCwd
                          ? null
                          : h(
                              Button,
                              {
                                variant: 'primary',
                                small: true,
                                loading: saving === group.dirName,
                                disabled: saving !== ''
                                  || String(valueFor(group) || '').trim() === String(group.cwd || ''),
                                onClick: () => move(group),
                              },
                              '迁移到该目录'
                            ),
                      ),
                      group.exists
                        ? null
                        : h(
                            'span',
                            { style: styles.hint },
                            group.noCwd
                              ? '该组没有工作区路径，无法迁移。'
                              : '本机目录：' + (String(valueFor(group) || '').trim() || '（未设置）')
                                + '（当前目录不存在；迁移会改写会话头并重命名目录）'
                          ),
                      group.sessions.map((session) => {
                        const meta = sessionMeta.get(session.id) || {}
                        const name = String(meta.name || '').trim() || '未命名会话'
                        const updatedAt = meta.updatedAt || session.mtimeMs || session.createdAt || null
                        const pinned = meta.pinned === true
                        return h(
                          'div',
                          {
                            key: session.id,
                            style: {
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 8,
                              padding: '4px 0 4px 16px',
                            },
                          },
                          h(Checkbox, {
                            checked: selectedSet.has(session.id),
                            disabled: selectionBusy,
                            onChange: (checked) => toggleSession(session.id, checked),
                            title: session.id,
                          }),
                          h(
                            'div',
                            { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                            h(
                              'span',
                              {
                                title: name,
                                style: {
                                  fontSize: 12,
                                  color: 'var(--dsw-alias-label-primary)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                },
                              },
                              name
                            ),
                            h(
                              'span',
                              {
                                title: session.id,
                                style: Object.assign({}, styles.mono, {
                                  fontSize: 10,
                                  color: 'var(--dsw-alias-label-tertiary)',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }),
                              },
                              shortSessionId(session.id)
                            )
                          ),
                          h(
                            'div',
                            {
                              style: {
                                flex: 'none',
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'flex-end',
                                gap: 2,
                                fontSize: 10,
                                color: 'var(--dsw-alias-label-tertiary)',
                                whiteSpace: 'nowrap',
                              },
                            },
                            h(
                              'span',
                              { style: { display: 'inline-flex', alignItems: 'center', gap: 4 } },
                              h('span', { title: '占用空间' }, formatBytes(session.size || 0)),
                              pinned
                                ? h(
                                    'svg',
                                    {
                                      width: 11,
                                      height: 11,
                                      viewBox: '0 0 24 24',
                                      fill: 'none',
                                      'aria-label': '已置顶',
                                      title: '已置顶',
                                      style: { flex: 'none', color: 'var(--dsw-alias-brand-primary)' },
                                    },
                                    h('path', {
                                      d: 'M9 3h6l-1 5 4 4v2h-7v7l-1 1-1-1v-7H4v-2l4-4-1-5z',
                                      stroke: 'currentColor',
                                      strokeWidth: 1.6,
                                      strokeLinejoin: 'round',
                                    })
                                  )
                                : null
                            ),
                            h('span', { title: '最新交互时间' }, updatedAt ? formatDate(updatedAt, true) : '—')
                          )
                        )
                      }),
                    ),
                  ),
                ),
        ),

        // 2. Duplicates --------------------------------------------------
        state.duplicates.length > 0
          ? h(
              'div',
              {
                style: Object.assign({}, styles.card, {
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  border: '1px solid var(--dsw-alias-state-error)',
                }),
              },
              h('h3', { style: styles.sectionTitle }, '发现重复会话（会导致无法初始化）'),
              h('span', { style: styles.hint }, '同一个 sessionId 出现在多个目录里。清理会把多余副本移动到 sessions\\.dedupe-backup-<时间戳>\\ 下，不会删除主副本；从备份恢复时也会自动把旧副本移到本机备份目录。'),
              state.duplicates.slice(0, 20).map((duplicate) =>
                h(
                  'div',
                  { key: duplicate.id, style: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 } },
                  h('span', { style: Object.assign({}, styles.mono, { wordBreak: 'break-all' }) }, duplicate.id),
                  h('span', { style: styles.hint }, duplicate.copies.map((copy) => copy.cwd || copy.dirName).join('  |  ')),
                ),
              ),
              h(
                'div',
                { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' } },
                h(Button, { variant: 'danger', small: true, onClick: dedupe }, dedupeConfirm ? '确认清理重复副本' : '清理重复副本'),
              ),
            )
          : null,
        renderPicker(),
      )
    }

    function HistoryTab(props) {
      const { targets, targetId, onTargetChange, onError } = props
      const [selected, setSelected] = useState(targetId || (targets[0] && targets[0].id) || '')
      const [snapshots, setSnapshots] = useState([])
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState('')
      const [nonce, setNonce] = useState(0)

      useEffect(() => {
        setSelected((previous) => {
          if (previous && targets.some((target) => target.id === previous)) return previous
          if (targetId && targets.some((target) => target.id === targetId)) return targetId
          return targets[0] ? targets[0].id : ''
        })
      }, [targets, targetId])

      useEffect(() => {
        if (!selected) {
          setSnapshots([])
          setError('')
          return undefined
        }
        let cancelled = false
        setLoading(true)
        setError('')
        api('snapshots.list', { targetId: selected })
          .then((value) => {
            if (cancelled) return
            const list = value && Array.isArray(value.snapshots) ? value.snapshots : []
            list.sort((a, b) => {
              const left = toDate(a && a.createdAt)
              const right = toDate(b && b.createdAt)
              return (right ? right.getTime() : 0) - (left ? left.getTime() : 0)
            })
            setSnapshots(list)
          })
          .catch((fetchError) => {
            if (cancelled) return
            setSnapshots([])
            setError(errorText(fetchError))
            onError(fetchError)
          })
          .finally(() => {
            if (!cancelled) setLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [selected, nonce, onError])

      function handleSelect(value) {
        setSelected(value)
        if (typeof onTargetChange === 'function') onTargetChange(value)
      }

      return h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h3', { style: styles.sectionTitle }, '同步历史'),
            h('span', { style: styles.hint }, '快照在每次成功同步且存在变更时写入；这里只读展示已写入的快照。')
          ),
          h(
            'div',
            { style: Object.assign({}, styles.row, { alignItems: 'end' }) },
            targets.length > 0
              ? h(
                  'div',
                  { style: { minWidth: 200 } },
                  h(TargetSelect, {
                    targets: targets,
                    value: selected,
                    onChange: handleSelect,
                    label: '历史目标',
                  })
                )
              : null,
            h(
              Button,
              {
                variant: 'secondary',
                onClick: () => setNonce((value) => value + 1),
                disabled: !selected || loading,
                loading: loading,
                icon: h(RefreshIcon),
              },
              '刷新'
            )
          )
        ),
        targets.length === 0
          ? h(EmptyState, {
              icon: h(FolderIcon, { size: 20 }),
              title: '还没有可查看的目标',
              description: '先在「目标」页添加一个本地目录，成功同步后这里会出现快照记录。',
            })
          : null,
        error ? h(InlineError, { message: error, onRetry: () => setNonce((value) => value + 1) }) : null,
        targets.length > 0
          ? h(
              'div',
              { style: styles.card },
              loading
                ? h(SpinnerText, null, '正在读取快照…')
                : snapshots.length === 0
                  ? h('div', { style: Object.assign({}, styles.hint, { padding: '12px 0', textAlign: 'center' }) }, '暂无快照')
                  : h(
                      'table',
                      { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
                      h(
                        'thead',
                        null,
                        h(
                          'tr',
                          null,
                          ['时间', '设备', '文件数'].map((label, index) =>
                            h(
                              'th',
                              {
                                key: label,
                                style: {
                                  textAlign: index === 2 ? 'right' : 'left',
                                  padding: '6px 8px',
                                  fontSize: 11,
                                  fontWeight: 500,
                                  color: 'var(--dsw-alias-label-tertiary)',
                                  borderBottom: '1px solid var(--dsw-alias-border-l2)',
                                  whiteSpace: 'nowrap',
                                },
                              },
                              label
                            )
                          )
                        )
                      ),
                      h(
                        'tbody',
                        null,
                        snapshots.map((snapshot, index) =>
                          h(
                            'tr',
                            { key: (snapshot && snapshot.key) || index, title: snapshot && snapshot.key ? snapshot.key : undefined },
                            h(
                              'td',
                              {
                                style: {
                                  padding: '7px 8px',
                                  borderBottom:
                                    index === snapshots.length - 1
                                      ? 'none'
                                      : '1px solid var(--dsw-alias-border-l2)',
                                  whiteSpace: 'nowrap',
                                },
                              },
                              formatDate(snapshot && snapshot.createdAt, true)
                            ),
                            h(
                              'td',
                              {
                                style: {
                                  padding: '7px 8px',
                                  borderBottom:
                                    index === snapshots.length - 1
                                      ? 'none'
                                      : '1px solid var(--dsw-alias-border-l2)',
                                  color: 'var(--dsw-alias-label-secondary)',
                                },
                              },
                              textOf(snapshot && snapshot.deviceName, '未知设备')
                            ),
                            h(
                              'td',
                              {
                                style: {
                                  padding: '7px 8px',
                                  borderBottom:
                                    index === snapshots.length - 1
                                      ? 'none'
                                      : '1px solid var(--dsw-alias-border-l2)',
                                  textAlign: 'right',
                                  whiteSpace: 'nowrap',
                                },
                              },
                              formatNumber(snapshot && snapshot.files)
                            )
                          )
                        )
                      )
                    )
            )
          : null
      )
    }

    // ---------------------------------------------------------------------
    // 设置页外壳
    // ---------------------------------------------------------------------

    function Panel() {
      const [tab, setTab] = useState(() => {
        try {
          const desired = globalThis.__dshSyncHubInitialTab
          if (desired) {
            delete globalThis.__dshSyncHubInitialTab
            return desired === 'sessions' ? 'sessions' : 'sync'
          }
        } catch (error) {
          // Ignore hosts without a global object.
        }
        return 'sync'
      })
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [status, setStatus] = useState(null)
      const [settings, setSettings] = useState(null)
      const [targets, setTargets] = useState([])
      const [estimates, setEstimates] = useState([])
      const [estimatesLoading, setEstimatesLoading] = useState(false)
      const [targetId, setTargetId] = useState('')
      const [direction, setDirection] = useState('both')
      const [estimateNonce, setEstimateNonce] = useState(0)

      const mountedRef = useRef(true)
      const directionInitialized = useRef(false)
      const estimateTargetRef = useRef('')

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
        }
      }, [])

      const reportError = useCallback((nextError) => {
        setError(errorInfo(nextError))
      }, [])

      const loadInitial = useCallback(async () => {
        setLoading(true)
        setError(null)
        const results = await Promise.allSettled([
          api('status'),
          api('settings.get'),
          api('targets.list'),
        ])
        if (!mountedRef.current) return

        const failures = []
        let nextSettings = null
        let nextTargets = []

        const statusResult = results[0]
        const settingsResult = results[1]
        const targetsResult = results[2]

        if (statusResult.status === 'fulfilled') {
          setStatus(isObject(statusResult.value) ? statusResult.value : null)
        } else {
          failures.push('状态：' + errorText(statusResult.reason))
        }

        if (settingsResult.status === 'fulfilled' && isObject(settingsResult.value) && isObject(settingsResult.value.settings)) {
          nextSettings = settingsResult.value.settings
          setSettings(nextSettings)
        } else if (settingsResult.status === 'rejected') {
          failures.push('设置：' + errorText(settingsResult.reason))
        } else {
          failures.push('设置：宿主返回了空设置')
        }

        if (targetsResult.status === 'fulfilled' && isObject(targetsResult.value)) {
          nextTargets = normalizeTargetList(targetsResult.value.targets)
          setTargets(nextTargets)
        } else {
          if (targetsResult.status === 'rejected') {
            failures.push('目标：' + errorText(targetsResult.reason))
          }
          if (nextSettings && Array.isArray(nextSettings.targets)) {
            nextTargets = normalizeTargetList(nextSettings.targets)
            setTargets(nextTargets)
          }
        }

        setTargetId((previous) => {
          if (previous && nextTargets.some((target) => target.id === previous)) return previous
          const preferred = nextTargets.find((target) => target.enabled !== false) || nextTargets[0]
          return preferred ? preferred.id : ''
        })

        if (nextSettings && !directionInitialized.current) {
          directionInitialized.current = true
          setDirection(normalizeDirection(nextSettings.direction))
        }

        setLoading(false)
        if (failures.length) setError({ message: failures.join('；') })
      }, [])

      useEffect(() => {
        loadInitial()
      }, [loadInitial])

      useEffect(() => {
        if (loading) return undefined
        let cancelled = false
        const targetChanged = estimateTargetRef.current !== targetId
        estimateTargetRef.current = targetId
        if (targetChanged) setEstimates([])
        setEstimatesLoading(true)
        api('scopes.estimate', targetId ? { targetId: targetId } : {})
          .then((value) => {
            if (cancelled) return
            setEstimates(normalizeEstimateList(value && value.scopes))
          })
          .catch((fetchError) => {
            if (cancelled) return
            setEstimates([])
            reportError(fetchError)
          })
          .finally(() => {
            if (!cancelled) setEstimatesLoading(false)
          })
        return () => {
          cancelled = true
        }
      }, [loading, targetId, estimateNonce, reportError])

      const saveSettings = useCallback(async (patch) => {
        const value = await api('settings.save', { patch: patch })
        const nextSettings = value && isObject(value.settings) ? value.settings : null
        if (nextSettings) setSettings(nextSettings)
        return nextSettings
      }, [])

      const changeDirection = useCallback(
        async (nextDirection) => {
          const safeDirection = normalizeDirection(nextDirection)
          const previousDirection = normalizeDirection(settings && settings.direction)
          setDirection(safeDirection)
          try {
            await saveSettings({ direction: safeDirection })
          } catch (saveError) {
            setDirection(previousDirection)
            reportError(saveError)
          }
        },
        [settings, saveSettings, reportError]
      )

      const refreshStatus = useCallback(async () => {
        try {
          const value = await api('status')
          if (mountedRef.current) setStatus(isObject(value) ? value : null)
        } catch (fetchError) {
          reportError(fetchError)
        }
      }, [reportError])

      // Keep the host-side pending decision visible even when it was raised or
      // resolved from the sidebar widget.
      useEffect(() => {
        if (loading) return undefined
        const timer = setInterval(() => {
          refreshStatus()
        }, 2000)
        return () => clearInterval(timer)
      }, [loading, refreshStatus])

      const refreshTargets = useCallback(async () => {
        const value = await api('targets.list')
        const list = normalizeTargetList(value && value.targets)
        setTargets(list)
        setTargetId((previous) => {
          if (previous && list.some((target) => target.id === previous)) return previous
          const preferred = list.find((target) => target.enabled !== false) || list[0]
          return preferred ? preferred.id : ''
        })
        setEstimateNonce((valueNonce) => valueNonce + 1)
        return list
      }, [])

      const refreshEstimates = useCallback(() => {
        setEstimateNonce((value) => value + 1)
      }, [])

      const handleTab = useCallback(
        (nextTab) => {
          setTab(nextTab)
          setError(null)
          if (nextTab === 'sync') refreshStatus()
        },
        [refreshStatus]
      )

      const handleRunFinished = useCallback(() => {
        refreshStatus()
        setEstimateNonce((value) => value + 1)
      }, [refreshStatus])

      const tabs = [
        { id: 'sync', label: '同步' },
        { id: 'scopes', label: '同步项' },
        { id: 'advanced', label: '高级' },
        { id: 'custom', label: '自定义' },
        { id: 'sessions', label: '会话' },
        { id: 'targets', label: '目标' },
        { id: 'history', label: '历史' },
      ]

      let content = null
      if (loading) {
        content = h(
          'div',
          { style: Object.assign({}, styles.card, { display: 'flex', alignItems: 'center', gap: 8 }) },
          h(SpinnerText, null, '正在加载同步配置…')
        )
      } else if (!settings) {
        content = h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } },
            h('span', { style: styles.muted }, '无法加载同步设置，请确认插件宿主已正确启动。'),
            h(Button, { variant: 'secondary', small: true, onClick: loadInitial }, '重新加载')
          )
        )
      } else if (tab === 'sync') {
        content = h(SyncTab, {
          settings: settings,
          targets: targets,
          estimates: estimates,
          estimatesLoading: estimatesLoading,
          status: status,
          targetId: targetId,
          direction: direction,
          onTargetChange: setTargetId,
          onDirectionChange: changeDirection,
          onSaveSettings: saveSettings,
          onRefreshEstimates: refreshEstimates,
          onRefreshStatus: refreshStatus,
          onRunFinished: handleRunFinished,
          onError: reportError,
          onGoTargets: () => handleTab('targets'),
        })
      } else if (tab === 'scopes') {
        content = h(ScopesTab, {
          settings: settings,
          estimates: estimates,
          estimatesLoading: estimatesLoading,
          targetId: targetId,
          onRefreshEstimates: refreshEstimates,
          onSaveSettings: saveSettings,
          onError: reportError,
          onGoTargets: () => handleTab('targets'),
        })
      } else if (tab === 'advanced') {
        content = h(AdvancedTab, {
          settings: settings,
          status: status,
          onSaveSettings: saveSettings,
          onError: reportError,
        })
      } else if (tab === 'custom') {
        content = h(CustomTab, {
          settings: settings,
          status: status,
          onSaveSettings: saveSettings,
          onRefreshEstimates: refreshEstimates,
          onError: reportError,
        })
      } else if (tab === 'sessions') {
        content = h(SessionsTab, {
          settings: settings,
          onSaveSettings: saveSettings,
          onError: reportError,
        })
      } else if (tab === 'targets') {
        content = h(TargetsTab, {
          targets: targets,
          currentTargetId: targetId,
          deviceName: status && status.deviceName ? status.deviceName : '',
          onRefreshTargets: refreshTargets,
          onError: reportError,
        })
      } else {
        content = h(HistoryTab, {
          targets: targets,
          targetId: targetId,
          onTargetChange: setTargetId,
          onError: reportError,
        })
      }

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
            h('h2', { style: { margin: 0, fontSize: 17, fontWeight: 600 } }, APP_TITLE),
            h('p', { style: { margin: 0, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, '把 DSH 的配置、技能与会话数据备份到你自己的位置。')
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6 } },
            h(StateBadge, { state: lastRunState(status) }),
            status && status.version
              ? h(Badge, { tone: 'muted' }, 'v' + status.version)
              : null
          )
        ),
        error
          ? h(
              'div',
              {
                role: 'alert',
                style: {
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '8px 10px',
                  border: '1px solid var(--dsw-alias-state-error)',
                  borderRadius: 8,
                  color: 'var(--dsw-alias-state-error)',
                  fontSize: 12,
                  lineHeight: 1.5,
                },
              },
              h('span', { style: { flex: 1, minWidth: 0, wordBreak: 'break-word' } }, error.message),
              error.code
                ? h('span', { style: Object.assign({}, styles.mono, { opacity: 0.7 }) }, error.code)
                : null,
              h(
                'button',
                {
                  type: 'button',
                  onClick: () => setError(null),
                  'aria-label': '关闭错误提示',
                  style: {
                    border: 'none',
                    background: 'transparent',
                    color: 'inherit',
                    fontFamily: 'inherit',
                    fontSize: 14,
                    lineHeight: 1,
                    cursor: 'pointer',
                    padding: 0,
                  },
                },
                '×'
              )
            )
          : null,
        h(
          'div',
          { role: 'tablist', 'aria-label': '数据同步设置页', style: styles.tabs },
          tabs.map((item) =>
            h(
              'button',
              {
                key: item.id,
                type: 'button',
                role: 'tab',
                'aria-selected': tab === item.id ? 'true' : 'false',
                onClick: () => handleTab(item.id),
                style: {
                  padding: '5px 14px',
                  borderRadius: 6,
                  border: '1px solid',
                  borderColor:
                    tab === item.id ? 'var(--dsw-alias-border-l2)' : 'transparent',
                  background: tab === item.id ? 'var(--dsw-alias-bg-base)' : 'transparent',
                  color:
                    tab === item.id
                      ? 'var(--dsw-alias-label-primary)'
                      : 'var(--dsw-alias-label-secondary)',
                  fontFamily: 'inherit',
                  fontSize: 12,
                  fontWeight: tab === item.id ? 600 : 400,
                  cursor: 'pointer',
                },
              },
              item.label
            )
          )
        ),
        content
      )
    }

    // ---------------------------------------------------------------------
    // 插件入口
    // ---------------------------------------------------------------------

    function registerLocale(ctx) {
      if (!ctx || !ctx.locale || typeof ctx.locale.register !== 'function') return
      try {
        ctx.locale.register(NS, {
          zh: { title: APP_TITLE, 'tab.sync': '同步', 'tab.targets': '目标', 'tab.history': '历史' },
          en: { title: 'Data sync', 'tab.sync': 'Sync', 'tab.targets': 'Targets', 'tab.history': 'History' },
        })
      } catch (localeError) {
        // locale 服务是可选依赖；缺失或接口差异不能影响设置页渲染。
      }
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function' || typeof ctx.slots.register !== 'function') {
        return
      }
      registerLocale(ctx)

      try {
        if (typeof ctx.inject === 'function') {
          ctx.inject(['sessions', 'workspaces'], (scope) => {
            dshSessionMetaReader = () => {
              const map = new Map()
              try {
                const listSource = scope.sessions && scope.sessions.list
                const snapshot = listSource && typeof listSource.getSnapshot === 'function'
                  ? listSource.getSnapshot()
                  : null
                const ids = snapshot && Array.isArray(snapshot.ids) ? snapshot.ids : []
                const byId = snapshot && snapshot.byId ? snapshot.byId : {}
                for (const id of ids) {
                  const row = byId[id] || {}
                  map.set(id, {
                    name: typeof row.displayTitle === 'string' && row.displayTitle
                      ? row.displayTitle
                      : (typeof row.title === 'string' ? row.title : ''),
                    updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : null,
                    cwd: typeof row.cwd === 'string' ? row.cwd : '',
                    pinned: false,
                  })
                }
                const workspaceSource = scope.workspaces && scope.workspaces.list
                const workspace = workspaceSource && typeof workspaceSource.getSnapshot === 'function'
                  ? workspaceSource.getSnapshot()
                  : null
                for (const id of workspace && Array.isArray(workspace.pinnedSessionIds) ? workspace.pinnedSessionIds : []) {
                  const entry = map.get(id)
                  if (entry) entry.pinned = true
                }
              } catch (metaError) {
                // DSH session services are optional; keep whatever was readable.
              }
              return map
            }
          })
        }
      } catch (sessionInjectError) {
        // Older hosts without these client services still get the sessions tab.
      }

      const setup = () => {
        let stopped = false
        let sectionDisposer = null
        let sectionInjectDisposer = null
        let tabDisposer = null
        let tabInjectDisposer = null
        let sidebarDisposer = null
        let settingsButtonDisposer = null
        let rightTabDisposer = null
        let rightBodyDisposer = null
        let sectionSeen = false
        let timer = null

        const safeDispose = (disposer) => {
          if (typeof disposer !== 'function') return
          try {
            disposer()
          } catch (disposeError) {
            // 已被宿主回收的注册项再次释放时应保持安静。
          }
        }

        /** Top-level left-nav settings section: the preferred placement. */
        const registerSettingsSection = () => {
          if (stopped || sectionDisposer) return undefined
          try {
            sectionDisposer = ctx.slots.register(
              {
                name: 'settings.section',
                id: 'dsh-sync-hub',
                order: 60,
                label: () => APP_TITLE,
                locale: NS,
              },
              SettingsPage
            )
            sectionSeen = true
            if (tabDisposer) {
              safeDispose(tabDisposer)
              tabDisposer = null
            }
            if (timer) {
              clearTimeout(timer)
              timer = null
            }
            return sectionDisposer
          } catch (registerError) {
            console.error('[dsh-sync-hub] 无法注册设置页（settings.section）', registerError)
            return undefined
          }
        }

        /** Compatibility fallback: hosts without a top-level settings section. */
        const registerTabFallback = () => {
          if (stopped || tabDisposer) return
          try {
            tabDisposer = ctx.slots.register(
              {
                name: 'settings.plugins.tab',
                id: 'dsh-sync-hub',
                order: 60,
                label: () => APP_TITLE,
                locale: NS,
              },
              SettingsPage
            )
          } catch (registerError) {
            console.error('[dsh-sync-hub] 无法注册设置页（settings.plugins.tab）', registerError)
          }
        }

        try {
          sectionInjectDisposer = ctx.slots.inject('settings.section', registerSettingsSection)
        } catch (injectError) {
          // Older hosts may not declare the top-level settings section.
        }

        if (!sectionSeen) {
          timer = setTimeout(() => {
            timer = null
            if (stopped || sectionSeen) return
            try {
              tabInjectDisposer = ctx.slots.inject('settings.plugins.tab', registerTabFallback)
            } catch (tabInjectError) {
              registerTabFallback()
            }
          }, 1500)
        }

        // Optional sidebar footer widget is registered after the settings opener
        // below so the pending-decision button can navigate there.

        // Shortcut beside the other sidebar footer actions: open the settings
        // sheet on the data-sync section.
        const openSyncSettings = () => {
          try {
            const entries = typeof ctx.slots.entries === 'function'
              ? ctx.slots.entries('sidebar.settings')
              : []
            for (const entry of entries) {
              const store = entry && entry.store
                ? entry.store
                : (entry && entry.options ? entry.options.store : undefined)
              const instance = store && typeof store.create === 'function' ? store.create() : null
              if (instance && instance.actions && typeof instance.actions.openSection === 'function') {
                instance.actions.openSection('dsh-sync-hub')
                return
              }
              if (instance && instance.actions && typeof instance.actions.open === 'function') {
                instance.actions.open()
                return
              }
            }
          } catch (openError) {
            // Fall through to the shortcut fallback.
          }
          try {
            const shortcuts = typeof ctx.get === 'function' ? ctx.get('shortcuts') : undefined
            const rows = shortcuts && shortcuts.catalog && typeof shortcuts.catalog.getSnapshot === 'function'
              ? shortcuts.catalog.getSnapshot()
              : []
            const row = (Array.isArray(rows) ? rows : []).find((item) => item && item.id === 'settings.open')
            const binding = row && row.binding
            if (binding && typeof window !== 'undefined' && typeof KeyboardEvent === 'function') {
              const modifiers = new Set(Array.isArray(binding.modifiers) ? binding.modifiers : [])
              window.dispatchEvent(new KeyboardEvent('keydown', {
                code: binding.code,
                key: 'Unidentified',
                ctrlKey: modifiers.has('control'),
                altKey: modifiers.has('alt'),
                shiftKey: modifiers.has('shift'),
                metaKey: modifiers.has('meta'),
                bubbles: true,
                cancelable: true,
              }))
            }
          } catch (shortcutError) {
            // No settings entry point available on this host.
          }
        }

        /** Open the data-sync surface: right Sidebar page first, settings sheet second. */
        const openDataSync = () => {
          try {
            const sidebarRight = typeof ctx.get === 'function' ? ctx.get('sidebarRight') : undefined
            if (sidebarRight && typeof sidebarRight.openTab === 'function') {
              sidebarRight.openTab(RIGHT_TAB_KIND)
              return
            }
          } catch (openRightError) {
            // Fall back to the settings sheet below.
          }
          openSyncSettings()
        }

        /** Open the data-sync settings surface aimed at the sessions tab. */
        const openSessionsTab = () => {
          try {
            globalThis.__dshSyncHubInitialTab = 'sessions'
          } catch (globalError) {
            // Non-browser hosts have no global object.
          }
          openDataSync()
        }

        try {
          sidebarDisposer = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'dsh-sync-hub-progress',
              order: 10,
              label: () => '数据同步进度',
              inject: () => ({ openDataSync, openSessionsTab, openSettings: openSyncSettings }),
            },
            SidebarProgress
          ))
        } catch (sidebarError) {
          // The sidebar slot is optional; ignore hosts that do not declare it.
        }

        try {
          if (SHOW_SIDEBAR_SETTINGS_SHORTCUT) {
            settingsButtonDisposer = ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
              {
                name: 'sidebar.footer.action',
                id: 'dsh-sync-hub-open-settings',
                order: 11,
                label: () => '打开数据同步设置',
                inject: () => ({ open: openSyncSettings }),
              },
              SettingsShortcutButton
            ))
          }
        } catch (settingsButtonError) {
          // Older hosts may not declare the footer action slot.
        }

        // Right Sidebar tool: a page-type tab whose body is the same settings page.
        // Stage one declares the type (and its guide-page entry), stage two binds
        // the body under the definition id. The registry service may mount after
        // this plugin, so wait for it instead of a one-shot ctx.get().
        const registerRightSidebarTool = (scope) => {
          try {
            const sidebarRightTabs = scope.sidebarRightTabs
              ?? (typeof scope.get === 'function' ? scope.get('sidebarRightTabs') : undefined)
            if (!sidebarRightTabs || typeof sidebarRightTabs.register !== 'function') return
            const typeDisposer = sidebarRightTabs.register({
              id: RIGHT_TAB_ID,
              kind: RIGHT_TAB_KIND,
              title: () => APP_TITLE,
              guide: [
                {
                  id: RIGHT_TAB_ID,
                  order: 60,
                  title: () => APP_TITLE,
                  description: () => '备份与同步 DSH 数据',
                },
              ],
            })
            const bodyDisposer = scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
              { name: 'sidebar.right.pane.tab', key: RIGHT_TAB_ID },
              RightTabBody
            ))
            if (stopped) {
              safeDispose(bodyDisposer)
              safeDispose(typeDisposer)
              return
            }
            rightTabDisposer = typeDisposer
            rightBodyDisposer = bodyDisposer
          } catch (rightbarError) {
            // Hosts without the right Sidebar keep the settings tab working.
          }
        }
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['sidebarRightTabs'], registerRightSidebarTool)
          } else {
            registerRightSidebarTool(ctx)
          }
        } catch (rightbarInjectError) {
          // Older client runtimes may not expose ctx.inject().
        }

        return () => {
          stopped = true
          if (timer) clearTimeout(timer)
          safeDispose(sectionDisposer)
          sectionDisposer = null
          safeDispose(sectionInjectDisposer)
          sectionInjectDisposer = null
          safeDispose(tabDisposer)
          tabDisposer = null
          safeDispose(tabInjectDisposer)
          tabInjectDisposer = null
          safeDispose(sidebarDisposer)
          sidebarDisposer = null
          safeDispose(settingsButtonDisposer)
          settingsButtonDisposer = null
          safeDispose(rightBodyDisposer)
          rightBodyDisposer = null
          safeDispose(rightTabDisposer)
          rightTabDisposer = null
        }
      }

      if (typeof ctx.effect === 'function') {
        ctx.effect(setup, 'dsh-sync-hub: settings panel')
      } else {
        setup()
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
