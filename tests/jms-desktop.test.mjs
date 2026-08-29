import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { setJmsResponse } from './desktop-sdk.mjs'
import { DailyTrend, fillJmsDaily, JmsDailyTrend, JmsPage, UsageCenterPage } from '../desktop/plugin.js'

const snapshotDate = new Date('2026-08-28T15:59:59Z')
const render = (Component, props) => new JSDOM(renderToStaticMarkup(createElement(Component, props))).window.document

test('window includes today and the previous 29 consecutive days, crossing months', () => {
  const rows = fillJmsDaily([], 30, snapshotDate)
  assert.equal(rows.length, 30)
  assert.equal(rows[0].date, '2026-07-30')
  assert.equal(rows.at(-1).date, '2026-08-28')
  for (let i = 1; i < rows.length; i++) {
    assert.equal(Date.parse(rows[i].date) - Date.parse(rows[i - 1].date), 86_400_000)
  }
})

test('window rolls forward at Shanghai midnight', () => {
  const before = fillJmsDaily([], 30, snapshotDate)
  const after = fillJmsDaily([], 30, new Date('2026-08-28T16:00:00Z'))
  assert.equal(before.at(-1).date, '2026-08-28')
  assert.equal(after[0].date, '2026-07-31')
  assert.equal(after.at(-1).date, '2026-08-29')
})

test('window handles leap day and year boundaries', () => {
  const leap = fillJmsDaily([], 30, new Date('2024-03-01T00:00:00+08:00'))
  assert.equal(leap[0].date, '2024-02-01')
  assert.equal(leap.at(-2).date, '2024-02-29')
  const newYear = fillJmsDaily([], 30, new Date('2026-01-01T00:00:00+08:00'))
  assert.equal(newYear[0].date, '2025-12-03')
  assert.equal(newYear.at(-1).date, '2026-01-01')
})

test('window is independent of the device timezone and DST', () => {
  const previous = process.env.TZ
  try {
    for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = zone
      const rows = fillJmsDaily([], 30, new Date('2026-03-08T17:00:00Z'))
      assert.equal(rows[0].date, '2026-02-08', zone)
      assert.equal(rows.at(-1).date, '2026-03-09', zone)
    }
  } finally {
    if (previous === undefined) delete process.env.TZ
    else process.env.TZ = previous
  }
})

test('filtering preserves real zeros and amounts, excludes old/future days, and does not mutate input', () => {
  const input = Object.freeze([
    Object.freeze({ date: '2026-08-28', used_b: 3_880_000_000 }),
    Object.freeze({ date: '2026-07-29', used_b: 100 }),
    Object.freeze({ date: '2026-08-29', used_b: 200 }),
    Object.freeze({ date: '2026-07-30', used_b: 0 })
  ])
  const rows = fillJmsDaily(input, 30, snapshotDate)
  assert.equal(rows[0].used_b, 0)
  assert.equal(rows[1].used_b, null)
  assert.equal(rows.at(-1).used_b, 3_880_000_000)
  assert.equal(rows.filter(row => row.used_b != null).length, 2)
  assert.equal(input[0].date, '2026-08-28')
})

test('chart renders 30 daily markers, explicit date range, monthly tick labels and honest missing-data labels', () => {
  const rows = fillJmsDaily([{ date: '2026-08-28', used_b: 3_880_000_000 }], 30, snapshotDate)
  const doc = render(JmsDailyTrend, { rows })
  const chart = doc.querySelector('[role="img"]')
  assert.equal(chart.querySelectorAll('[title]').length, 30)
  assert.match(doc.body.textContent, /2026-07-30 至 2026-08-28/)
  assert.match(chart.textContent, /07\/30/)
  assert.match(chart.textContent, /08\/28/)
  assert.equal(chart.querySelector('[title^="2026-07-30"]').title, '2026-07-30 · 暂无采样差值')
  assert.equal(chart.querySelector('[title^="2026-08-28"]').title, '2026-08-28 · 3.88 GB')
  assert.match(doc.body.textContent, /已记录 1\/30 天/)
  assert.match(doc.body.textContent, /单日峰值 3.88 GB/)
})

test('empty and all-zero charts render without NaN, Infinity or fictitious usage', () => {
  for (const input of [[], [{ date: '2026-08-28', used_b: 0 }]]) {
    const doc = render(JmsDailyTrend, { rows: fillJmsDaily(input, 30, snapshotDate) })
    assert.doesNotMatch(doc.body.innerHTML, /NaN|Infinity/)
    assert.equal(doc.querySelectorAll('[title]').length, 30)
    if (input.length) assert.match(doc.body.textContent, /单日峰值 0.00 GB/)
    else assert.doesNotMatch(doc.body.textContent, /单日峰值/)
  }
})

test('page uses the same 30 days for chart and newest-first detail rows', () => {
  const dates = fillJmsDaily([], 30)
  const oldDate = new Date(Date.parse(dates[0].date) - 86_400_000).toISOString().slice(0, 10)
  const futureDate = new Date(Date.parse(dates.at(-1).date) + 86_400_000).toISOString().slice(0, 10)
  setJmsResponse({ data: { status: 'available', sample_count: 3, usage: {
    daily: [
      { date: dates[0].date, used_b: 1_000_000_000 },
      { date: oldDate, used_b: 9_000_000_000 },
      { date: dates.at(-1).date, used_b: 2_000_000_000 },
      { date: futureDate, used_b: 8_000_000_000 }
    ]
  } } })
  const doc = render(JmsPage)
  const heading = [...doc.querySelectorAll('h3')].find(node => node.textContent === '每日明细（最近 30 天）')
  const detail = heading.parentElement.parentElement
  const detailTitles = [...detail.querySelectorAll('.uc-daily-detail-grid > div')].map(node => node.title)
  assert.match(detailTitles[0], new RegExp(`^${dates.at(-1).date}`))
  assert.match(detailTitles[1], new RegExp(`^${dates[0].date}`))
  assert.ok(!detailTitles.some(title => title.startsWith(oldDate)))
  assert.ok(!detailTitles.some(title => title.startsWith(futureDate)))
  assert.equal(doc.querySelectorAll('.uc-vpn-stats').length, 1)
  assert.equal(doc.querySelectorAll('.uc-vpn-stats > .uc-panel').length, 6)
  assert.ok(doc.querySelector('.uc-vpn-bottom-grid'))
  assert.equal(doc.querySelectorAll('.uc-daily-detail-grid > div').length, 2)
  assert.match(doc.querySelector('[role="img"][aria-label^="最近 30 天"]').getAttribute('aria-label'), /2 天有采样差值/)
})

test('unconfigured and unavailable pages still render their recovery actions', () => {
  setJmsResponse({ data: { status: 'unconfigured', config: { configured: false } } })
  assert.match(render(JmsPage).body.textContent, /接入 Just My Socks/)
  setJmsResponse({ isError: true })
  assert.match(render(JmsPage).body.textContent, /VPN 流量后端不可用/)
})

test('model trend uses readable axes, explicit month/day ticks and animated bars', () => {
  const rows = Array.from({ length: 30 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 7, index + 1)).toISOString().slice(0, 10),
    input_tokens: (index + 1) * 1_000_000,
    output_tokens: (index + 1) * 100_000,
    api_calls: index + 1
  }))
  const doc = render(DailyTrend, { rows, summary: { total_tokens: 500_000_000, api_calls: 465 } })
  const chart = doc.querySelector('[role="img"][aria-label^="最近 30 天 Token 趋势"]')
  assert.ok(chart)
  assert.equal(chart.querySelectorAll('[title]').length, 30)
  assert.equal(chart.style.gridTemplateRows, '132px 20px')
  assert.equal(chart.querySelectorAll('.uc-chart-bar').length, 30)
  assert.match(chart.textContent, /\d{2}\/\d{2}/)
})

test('model page shares the responsive typography and reduced-motion design system', () => {
  const token = { input_tokens: 50_000_000, output_tokens: 5_000_000, api_calls: 42, sessions: 3 }
  setJmsResponse({ data: {
    generated_at: '2026-08-29T00:00:00+08:00',
    local_usage_status: 'available',
    current_session: { model: 'gpt-5.6-sol', provider: 'openai-codex' },
    usage: {
      periods: { today: token, week: token, month: token },
      rolling: { '7d': token, '30d': token, '90d': token },
      daily: [],
      cycle_by_model: { 'gpt-5.6-sol': { ...token, kind: 'session', reset_at: '2026-09-04T00:00:00+08:00' } },
      by_provider: [{ name: 'openai-codex', total_tokens: 55_000_000, api_calls: 42 }],
      by_source: [{ name: 'desktop', total_tokens: 55_000_000, api_calls: 42 }]
    },
    providers: {}
  } })
  const doc = render(UsageCenterPage)
  const page = doc.querySelector('.uc-page.uc-model')
  const css = page.querySelector('style').textContent
  assert.ok(page.classList.contains('overflow-auto'))
  assert.ok(page.querySelector('.uc-page-hero'))
  assert.equal(page.querySelectorAll('.uc-metric-card').length, 6)
  assert.ok(page.querySelector('.uc-model-main-grid'))
  assert.equal(page.querySelectorAll('.uc-distribution-grid > .uc-panel').length, 3)
  assert.match(css, /font-size: 13px/)
  assert.match(css, /prefers-reduced-motion: reduce/)
  assert.match(css, /uc-provider-grid/)
  assert.match(css, /uc-model-main-grid/)
  assert.match(css, /uc-vpn-bottom-grid/)
  assert.match(css, /uc-grow-y/)
})
