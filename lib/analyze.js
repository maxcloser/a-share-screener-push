/**
 * 个股深度分析编排层。
 *
 * 与 screener.js（批量扫描）的区别：
 * - screener：从股票池里筛出候选，广度优先
 * - analyze：对**指定个股**做全维度体检，深度优先
 *
 * 数据来源分两路：
 * - westock CLI：K线、技术指标、资金流、筹码、股东
 * - 东财 API：准确市值/PE/PB、公告风险扫描、ST 判定
 */

import { runCli, parseKline, parseTechnical, parseFundFlow, parseProfile, parseSearch, parseSuspensions } from './cli.js'
import {
  scoreCandidate, mergeParameters, evaluateTradability, evaluateMarket,
  evaluateMa5, formatMoney,
} from './strategies.js'
import {
  fetchQuote, fetchAnnouncements, scanAnnouncementRisk, detectSTStatus,
  capTier, TIER_PARAMS,
} from './eastmoney.js'
import {
  parseTechnicalSeries, analyzeMACD, analyzeCandlePatterns,
  analyzeVolumePattern, analyzeOscillators,
} from './indicators.js'
import {
  parseLhb, parseChipHistory, analyzeChipDistribution, interpretLhb,
} from './lhb.js'
import { analyzeLimitPattern, analyzeRegulatoryAction } from './extremes.js'

const TIMEOUT = 60000

function withTimeout(promise, ms) {
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(Symbol.for('timeout')), ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 归一化股票输入：名称或代码 → 标准代码 */
export async function resolveStock(input, cli, signal) {
  const raw = String(input ?? '').trim()
  if (!raw) return undefined

  // 已是标准代码
  const m = raw.toLowerCase().match(/^(sh|sz|bj)(\d{6})$/)
  if (m) return { code: `${m[1]}${m[2]}`, name: undefined }

  // 纯数字
  const digits = raw.match(/^(\d{6})$/)
  if (digits) {
    const d = digits[1]
    if (/^(6|9)/.test(d)) return { code: `sh${d}`, name: undefined }
    if (/^(0|2|3)/.test(d)) return { code: `sz${d}`, name: undefined }
    if (/^(4|8)/.test(d)) return { code: `bj${d}`, name: undefined }
  }

  // 按名称搜索
  const r = await withTimeout(runCli(cli, ['search', raw, '--stock', '--limit', '20'], signal), TIMEOUT)
  if (r && r.ok) {
    const hits = parseSearch(r.stdout)
    if (hits.length > 0) {
      // 优先精确匹配名称
      const exact = hits.find(h => h.name === raw)
      const pick = exact ?? hits[0]
      return { code: pick.code, name: pick.name }
    }
  }
  return undefined
}

/**
 * 执行个股深度分析。
 */
export async function analyzeStock({ config, input, signal, log }) {
  const cli = config.cli ?? {}
  const params = mergeParameters({})
  const startedAt = Date.now()
  const warnings = []

  // ---------- 1. 识别股票 ----------
  log?.(`识别「${input}」`)
  const resolved = await resolveStock(input, cli, signal)
  if (!resolved) {
    return { error: `未找到股票「${input}」，请检查名称或代码` }
  }
  const code = resolved.code

  // 北交所 / 科创板 直接拒绝
  if (code.startsWith('bj')) {
    return { error: `${code} 属于北交所，已按规则排除` }
  }
  if (/^sh68[89]/.test(code)) {
    return { error: `${code} 属于科创板，已按规则排除` }
  }

  // ---------- 2. 并行拉取数据 ----------
  log?.('拉取行情与基本面数据')
  // 技术指标需要历史序列（用于 MACD 金叉/死叉、背离、柱体趋势判定）
  // ⚠️ 实测：CLI 的 --start 必须配合 --end 才生效，单独传 --start 只返回 1 行
  const histStart = new Date(Date.now() - 150 * 86400000).toISOString().slice(0, 10)
  const histEnd = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const [quote, klineRes, techRes, techSeriesRes, fundRes, profileRes, suspendRes, lhbRes, chipHistRes] = await Promise.all([
    withTimeout(fetchQuote(code), 10000).catch(() => undefined),
    withTimeout(runCli(cli, ['kline', code, '--period', 'day', '--limit', '120'], signal), TIMEOUT),
    withTimeout(runCli(cli, ['technical', code, '--group', 'ma,macd,kdj,rsi'], signal), TIMEOUT),
    withTimeout(runCli(cli, ['technical', code, '--group', 'ma,macd,kdj,rsi,boll,bias,wr,dmi', '--start', histStart, '--end', histEnd], signal), TIMEOUT),
    withTimeout(runCli(cli, ['asfund', code], signal), TIMEOUT),
    withTimeout(runCli(cli, ['profile', code], signal), TIMEOUT),
    withTimeout(runCli(cli, ['suspension', 'hs'], signal), TIMEOUT),
    // 龙虎榜（近 5 日内有上榜记录才有效）
    withTimeout(runCli(cli, ['lhb', code], signal), TIMEOUT),
    // 筹码历史序列（用于趋势分析）
    withTimeout(runCli(cli, ['chip', code, '--start', histStart, '--end', histEnd], signal), TIMEOUT),
  ])

  const bars = klineRes?.ok ? parseKline(klineRes.stdout, code).get(code) : undefined
  if (!bars || bars.length < params.minBars) {
    return { error: `${code} K线数据不足（${bars?.length ?? 0} 条），可能停牌或数据异常` }
  }

  const tech = techRes?.ok ? parseTechnical(techRes.stdout, code).get(code) : undefined
  const flow = fundRes?.ok ? parseFundFlow(fundRes.stdout, code).get(code) : undefined
  const profile = profileRes?.ok ? parseProfile(profileRes.stdout, code).get(code) : undefined
  const suspended = suspendRes?.ok && suspendRes.stdout.includes(code)

  // ---------- 2.5 深度技术指标分析 ----------
  const series = techSeriesRes?.ok ? parseTechnicalSeries(techSeriesRes.stdout, code) : []
  const macdAnalysis = analyzeMACD(series)
  const candleAnalysis = analyzeCandlePatterns(bars)
  const volumeAnalysis = analyzeVolumePattern(bars)
  const oscAnalysis = analyzeOscillators(series)

  // ---------- 2.6 龙虎榜 + 筹码分布 ----------
  const lhbRaw = lhbRes?.ok ? parseLhb(lhbRes.stdout) : undefined
  const lhbAnalysis = lhbRaw ? interpretLhb(lhbRaw) : { available: false, reason: '未获取到龙虎榜数据' }

  const chipHistory = chipHistRes?.ok ? parseChipHistory(chipHistRes.stdout) : []
  const chipCurrent = chipHistory.length > 0 ? chipHistory[chipHistory.length - 1] : undefined
  const chipAnalysis = chipCurrent
    ? analyzeChipDistribution(chipCurrent, chipHistory, chipCurrent.close ?? quote?.price)
    : { available: false, reason: '筹码数据缺失' }

  // ---------- 3. 公告风险扫描 ----------
  log?.('扫描公告风险')
  const announcements = await withTimeout(fetchAnnouncements(code, 100), 15000).catch(() => [])
  const risk = scanAnnouncementRisk(announcements)

  // ---------- 3.5 极端形态识别 ----------
  const limitPattern = analyzeLimitPattern(code, bars, 30)
  const regulatory = analyzeRegulatoryAction(announcements)

  // ---------- 4. 剔除规则检查 ----------
  const name = quote?.name ?? profile?.name ?? resolved.name ?? code
  const stCheck = detectSTStatus(name)
  const excluded = []
  if (stCheck.isST) excluded.push(stCheck.reason)
  if (suspended) excluded.push('当前停牌')
  // 监管已介入（停牌核查/严重异常波动/立案调查）→ 直接排除
  if (regulatory.available && regulatory.level === 'fatal') {
    excluded.push(`监管介入：${regulatory.summary}`)
  }

  // ---------- 5. 市值分档与参数适配 ----------
  const tier = capTier(quote?.floatCap)
  const tierParams = tier ? TIER_PARAMS[tier] : undefined
  const effectiveParams = {
    ...params,
    bigCandleVolumeRatio: tierParams?.volumeRatio ?? params.bigCandleVolumeRatio,
    hardStopPct: tierParams?.hardStopPct ?? params.hardStopPct,
  }

  // ---------- 6. 大盘环境 ----------
  const idxRes = await withTimeout(runCli(cli, ['kline', 'sh000001', '--period', 'day', '--limit', '60'], signal), TIMEOUT)
  const idxBars = idxRes?.ok ? parseKline(idxRes.stdout, 'sh000001').get('sh000001') : undefined
  const marketEnv = idxBars ? evaluateMarket(idxBars, params) : undefined

  // ---------- 7. 综合评分 ----------
  const candidate = scoreCandidate({
    code, name, bars, tech, flow,
    boardNames: undefined, boardRanks: undefined,
    market: idxBars, params: effectiveParams,
  })
  const tradability = evaluateTradability(bars, effectiveParams)
  const ma5Detail = evaluateMa5(bars, effectiveParams)

  // ---------- 8. 生成买卖建议 ----------
  const close = bars[bars.length - 1].close
  const advice = buildAdvice({
    candidate, tradability, ma5Detail, bars, tier, tierParams,
    risk, excluded, marketEnv, quote,
    macdAnalysis, candleAnalysis, lhbAnalysis, chipAnalysis,
    limitPattern, regulatory,
  })

  return {
    asOf: new Date().toISOString(),
    dataDate: bars[bars.length - 1].date,
    elapsedMs: Date.now() - startedAt,
    stock: {
      code, name,
      industry: profile?.industry,
      price: quote?.price ?? close,
      changePct: quote?.changePct,
      totalCap: quote?.totalCap,
      floatCap: quote?.floatCap,
      pe: quote?.pe,
      pb: quote?.pb,
      turnover: quote?.turnover,
      tier,
      tierNote: tierParams?.note,
    },
    excluded: excluded.length > 0 ? excluded : undefined,
    risk: {
      level: risk.level,
      fatal: risk.fatal.map(a => `${a.date}【${a.label ?? '风险'}】${a.title}`),
      severe: risk.severe.map(a => `${a.date}【${a.label ?? '警示'}】${a.title}`),
      warning: risk.warning.slice(0, 8).map(a => `${a.date}【${a.label ?? '关注'}】${a.title}`),
      labels: [...new Set([...(risk.fatal ?? []), ...(risk.severe ?? [])].map(x => x.label).filter(Boolean))],
      announcementCount: announcements.length,
    },
    market: marketEnv ? { ok: marketEnv.ok, reason: marketEnv.reason, ...marketEnv.metrics } : undefined,
    technical: {
      status: candidate.status,
      score: candidate.score,
      tradable: tradability.tradable,
      untradableReason: tradability.reason,
      metrics: candidate.metrics,
      breakdown: candidate.breakdown,
      signals: candidate.signals,
      risks: candidate.risks,
      // 深度指标
      macd: macdAnalysis,
      candle: candleAnalysis,
      volume: volumeAnalysis,
      oscillators: oscAnalysis,
    },
    lhb: lhbAnalysis,
    chipDistribution: chipAnalysis,
    limitPattern,
    regulatory,
    advice,
    warnings,
  }
}

/**
 * 根据分析结果生成结构化的买卖建议。
 */
function buildAdvice({ candidate, tradability, ma5Detail, bars, tier, tierParams, risk, excluded, marketEnv, quote, macdAnalysis, candleAnalysis, lhbAnalysis, chipAnalysis, limitPattern, regulatory }) {
  const m = candidate.metrics ?? {}
  const close = m.close ?? bars[bars.length - 1].close
  const ma5 = m.ma5
  const ma10 = m.ma10
  const ma20 = m.ma20
  const stopPct = tierParams?.hardStopPct ?? 5
  const maxWeight = tierParams?.maxWeightPct ?? 20

  // 结论分级
  // 关键原则：财务/合规风险、超买、MACD 顶背离、诱多形态都必须能「否决」技术面买点，
  // 否则会出现「既提示高度警惕、又建议买入」的自相矛盾结论。
  const rsi = m.rsi6
  const overbought = Number.isFinite(rsi) && rsi >= 90
  const devFar = Number.isFinite(m.deviationMa5Pct) && m.deviationMa5Pct >= 10
  const topDivergence = macdAnalysis?.divergence?.type === 'top'
  const bullTrap = candleAnalysis?.candleType === 'bull_trap' || (candleAnalysis?.trapSignals?.length > 0)

  // 汇总否决原因
  const vetoes = []
  if (overbought) vetoes.push(`RSI6=${rsi.toFixed(0)} 极度超买`)
  if (devFar) vetoes.push(`偏离MA5 ${m.deviationMa5Pct}%`)
  if (topDivergence) vetoes.push('MACD 顶背离')
  if (bullTrap) vetoes.push('存在诱多信号')
  // 龙虎榜：机构净卖出是明确的负面信号
  if (lhbAnalysis?.available && Number.isFinite(lhbAnalysis.institutionNet) && lhbAnalysis.institutionNet < -5e7) {
    vetoes.push(`龙虎榜机构净卖出 ${(Math.abs(lhbAnalysis.institutionNet) / 1e4).toFixed(0)} 万`)
  }
  // 筹码：获利盘极高 + 平均成本上移 = 高位派发
  if (chipAnalysis?.available && Number.isFinite(chipAnalysis.profitRate) && chipAnalysis.profitRate >= 90
      && Number.isFinite(chipAnalysis.trend?.avgCostChange) && chipAnalysis.trend.avgCostChange > 20) {
    vetoes.push('筹码高位换手（平均成本大幅上移 + 获利盘>90%）')
  }
  // 一字板 / 连板：不可交易或开板即派发
  if (limitPattern?.available) {
    if (limitPattern.consecutiveOneWord >= 3) {
      vetoes.push(`连续 ${limitPattern.consecutiveOneWord} 个一字板（无法买入，开板即高位）`)
    }
    if (limitPattern.openedAfter && Number.isFinite(limitPattern.openDayInfo?.turnover)
        && limitPattern.openDayInfo.turnover >= 15) {
      vetoes.push(`开板日巨量派发（换手 ${limitPattern.openDayInfo.turnover}%）`)
    }
  }
  // 监管介入
  if (regulatory?.available && regulatory.level === 'fatal') {
    vetoes.push(`监管介入：${regulatory.summary}`)
  }
  // 财务警示：作为否决项参与判断，而不是无条件一票否决技术面
  if (risk.level === 'severe') {
    const labels = [...new Set([...(risk.severe ?? []), ...(risk.fatal ?? [])].map(x => x.label).filter(Boolean))]
    vetoes.push(`财务警示（${labels.slice(0, 3).join('、') || '见公告'}）`)
  }

  let verdict
  let verdictLevel
  if (excluded.length > 0) {
    verdict = '回避'
    verdictLevel = 'avoid'
  } else if (risk.level === 'fatal') {
    verdict = '回避（财务/合规重大风险）'
    verdictLevel = 'avoid'
  } else if (candidate.status === 'exit') {
    verdict = risk.level === 'severe' ? '清仓（叠加财务警示）' : '清仓'
    verdictLevel = 'exit'
  } else if (candidate.status === 'buy') {
    // 超买 / 严重偏离 / 顶背离 / 诱多 / 机构出货 / 财务警示 时，即使技术面给买点也不建议追
    if (vetoes.length > 0) {
      verdict = `不建议追高（技术面买点，但${vetoes.join('、')}）`
      verdictLevel = 'watch'
    } else {
      verdict = '买入（符合战法买点）'
      verdictLevel = 'buy'
    }
  } else if (candidate.status === 'hold') {
    verdict = vetoes.length > 0 ? `持有但不加仓（${vetoes.join('、')}）` : '持有'
    verdictLevel = 'hold'
  } else if (candidate.status === 'bigcandle') {
    verdict = vetoes.length > 0
      ? `观察，不追高（${vetoes.join('、')}）`
      : '观察（大阳线待回踩，不追高）'
    verdictLevel = 'watch'
  } else {
    verdict = vetoes.length > 0 ? `观察（${vetoes.join('、')}）` : '观察（条件不满足）'
    verdictLevel = 'watch'
  }

  // 买点
  const buyPoints = []
  if (Number.isFinite(ma5)) buyPoints.push({ price: Math.round(ma5 * 100) / 100, basis: '回踩MA5缩量不破', type: 'primary' })
  if (Number.isFinite(ma10)) buyPoints.push({ price: Math.round(ma10 * 100) / 100, basis: '回踩MA10', type: 'secondary' })
  if (Number.isFinite(m.chipAvgCost)) buyPoints.push({ price: m.chipAvgCost, basis: '筹码平均成本区', type: 'support' })

  // 卖点/止损
  // 注意：close 来自 metrics.close（已做 2 位小数舍入），直接用可能导致止损位精度丢失
  const realClose = Number.isFinite(quote?.price) && quote.price > 0 ? quote.price : close
  const stopLoss = Math.round(realClose * (1 - stopPct / 100) * 100) / 100
  const targets = []
  if (Number.isFinite(ma20) && ma20 > realClose) targets.push({ price: Math.round(ma20 * 100) / 100, basis: 'MA20 压力位' })
  const recentHigh = Math.max(...bars.slice(-20).map(b => b.high))
  if (Number.isFinite(recentHigh) && recentHigh > realClose) {
    targets.push({ price: Math.round(recentHigh * 100) / 100, basis: '近20日高点' })
  }
  if (Number.isFinite(m.chipAvgCost) && m.chipAvgCost > realClose) {
    targets.push({ price: m.chipAvgCost, basis: '筹码成本（套牢区）' })
  }

  // 关键风险
  const keyRisks = []
  if (excluded.length > 0) keyRisks.push(...excluded)
  if (risk.level === 'fatal') keyRisks.push(`存在 ${risk.fatal.length} 条重大风险公告`)
  if (risk.level === 'severe') {
    const labels = [...new Set([...(risk.severe ?? []), ...(risk.fatal ?? [])].map(x => x.label).filter(Boolean))]
    keyRisks.push(`财务警示：${labels.slice(0, 4).join('、') || `共 ${risk.severe.length} 条`}`)
  }
  if (!tradability.tradable) keyRisks.push(`不可交易：${tradability.reason}`)
  if (marketEnv && marketEnv.ok === false) keyRisks.push(marketEnv.reason)

  // 技术形态风险
  if (topDivergence) keyRisks.push(`MACD 顶背离：${macdAnalysis.divergence.detail}`)
  if (macdAnalysis?.barTrend === 'green_expanding') keyRisks.push('MACD 绿柱持续放大，空头动能增强')
  if (candleAnalysis?.candleType === 'false_bullish') keyRisks.push(`假阳线：${candleAnalysis.candleReason}`)
  if (candleAnalysis?.candleType === 'bull_trap') keyRisks.push(`诱多形态：${candleAnalysis.candleReason}`)
  if (candleAnalysis?.trapSignals?.length > 0) keyRisks.push(...candleAnalysis.trapSignals.slice(0, 2))
  // 龙虎榜风险
  if (lhbAnalysis?.available) {
    if (Number.isFinite(lhbAnalysis.institutionNet) && lhbAnalysis.institutionNet < 0) {
      keyRisks.push(`龙虎榜机构净卖出 ${(Math.abs(lhbAnalysis.institutionNet) / 1e4).toFixed(0)} 万`)
    }
    if (Number.isFinite(lhbAnalysis.netBuy) && lhbAnalysis.netBuy < 0) {
      keyRisks.push(`龙虎榜整体净卖出 ${(Math.abs(lhbAnalysis.netBuy) / 1e4).toFixed(0)} 万`)
    }
  }
  // 筹码风险
  if (chipAnalysis?.available) {
    if (Number.isFinite(chipAnalysis.profitRate) && chipAnalysis.profitRate >= 90) {
      keyRisks.push(`获利盘 ${chipAnalysis.profitRate}%，浮盈高度集中`)
    }
    if (chipAnalysis.trend?.notes?.length > 0) keyRisks.push(...chipAnalysis.trend.notes)
  }
  // 极端形态风险
  if (limitPattern?.risks?.length > 0) keyRisks.push(...limitPattern.risks)
  if (regulatory?.available && regulatory.level === 'fatal') {
    keyRisks.push(regulatory.summary)
  }

  for (const r of (candidate.risks ?? []).slice(0, 5)) keyRisks.push(r)

  // 仓位建议
  let positionAdvice = `建议单只不超过总仓位 ${maxWeight}%`
  if (tier === '小盘' || tier === '微盘') positionAdvice += '（小盘股波动大，建议分 2-3 次建仓）'
  if (verdictLevel === 'avoid') positionAdvice = '不建议建仓'

  return {
    verdict,
    verdictLevel,
    positionAdvice,
    buyPoints: buyPoints.length > 0 ? buyPoints : undefined,
    stopLoss,
    stopLossBasis: `现价 -${stopPct}%（${tier ?? '默认'}档参数）`,
    targets: targets.length > 0 ? targets : undefined,
    keyRisks: [...new Set(keyRisks)].slice(0, 8),
  }
}

/**
 * 把分析结果渲染成 Markdown 报告。
 */
export function renderAnalysisMarkdown(r) {
  if (r.error) return `## ❌ 分析失败\n\n${r.error}`
  const L = []
  const s = r.stock
  const t = r.technical
  const a = r.advice

  L.push(`# ${s.name}（${s.code}）分析报告`)
  L.push('')
  L.push(`> 数据日期 ${r.dataDate} ｜ 生成于 ${r.asOf.slice(0, 19).replace('T', ' ')}`)
  L.push('')

  // 结论
  const icon = { buy: '🟢', hold: '🔵', watch: '🟡', exit: '🔴', avoid: '⛔' }[a.verdictLevel] ?? '⚪'
  L.push(`## ${icon} 结论：${a.verdict}`)
  L.push('')
  L.push(`**${a.positionAdvice}**`)
  L.push('')

  // 基本信息
  L.push('## 一、基本信息')
  L.push('')
  L.push('| 项目 | 数值 |')
  L.push('| --- | --- |')
  L.push(`| 现价 | ${s.price ?? '-'} ${Number.isFinite(s.changePct) ? `(${s.changePct > 0 ? '+' : ''}${s.changePct}%)` : ''} |`)
  if (Number.isFinite(s.totalCap)) L.push(`| 总市值 | ${s.totalCap.toFixed(1)} 亿 |`)
  if (Number.isFinite(s.floatCap)) L.push(`| 流通市值 | ${s.floatCap.toFixed(1)} 亿 |`)
  L.push(`| **市值分档** | **${s.tier ?? '未知'}**${s.tierNote ? `（${s.tierNote}）` : ''} |`)
  if (Number.isFinite(s.pe)) L.push(`| PE | ${s.pe.toFixed(1)}${s.pe < 0 ? ' ⚠️亏损' : ''} |`)
  if (Number.isFinite(s.pb)) L.push(`| PB | ${s.pb.toFixed(2)} |`)
  if (s.industry) L.push(`| 所属行业 | ${s.industry} |`)
  if (Number.isFinite(s.turnover)) L.push(`| 换手率 | ${s.turnover}% |`)
  L.push('')

  // 剔除提示
  if (r.excluded?.length > 0) {
    L.push('## ⛔ 剔除原因')
    L.push('')
    for (const e of r.excluded) L.push(`- ${e}`)
    L.push('')
  }

  // 财务风险
  L.push('## 二、财务与合规风险')
  L.push('')
  const levelLabel = { none: '✅ 未发现明显风险', warning: '🟡 需关注', severe: '🟠 高度警惕', fatal: '🔴 重大风险' }
  L.push(`**综合评估：${levelLabel[r.risk.level] ?? r.risk.level}**（扫描 ${r.risk.announcementCount} 条公告）`)
  L.push('')
  if (r.risk.fatal.length > 0) {
    L.push('**🔴 重大风险公告：**')
    for (const x of r.risk.fatal) L.push(`- ${x}`)
    L.push('')
  }
  if (r.risk.severe.length > 0) {
    L.push('**🟠 财务/合规警示：**')
    for (const x of r.risk.severe.slice(0, 8)) L.push(`- ${x}`)
    L.push('')
  }
  if (r.risk.warning.length > 0) {
    L.push('**🟡 其他需关注：**')
    for (const x of r.risk.warning) L.push(`- ${x}`)
    L.push('')
  }

  // 技术面
  L.push('## 三、技术面')
  L.push('')
  const mm = t.metrics ?? {}
  L.push('| 指标 | 数值 |')
  L.push('| --- | --- |')
  L.push(`| 状态 | ${t.status} |`)
  L.push(`| 综合评分 | **${t.score}** / 100 |`)
  if (Number.isFinite(mm.ma5)) L.push(`| MA5 / MA10 / MA20 | ${mm.ma5} / ${mm.ma10 ?? '-'} / ${mm.ma20 ?? '-'} |`)
  if (Number.isFinite(mm.deviationMa5Pct)) L.push(`| 偏离MA5 | ${mm.deviationMa5Pct > 0 ? '+' : ''}${mm.deviationMa5Pct}% |`)
  if (Number.isFinite(mm.belowMa5Days)) L.push(`| 连续跌破MA5 | ${mm.belowMa5Days} 天 |`)
  if (mm.bigCandle) L.push(`| 最近大阳线 | ${mm.bigCandle.changePct}%（${mm.bigCandle.barsAgo}日前）量比${mm.bigCandle.amountRatio ?? '-'} |`)
  if (Number.isFinite(mm.chipProfitRate)) L.push(`| 获利盘 | ${mm.chipProfitRate}% |`)
  if (Number.isFinite(mm.chipAvgCost)) L.push(`| 筹码平均成本 | ${mm.chipAvgCost} |`)
  if (Number.isFinite(mm.mainNetFlow)) L.push(`| 主力当日 | ${formatMoney(mm.mainNetFlow)} |`)
  if (Number.isFinite(mm.mainNetFlow5D)) L.push(`| 主力5日 | ${formatMoney(mm.mainNetFlow5D)} |`)
  L.push('')

  if (t.breakdown) {
    L.push('**各因子得分（50=中性）：**')
    L.push('')
    L.push('| ' + Object.keys(t.breakdown).join(' | ') + ' |')
    L.push('|' + Object.keys(t.breakdown).map(() => ' --- ').join('|') + '|')
    L.push('| ' + Object.values(t.breakdown).join(' | ') + ' |')
    L.push('')
  }

  // ---- MACD 深度分析 ----
  const macd = t.macd
  if (macd?.available) {
    L.push('### MACD 分析')
    L.push('')
    L.push('| 项目 | 数值 |')
    L.push('| --- | --- |')
    L.push(`| DIF / DEA / 柱 | ${macd.dif} / ${macd.dea} / **${macd.macd}** |`)
    L.push(`| 状态 | **${macd.statusLabel}**${Number.isFinite(macd.daysSinceCross) ? `（${macd.crossType === 'golden' ? '金叉' : '死叉'}后第 ${macd.daysSinceCross} 日，${macd.crossDate}）` : ''} |`)
    L.push(`| 柱体趋势 | ${macd.barTrendLabel} |`)
    L.push(`| 零轴位置 | ${macd.zeroAxis === 'above' ? '零轴上方（强势）' : macd.zeroAxis === 'below' ? '零轴下方（弱势）' : '穿越零轴'} |`)
    L.push(`| DIF-DEA 差 | ${macd.diffNow} |`)
    L.push('')
    if (macd.barSeq?.length > 1) {
      L.push(`**近 6 日柱体：** ${macd.barSeq.join(' → ')}`)
      L.push('')
    }
    if (macd.divergence) {
      const isTop = macd.divergence.type === 'top'
      L.push(`${isTop ? '🔴 **顶背离**' : '🟢 **底背离**'}：${macd.divergence.detail}`)
      L.push('')
    }
  }

  // ---- K 线形态（真假阳线 / 诱多）----
  const cd = t.candle
  if (cd?.available) {
    L.push('### K 线形态与真假阳线')
    L.push('')
    L.push('| 项目 | 数值 |')
    L.push('| --- | --- |')
    L.push(`| 涨跌幅 / 振幅 | ${cd.changePct > 0 ? '+' : ''}${cd.changePct}% / ${cd.amplitude}% |`)
    L.push(`| **量比** | **${cd.volumeRatio}** |`)
    L.push(`| 收盘位置 | 当日 ${cd.closePosition}% 处 |`)
    L.push(`| 上影线 / 下影线 | ${cd.upperShadowPct}% / ${cd.lowerShadowPct}% |`)
    if (cd.candleType) L.push(`| **判定** | **${cd.candleTypeLabel}** |`)
    L.push('')
    if (cd.candleReason) L.push(`> ${cd.candleReason}`)
    if (cd.candleReason) L.push('')
    if (cd.gap) {
      L.push(`**跳空${cd.gap.type === 'up' ? '向上' : '向下'}缺口**：${cd.gap.from} → ${cd.gap.to}`)
      L.push('')
    }
    if (cd.trapSignals?.length > 0) {
      L.push('**⚠️ 诱多信号：**')
      for (const x of cd.trapSignals) L.push(`- ${x}`)
      L.push('')
    }
  }

  // ---- 量能结构 ----
  const vp = t.volume
  if (vp?.available) {
    L.push('### 量能结构')
    L.push('')
    L.push(`- 今日成交额相对 20 日均量：**${vp.amountVsAvg20} 倍**`)
    L.push(`- 量价配合：**${vp.volPriceLabel}**`)
    L.push(`- 近 6 日涨跌幅：${vp.last6Changes.map(c => `${c > 0 ? '+' : ''}${c}%`).join(' → ')}`)
    L.push('')
  }

  // ---- 振荡指标 ----
  const osc = t.oscillators
  if (osc?.available) {
    L.push('### KDJ / RSI / BOLL / DMI')
    L.push('')
    L.push('| 指标 | 数值 | 判断 |')
    L.push('| --- | --- | --- |')
    if (Number.isFinite(osc.k)) L.push(`| KDJ | K ${osc.k} / D ${osc.d} / J ${osc.j} | ${osc.kdjLabel}${osc.kdjOverbought ? ' ⚠️J值>100 超买' : ''}${osc.kdjOversold ? ' 🟢J值<0 超卖' : ''} |`)
    if (Number.isFinite(osc.rsi6)) L.push(`| RSI6 | ${osc.rsi6} | ${osc.rsi6Label} |`)
    if (Number.isFinite(osc.bollUpper)) L.push(`| BOLL | 上${osc.bollUpper} / 中${osc.bollMid} / 下${osc.bollLower} | ${osc.bollLabel}（位置 ${osc.bollPosition}%） |`)
    if (Number.isFinite(osc.adx)) L.push(`| DMI | ADX ${osc.adx} / +DI ${osc.pdi} / -DI ${osc.mdi} | ${osc.dmiLabel} |`)
    L.push('')
  }

  // ---- 龙虎榜 ----
  const lhb = r.lhb
  if (lhb?.available) {
    L.push('### 龙虎榜明细')
    L.push('')
    L.push(`**${lhb.date} 上榜** ｜ 原因：${lhb.reason ?? '-'}`)
    L.push('')
    L.push('| 项目 | 金额 |')
    L.push('| --- | --- |')
    if (Number.isFinite(lhb.totalBuy)) L.push(`| 买入合计 | ${(lhb.totalBuy / 1e4).toFixed(0)} 万 |`)
    if (Number.isFinite(lhb.totalSell)) L.push(`| 卖出合计 | ${(lhb.totalSell / 1e4).toFixed(0)} 万 |`)
    if (Number.isFinite(lhb.netBuy)) L.push(`| **净买卖** | **${(lhb.netBuy / 1e4).toFixed(0)} 万**（${lhb.netBuy > 0 ? '买方占优' : '卖方占优'}） |`)
    L.push('')
    if (lhb.institutionLabel) {
      L.push(`**机构动向**：${lhb.institutionLabel}`)
      L.push('')
    }
    if (lhb.hotMoney?.length > 0) {
      L.push('**游资席位：**')
      for (const h of lhb.hotMoney) L.push(`- ${h.tag}：${h.desc}`)
      L.push('')
    }
    if (lhb.topBuy?.length > 0) {
      L.push('**买入前 5：**')
      L.push('')
      L.push('| 营业部 | 净买入(万) | 标签 |')
      L.push('| --- | --- | --- |')
      for (const x of lhb.topBuy) L.push(`| ${x.name} | ${(x.net / 1e4).toFixed(0)} | ${x.tag ?? '-'} |`)
      L.push('')
    }
    if (lhb.topSell?.length > 0) {
      L.push('**卖出前 5：**')
      L.push('')
      L.push('| 营业部 | 净卖出(万) | 标签 |')
      L.push('| --- | --- | --- |')
      for (const x of lhb.topSell) L.push(`| ${x.name} | ${(Math.abs(x.net) / 1e4).toFixed(0)} | ${x.tag ?? '-'} |`)
      L.push('')
    }
  } else if (lhb?.reason) {
    L.push('### 龙虎榜')
    L.push('')
    L.push(`> ${lhb.reason}`)
    L.push('')
  }

  // ---- 详细筹码分布 ----
  const chip = r.chipDistribution
  if (chip?.available) {
    L.push('### 详细筹码分布')
    L.push('')
    L.push('| 项目 | 数值 |')
    L.push('| --- | --- |')
    L.push(`| 获利盘 / 套牢盘 | **${chip.profitRate}%** / ${chip.trappedRate}% |`)
    L.push(`| 平均成本 | ${chip.avgCost}（现价偏离 ${chip.gapToAvgCost > 0 ? '+' : ''}${chip.gapToAvgCost}%） |`)
    L.push(`| 90% 集中度 | ${chip.concentration90}（越小越集中） |`)
    L.push(`| 70% 集中度 | ${chip.concentration70} |`)
    L.push('')
    if (chip.level?.length > 0) {
      for (const x of chip.level) L.push(`- ${x}`)
      L.push('')
    }
    if (chip.trend) {
      const t = chip.trend
      L.push(`**筹码迁移（${t.from} ~ ${t.to}，${t.days} 个交易日）：**`)
      L.push('')
      L.push(`- 平均成本变化：**${t.avgCostChange > 0 ? '+' : ''}${t.avgCostChange}%**`)
      L.push(`- 获利盘变化：${t.profitRateChange > 0 ? '+' : ''}${t.profitRateChange} 个百分点`)
      L.push(`- 集中度变化：${t.concentrationChange > 0 ? '+' : ''}${t.concentrationChange}`)
      L.push('')
      if (t.notes?.length > 0) {
        for (const x of t.notes) L.push(`> ⚠️ ${x}`)
        L.push('')
      }
      if (t.sample?.length > 0) {
        L.push('**近期筹码变化：**')
        L.push('')
        L.push('| 日期 | 获利盘% | 平均成本 | 90%集中度 |')
        L.push('| --- | --- | --- | --- |')
        for (const s of t.sample) L.push(`| ${s.date} | ${s.profitRate} | ${s.avgCost} | ${s.conc90} |`)
        L.push('')
      }
    }
  }

  // ---- 极端形态（一字板/连板/监管）----
  const lp = r.limitPattern
  const rg = r.regulatory
  if ((lp?.available && (lp.boardCount > 0 || lp.oneWordCount > 0)) || rg?.available) {
    L.push('### 极端形态与监管')
    L.push('')
    if (lp?.available && lp.boardCount > 0) {
      L.push('| 项目 | 数值 |')
      L.push('| --- | --- |')
      L.push(`| 近${lp.lookbackDays}日涨停次数 | **${lp.boardCount}** 次 |`)
      L.push(`| 其中一字板 | **${lp.oneWordCount}** 个 |`)
      if (lp.consecutiveOneWord > 0) L.push(`| **连续一字板** | **${lp.consecutiveOneWord}** 个 |`)
      if (Number.isFinite(lp.cumulativeGain)) L.push(`| 累计涨幅 | **${lp.cumulativeGain > 0 ? '+' : ''}${lp.cumulativeGain}%** |`)
      if (lp.openedAfter && lp.openDayInfo) {
        L.push(`| 开板日 | ${lp.openDayInfo.date}（换手 ${lp.openDayInfo.turnover}%，成交 ${(lp.openDayInfo.amount / 1e8).toFixed(1)} 亿） |`)
      }
      L.push('')
      if (lp.boards?.length > 0) {
        L.push('**近期涨停记录：**')
        L.push('')
        L.push('| 日期 | 涨幅 | 振幅 | 一字板 |')
        L.push('| --- | --- | --- | --- |')
        for (const b of lp.boards.slice(-8)) {
          L.push(`| ${b.date} | +${b.chg}% | ${b.amp}% | ${b.oneWord ? '**是**' : '否'} |`)
        }
        L.push('')
      }
    }
    if (rg?.available) {
      L.push(`**监管状态：${rg.level === 'fatal' ? '🔴' : '🟠'} ${rg.summary}**`)
      L.push('')
      L.push('| 日期 | 类型 | 公告 |')
      L.push('| --- | --- | --- |')
      for (const h of rg.hits) {
        L.push(`| ${h.date} | ${h.label} | ${h.title.slice(0, 40)} |`)
      }
      L.push('')
    }
  }

  // 买卖建议
  L.push('## 四、买卖建议')
  L.push('')
  if (a.buyPoints?.length > 0) {
    L.push('**买入参考位：**')
    for (const p of a.buyPoints) L.push(`- ${p.price} ｜ ${p.basis}`)
    L.push('')
  }
  L.push(`**止损位：${a.stopLoss}**（${a.stopLossBasis}）`)
  L.push('')
  if (a.targets?.length > 0) {
    L.push('**卖出参考位：**')
    for (const p of a.targets) L.push(`- ${p.price} ｜ ${p.basis}`)
    L.push('')
  }

  // 风险
  if (a.keyRisks?.length > 0) {
    L.push('## 五、关键风险')
    L.push('')
    for (const x of a.keyRisks) L.push(`- ⚠️ ${x}`)
    L.push('')
  }

  if (r.warnings?.length > 0) {
    L.push('> 数据提示：' + r.warnings.join('；'))
    L.push('')
  }
  L.push('---')
  L.push('> 本报告为基于公开数据的规则化统计，不构成投资建议。')
  return L.join('\n')
}
