import {
  host,
  useValue,
  useQuery,
  useMutation,
  useQueryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  PALETTE_AREA,
  Button,
  GlyphSpinner,
  Popover,
  PopoverContent,
  PopoverTrigger,
  haptic,
  cn,
  atom
} from '@hermes/plugin-sdk'
import { useState, useEffect } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const EMPTY_ATOM = atom(null)

function useHostState(name) {
  const candidate = host.state ? host.state[name] : null
  const store = candidate && typeof candidate.get === 'function' ? candidate : EMPTY_ATOM
  return useValue(store)
}

let pluginContext = null

const DISPLAY_KEY = 'display-prefs'
const DISPLAY_DEFAULT = {
  showToday: true,
  showWeek: false,
  showGrok: true,
  showCodex: true,
  showClaude: true,
  showJms: true,
  models: null,
  unitMode: 'auto',
  unitSystem: 'cn',
  unit: 'wan'
}

let prefsState = { ...DISPLAY_DEFAULT }
const prefsListeners = new Set()

function readDisplayPrefs() {
  const raw = pluginContext?.storage?.get(DISPLAY_KEY)
  return { ...DISPLAY_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) }
}

function hydratePrefs() {
  prefsState = readDisplayPrefs()
  prefsListeners.forEach(fn => fn(prefsState))
}

function useDisplayPrefs() {
  const [prefs, setPrefs] = useState(() => prefsState)
  useEffect(() => {
    prefsListeners.add(setPrefs)
    setPrefs(prefsState)
    return () => prefsListeners.delete(setPrefs)
  }, [])
  const save = next => {
    prefsState = next
    pluginContext?.storage?.set(DISPLAY_KEY, next)
    prefsListeners.forEach(fn => fn(next))
  }
  return [prefs, save]
}

function modelAllowed(name, prefs) {
  if (!prefs?.models || !prefs.models.length) return true
  return prefs.models.includes(name)
}

function Check({ checked, onChange, children }) {
  return jsxs('label', {
    className: 'inline-flex cursor-pointer items-center gap-1.5 text-[0.625rem]',
    children: [
      jsx('input', {
        type: 'checkbox',
        checked: Boolean(checked),
        onChange: event => onChange(event.target.checked)
      }),
      children
    ]
  })
}

function Seg({ value, options, onChange }) {
  return jsx('div', {
    className: 'inline-flex items-center rounded-md p-0.5',
    style: {
      background: 'var(--ui-bg-secondary)',
      border: '1px solid var(--ui-stroke-secondary)'
    },
    children: options.map(opt => jsx('button', {
      type: 'button',
      className: 'h-6 rounded px-2 text-[0.625rem] leading-none',
      style: value === opt.id
        ? { background: 'var(--ui-bg-elevated)', color: 'var(--ui-text-primary)', fontWeight: 600 }
        : { color: 'var(--ui-text-tertiary)' },
      onClick: () => onChange(opt.id),
      children: opt.label
    }, opt.id))
  })
}

function cycleKindLabel(kind) {
  if (kind === '5h') return '5小时窗'
  if (kind === '7d') return '官方周窗'
  if (kind === '30d') return '官方月窗'
  if (kind === 'due') return '已到重置'
  if (kind === 'calendar_week') return '自然周'
  return '重置窗'
}

const compact = new Intl.NumberFormat('zh-CN', {
  notation: 'compact',
  maximumFractionDigits: 1
})
const integer = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })

const TOKEN_SERIES = [
  { key: 'input_tokens', label: '输入', short: '入', color: 'var(--ui-accent)' },
  { key: 'output_tokens', label: '输出', short: '出', color: 'var(--ui-success)' },
  { key: 'cache_read_tokens', label: '缓存读', short: '缓', color: 'var(--ui-warning)' },
  { key: 'cache_write_tokens', label: '缓存写', short: '写', color: 'var(--ui-text-tertiary)' },
  { key: 'reasoning_tokens', label: '推理', short: '理', color: 'var(--ui-danger)' }
]

function fmtTokens(value) {
  return compact.format(Number(value || 0))
}

function fmtCount(value, prefs) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0'
  const options = prefs || readDisplayPrefs()
  const system = options.unitSystem === 'si' ? 'si' : 'cn'
  const scaled = (divisor, suffix) => {
    const value = n / divisor
    const digits = Math.abs(value) >= 100 ? 0 : 1
    return String(value.toFixed(digits)).replace(/\.0$/, '') + suffix
  }
  if (options.unitMode === 'manual') {
    if (system === 'si') {
      if (options.unit === 'b') return scaled(1_000_000_000, 'B')
      if (options.unit === 'm') return scaled(1_000_000, 'M')
      return scaled(1_000, 'K')
    }
    if (options.unit === 'yi') return scaled(100_000_000, '亿')
    return scaled(10_000, '万')
  }
  if (system === 'si') {
    if (n >= 1_000_000_000) return scaled(1_000_000_000, 'B')
    if (n >= 1_000_000) return scaled(1_000_000, 'M')
    if (n >= 1_000) return scaled(1_000, 'K')
    return integer.format(Math.round(n))
  }
  if (n >= 100_000_000) return scaled(100_000_000, '亿')
  if (n >= 10_000) return scaled(10_000, '万')
  return integer.format(Math.round(n))
}

function fmtInteger(value) {
  return integer.format(Number(value || 0))
}

function fmtPercent(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toFixed(Number(value) % 1 ? 1 : 0)}%`
}

function fmtTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function hoursUntilReset(resetAt) {
  if (!resetAt) return null
  const ms = new Date(resetAt).getTime() - Date.now()
  if (Number.isNaN(ms)) return null
  if (ms <= 0) return 0
  return Math.max(1, Math.round(ms / 3_600_000))
}

function fmtResetHours(resetAt) {
  const hours = hoursUntilReset(resetAt)
  if (hours === null) return ''
  return `/${hours}h`
}

function providerWindows(data) {
  if (data?.windows?.length) return data.windows
  if (data && data.used_percent !== undefined) {
    return [{
      label: '周额度',
      used_percent: data.used_percent,
      remaining_percent: data.remaining_percent,
      reset_at: data.reset_at
    }]
  }
  return []
}

function bindingWindow(data) {
  const windows = providerWindows(data).filter(window => (
    window.remaining_percent !== null
    && window.remaining_percent !== undefined
    && !Number.isNaN(Number(window.remaining_percent))
  ))
  if (!windows.length) return null
  return windows.slice().sort((a, b) => Number(a.remaining_percent) - Number(b.remaining_percent))[0]
}

function fmtResetCompact(resetAt) {
  const hours = hoursUntilReset(resetAt)
  if (hours === null) return ''
  if (hours <= 0) return '0h'
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  const rem = hours % 24
  return rem ? `${days}d${rem}h` : `${days}d`
}

function quotaSnapshot(name, data) {
  const cycleKnown = Boolean(data?.cycle)
  const cycleTokens = totalTokens(data?.cycle)
  const cycleKind = data?.cycle?.kind || ''
  if (!data || data.status === 'unavailable') {
    return { name, known: false, remaining: null, resetAt: null, label: '', hours: null, compact: '', cycleKnown, cycleTokens, cycleKind, title: `${name} 不可查询` }
  }
  const window = bindingWindow(data)
  if (!window) {
    return { name, known: false, remaining: null, resetAt: null, label: '', hours: null, compact: '', cycleKnown, cycleTokens, cycleKind, title: `${name} 不可查询` }
  }
  const remaining = Number(window.remaining_percent)
  const known = !Number.isNaN(remaining)
  const hours = hoursUntilReset(window.reset_at)
  const compact = fmtResetCompact(window.reset_at)
  const label = window.label || '额度'
  const hourText = hours === null ? '重置时间未知' : hours <= 0 ? '已到重置点' : `约 ${hours} 小时后重置`
  return {
    name,
    known,
    remaining: known ? remaining : null,
    resetAt: window.reset_at,
    label,
    hours,
    compact,
    cycleKnown,
    cycleTokens,
    cycleKind,
    title: `${name} ${known ? fmtPercent(remaining) : '—'} · 本周期 ${cycleKnown ? fmtInteger(cycleTokens) : '—'} · ${label} · ${hourText} · ${fmtTime(window.reset_at)}`
  }
}

function totalTokens(value) {
  if (!value) return 0
  const explicit = Number(value.total_tokens || 0)
  if (explicit) return explicit
  return TOKEN_SERIES.reduce((sum, series) => sum + Number(value[series.key] || 0), 0)
}

function exactTokenTitle(value) {
  const item = value || {}
  return TOKEN_SERIES
    .map(series => `${series.label} ${fmtInteger(item[series.key])}`)
    .join(' · ')
}

function statusTone(status) {
  if (status === 'available') return 'var(--ui-accent)'
  if (status === 'stale') return 'var(--ui-text-secondary)'
  return 'var(--ui-text-quaternary)'
}

function StatusPill({ status, children, compact: dense = false }) {
  return jsxs('span', {
    className: `inline-flex min-w-0 items-center gap-1.5 rounded-full border ${dense ? 'px-1.5 py-0 text-[0.625rem]' : 'px-2 py-0.5 text-[0.6875rem]'}`,
    style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-secondary)' },
    children: [
      jsx('span', {
        className: 'h-1.5 w-1.5 shrink-0 rounded-full',
        style: { background: statusTone(status) }
      }),
      jsx('span', { className: 'truncate', children })
    ]
  })
}

function Panel({ children, className = '', title }) {
  return jsx('div', {
    className: `min-h-0 rounded-lg border ${className}`,
    title,
    style: { borderColor: 'var(--ui-stroke-secondary)' },
    children
  })
}

function TokenStack({ value, className = 'h-1.5' }) {
  const item = value || {}
  const total = Math.max(0, totalTokens(item))
  return jsx('div', {
    className: `${className} flex w-full overflow-hidden rounded-full`,
    style: { background: 'var(--ui-stroke-secondary)' },
    title: exactTokenTitle(item),
    role: 'img',
    'aria-label': exactTokenTitle(item),
    children: total > 0
      ? TOKEN_SERIES
          .filter(series => Number(item[series.key] || 0) > 0)
          .map(series =>
            jsx('span', {
              className: 'h-full',
              style: {
                width: `${Number(item[series.key] || 0) / total * 100}%`,
                background: series.color
              }
            }, series.key)
          )
      : null
  })
}

function TokenLegend() {
  return jsx('div', {
    className: 'flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[0.5625rem]',
    style: { color: 'var(--ui-text-quaternary)' },
    children: TOKEN_SERIES.map(series =>
      jsxs('span', {
        className: 'inline-flex items-center gap-1',
        children: [
          jsx('span', { className: 'h-1.5 w-1.5 rounded-sm', style: { background: series.color } }),
          series.label
        ]
      }, series.key)
    )
  })
}

function PeriodTile({ title, value, mode = 'natural' }) {
  const item = value || {}
  const cost = Number(item.actual_cost_usd || 0) > 0
    ? `$${Number(item.actual_cost_usd).toFixed(2)}`
    : Number(item.estimated_cost_usd || 0) > 0
      ? `≈$${Number(item.estimated_cost_usd).toFixed(2)}`
      : null
  return jsx(Panel, {
    className: 'px-2.5 py-2',
    title: `${title} · ${exactTokenTitle(item)}`,
    children: jsxs('div', {
      className: 'flex h-full min-w-0 flex-col justify-between gap-1.5',
      children: [
        jsxs('div', {
          className: 'flex min-w-0 items-baseline justify-between gap-1',
          children: [
            jsx('span', {
              className: 'truncate text-[0.6875rem] font-medium',
              style: { color: mode === 'natural' ? 'var(--ui-text-primary)' : 'var(--ui-text-tertiary)' },
              children: title
            }),
            cost
              ? jsx('span', {
                  className: 'shrink-0 text-[0.5625rem] tabular-nums',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: cost
                })
              : null
          ]
        }),
        jsx('div', {
          className: 'truncate text-lg font-semibold leading-none tabular-nums',
          children: fmtCount(item.total_tokens)
        }),
        jsx(TokenStack, { value: item }),
        jsxs('div', {
          className: 'flex items-center justify-between gap-1 text-[0.5625rem] tabular-nums',
          style: { color: 'var(--ui-text-quaternary)' },
          children: [
            jsx('span', { children: `调用 ${fmtInteger(item.api_calls)}` }),
            jsx('span', { children: `会话 ${fmtInteger(item.sessions)}` })
          ]
        })
      ]
    })
  })
}

function modelCycleRows(cycleMap) {
  return Object.entries(cycleMap || {})
    .map(([name, cycle]) => ({
      name,
      tokens: totalTokens(cycle),
      kind: cycle?.kind || '',
      label: cycle?.label || '额度',
      resetAt: cycle?.reset_at,
      start: cycle?.start
    }))
    .sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name))
}

function PeriodRibbon({ periods, rolling }) {
  const items = [
    { title: '今日', value: periods?.today, mode: 'natural' },
    { title: '本周', value: periods?.week, mode: 'natural' },
    { title: '本月', value: periods?.month, mode: 'natural' },
    { title: '近7天', value: rolling?.['7d'], mode: 'rolling' },
    { title: '近30天', value: rolling?.['30d'], mode: 'rolling' },
    { title: '近90天', value: rolling?.['90d'], mode: 'rolling' }
  ]
  return jsx('div', {
    className: 'grid min-h-0 gap-2',
    style: { gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' },
    children: items.map(item => jsx(PeriodTile, item, item.title))
  })
}

function quotaTone(remaining) {
  const value = Number(remaining)
  if (Number.isNaN(value)) return 'var(--ui-text-quaternary)'
  if (value <= 10) return 'var(--ui-text-primary)'
  if (value <= 25) return 'var(--ui-text-secondary)'
  return 'var(--ui-accent)'
}

function QuotaGauge({ remaining, label, resetAt }) {
  const known = remaining !== null && remaining !== undefined && !Number.isNaN(Number(remaining))
  const value = known ? Math.max(0, Math.min(100, Number(remaining))) : 0
  const tone = quotaTone(known ? value : null)
  return jsxs('div', {
    className: 'flex min-w-0 items-center gap-2',
    title: `${label || '额度'} · 剩余 ${known ? fmtPercent(value) : '不可查询'} · 重置 ${fmtTime(resetAt)}`,
    children: [
      jsxs('svg', {
        className: 'h-14 w-14 shrink-0',
        viewBox: '0 0 64 64',
        role: 'img',
        'aria-label': `${label || '额度'}剩余${known ? fmtPercent(value) : '不可查询'}`,
        children: [
          jsx('circle', {
            cx: 32,
            cy: 32,
            r: 25,
            fill: 'none',
            stroke: 'var(--ui-stroke-secondary)',
            strokeWidth: 6
          }),
          jsx('circle', {
            cx: 32,
            cy: 32,
            r: 25,
            fill: 'none',
            stroke: tone,
            strokeWidth: 6,
            strokeLinecap: 'round',
            pathLength: 100,
            strokeDasharray: `${value} 100`,
            transform: 'rotate(-90 32 32)'
          }),
          jsx('text', {
            x: 32,
            y: 35,
            textAnchor: 'middle',
            fontSize: 12,
            fontWeight: 700,
            fill: 'currentColor',
            children: known ? fmtPercent(value) : '—'
          })
        ]
      }),
      jsxs('div', {
        className: 'min-w-0',
        children: [
          jsx('div', { className: 'truncate text-[0.6875rem] font-medium', children: label || '额度' }),
          jsx('div', {
            className: 'mt-0.5 truncate text-[0.5625rem] tabular-nums',
            style: { color: 'var(--ui-text-quaternary)' },
            children: resetAt ? `${fmtResetHours(resetAt)} · ${fmtTime(resetAt)}` : '重置 —'
          })
        ]
      })
    ]
  })
}

function ProviderPanel({ title, data, onRefresh, refreshing }) {
  const status = data?.status || 'unavailable'
  const windows = data?.windows?.length
    ? data.windows
    : data && data.used_percent !== undefined
      ? [{
          label: '周额度',
          used_percent: data.used_percent,
          remaining_percent: data.remaining_percent,
          reset_at: data.reset_at
        }]
      : []
  return jsx(Panel, {
    className: 'h-full px-2.5 py-2',
    title: data?.reason || `${title} · ${data?.source || '官方账户'}`,
    children: jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className: 'flex items-center justify-between gap-2',
          children: [
            jsxs('div', {
              className: 'flex min-w-0 items-center gap-1.5',
              children: [
                jsx('h3', { className: 'truncate text-xs font-semibold', children: title }),
                data?.plan
                  ? jsx('span', {
                      className: 'truncate text-[0.5625rem]',
                      style: { color: 'var(--ui-text-quaternary)' },
                      children: data.plan
                    })
                  : null,
                jsx(StatusPill, {
                  status,
                  compact: true,
                  children: status === 'available' ? '实时' : status === 'stale' ? '过期' : '不可查'
                })
              ]
            }),
            jsx(Button, {
              size: 'sm',
              variant: 'secondary',
              disabled: refreshing,
              onClick: onRefresh,
              title: `刷新${title}额度`,
              children: refreshing ? '…' : '↻'
            })
          ]
        }),
        windows.length
          ? jsx('div', {
              className: 'mt-1.5 grid min-h-0 flex-1 items-center gap-1.5',
              style: { gridTemplateColumns: `repeat(${Math.min(3, windows.length)}, minmax(0, 1fr))` },
              children: windows.slice(0, 3).map((window, index) =>
                jsx(QuotaGauge, {
                  remaining: window.remaining_percent,
                  label: window.label || '额度',
                  resetAt: window.reset_at
                }, `${window.label || 'quota'}-${index}`)
              )
            })
          : jsx('div', {
              className: 'flex flex-1 items-center justify-center text-[0.6875rem]',
              style: { color: 'var(--ui-text-tertiary)' },
              children: '—'
            }),
        jsx('div', {
          className: 'mt-1 truncate text-[0.5rem]',
          style: { color: 'var(--ui-text-quaternary)' },
          children: data?.fetched_at ? `采样 ${fmtTime(data.fetched_at)}` : data?.source || data?.reason || '未采样'
        })
      ]
    })
  })
}

function dateKey(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function fillDaily(rows, count = 30) {
  const map = new Map((rows || []).map(row => [String(row.date), row]))
  const result = []
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const key = dateKey(date)
    result.push(map.get(key) || { date: key, total_tokens: 0, api_calls: 0 })
  }
  return result
}

function DailyTrend({ rows, summary }) {
  const data = fillDaily(rows, 30)
  const max = Math.max(1, ...data.map(row => totalTokens(row)))
  return jsx(Panel, {
    className: 'flex h-full min-h-0 flex-col px-3 py-2.5',
    children: jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className: 'flex items-start justify-between gap-3',
          children: [
            jsxs('div', {
              className: 'min-w-0',
              children: [
                jsx('h3', { className: 'text-xs font-semibold', children: '30天 Token 趋势' }),
                jsxs('div', {
                  className: 'mt-0.5 flex items-baseline gap-2',
                  children: [
                    jsx('b', { className: 'text-base tabular-nums', children: fmtTokens(summary?.total_tokens) }),
                    jsx('span', {
                      className: 'text-[0.5625rem] tabular-nums',
                      style: { color: 'var(--ui-text-quaternary)' },
                      children: `${fmtInteger(summary?.api_calls)} 调用`
                    })
                  ]
                })
              ]
            }),
            jsx(TokenLegend, {})
          ]
        }),
        jsxs('div', {
          className: 'mt-2 grid min-h-0 flex-1 gap-x-1',
          style: {
            gridTemplateColumns: '3.75rem minmax(0, 1fr)',
            gridTemplateRows: 'minmax(0, 1fr) 0.625rem'
          },
          children: [
            jsxs('div', {
              className: 'relative min-h-0 pr-1 text-right text-[0.4375rem] leading-none tabular-nums whitespace-nowrap',
              style: { color: 'var(--ui-text-quaternary)' },
              children: [
                jsx('span', { className: 'absolute right-1 top-0', children: fmtTokens(max) }),
                jsx('span', {
                  className: 'absolute right-1 top-1/2',
                  style: { transform: 'translateY(-50%)' },
                  children: fmtTokens(max / 2)
                }),
                jsx('span', { className: 'absolute bottom-0 right-1', children: '0' })
              ]
            }),
            jsxs('div', {
              className: 'relative flex min-h-0 items-end gap-px',
              children: [
                jsx('span', {
                  className: 'pointer-events-none absolute inset-x-0 top-0',
                  style: { borderTop: '1px solid var(--ui-stroke-secondary)' }
                }),
                jsx('span', {
                  className: 'pointer-events-none absolute inset-x-0 top-1/2',
                  style: { borderTop: '1px solid var(--ui-stroke-secondary)' }
                }),
                jsx('span', {
                  className: 'pointer-events-none absolute inset-x-0 bottom-0',
                  style: { borderTop: '1px solid var(--ui-stroke-secondary)' }
                }),
                ...data.map(row => {
                  const total = totalTokens(row)
                  const height = total > 0 ? Math.max(3, total / max * 100) : 0
                  return jsx('div', {
                    className: 'group relative flex h-full min-w-0 flex-1 items-end',
                    style: { zIndex: 1 },
                    title: `${row.date} · ${fmtInteger(total)} Token · ${fmtInteger(row.api_calls)} 调用 · ${exactTokenTitle(row)}`,
                    children: jsx('div', {
                      className: 'flex w-full flex-col-reverse overflow-hidden rounded-t-sm',
                      style: {
                        height: `${height}%`,
                        minHeight: total > 0 ? '3px' : '0',
                        background: 'var(--ui-stroke-secondary)'
                      },
                      children: total > 0
                        ? TOKEN_SERIES
                            .filter(series => Number(row[series.key] || 0) > 0)
                            .map(series =>
                              jsx('span', {
                                className: 'w-full',
                                style: {
                                  height: `${Number(row[series.key] || 0) / total * 100}%`,
                                  background: series.color
                                }
                              }, series.key)
                            )
                        : null
                    })
                  }, row.date)
                })
              ]
            }),
            jsx('span', {}),
            jsx('div', {
              className: 'flex min-w-0 gap-px',
              children: data.map((row, index) =>
                jsx('span', {
                  className: 'min-w-0 flex-1 text-center text-[0.4375rem] leading-[0.625rem]',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: index % 5 === 4 || index === data.length - 1 ? row.date.slice(8) : ''
                }, row.date)
              )
            })
          ]
        })
      ]
    })
  })
}

function DistributionPanel({ rows, title }) {
  const data = (rows || []).slice(0, 5)
  const max = Math.max(1, ...data.map(row => Number(row.total_tokens || 0)))
  return jsx(Panel, {
    className: 'flex h-full min-h-0 flex-col px-2.5 py-2',
    children: jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className: 'flex items-baseline justify-between gap-2',
          children: [
            jsx('h3', { className: 'text-xs font-semibold', children: title }),
            jsx('span', {
              className: 'text-[0.5rem]',
              style: { color: 'var(--ui-text-quaternary)' },
              children: '近90天'
            })
          ]
        }),
        data.length
          ? jsx('div', {
              className: 'mt-2 grid min-h-0 flex-1 gap-1.5',
              style: { gridTemplateRows: `repeat(${data.length}, minmax(0, 1fr))` },
              children: data.map((row, index) =>
                jsxs('div', {
                  className: 'flex min-h-0 flex-col justify-center',
                  title: `${row.name} · ${fmtInteger(row.total_tokens)} Token · ${fmtInteger(row.api_calls)} 调用`,
                  children: [
                    jsxs('div', {
                      className: 'flex min-w-0 items-center justify-between gap-2 text-[0.625rem]',
                      children: [
                        jsx('span', { className: 'truncate', children: row.name }),
                        jsx('span', { className: 'shrink-0 tabular-nums', children: fmtTokens(row.total_tokens) })
                      ]
                    }),
                    jsx('div', {
                      className: 'mt-0.5 h-1 overflow-hidden rounded-full',
                      style: { background: 'var(--ui-stroke-secondary)' },
                      children: jsx('div', {
                        className: 'h-full rounded-full',
                        style: {
                          width: `${Number(row.total_tokens || 0) / max * 100}%`,
                          background: 'var(--ui-accent)',
                          opacity: Math.max(0.35, 0.95 - index * 0.13)
                        }
                      })
                    })
                  ]
                }, row.name)
              )
            })
          : jsx('div', {
              className: 'flex flex-1 items-center justify-center text-xs',
              style: { color: 'var(--ui-text-quaternary)' },
              children: '—'
            })
      ]
    })
  })
}

function ModelCyclePanel({ cycleMap, activeModel, prefs = DISPLAY_DEFAULT }) {
  const rows = modelCycleRows(cycleMap).filter(row => modelAllowed(row.name, prefs))
  return jsx(Panel, {
    className: 'flex h-full min-h-0 flex-col px-2.5 py-2',
    children: jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className: 'flex items-baseline justify-between gap-2',
          children: [
            jsx('h3', { className: 'text-xs font-semibold', children: '本周期 Token' }),
            jsx('span', {
              className: 'text-[0.5rem]',
              style: { color: 'var(--ui-text-quaternary)' },
              children: '官方重置窗内已用 · 与底栏%同一口径'
            })
          ]
        }),
        rows.length
          ? jsxs('div', {
              className: 'mt-1.5 min-h-0 flex-1 overflow-auto',
              children: [
                jsxs('div', {
                  className: 'grid gap-2 pb-1 text-[0.5rem]',
                  style: {
                    gridTemplateColumns: 'minmax(0, 1.5fr) minmax(4.8rem, 0.9fr) minmax(4.2rem, 0.7fr) minmax(5.2rem, 0.8fr)',
                    color: 'var(--ui-text-quaternary)'
                  },
                  children: [
                    jsx('span', { children: '模型' }),
                    jsx('span', { className: 'text-right', children: '本周期已用' }),
                    jsx('span', { className: 'text-right', children: '窗口' }),
                    jsx('span', { className: 'text-right', children: '重置' })
                  ]
                }),
                rows.map(row => {
                  const on = activeModel && row.name === activeModel
                  return jsxs('div', {
                    className: 'grid items-center gap-2 border-t py-1 text-[0.625rem]',
                    style: {
                      gridTemplateColumns: 'minmax(0, 1.5fr) minmax(4.8rem, 0.9fr) minmax(4.2rem, 0.7fr) minmax(5.2rem, 0.8fr)',
                      borderColor: 'var(--ui-stroke-secondary)',
                      color: on ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)'
                    },
                    title: `${row.name} · ${fmtInteger(row.tokens)} · ${cycleKindLabel(row.kind)} · ${fmtTime(row.resetAt)}`,
                    children: [
                      jsx('span', { className: 'truncate font-medium', children: row.name }),
                      jsx('span', { className: 'text-right font-semibold tabular-nums', children: fmtCount(row.tokens, prefs) }),
                      jsx('span', { className: 'text-right text-[0.5625rem]', children: cycleKindLabel(row.kind) }),
                      jsx('span', { className: 'text-right tabular-nums text-[0.5625rem]', children: fmtResetCompact(row.resetAt) || '—' })
                    ]
                  }, row.name)
                })
              ]
            })
          : jsx('div', {
              className: 'flex flex-1 items-center justify-center text-xs',
              style: { color: 'var(--ui-text-quaternary)' },
              children: '还没有官方窗内的本地 Token'
            })
      ]
    })
  })
}

function DisplayPrefsPanel({ prefs, onChange, modelNames }) {
  const names = modelNames.length ? modelNames : []
  const selected = prefs.models
  const allOn = !selected || !selected.length
  const toggleFlag = key => onChange({ ...prefs, [key]: !prefs[key] })
  const toggleModel = name => {
    const current = allOn ? names : selected.slice()
    const next = current.includes(name)
      ? current.filter(item => item !== name)
      : current.concat(name)
    onChange({ ...prefs, models: next.length === names.length ? null : next })
  }
  return jsx(Panel, {
    className: 'px-2.5 py-2',
    children: jsxs('div', {
      className: 'flex flex-col gap-2',
      children: [
        jsxs('div', {
          className: 'flex items-baseline justify-between gap-2',
          children: [
            jsx('h3', { className: 'text-xs font-semibold', children: '显示设置' }),
            jsx('span', {
              className: 'text-[0.5rem]',
              style: { color: 'var(--ui-text-quaternary)' },
              children: '改完立刻作用于本页和右下角'
            })
          ]
        }),
        jsxs('div', {
          className: 'flex flex-wrap items-center gap-x-3 gap-y-1',
          children: [
            jsx('span', { className: 'w-10 shrink-0 text-[0.5625rem]', style: { color: 'var(--ui-text-quaternary)' }, children: '状态条' }),
            jsx(Check, { checked: prefs.showToday, onChange: () => toggleFlag('showToday'), children: '今日' }),
            jsx(Check, { checked: prefs.showWeek, onChange: () => toggleFlag('showWeek'), children: '自然周' }),
            jsx(Check, { checked: prefs.showGrok, onChange: () => toggleFlag('showGrok'), children: 'Grok' }),
            jsx(Check, { checked: prefs.showCodex, onChange: () => toggleFlag('showCodex'), children: 'Codex' }),
            jsx(Check, { checked: prefs.showClaude, onChange: () => toggleFlag('showClaude'), children: 'Claude' }),
            jsx(Check, { checked: prefs.showJms, onChange: () => toggleFlag('showJms'), children: 'VPN' })
          ]
        }),
        jsxs('div', {
          className: 'flex flex-wrap items-center gap-x-3 gap-y-1',
          children: [
            jsx('span', { className: 'w-10 shrink-0 text-[0.5625rem]', style: { color: 'var(--ui-text-quaternary)' }, children: '模型' }),
            jsx(Check, {
              checked: allOn,
              onChange: checked => onChange({ ...prefs, models: checked ? null : names.slice() }),
              children: '全部'
            }),
            ...names.map(name => jsx(Check, {
              checked: allOn || selected.includes(name),
              onChange: () => toggleModel(name),
              children: name
            }, name))
          ]
        }),
        jsxs('div', {
          className: 'flex flex-wrap items-center gap-x-3 gap-y-1',
          children: [
            jsx('span', { className: 'w-10 shrink-0 text-[0.5625rem]', style: { color: 'var(--ui-text-quaternary)' }, children: '单位' }),
            jsx(Seg, {
              value: prefs.unitMode === 'manual' ? 'manual' : 'auto',
              onChange: id => onChange({ ...prefs, unitMode: id }),
              options: [{ id: 'auto', label: '自动' }, { id: 'manual', label: '手动' }]
            }),
            jsx(Seg, {
              value: prefs.unitSystem === 'si' ? 'si' : 'cn',
              onChange: id => onChange({
                ...prefs,
                unitSystem: id,
                unit: id === 'si' ? (['k', 'm', 'b'].includes(prefs.unit) ? prefs.unit : 'k') : (prefs.unit === 'yi' ? 'yi' : 'wan')
              }),
              options: [{ id: 'cn', label: '万/亿' }, { id: 'si', label: 'K/M/B' }]
            }),
            prefs.unitMode === 'manual' && prefs.unitSystem !== 'si'
              ? jsx(Seg, {
                  value: prefs.unit === 'yi' ? 'yi' : 'wan',
                  onChange: id => onChange({ ...prefs, unit: id }),
                  options: [{ id: 'wan', label: '万' }, { id: 'yi', label: '亿' }]
                })
              : null,
            prefs.unitMode === 'manual' && prefs.unitSystem === 'si'
              ? jsx(Seg, {
                  value: ['k', 'm', 'b'].includes(prefs.unit) ? prefs.unit : 'k',
                  onChange: id => onChange({ ...prefs, unit: id }),
                  options: [{ id: 'k', label: 'K' }, { id: 'm', label: 'M' }, { id: 'b', label: 'B' }]
                })
              : null
          ]
        })
      ]
    })
  })
}


function fmtGB(bytes) {
  const gb = Number(bytes || 0) / 1_000_000_000
  if (!Number.isFinite(gb)) return '—'
  const places = Math.abs(gb) >= 100 ? 1 : 2
  return `${gb.toFixed(places)} GB`
}

function fillJmsDaily(rows, count = 30) {
  const map = new Map((rows || []).map(row => [String(row.date), row]))
  const result = []
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today)
    date.setDate(today.getDate() - offset)
    const key = dateKey(date)
    result.push(map.get(key) || { date: key, used_b: 0 })
  }
  return result
}

function jmsQueryKey(profile) {
  return ['usage-center', 'jms', profile || 'default']
}

function useJms(interval = 60000) {
  const profile = useHostState('profile')
  return useQuery({
    queryKey: jmsQueryKey(profile),
    queryFn: () => pluginContext.rest('/jms'),
    placeholderData: () => undefined,
    refetchInterval: interval,
    staleTime: 10000,
    retry: 1
  })
}

function JmsConfigForm({ compact = false }) {
  const queryClient = useQueryClient()
  const profile = useHostState('profile')
  const [url, setUrl] = useState('')
  const save = useMutation({
    mutationFn: () => pluginContext.rest('/jms/config', { method: 'POST', body: { url } }),
    onSuccess: () => {
      setUrl('')
      queryClient.invalidateQueries({ queryKey: jmsQueryKey(profile) })
    }
  })
  return jsxs('form', {
    className: compact ? 'flex min-w-0 flex-col gap-2' : 'flex min-w-0 flex-col gap-3',
    onSubmit: event => {
      event.preventDefault()
      if (url.trim()) save.mutate()
    },
    children: [
      jsx('textarea', {
        className: 'min-h-16 w-full resize-y rounded-md px-2.5 py-2 text-[0.75rem]',
        style: {
          background: 'var(--ui-bg-secondary)',
          border: '1px solid var(--ui-stroke-secondary)',
          color: 'var(--ui-text-primary)'
        },
        placeholder: '粘贴 getbwcounter / getsub 链接，或 service=…&id=…',
        value: url,
        onChange: event => setUrl(event.target.value)
      }),
      jsxs('div', {
        className: 'flex items-center gap-2',
        children: [
          jsx(Button, {
            type: 'submit',
            size: 'sm',
            disabled: save.isPending || !url.trim(),
            children: save.isPending ? '保存中…' : '保存并采样'
          }),
          save.isError
            ? jsx('span', {
                className: 'text-[0.625rem]',
                style: { color: 'var(--ui-danger)' },
                children: save.error?.message || '保存失败'
              })
            : null
        ]
      })
    ]
  })
}

function JmsStat({ title, value, hint }) {
  return jsx(Panel, {
    className: 'px-2.5 py-2',
    title: hint || title,
    children: jsxs('div', {
      className: 'flex h-full min-w-0 flex-col justify-between gap-1.5',
      children: [
        jsx('span', {
          className: 'truncate text-[0.6875rem] font-medium',
          children: title
        }),
        jsx('div', {
          className: 'truncate text-lg font-semibold leading-none tabular-nums',
          children: value
        }),
        hint
          ? jsx('div', {
              className: 'truncate text-[0.5625rem]',
              style: { color: 'var(--ui-text-quaternary)' },
              children: hint
            })
          : null
      ]
    })
  })
}

function JmsDailyTrend({ rows }) {
  const data = fillJmsDaily(rows, 30)
  const max = Math.max(1, ...data.map(row => Number(row.used_b || 0)))
  return jsx(Panel, {
    className: 'flex h-full min-h-0 flex-col px-3 py-2.5',
    children: jsxs('div', {
      className: 'flex h-full min-h-0 flex-col',
      children: [
        jsxs('div', {
          className: 'flex items-start justify-between gap-3',
          children: [
            jsxs('div', {
              className: 'min-w-0',
              children: [
                jsx('h3', { className: 'text-xs font-semibold', children: '30天流量' }),
                jsx('div', {
                  className: 'mt-0.5 text-[0.5625rem]',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: '本地采样差值 · 官方接口只有本周期总量'
                })
              ]
            }),
            jsx('span', {
              className: 'text-[0.5625rem] tabular-nums',
              style: { color: 'var(--ui-text-quaternary)' },
              children: `峰值 ${fmtGB(max)}`
            })
          ]
        }),
        jsxs('div', {
          className: 'mt-2 grid min-h-0 flex-1 gap-x-1',
          style: {
            gridTemplateColumns: '3.75rem minmax(0, 1fr)',
            gridTemplateRows: 'minmax(0, 1fr) 0.625rem'
          },
          children: [
            jsxs('div', {
              className: 'relative min-h-0 pr-1 text-right text-[0.4375rem] leading-none tabular-nums whitespace-nowrap',
              style: { color: 'var(--ui-text-quaternary)' },
              children: [
                jsx('span', { className: 'absolute right-1 top-0', children: fmtGB(max) }),
                jsx('span', {
                  className: 'absolute right-1 top-1/2',
                  style: { transform: 'translateY(-50%)' },
                  children: fmtGB(max / 2)
                }),
                jsx('span', { className: 'absolute bottom-0 right-1', children: '0' })
              ]
            }),
            jsxs('div', {
              className: 'relative flex min-h-0 items-end gap-px',
              children: [
                jsx('span', {
                  className: 'pointer-events-none absolute inset-x-0 top-0',
                  style: { borderTop: '1px solid var(--ui-stroke-secondary)' }
                }),
                jsx('span', {
                  className: 'pointer-events-none absolute inset-x-0 top-1/2',
                  style: { borderTop: '1px solid var(--ui-stroke-secondary)' }
                }),
                ...data.map(row => {
                  const total = Number(row.used_b || 0)
                  const height = total > 0 ? Math.max(3, total / max * 100) : 0
                  return jsx('div', {
                    className: 'group relative flex h-full min-w-0 flex-1 items-end',
                    title: `${row.date} · ${fmtGB(total)}`,
                    children: jsx('div', {
                      className: 'w-full rounded-t-sm',
                      style: {
                        height: `${height}%`,
                        minHeight: total > 0 ? '3px' : '0',
                        background: 'var(--ui-accent)'
                      }
                    })
                  }, row.date)
                })
              ]
            }),
            jsx('span', {}),
            jsx('div', {
              className: 'flex min-w-0 gap-px',
              children: data.map((row, index) =>
                jsx('span', {
                  className: 'min-w-0 flex-1 text-center text-[0.4375rem] leading-[0.625rem]',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: index % 5 === 4 || index === data.length - 1 ? row.date.slice(8) : ''
                }, row.date)
              )
            })
          ]
        })
      ]
    })
  })
}

function JmsPage() {
  const queryClient = useQueryClient()
  const profile = useHostState('profile')
  const query = useJms(30000)
  const refresh = useMutation({
    mutationFn: () => pluginContext.rest('/jms/refresh', { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: jmsQueryKey(profile) })
  })
  const forget = useMutation({
    mutationFn: () => pluginContext.rest('/jms/config', { method: 'DELETE' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: jmsQueryKey(profile) })
  })
  if (query.isLoading && !query.data) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center gap-2 text-xs',
      style: { color: 'var(--ui-text-tertiary)' },
      children: [jsx(GlyphSpinner, {}), '正在读取 VPN 流量…']
    })
  }
  const data = query.data
  if (query.isError && !data) {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
      children: [
        jsx('div', { className: 'text-sm font-semibold', children: 'VPN 流量后端不可用' }),
        jsx('div', {
          className: 'max-w-md text-[0.75rem]',
          style: { color: 'var(--ui-text-tertiary)' },
          children: '需要重挂 Usage Center 后端后才会出现 /jms 接口。'
        }),
        jsx(Button, { onClick: () => query.refetch(), children: '重试' })
      ]
    })
  }
  const usage = data?.usage
  const status = data?.status || 'unavailable'
  const daily = [...(usage?.daily || [])].slice().reverse()
  return jsx('div', {
    className: 'h-full min-h-0 overflow-auto',
    children: jsxs('div', {
      className: 'mx-auto flex min-h-full max-w-[1600px] flex-col gap-2.5 p-3',
      children: [
        jsxs('header', {
          className: 'flex min-w-0 items-center justify-between gap-3',
          children: [
            jsxs('div', {
              className: 'flex min-w-0 items-center gap-2',
              children: [
                jsx('h1', { className: 'shrink-0 text-base font-semibold', children: 'VPN 流量' }),
                jsx(StatusPill, {
                  status: status === 'available' ? 'available' : status === 'stale' ? 'stale' : 'unavailable',
                  compact: true,
                  children: status === 'available' ? '实时' : status === 'stale' ? '过期' : status === 'unconfigured' ? '未配置' : '不可查'
                }),
                data?.config?.configured
                  ? jsx('span', {
                      className: 'truncate text-[0.625rem]',
                      style: { color: 'var(--ui-text-tertiary)' },
                      children: `JMS #${data.config.service} · ${data.config.id_masked}`
                    })
                  : null
              ]
            }),
            jsxs('div', {
              className: 'flex shrink-0 items-center gap-2',
              children: [
                jsx('span', {
                  className: 'hidden text-[0.5625rem] tabular-nums sm:inline',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: fmtTime(data?.sampled_at || data?.generated_at)
                }),
                jsx(Button, {
                  size: 'sm',
                  variant: 'secondary',
                  onClick: () => host.navigate('/usage-center'),
                  children: '模型用量'
                }),
                jsx(Button, {
                  size: 'sm',
                  variant: 'secondary',
                  disabled: refresh.isPending || status === 'unconfigured',
                  onClick: () => refresh.mutate(),
                  children: refresh.isPending ? '…' : '↻'
                })
              ]
            })
          ]
        }),
        status === 'unconfigured'
          ? jsx(Panel, {
              className: 'px-3 py-3',
              children: jsxs('div', {
                className: 'flex max-w-xl flex-col gap-2',
                children: [
                  jsx('h3', { className: 'text-xs font-semibold', children: '接入 Just My Socks' }),
                  jsx('p', {
                    className: 'text-[0.6875rem]',
                    style: { color: 'var(--ui-text-tertiary)' },
                    children: '不需要邮箱密码。会员页底部的 Bandwidth counter API，或应用订阅链接即可。密钥只存在本机 usage-center/jms.json。'
                  }),
                  jsx(JmsConfigForm, {})
                ]
              })
            })
          : null,
        usage
          ? jsxs('div', {
              className: 'grid min-h-0 gap-2',
              style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
              children: [
                jsx(JmsStat, {
                  title: '本周期已用',
                  value: fmtGB(usage.used_b),
                  hint: `${fmtPercent(usage.used_percent)} · ${fmtInteger(usage.used_b)} B`
                }),
                jsx(JmsStat, {
                  title: '剩余',
                  value: fmtGB(usage.remaining_b),
                  hint: `${fmtPercent(usage.remaining_percent)} · 重置 ${fmtTime(usage.reset_at)}`
                }),
                jsx(JmsStat, {
                  title: '套餐',
                  value: fmtGB(usage.limit_b),
                  hint: `每月洛杉矶时间 ${usage.reset_day} 日 0 点重置`
                })
              ]
            })
          : null,
        usage
          ? jsxs('div', {
              className: 'grid min-h-0 gap-2',
              style: { gridTemplateColumns: 'minmax(220px, 0.7fr) repeat(2, minmax(0, 1fr))' },
              children: [
                jsx(Panel, {
                  className: 'px-2.5 py-2',
                  children: jsx(QuotaGauge, {
                    remaining: usage.remaining_percent,
                    label: '剩余流量',
                    resetAt: usage.reset_at
                  })
                }),
                jsx(JmsStat, {
                  title: '今日',
                  value: data.sample_count > 1 ? fmtGB(usage.today_b) : '采样中',
                  hint: data.sample_count > 1 ? '上海时区自然日 · 采样差值' : '需要至少两次采样才能拆日'
                }),
                jsx(JmsStat, {
                  title: '本周',
                  value: data.sample_count > 1 ? fmtGB(usage.week_b) : '采样中',
                  hint: `已采样 ${fmtInteger(data.sample_count)} 次`
                })
              ]
            })
          : null,
        usage ? jsx(JmsDailyTrend, { rows: usage.daily }) : null,
        usage
          ? jsx(Panel, {
              className: 'px-2.5 py-2',
              children: jsxs('div', {
                className: 'flex min-h-0 flex-col',
                children: [
                  jsxs('div', {
                    className: 'flex items-baseline justify-between gap-2',
                    children: [
                      jsx('h3', { className: 'text-xs font-semibold', children: '每日明细' }),
                      jsx('span', {
                        className: 'text-[0.5rem]',
                        style: { color: 'var(--ui-text-quaternary)' },
                        children: '新的一天会在下次采样后出现'
                      })
                    ]
                  }),
                  daily.length
                    ? jsxs('div', {
                        className: 'mt-1.5 min-h-0 overflow-auto',
                        children: [
                          jsxs('div', {
                            className: 'grid gap-2 pb-1 text-[0.5rem]',
                            style: {
                              gridTemplateColumns: 'minmax(0, 1fr) minmax(6rem, 0.6fr)',
                              color: 'var(--ui-text-quaternary)'
                            },
                            children: [
                              jsx('span', { children: '日期' }),
                              jsx('span', { className: 'text-right', children: '用量' })
                            ]
                          }),
                          daily.slice(0, 31).map(row =>
                            jsxs('div', {
                              className: 'grid items-center gap-2 border-t py-1 text-[0.625rem]',
                              style: {
                                gridTemplateColumns: 'minmax(0, 1fr) minmax(6rem, 0.6fr)',
                                borderColor: 'var(--ui-stroke-secondary)'
                              },
                              children: [
                                jsx('span', { className: 'tabular-nums', children: row.date }),
                                jsx('span', {
                                  className: 'text-right font-semibold tabular-nums',
                                  children: fmtGB(row.used_b)
                                })
                              ]
                            }, row.date)
                          )
                        ]
                      })
                    : jsx('div', {
                        className: 'py-6 text-center text-[0.6875rem]',
                        style: { color: 'var(--ui-text-quaternary)' },
                        children: '还没有跨天差值。保持 Desktop 打开，或等定时采样。'
                      })
                ]
              })
            })
          : null,
        data?.config?.configured
          ? jsx(Panel, {
              className: 'px-2.5 py-2',
              children: jsxs('div', {
                className: 'flex flex-col gap-2',
                children: [
                  jsxs('div', {
                    className: 'flex items-baseline justify-between gap-2',
                    children: [
                      jsx('h3', { className: 'text-xs font-semibold', children: '账号' }),
                      jsx(Button, {
                        size: 'sm',
                        variant: 'secondary',
                        disabled: forget.isPending,
                        onClick: () => forget.mutate(),
                        children: '清除本机密钥'
                      })
                    ]
                  }),
                  jsx(JmsConfigForm, { compact: true })
                ]
              })
            })
          : null,
        data?.reason
          ? jsx('div', {
              className: 'text-[0.625rem]',
              style: { color: 'var(--ui-text-quaternary)' },
              children: data.reason
            })
          : null
      ]
    })
  })
}

function JmsChip({ data }) {
  const usage = data?.usage
  const remaining = usage?.remaining_percent
  const known = remaining !== null && remaining !== undefined && !Number.isNaN(Number(remaining))
  const tone = quotaTone(known ? remaining : null)
  return jsxs('span', {
    className: 'inline-flex h-full min-w-0 items-center gap-1',
    children: [
      jsx('span', {
        className: 'relative h-1 w-3.5 shrink-0 overflow-hidden rounded-full',
        style: { background: 'var(--ui-stroke-secondary)' },
        'aria-hidden': true,
        children: known
          ? jsx('span', {
              className: 'absolute inset-y-0 left-0 rounded-full',
              style: {
                width: `${Math.max(0, Math.min(100, remaining))}%`,
                background: tone
              }
            })
          : null
      }),
      jsx('span', { className: 'shrink-0 text-(--ui-text-quaternary)', children: 'VPN' }),
      jsx('span', {
        className: 'shrink-0 font-medium tabular-nums',
        style: { color: tone },
        children: known ? fmtGB(usage.remaining_b) : '—'
      })
    ]
  })
}

function JmsHoverCard({ data }) {
  const usage = data?.usage || {}
  return jsxs('div', {
    className: 'flex w-full flex-col gap-2 text-[0.75rem] leading-snug text-(--ui-text-primary)',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3',
        children: [
          jsx('span', { className: 'font-medium', children: 'Just My Socks' }),
          jsx('span', { className: 'tabular-nums text-[0.5625rem] text-(--ui-text-quaternary)', children: data?.config?.service ? `#${data.config.service}` : '' })
        ]
      }),
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3',
        children: [
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: '已用 / 剩余' }),
          jsx('span', { className: 'font-semibold tabular-nums', children: `${fmtGB(usage.used_b)} / ${fmtGB(usage.remaining_b)}` })
        ]
      }),
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3',
        children: [
          jsx('span', { className: 'text-(--ui-text-quaternary)', children: '今日' }),
          jsx('span', { className: 'tabular-nums', children: data?.sample_count > 1 ? fmtGB(usage.today_b) : '采样中' })
        ]
      }),
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3 text-(--ui-text-quaternary)',
        children: [
          jsx('span', { children: '重置' }),
          jsx('span', { className: 'tabular-nums', children: fmtTime(usage.reset_at) })
        ]
      })
    ]
  })
}

function useSummary(interval = 30000) {
  const focusedSessionId = useHostState('focusedSessionId')
  const activeSessionId = useHostState('activeSessionId')
  const sessionId = focusedSessionId || activeSessionId
  const profile = useHostState('profile')
  return useQuery({
    queryKey: ['usage-center', 'summary', profile || 'default', sessionId || 'none'],
    queryFn: () => {
      const suffix = sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : ''
      return pluginContext.rest(`/summary?days=30${suffix}`)
    },
    refetchInterval: query => {
      const grok = query.state.data?.providers?.['xai-oauth']
      if (!grok || grok.status === 'unavailable') return Math.min(interval, 5000)
      return interval
    },
    staleTime: 5000,
    retry: 1
  })
}

function UsageCenterPage() {
  const [prefs, setPrefs] = useDisplayPrefs()
  const model = useHostState('model')
  const profile = useHostState('profile')
  const queryClient = useQueryClient()
  const summary = useSummary()
  const refresh = useMutation({
    mutationFn: provider => pluginContext.rest(`/refresh/${provider}`, { method: 'POST' }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['usage-center', 'summary'] })
  })

  if (summary.isLoading && !summary.data) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center gap-2 text-xs',
      style: { color: 'var(--ui-text-tertiary)' },
      children: [jsx(GlyphSpinner, {}), '正在读取本地用量…']
    })
  }
  if (summary.isError && !summary.data) {
    return jsxs('div', {
      className: 'flex h-full flex-col items-center justify-center gap-3 p-6 text-center',
      children: [
        jsx('div', { className: 'text-sm font-semibold', children: '模型用量后端不可用' }),
        jsx(Button, { onClick: () => summary.refetch(), children: '重试' })
      ]
    })
  }
  const data = summary.data
  if (!data) {
    return jsx('div', {
      className: 'flex h-full items-center justify-center gap-2 text-xs',
      style: { color: 'var(--ui-text-tertiary)' },
      children: [jsx(GlyphSpinner, {}), '正在读取本地用量…']
    })
  }
  const usage = data.usage || {}
  const periods = usage.periods || {}
  const rolling = usage.rolling || {}
  const providers = data.providers || {}
  const mutating = refresh.variables
  const runtimeProvider = data.current_session?.provider

  return jsx('div', {
    className: 'h-full min-h-0 overflow-hidden',
    children: jsxs('div', {
      className: 'mx-auto grid h-full min-h-0 max-w-[1600px] gap-2.5 p-3',
      style: {
        gridTemplateRows: 'auto auto minmax(140px, 1fr) minmax(132px, 0.78fr) minmax(120px, 0.68fr) minmax(108px, 0.62fr) auto auto'
      },
      children: [
        jsxs('header', {
          className: 'flex min-w-0 items-center justify-between gap-3',
          children: [
            jsxs('div', {
              className: 'flex min-w-0 items-center gap-2',
              children: [
                jsx('h1', { className: 'shrink-0 text-base font-semibold', children: '模型用量' }),
                jsx(StatusPill, { status: 'available', compact: true, children: model || '未连接模型' }),
                runtimeProvider
                  ? jsx('span', {
                      className: 'max-w-40 truncate text-[0.625rem]',
                      style: { color: 'var(--ui-text-tertiary)' },
                      title: runtimeProvider,
                      children: runtimeProvider
                    })
                  : null,
                jsx('span', {
                  className: 'hidden text-[0.5625rem] xl:inline',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: `${profile || 'default'} · UTC+8 · 会话聚合`
                })
              ]
            }),
            jsxs('div', {
              className: 'flex shrink-0 items-center gap-2',
              children: [
                jsx(StatusPill, {
                  status: data.local_usage_status,
                  compact: true,
                  children: data.local_usage_status === 'available' ? '数据正常' : '数据异常'
                }),
                jsx('span', {
                  className: 'hidden text-[0.5625rem] tabular-nums sm:inline',
                  style: { color: 'var(--ui-text-quaternary)' },
                  children: fmtTime(data.generated_at)
                }),
                jsx(Button, {
                  size: 'sm',
                  variant: 'secondary',
                  onClick: () => host.navigate('/usage-center/vpn'),
                  title: '打开 VPN 流量页',
                  children: 'VPN'
                }),
                jsx(Button, {
                  size: 'sm',
                  variant: 'secondary',
                  onClick: () => summary.refetch(),
                  title: '刷新本地统计',
                  children: summary.isFetching ? '…' : '↻'
                })
              ]
            })
          ]
        }),
        jsx(PeriodRibbon, { periods, rolling }),
        jsx(DailyTrend, { rows: usage.daily, summary: rolling['30d'] }),
        jsx(ModelCyclePanel, {
          cycleMap: usage.cycle_by_model,
          activeModel: data.current_session?.model || model,
          prefs
        }),
        [prefs.showCodex, prefs.showGrok, prefs.showClaude].some(Boolean)
          ? jsxs('div', {
          className: 'grid min-h-0 gap-2.5',
          style: { gridTemplateColumns: `repeat(${[prefs.showCodex, prefs.showGrok, prefs.showClaude].filter(Boolean).length}, minmax(0, 1fr))` },
          children: [
            prefs.showCodex ? jsx(ProviderPanel, {
              title: 'OpenAI Codex',
              data: providers['openai-codex'],
              refreshing: refresh.isPending && mutating === 'codex',
              onRefresh: () => refresh.mutate('codex')
            }) : null,
            prefs.showGrok ? jsx(ProviderPanel, {
              title: 'xAI Grok',
              data: providers['xai-oauth'],
              refreshing: refresh.isPending && mutating === 'xai',
              onRefresh: () => refresh.mutate('xai')
            }) : null,
            prefs.showClaude ? jsx(ProviderPanel, {
              title: 'Claude',
              data: providers.anthropic || {
                status: 'unavailable',
                reason: 'Claude 官方额度暂时不可查询',
                source: 'pending_backend_reload',
                windows: []
              },
              refreshing: refresh.isPending && mutating === 'anthropic',
              onRefresh: () => refresh.mutate('anthropic')
            }) : null
          ]
        }) : null,
        jsxs('div', {
          className: 'grid min-h-0 gap-2.5',
          style: { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          children: [
            jsx(DistributionPanel, { rows: usage.by_provider, title: 'Provider占比' }),
            jsx(DistributionPanel, { rows: usage.by_source, title: '平台占比' })
          ]
        }),
        jsx(DisplayPrefsPanel, {
          prefs,
          onChange: setPrefs,
          modelNames: Object.keys(usage.cycle_by_model || usage.by_model_periods || {})
        }),
        jsxs('div', {
          className: 'flex min-w-0 items-center justify-between gap-3 text-[0.5rem]',
          style: { color: 'var(--ui-text-quaternary)' },
          children: [
            jsx(TokenLegend, {}),
            jsx('span', {
              className: 'truncate',
              title: 'Token与调用来自state.db会话聚合；失败率与P95延迟当前不可得；不采集Prompt、认证头或密钥。',
              children: 'state.db · 官方额度 · 隐私安全'
            })
          ]
        })
      ]
    })
  })
}

function StatusQuotaChip({ item, prefs }) {
  const tone = quotaTone(item.known ? item.remaining : null)
  return jsxs('span', {
    className: 'inline-flex h-full min-w-0 items-center gap-1',
    children: [
      jsx('span', {
        className: 'relative h-1 w-3.5 shrink-0 overflow-hidden rounded-full',
        style: { background: 'var(--ui-stroke-secondary)' },
        'aria-hidden': true,
        children: item.known
          ? jsx('span', {
              className: 'absolute inset-y-0 left-0 rounded-full',
              style: {
                width: `${Math.max(0, Math.min(100, item.remaining))}%`,
                background: tone
              }
            })
          : null
      }),
      jsx('span', {
        className: 'shrink-0 text-(--ui-text-quaternary)',
        children: item.name
      }),
      jsx('span', {
        className: 'shrink-0 font-medium tabular-nums',
        style: { color: tone },
        children: item.known ? fmtPercent(item.remaining) : '—'
      }),
      jsx('span', {
        className: 'shrink-0 tabular-nums text-(--ui-text-secondary)',
        children: item.cycleKnown ? fmtCount(item.cycleTokens, prefs) : '—'
      }),
      item.compact
        ? jsx('span', {
            className: 'shrink-0 tabular-nums text-(--ui-text-quaternary)',
            children: item.compact
          })
        : null
    ]
  })
}

function TodayChip({ value }) {
  const tokens = totalTokens(value)
  const item = value || {}
  const parts = TOKEN_SERIES.filter(series => Number(item[series.key] || 0) > 0)
  return jsxs('span', {
    className: 'inline-flex h-full min-w-0 items-center gap-1',
    children: [
      jsx('span', {
        className: 'relative flex h-1 w-3.5 shrink-0 overflow-hidden rounded-full',
        style: { background: 'var(--ui-stroke-secondary)' },
        'aria-hidden': true,
        children: tokens > 0
          ? parts.map(series =>
              jsx('span', {
                className: 'h-full',
                style: {
                  width: `${Number(item[series.key] || 0) / tokens * 100}%`,
                  background: series.color
                }
              }, series.key)
            )
          : null
      }),
      jsx('span', {
        className: 'shrink-0 text-(--ui-text-quaternary)',
        children: '今日'
      }),
      jsx('span', {
        className: 'shrink-0 font-medium tabular-nums text-(--ui-text-secondary)',
        children: fmtCount(tokens)
      })
    ]
  })
}

function WeekChip({ value }) {
  const tokens = totalTokens(value)
  return jsxs('span', {
    className: 'inline-flex h-full min-w-0 items-center gap-1',
    children: [
      jsx('span', {
        className: 'shrink-0 text-(--ui-text-quaternary)',
        children: '本周'
      }),
      jsx('span', {
        className: 'shrink-0 font-medium tabular-nums text-(--ui-text-secondary)',
        children: fmtCount(tokens)
      })
    ]
  })
}

function HoverChip({ ariaLabel, card, children, startOpen = false, wide = false, href = '/usage-center' }) {
  const [open, setOpen] = useState(startOpen)
  const show = event => {
    event.preventDefault()
    setOpen(true)
  }
  const hide = () => setOpen(false)
  return jsxs(Popover, {
    open,
    onOpenChange: setOpen,
    children: [
      jsx(PopoverTrigger, {
        asChild: true,
        children: jsx('button', {
          type: 'button',
          className: cn(
            'inline-flex h-full items-center px-1.5 text-[0.75rem] leading-none',
            'text-(--ui-text-tertiary) transition-colors hover:bg-(--chrome-action-hover) hover:text-foreground'
          ),
          'aria-label': ariaLabel,
          onMouseEnter: show,
          onMouseLeave: hide,
          onClick: () => {
            haptic('tap')
            setOpen(false)
            host.navigate(href)
          },
          children
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'top',
        sideOffset: 8,
        onMouseEnter: show,
        onMouseLeave: hide,
        className: cn(
          'p-3 shadow-lg backdrop-blur-none [--popover-surface:var(--ui-bg-elevated)]',
          wide ? 'w-[26rem]' : 'w-[22rem]'
        ),
        style: {
          background: 'var(--ui-bg-elevated)',
          color: 'var(--ui-text-primary)',
          ['--popover-surface']: 'var(--ui-bg-elevated)'
        },
        children: card
      })
    ]
  })
}

function TodayHoverCard({ value }) {
  const item = value || {}
  const tokens = totalTokens(item)
  return jsxs('div', {
    className: 'flex w-full flex-col gap-2 text-[0.75rem] leading-snug text-(--ui-text-primary)',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3',
        children: [
          jsx('span', { className: 'font-medium', children: '今日 Token' }),
          jsx('span', { className: 'font-semibold tabular-nums', children: fmtInteger(tokens) })
        ]
      }),
      jsx(TokenStack, { value: item, className: 'h-1.5' }),
      ...TOKEN_SERIES.map(series =>
        jsxs('div', {
          className: 'flex items-baseline justify-between gap-3',
          children: [
            jsxs('span', {
              className: 'inline-flex items-center gap-1 text-(--ui-text-quaternary)',
              children: [
                jsx('span', {
                  className: 'h-1.5 w-1.5 rounded-sm',
                  style: { background: series.color }
                }),
                series.label
              ]
            }),
            jsx('span', {
              className: 'tabular-nums',
              children: fmtInteger(item[series.key])
            })
          ]
        }, series.key)
      ),
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-3 pt-0.5 text-(--ui-text-quaternary)',
        children: [
          jsx('span', { children: '调用' }),
          jsx('span', { className: 'tabular-nums', children: fmtInteger(item.api_calls) })
        ]
      })
    ]
  })
}

function fmtResetPair(resetAt) {
  const compact = fmtResetCompact(resetAt)
  const clock = fmtTime(resetAt)
  if (!compact && clock === '—') return '—'
  if (!compact) return clock
  if (clock === '—') return compact
  return `${compact} · ${clock}`
}

function MiniRing({ remaining, label }) {
  const known = remaining !== null && remaining !== undefined && !Number.isNaN(Number(remaining))
  const value = known ? Math.max(0, Math.min(100, Number(remaining))) : 0
  const tone = quotaTone(known ? value : null)
  return jsxs('svg', {
    className: 'h-8 w-8 shrink-0',
    viewBox: '0 0 36 36',
    role: 'img',
    'aria-label': `${label || '额度'} ${known ? fmtPercent(value) : '不可查询'}`,
    children: [
      jsx('circle', {
        cx: 18,
        cy: 18,
        r: 14,
        fill: 'none',
        stroke: 'var(--ui-stroke-secondary)',
        strokeWidth: 3.5
      }),
      known
        ? jsx('circle', {
            cx: 18,
            cy: 18,
            r: 14,
            fill: 'none',
            stroke: tone,
            strokeWidth: 3.5,
            strokeLinecap: 'round',
            pathLength: 100,
            strokeDasharray: `${value} 100`,
            transform: 'rotate(-90 18 18)'
          })
        : null,
      jsx('text', {
        x: 18,
        y: 21,
        textAnchor: 'middle',
        fontSize: 8,
        fontWeight: 700,
        fill: 'currentColor',
        children: known ? `${Math.round(value)}` : '—'
      })
    ]
  })
}

function WindowRow({ window }) {
  const remaining = window.remaining_percent
  const known = remaining !== null && remaining !== undefined && !Number.isNaN(Number(remaining))
  return jsxs('div', {
    className: 'flex min-w-0 items-center gap-2',
    title: `${window.label || '额度'} · 剩余 ${known ? fmtPercent(remaining) : '—'} · ${fmtResetPair(window.reset_at)}`,
    children: [
      jsx(MiniRing, { remaining: known ? remaining : null, label: window.label }),
      jsxs('div', {
        className: 'min-w-0 flex-1',
        children: [
          jsxs('div', {
            className: 'flex items-baseline justify-between gap-2',
            children: [
              jsx('span', { className: 'truncate text-[0.6875rem]', children: window.label || '额度' }),
              jsx('span', {
                className: 'shrink-0 font-medium tabular-nums',
                style: { color: quotaTone(known ? remaining : null) },
                children: known ? fmtPercent(remaining) : '—'
              })
            ]
          }),
          jsx('div', {
            className: 'mt-0.5 truncate text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)',
            children: fmtResetPair(window.reset_at)
          })
        ]
      })
    ]
  })
}

function matchProviderPeriods(periodsMap, name) {
  if (!periodsMap || typeof periodsMap !== 'object') return null
  const aliases = {
    Grok: ['xai-oauth', 'xai', 'grok'],
    Codex: ['openai-codex', 'openai', 'codex'],
    Claude: ['anthropic', 'claude']
  }[name] || [String(name).toLowerCase()]
  const entries = Object.entries(periodsMap)
  const hit = entries.find(([key]) => {
    const lower = String(key).toLowerCase()
    return aliases.some(alias => lower === alias || lower.includes(alias))
  })
  return hit ? hit[1] : null
}

function PeriodMini({ title, value }) {
  const tokens = totalTokens(value)
  return jsxs('div', {
    className: 'min-w-0 rounded-md border px-2 py-1.5',
    style: { borderColor: 'var(--ui-stroke-secondary)' },
    title: exactTokenTitle(value),
    children: [
      jsx('div', {
        className: 'text-[0.5625rem] text-(--ui-text-quaternary)',
        children: title
      }),
      jsx('div', {
        className: 'mt-0.5 font-semibold tabular-nums',
        children: fmtInteger(tokens)
      }),
      jsx('div', {
        className: 'text-[0.5625rem] tabular-nums text-(--ui-text-quaternary)',
        children: `${fmtCount(tokens)} · ${fmtInteger(value?.api_calls)} 次`
      }),
      jsx(TokenStack, { value, className: 'mt-1 h-1' })
    ]
  })
}

function ProviderHoverBlock({ name, data, periods, prefs }) {
  const windows = providerWindows(data)
  const tight = bindingWindow(data)
  const cycle = data?.cycle
  const hasPeriods = Boolean(periods && (periods.today || periods.week || periods.month))
  return jsxs('section', {
    className: 'flex flex-col gap-2',
    children: [
      jsxs('div', {
        className: 'flex items-baseline justify-between gap-2',
        children: [
          jsxs('span', {
            className: 'text-[0.75rem] font-medium',
            children: [
              name,
              data?.plan
                ? jsx('span', {
                    className: 'ml-1 text-[0.5625rem] font-normal text-(--ui-text-quaternary)',
                    children: data.plan
                  })
                : null
            ]
          }),
          tight
            ? jsx('span', {
                className: 'tabular-nums text-[0.5625rem] text-(--ui-text-quaternary)',
                children: `最紧 ${fmtPercent(tight.remaining_percent)}`
              })
            : jsx('span', {
                className: 'text-[0.5625rem] text-(--ui-text-quaternary)',
                children: data?.status === 'unavailable' ? '不可查询' : ''
              })
        ]
      }),
      cycle
        ? jsxs('div', {
            className: 'flex items-baseline justify-between gap-2 rounded-md border px-2 py-1.5',
            style: { borderColor: 'var(--ui-stroke-secondary)' },
            children: [
              jsx('span', {
                className: 'text-[0.625rem] text-(--ui-text-quaternary)',
                children: `本周期 · ${cycleKindLabel(cycle.kind)}`
              }),
              jsx('span', {
                className: 'font-semibold tabular-nums',
                children: fmtCount(totalTokens(cycle), prefs)
              })
            ]
          })
        : null,
      hasPeriods
        ? jsx('div', {
            className: 'grid gap-1.5',
            style: { gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' },
            children: [
              { title: '今日', value: periods.today },
              { title: '本周', value: periods.week },
              { title: '本月', value: periods.month }
            ].map(item => jsx(PeriodMini, item, item.title))
          })
        : jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: '本地日/周/月需重挂后端后才能按这家拆'
          }),
      windows.length
        ? windows.slice(0, 3).map((window, index) =>
            jsx(WindowRow, { window }, `${name}-${window.label || index}`)
          )
        : jsx('div', {
            className: 'text-[0.6875rem] text-(--ui-text-quaternary)',
            children: data?.reason || '无官方额度窗口'
          })
    ]
  })
}

function UsageStatus() {
  const [prefs] = useDisplayPrefs()
  const summary = useSummary(60000)
  const jms = useJms(60000)
  const providers = summary.data?.providers || {}
  const todayValue = summary.data?.usage?.periods?.today
  const weekValue = summary.data?.usage?.periods?.week
  const providerPeriods = summary.data?.usage?.by_provider_periods || {}
  const modelPeriods = summary.data?.usage?.by_model_periods || {}
  const cycleMap = summary.data?.usage?.cycle_by_model || {}
  const periodsReady = Object.prototype.hasOwnProperty.call(summary.data?.usage || {}, 'by_provider_periods')
  const runtimeModel = summary.data?.current_session?.model
  const visible = {
    Grok: prefs.showGrok !== false,
    Codex: prefs.showCodex !== false,
    Claude: prefs.showClaude !== false
  }
  const items = [
    { name: 'Grok', data: providers['xai-oauth'] },
    { name: 'Codex', data: providers['openai-codex'] },
    { name: 'Claude', data: providers.anthropic }
  ].filter(item => visible[item.name]).map(item => ({
    ...item,
    snap: quotaSnapshot(item.name, item.data),
    periods: matchProviderPeriods(providerPeriods, item.name)
      || (periodsReady ? { today: {}, week: {}, month: {} } : null)
  }))
  const chips = []
  if (prefs.showToday !== false) {
    chips.push(jsx(HoverChip, {
      ariaLabel: `今日 ${fmtInteger(totalTokens(todayValue))} Token`,
      card: jsx(TodayHoverCard, { value: todayValue }),
      children: jsx(TodayChip, { value: todayValue })
    }, 'today'))
  }
  if (prefs.showWeek) {
    chips.push(jsx(HoverChip, {
      ariaLabel: `自然周 ${fmtInteger(totalTokens(weekValue))} Token`,
      card: jsx(TodayHoverCard, { value: weekValue }),
      children: jsx(WeekChip, { value: weekValue })
    }, 'week'))
  }
  items.forEach(item => {
    chips.push(jsx(HoverChip, {
      ariaLabel: item.snap.title,
      startOpen: false,
      card: jsx(ProviderHoverBlock, { name: item.name, data: item.data, periods: item.periods, prefs }),
      children: jsx(StatusQuotaChip, { item: item.snap, prefs })
    }, item.name))
  })
  if (prefs.showJms !== false) {
    chips.push(jsx(HoverChip, {
      ariaLabel: 'VPN 剩余流量',
      href: '/usage-center/vpn',
      card: jsx(JmsHoverCard, { data: jms.data }),
      children: jsx(JmsChip, { data: jms.data })
    }, 'jms'))
  }
  const loading = summary.isLoading && !summary.data
  if (loading) {
    return jsxs('span', {
      className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.75rem] leading-none text-(--ui-text-tertiary)',
      children: [jsx(GlyphSpinner, {}), '用量']
    })
  }
  return jsxs('span', {
    className: 'inline-flex h-full min-w-0 items-center text-[0.75rem] leading-none',
    children: chips.flatMap((chip, index) => index
      ? [
          jsx('span', {
            className: 'h-3 w-px shrink-0',
            style: { background: 'var(--ui-stroke-secondary)' },
            'aria-hidden': true
          }, `sep-${index}`),
          chip
        ]
      : [chip])
  })
}

export default {
  id: 'usage-center',
  name: '模型用量中心',
  description: '按 Hermes 配置档聚合模型 Token、官方额度，以及 Just My Socks 流量',
  defaultEnabled: true,
  register(ctx) {
    pluginContext = ctx
    hydratePrefs()
    ctx.storage.set('loaded-version', '1.12.0')
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/usage-center' },
        render: () => jsx(UsageCenterPage, {})
      },
      {
        id: 'vpn-page',
        area: ROUTES_AREA,
        data: { path: '/usage-center/vpn' },
        render: () => jsx(JmsPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 72,
        data: { path: '/usage-center', label: '模型用量', codicon: 'graph' }
      },
      {
        id: 'vpn-nav',
        area: SIDEBAR_NAV_AREA,
        order: 73,
        data: { path: '/usage-center/vpn', label: 'VPN 流量', codicon: 'globe' }
      },
      {
        id: 'status-chips',
        area: STATUSBAR_AREAS.right,
        order: 980,
        render: () => jsx(UsageStatus, {})
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'usage-center.open',
          label: '模型用量',
          keywords: ['usage', 'token', 'quota', '用量', '额度', '模型'],
          run: () => host.navigate('/usage-center')
        }
      },
      {
        id: 'open-vpn',
        area: PALETTE_AREA,
        data: {
          id: 'usage-center.open-vpn',
          label: 'VPN 流量',
          keywords: ['vpn', 'jms', 'justmysocks', '流量', '带宽'],
          run: () => host.navigate('/usage-center/vpn')
        }
      }
    ])
  }
}
