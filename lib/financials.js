/**
 * 财务数据分析。
 *
 * 目的：把「财务风险」从「靠公告关键词猜」升级为「有真实财报数据支撑」。
 * 核心用途是 ST 预警——连续亏损年数、净资产为负、营收过低。
 *
 * 数据源：westock `finance` 接口（利润表 lrb）
 * 已知限制：
 * - 只有利润表，无资产负债表 → 无法算「净资产为负」（DATA_LIMITATION）
 * - 无审计意见字段 → 无法判定非标意见
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)

/**
 * 解析利润表（横向多期输出）。
 * 返回按报告期升序的数组。
 */
export function parseFinanceLrb(text) {
  const rows = []
  let header = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.every(c => /^-+$/.test(c))) continue
    if (cells.includes('EndDate') || cells.includes('_date')) { header = cells; continue }
    if (header.length === 0) continue
    const get = name => {
      const i = header.indexOf(name)
      return i >= 0 ? cells[i] : undefined
    }
    const num = v => {
      const n = Number(String(v ?? '').replace(/,/g, ''))
      return Number.isFinite(n) ? n : undefined
    }
    const endDate = get('EndDate') || get('_date')
    if (!/^\d{4}-\d{2}-\d{2}/.test(endDate ?? '')) continue
    rows.push({
      period: endDate.slice(0, 10),
      netProfit: num(get('NPParentCompanyOwners')),          // 归母净利润（元）
      netProfitTTM: num(get('NPParentCompanyOwnersTTM')),
      revenue: num(get('OperatingRevenue')),                  // 营业收入（元）
      revenueTTM: num(get('OperatingRevenueTTM')),
      grossProfitTTM: num(get('GrossProfitTTM')),
      eps: num(get('BasicEPS')),
    })
  }
  rows.sort((a, b) => (a.period < b.period ? -1 : 1))
  return rows
}

/**
 * 财务健康度分析。
 *
 * @param {Array} periods parseFinanceLrb 的输出（升序）
 */
export function analyzeFinancials(periods) {
  if (!Array.isArray(periods) || periods.length === 0) {
    return { available: false, reason: '无财务数据' }
  }

  // 只保留年报（12-31）用于「连续亏损年数」
  const annuals = periods.filter(p => p.period.endsWith('12-31'))
  const latest = periods[periods.length - 1]

  const out = { available: true, latestPeriod: latest.period }

  // 最新一期
  if (Number.isFinite(latest.netProfit)) {
    out.latestNetProfit = latest.netProfit
    out.latestNetProfitYi = round(latest.netProfit / 1e8)
  }
  if (Number.isFinite(latest.revenue)) {
    out.latestRevenue = latest.revenue
    out.latestRevenueYi = round(latest.revenue / 1e8)
  }
  if (Number.isFinite(latest.eps)) out.latestEps = latest.eps

  // 毛利率（TTM）
  if (Number.isFinite(latest.grossProfitTTM) && Number.isFinite(latest.revenueTTM) && latest.revenueTTM > 0) {
    out.grossMargin = round((latest.grossProfitTTM / latest.revenueTTM) * 100, 1)
  }
  // 净利率（TTM）
  if (Number.isFinite(latest.netProfitTTM) && Number.isFinite(latest.revenueTTM) && latest.revenueTTM > 0) {
    out.netMargin = round((latest.netProfitTTM / latest.revenueTTM) * 100, 1)
  }

  // 年度利润序列
  if (annuals.length > 0) {
    out.annualProfits = annuals.slice(-4).map(a => ({
      year: a.period.slice(0, 4),
      netProfitYi: Number.isFinite(a.netProfit) ? round(a.netProfit / 1e8) : undefined,
      revenueYi: Number.isFinite(a.revenue) ? round(a.revenue / 1e8) : undefined,
    }))
  }

  // ---- 连续亏损年数（ST 预警核心）----
  let lossYears = 0
  for (let i = annuals.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(annuals[i].netProfit) && annuals[i].netProfit < 0) lossYears += 1
    else break
  }
  out.consecutiveLossYears = lossYears

  // ---- 营收规模（ST 判定：主板 < 1 亿）----
  if (Number.isFinite(latest.revenueTTM)) {
    out.revenueTTMYi = round(latest.revenueTTM / 1e8)
    out.lowRevenue = latest.revenueTTM < 1e8
  }

  // ---- 风险信号 ----
  const flags = []
  if (lossYears >= 2) {
    flags.push({ level: 'severe', text: `连续 ${lossYears} 年亏损（连续 3 年将触发退市风险警示）` })
  } else if (lossYears === 1) {
    flags.push({ level: 'warning', text: '最近一个完整年度亏损' })
  }
  if (out.lowRevenue) {
    flags.push({ level: 'severe', text: `营业收入 TTM 仅 ${out.revenueTTMYi} 亿，低于 1 亿红线` })
  }
  if (Number.isFinite(out.netMargin) && out.netMargin < -20) {
    flags.push({ level: 'warning', text: `净利率 ${out.netMargin}%，大幅亏损` })
  }
  if (Number.isFinite(out.grossMargin) && out.grossMargin < 10) {
    flags.push({ level: 'warning', text: `毛利率仅 ${out.grossMargin}%，盈利能力弱` })
  }
  out.flags = flags.length > 0 ? flags : undefined

  out.dataLimitations = [
    '仅利润表，无资产负债表 → 无法判定「净资产为负」',
    '无审计意见字段 → 非标意见需靠公告扫描',
  ]

  return out
}
