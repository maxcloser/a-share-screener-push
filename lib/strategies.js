/**
 * 选股策略引擎（纯函数，不做 IO）。
 *
 * 核心「5日均线战法」口诀：
 *   1. 没5%以上大阳线不参与，阳线是主力信号
 *   2. 大阳线后回落碰5日线没跌破就买入
 *   3. 股价远离5日线时减半仓，回调贴近再接回
 *   4. 收盘跌破5日线立刻减半仓，重回再补
 *   5. 跌破后三天站不回就清仓
 */

export const DEFAULT_PARAMETERS = {
  // 口诀第1条
  bigCandlePct: 5,
  bigCandleLookback: 20,
  /** 口诀1 量能确认：大阳线当日成交额 ≥ 前5日均量 × 该倍数，否则视为「假阳线」不参与。 */
  bigCandleVolumeRatio: 1.5,
  // 口诀第2条
  touchTolerancePct: 1,
  maxRunUpPct: 12,
  requireHoldMa5: true,
  /** 口诀2 缩量确认：回踩日成交额 ≤ 前5日均量 × 该倍数才算健康回踩。 */
  pullbackVolumeRatio: 0.8,
  // 口诀第3条
  farAboveMa5Pct: 8,
  // 口诀第4/5条
  exitGraceDays: 3,
  /** P0-② 硬止损：自大阳线收盘价回撤该百分比即清仓。回测显示 -5% 优于「破MA5离场」。 */
  hardStopPct: 5,
  /** P0-② 时间止损：大阳线后持有超过该交易日数仍未盈利则离场。 */
  holdingDays: 10,
  /** 旧的固定止损参考（仅用于展示止损位，不参与离场判定）。 */
  stopLossPct: 5,
  /**
   * P0-① 大盘空头时是否屏蔽买点。
   *
   * ⚠️ 默认 **false**（不屏蔽）。原因：在**行业均衡样本**（463 只 / 28 行业）上回测发现，
   * 大盘在 MA20 下方时的买点信号平均收益反而更高（+2.07% vs 多头期 -0.28%），
   * 开启屏蔽会让超额收益从 +0.45% 掉到 -0.87%。
   *
   * 早期「-1.66%」的结论来自有偏样本（127 只、54% 是电力设备/电子/医药/军工），
   * 已作废。若你仍想用大盘择时，可将此项设为 true，但请知悉回测不支持。
   */
  blockBuyInBearMarket: false,
  // 可交易性（P0）
  /** 一字板判定：当日振幅 ≤ 该百分比视为一字/准一字板。 */
  limitUpAmplitudePct: 1,
  /** 高位连板：近 N 日内出现 ≥ 该数量的涨停视为高位连板股。 */
  consecutiveLimitLookback: 5,
  consecutiveLimitCount: 3,
  /** 涨停幅度判定阈值（主板10%、创业板/科创板20%，用当日涨幅近似）。 */
  limitUpPct: 9.8,
  // 大盘环境（P1）
  marketMaPeriod: 20,
  /**
   * 是否用大盘状态**过滤**买卖信号。
   *
   * ⚠️ 默认 **false**。均衡样本回测显示：把「大盘 MA20 下方」当作利空而压低信号，
   * 会让超额收益从 +0.45% 变成 -0.87%（大盘空头期的买点平均 +2.07%，反而更好）。
   * 大盘环境仍会**展示**在结果里作为参考，只是不再默认否决信号。
   */
  requireMarketUp: false,
  // 板块共振（P2）
  sectorTopN: 10,
  // 组合构建（P2-⑧）
  /** 同板块最多持有几只，用于控制相关性。 */
  maxPerSector: 2,
  /** 组合最多持有几只。 */
  maxHoldings: 5,
  /** 单票最大仓位（%）。 */
  maxSinglePositionPct: 30,
  // 量价 / 技术
  volumeRatio: 1.5,
  breakoutLookback: 20,
  rsiOverbought: 80,
  rsiOversold: 20,
  // 资金
  minMainNetFlow: 0,
  // 其它
  minBars: 25,
}

export const STRATEGY_IDS = ['ma5', 'technical', 'capital', 'volume', 'sector', 'fundamental', 'valuation', 'institution']

/**
 * P1-④ 评分权重（基于回测因子有效性重做）。
 *
 * 旧权重（ma5:45 / capital:20 / volume:15 / technical:10 / sector:6 / fundamental:4）
 * 的问题是：
 *   1. MA5 占 45% 过高 —— 回测显示 40-60 分区间超额为 -0.88%，说明战法信号被放大后反而有害；
 *   2. 资金流 20% —— asfund 的「主力净流入」在 A 股是滞后指标，拉高出货时反而显示流入；
 *   3. 基本面仅 4% —— 中期收益主要由基本面驱动，权重严重不足。
 *
 * 新权重思路：降低单一技术信号的支配地位，提高估值/基本面/资金质量的权重，
 * 让评分更接近「多因子共振」而不是「单一图形打分」。
 */
export const STRATEGY_WEIGHTS = {
  ma5: 30,
  volume: 15,
  capital: 12,
  technical: 10,
  sector: 8,
  fundamental: 10,
  valuation: 10,
  institution: 5,
}

export const SCREENS = ['all', 'buy', 'watch', 'exit', 'bigcandle', 'hold']

const round = (value, digits = 2) => {
  if (value === undefined || value === null || !Number.isFinite(value)) return undefined
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

const pct = (a, b) => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return undefined
  return ((a - b) / b) * 100
}

const mean = (values) => {
  const list = values.filter(Number.isFinite)
  if (list.length === 0) return undefined
  return list.reduce((sum, value) => sum + value, 0) / list.length
}

const sum = (values) => values.reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0)

export function mergeParameters(overrides = {}) {
  const merged = { ...DEFAULT_PARAMETERS }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined || value === null) continue
    merged[key] = value
  }
  return merged
}

/** 成交额均线（用于量能对比）。 */
function averageAmount(bars, endIndex, window) {
  const start = Math.max(0, endIndex - window + 1)
  const slice = bars.slice(start, endIndex + 1)
  return mean(slice.map(bar => bar.amount))
}

/**
 * 某根K线的「量比」：当日成交额 / 其前 window 日均成交额。
 * 注意分母只取该日之前的窗口，不含当日自身，避免自我稀释。
 */
export function amountRatio(bars, index, window = 5) {
  if (index < 1) return undefined
  const current = bars[index]?.amount
  if (!Number.isFinite(current) || current <= 0) return undefined
  const prevAvg = averageAmount(bars, index - 1, window)
  if (!Number.isFinite(prevAvg) || prevAvg <= 0) return undefined
  return current / prevAvg
}

/** 均线按收盘价序列计算（不复权口径，与 CLI 的 K 线一致）。 */
function movingAverage(bars, endIndex, window) {
  if (endIndex + 1 < window) return undefined
  const slice = bars.slice(endIndex + 1 - window, endIndex + 1)
  return mean(slice.map(bar => bar.close))
}

/**
 * 最近一次「5%以上大阳线」的位置（相对前一交易日收盘，而非今日收盘）。
 *
 * P0-① 量能确认：大阳线当日成交额必须 ≥ 前 5 日均量 × bigCandleVolumeRatio，
 * 否则标记 `volumeConfirmed: false`，由调用方降级为「假阳线，不参与」。
 */
function findBigCandle(bars, params) {
  const last = bars.length - 1
  const from = Math.max(1, last - params.bigCandleLookback + 1)
  for (let i = last; i >= from; i -= 1) {
    const bar = bars[i]
    const prev = bars[i - 1]
    if (!prev) continue
    const change = pct(bar.close, prev.close)
    if (change === undefined || change < params.bigCandlePct) continue
    const ratio = amountRatio(bars, i, 5)
    // 数据缺失时不做否决：宁可放行也不误杀（ratio 为 undefined 视为通过）
    const volumeConfirmed = ratio === undefined ? true : ratio >= params.bigCandleVolumeRatio
    return {
      index: i,
      date: bar.date,
      changePct: round(change),
      close: bar.close,
      barsAgo: last - i,
      high: bar.high,
      low: bar.low,
      open: bar.open,
      amountRatio: round(ratio),
      volumeConfirmed,
    }
  }
  return null
}

/** 口诀第 4/5 条：最近一次收盘跌破 MA5 后的连续天数。 */
function belowMa5Streak(bars) {
  let streak = 0
  for (let i = bars.length - 1; i >= 1; i -= 1) {
    const ma5 = movingAverage(bars, i, 5)
    if (ma5 === undefined) break
    if (bars[i].close < ma5) {
      streak += 1
      continue
    }
    break
  }
  return streak
}

/**
 * P0-③ 可交易性判定：剔除买不进/高位接盘的形态。
 *
 * - 一字板：振幅极小且涨停 → 根本买不进，次日开板即出货
 * - 高位连板：近 N 日出现多次涨停 → 处于加速末端，风险收益比差
 * - 停牌/无成交：amount 为 0
 */
export function evaluateTradability(bars, params) {
  const signals = []
  const risks = []
  const last = bars.length - 1
  const today = bars[last]
  if (!today) return { tradable: false, reason: '无K线数据', signals, risks, metrics: {} }

  const prev = bars[last - 1]
  const changePct = pct(today.close, prev?.close)
  const amplitude = Number.isFinite(today.high) && Number.isFinite(today.low) && Number.isFinite(prev?.close) && prev.close > 0
    ? ((today.high - today.low) / prev.close) * 100
    : undefined

  // 无成交 / 停牌
  if (!Number.isFinite(today.amount) || today.amount <= 0) {
    return { tradable: false, reason: '当日无成交（疑似停牌）', signals, risks, metrics: { changePct: round(changePct) } }
  }

  // 一字板：涨停 + 振幅极小
  const isLimitUp = Number.isFinite(changePct) && changePct >= params.limitUpPct
  if (isLimitUp && amplitude !== undefined && amplitude <= params.limitUpAmplitudePct) {
    return {
      tradable: false,
      reason: `一字板涨停（振幅 ${round(amplitude)}%）：买不进，次日开板多为出货`,
      signals,
      risks,
      metrics: { changePct: round(changePct), amplitude: round(amplitude), limitUp: true },
    }
  }

  // 高位连板：近 N 日涨停次数
  const from = Math.max(1, last - params.consecutiveLimitLookback + 1)
  let limitUpDays = 0
  for (let i = from; i <= last; i += 1) {
    const dayChange = pct(bars[i].close, bars[i - 1]?.close)
    if (Number.isFinite(dayChange) && dayChange >= params.limitUpPct) limitUpDays += 1
  }
  if (limitUpDays >= params.consecutiveLimitCount) {
    return {
      tradable: false,
      reason: `近${params.consecutiveLimitLookback}日出现 ${limitUpDays} 次涨停，属高位连板，追高风险极大`,
      signals,
      risks,
      metrics: { changePct: round(changePct), limitUpDays, amplitude: round(amplitude) },
    }
  }

  if (limitUpDays > 0) {
    risks.push(`近${params.consecutiveLimitLookback}日有 ${limitUpDays} 次涨停，注意高位波动`)
  }

  return {
    tradable: true,
    reason: undefined,
    signals,
    risks,
    metrics: { changePct: round(changePct), amplitude: round(amplitude), limitUpDays },
  }
}

/**
 * P1-⑤ 价格止损位。
 *
 * 取三个候选中的最高者（最贴近现价 = 最早离场 = 亏损最小）：
 *   1. 大阳线当日最低点（跌破即说明大阳线被完全吞掉）
 *   2. 大阳线实体中位（open/close 中点）
 *   3. 现价 × (1 - stopLossPct%)
 */
export function computeStopLoss(big, close, params) {
  const candidates = []
  if (big && Number.isFinite(big.low) && big.low > 0) {
    candidates.push({ price: big.low, basis: '大阳线最低点' })
  }
  if (big && Number.isFinite(big.open) && Number.isFinite(big.close)) {
    const mid = (big.open + big.close) / 2
    if (mid > 0) candidates.push({ price: mid, basis: '大阳线实体中位' })
  }
  if (Number.isFinite(close) && close > 0) {
    candidates.push({ price: close * (1 - params.stopLossPct / 100), basis: `现价-${params.stopLossPct}%` })
  }
  if (candidates.length === 0) return undefined
  const best = candidates.reduce((a, b) => (b.price > a.price ? b : a))
  return { price: round(best.price), basis: best.basis }
}

/**
 * P1-④ 大盘环境过滤。
 *
 * @param {object} marketBars 指数日K（如 sh000001）
 * @returns {{ ok: boolean, reason?: string, metrics: object }}
 */
export function evaluateMarket(marketBars, params) {
  if (!Array.isArray(marketBars) || marketBars.length < params.marketMaPeriod + 1) {
    // 拿不到指数数据时不阻塞信号，只记录
    return { ok: true, unknown: true, reason: '未取到大盘数据，跳过环境过滤', metrics: {} }
  }
  const last = marketBars.length - 1
  const close = marketBars[last].close
  const ma = movingAverage(marketBars, last, params.marketMaPeriod)
  const prevMa = movingAverage(marketBars, last - 1, params.marketMaPeriod)
  if (!Number.isFinite(ma)) {
    return { ok: true, unknown: true, reason: '大盘均线不足，跳过环境过滤', metrics: {} }
  }
  const deviation = pct(close, ma)
  const maRising = Number.isFinite(prevMa) ? ma >= prevMa : undefined
  const ok = close >= ma && (maRising === undefined ? true : maRising)
  return {
    ok,
    reason: ok
      ? `大盘站上MA${params.marketMaPeriod}（偏离 ${round(deviation)}%）`
      : `大盘在MA${params.marketMaPeriod}下方或走平（偏离 ${round(deviation)}%）`,
    metrics: {
      indexClose: round(close),
      indexMa: round(ma),
      indexDeviationPct: round(deviation),
      indexMaRising: maRising,
    },
  }
}

/**
 * 5 日均线战法主评分。
 * 返回 { score(0-100), status, signals[], risks[], metrics{} }
 */
export function evaluateMa5(bars, params) {
  const signals = []
  const risks = []
  const last = bars.length - 1
  const today = bars[last]
  if (!today) {
    return { score: 0, status: 'data_missing', signals, risks: ['无K线数据'], metrics: {} }
  }

  const ma5 = movingAverage(bars, last, 5)
  const ma10 = movingAverage(bars, last, 10)
  const ma20 = movingAverage(bars, last, 20)
  const prev = bars[last - 1]
  const changePct = pct(today.close, prev?.close)
  const deviation = ma5 === undefined ? undefined : pct(today.close, ma5)
  const streak = belowMa5Streak(bars)
  const big = findBigCandle(bars, params)

  const recentHigh = Math.max(...bars.slice(Math.max(0, last - 19), last + 1).map(bar => bar.high))

  let score = 0
  let status = 'neutral'

  // ---- P0-② 离场规则（基于回测重构） ----
  // 回测结论：原「跌破MA5立即离场」胜率仅 30.2%（A股日内波动大，MA5被反复穿越），
  // 而「-5%硬止损 + 10日时间止损」胜率 45.2%、均值 +1.97%，显著优于前者。
  // 因此这里把 MA5 跌破降级为「减仓提示」，真正的离场由硬止损/时间止损决定。
  let exitTriggered = false
  let hardStopTriggered = false

  // 硬止损：从大阳线收盘价（买入参考价）回撤 ≥ stopLossPct
  if (big && big.barsAgo > 0 && Number.isFinite(big.close) && big.close > 0) {
    const drawdownFromEntry = pct(today.close, big.close)
    if (drawdownFromEntry !== undefined && drawdownFromEntry <= -params.hardStopPct) {
      exitTriggered = true
      hardStopTriggered = true
      signals.push(
        `硬止损触发：自大阳线收盘 ${round(big.close)} 回撤 ${round(drawdownFromEntry)}%（阈值 -${params.hardStopPct}%）→ 清仓`,
      )
      score -= 45
    }
  }

  // 时间止损：大阳线后超过 holdingDays 仍未盈利 → 离场
  if (big && big.barsAgo >= params.holdingDays && !exitTriggered) {
    const ret = pct(today.close, big.close)
    if (ret !== undefined && ret <= 0) {
      exitTriggered = true
      signals.push(
        `时间止损触发：大阳线后已 ${big.barsAgo} 个交易日（上限 ${params.holdingDays}）仍未盈利（${round(ret)}%）→ 离场`,
      )
      score -= 35
    }
  }

  // 口诀4/5：跌破 MA5 —— 降级为减仓提示，不再直接清仓
  if (!exitTriggered) {
    if (streak >= params.exitGraceDays) {
      // 连续跌破3日且未站回，配合弱势才清仓
      const ma5Weak = ma5 !== undefined && ma20 !== undefined && ma5 < ma20
      if (ma5Weak) {
        exitTriggered = true
        signals.push(`口诀5触发：收盘已连续 ${streak} 天处于5日线下方且MA5<MA20 → 清仓`)
        score -= 40
      } else {
        risks.push(`已连续 ${streak} 天跌破5日线，但MA5仍在MA20上方 → 减半仓观察，暂不清仓`)
        score -= 15
      }
    } else if (streak === 2) {
      risks.push('口诀4跟进：已跌破5日线2天，明日若仍站不回则考虑减仓')
      score -= 18
    } else if (streak === 1) {
      risks.push('口诀4触发：今日收盘跌破5日线 → 减半仓（非清仓）')
      score -= 10
    }
  }

  // 硬止损 / 时间止损一旦触发，直接进入清仓状态
  if (exitTriggered) status = 'exit'

  // ---- 口诀第 1 条：5% 以上大阳线是主力信号（P0-① 需量能确认） ----
  const freshBigCandle = Boolean(big && big.barsAgo === 0)
  const bigCandleVolumeOk = Boolean(big && big.volumeConfirmed)
  if (big && bigCandleVolumeOk) {
    score += 22
    const label = freshBigCandle ? '今日' : `${big.barsAgo}个交易日前`
    signals.push(`口诀1满足：${label}出现大阳线 +${big.changePct}%（${big.date}），量比 ${big.amountRatio ?? '-'} 倍（≥${params.bigCandleVolumeRatio}）`)
  } else if (big && !bigCandleVolumeOk) {
    // 有涨幅但没量：假阳线，按口诀1「不参与」处理
    score -= 20
    risks.push(
      `口诀1否决：${big.date} 大阳线 +${big.changePct}% 但成交额仅为前5日均量的 ${big.amountRatio ?? '-'} 倍`
      + `（要求 ≥${params.bigCandleVolumeRatio} 倍）→ 假阳线，不参与`,
    )
  } else {
    risks.push(`近${params.bigCandleLookback}日无5%以上大阳线 → 口诀1：不参与`)
    score -= 20
  }

  // 大阳线有效（含量能确认）才允许进入口诀2的买点判定
  const bigValid = Boolean(big && bigCandleVolumeOk)

  // ---- 口诀第 2 条：回踩5日线不破 = 买点（P0-② 需缩量确认） ----
  let pullbackVolumeOk = true
  let pullbackRatio
  if (ma5 !== undefined && deviation !== undefined) {
    const low = today.low ?? today.close
    const touchedMa5 = low <= ma5 * (1 + params.touchTolerancePct / 100) || today.close <= ma5 * (1 + params.touchTolerancePct / 100)
    const holding = today.close >= ma5
    const runUpFromBig = big && bars[big.index] ? pct(today.close, bars[big.index].close) : undefined

    // P0-② 缩量确认：回踩日成交额 ≤ 前5日均量 × pullbackVolumeRatio
    pullbackRatio = amountRatio(bars, last, 5)
    pullbackVolumeOk = pullbackRatio === undefined ? true : pullbackRatio <= params.pullbackVolumeRatio

    const buyPattern = bigValid && big.barsAgo > 0 && holding && touchedMa5
      && (runUpFromBig === undefined || runUpFromBig <= params.maxRunUpPct)

    if (buyPattern && pullbackVolumeOk) {
      status = 'buy'
      score += 34
      signals.push(
        `口诀2满足：大阳线后回踩5日线未跌破（最低 ${round(low)} vs MA5 ${round(ma5)}），`
        + `且回踩缩量至 ${round(pullbackRatio)} 倍（≤${params.pullbackVolumeRatio}）→ 健康回踩买点`,
      )
    } else if (buyPattern && !pullbackVolumeOk) {
      // 价格形态到位但放量下跌：是出货不是回踩
      status = exitTriggered ? 'exit' : 'watch'
      score += 4
      risks.push(
        `口诀2否决：回踩5日线但放量下跌（量比 ${round(pullbackRatio)} 倍 > ${params.pullbackVolumeRatio}）`
        + '→ 疑似出货，等缩量企稳再介入',
      )
    } else if (bigValid && big.barsAgo > 0 && holding && bars[big.index] && today.low <= bars[big.index].high * 0.98) {
      // 已从大阳线回落但尚未贴近5日线：等待回踩
      status = exitTriggered ? 'exit' : 'watch'
      score += 16
      signals.push('大阳线后正在回落，尚未贴近5日线 → 等回踩MA5再动手')
    } else if (bigValid && big.barsAgo > 0 && holding) {
      status = exitTriggered ? 'exit' : 'hold'
      score += 10
      signals.push('站稳5日线，可继续持有，回踩再加')
    }
  }

  // 今日新出大阳线：口诀1信号成立，但尚无回踩，属于次日观察对象
  if (freshBigCandle && bigCandleVolumeOk && !exitTriggered && (status === 'neutral' || status === 'watch')) {
    status = 'bigcandle'
    score += 4
    risks.push('今日大阳线偏离5日线，次日观察回踩不破5日线再介入（口诀2）')
  }

  // ---- 口诀第 3 条：远离5日线 → 减半仓 ----
  if (deviation !== undefined) {
    if (deviation >= params.farAboveMa5Pct) {
      score += exitTriggered ? 8 : 16
      signals.push(`口诀3触发：偏离5日线 +${round(deviation)}%（阈值 ${params.farAboveMa5Pct}%）→ 减半仓，回调贴近再接回`)
      if (status === 'buy' || status === 'hold') status = 'watch'
    } else if (deviation >= 0 && deviation < params.farAboveMa5Pct) {
      score += 8
    }
  }

  // ---- 口诀第 4 条跟进：跌破后重新站回5日线 → 可补回 ----
  if (streak === 0 && last >= 1) {
    const prevMa5 = movingAverage(bars, last - 1, 5)
    if (prevMa5 !== undefined && ma5 !== undefined && bars[last - 1].close < prevMa5) {
      signals.push('口诀4跟进：今日重新站上5日线 → 仓位补回')
      score += 6
    }
  }

  // 均线多头排列作为辅助
  if (ma5 !== undefined && ma10 !== undefined && ma20 !== undefined) {
    if (ma5 > ma10 && ma10 > ma20) {
      score += 6
      signals.push('均线多头排列（MA5 > MA10 > MA20）')
    } else if (ma5 < ma20) {
      risks.push('MA5 仍在 MA20 下方，趋势未修复')
      score -= 4
    }
  }

  // 假阳线（未通过量能确认）不作为有效大阳线：不给止损位，也不参与买点
  const stopLoss = bigValid ? computeStopLoss(big, today.close, params) : undefined

  const metrics = {
    close: round(today.close),
    changePct: round(changePct),
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    deviationMa5Pct: round(deviation),
    belowMa5Days: streak,
    bigCandle: big
      ? {
        date: big.date,
        changePct: big.changePct,
        barsAgo: big.barsAgo,
        amountRatio: big.amountRatio,
        volumeConfirmed: big.volumeConfirmed,
      }
      : null,
    pullbackVolumeRatio: round(pullbackRatio),
    pullbackVolumeOk,
    stopLossPrice: stopLoss?.price,
    stopLossBasis: stopLoss?.basis,
    nearHigh20: recentHigh !== undefined && today.close >= recentHigh,
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score + 20))),
    status,
    signals,
    risks,
    metrics,
  }
}

/** 技术面：MACD 金叉/金叉初期、KDJ、RSI。 */
export function evaluateTechnical(tech, bars, params) {
  const signals = []
  const risks = []
  let score = 0
  if (!tech) return { score: 0, signals, risks, metrics: {} }

  const last = bars.length - 1
  const prev = bars[last - 1]
  if (!prev || !Number.isFinite(tech.dif) || !Number.isFinite(tech.dea)) {
    return { score: 0, signals: ['技术指标缺失'], risks, metrics: {} }
  }

  // 用 MA5/MA10 的变化近似前一日 DIF 之外的辅助：DIF 上穿 DEA 即金叉
  if (tech.dif > tech.dea) {
    score += 14
    if (Number.isFinite(tech.macd) && tech.macd > 0) {
      signals.push('MACD 金叉且红柱放大')
      score += 4
    } else {
      signals.push('MACD 处于 DIF > DEA（金叉状态）')
    }
    const ma5 = movingAverage(bars, last, 5)
    const ma10 = movingAverage(bars, last, 10)
    const prevMa5 = movingAverage(bars, last - 1, 5)
    const prevMa10 = movingAverage(bars, last - 1, 10)
    if (ma5 !== undefined && ma10 !== undefined && prevMa5 !== undefined && prevMa10 !== undefined
      && ma5 > ma10 && prevMa5 <= prevMa10) {
      score += 6
      signals.push('MA5 今日上穿 MA10')
    }
  } else {
    risks.push('MACD 处于死叉状态（DIF < DEA）')
    score -= 6
  }

  if (Number.isFinite(tech.rsi)) {
    if (tech.rsi >= params.rsiOverbought) {
      risks.push(`RSI6 ${round(tech.rsi, 1)} 超买，注意口诀3减仓`)
      score -= 4
    } else if (tech.rsi >= 50 && tech.rsi < 70) {
      score += 4
    } else if (tech.rsi <= params.rsiOversold) {
      signals.push(`RSI6 ${round(tech.rsi, 1)} 超卖`)
    }
  }

  return { score, signals, risks, metrics: { dif: round(tech.dif, 3), dea: round(tech.dea, 3), macd: round(tech.macd, 3), kdjK: round(tech.k, 1), kdjD: round(tech.d, 1), rsi6: round(tech.rsi, 1) } }
}

/** 资金面：主力净流入（当日与多日）。 */
export function evaluateCapital(flow, params) {
  const signals = []
  const risks = []
  let score = 0
  if (!flow) return { score: 0, signals: ['资金流向数据缺失'], risks, metrics: {} }

  const main = flow.mainNetFlow
  const main5 = flow.mainNetFlow5D
  if (!Number.isFinite(main)) return { score: 0, signals, risks: ['主力净流入缺失'], metrics: {} }

  if (main >= params.minMainNetFlow && main > 0) {
    score += 10
    signals.push(`主力当日净流入 ${formatMoney(main)}`)
    if (main >= 5e7) {
      score += 4
      signals.push('主力净流入 >5000万')
    }
  } else {
    risks.push(`主力当日净流出 ${formatMoney(main)}`)
    score -= 10
  }

  if (Number.isFinite(main5)) {
    if (main5 > 0) {
      score += 8
      signals.push(`主力5日累计净流入 ${formatMoney(main5)}`)
    } else {
      risks.push(`主力5日累计净流出 ${formatMoney(main5)}`)
      score -= 6
    }
  }
  if (Number.isFinite(flow.jumboNetFlow) && flow.jumboNetFlow > 0) score += 3

  return { score, signals, risks, metrics: { mainNetFlow: main, mainNetFlow5D: main5, jumboNetFlow: flow.jumboNetFlow } }
}

/** 量价：放量（成交额 vs 5日均量）与突破近 N 日高点。 */
export function evaluateVolume(bars, params) {
  const signals = []
  const risks = []
  let score = 0
  const last = bars.length - 1
  const today = bars[last]
  if (!today || last < 5) return { score: 0, signals, risks, metrics: {} }

  const prevAvg = averageAmount(bars, last - 1, 5)
  const volumeRatio = prevAvg && today.amount ? today.amount / prevAvg : undefined
  if (volumeRatio !== undefined) {
    if (volumeRatio >= params.volumeRatio * 1.5) {
      score += 10
      signals.push(`成交额放大 ${round(volumeRatio, 2)} 倍`)
    } else if (volumeRatio >= params.volumeRatio) {
      score += 6
      signals.push(`温和放量 ${round(volumeRatio, 2)} 倍`)
    } else if (volumeRatio < 0.7) {
      score -= 4
      risks.push(`成交额萎缩至均量的 ${round(volumeRatio, 2)} 倍`)
    }
  }

  const from = Math.max(0, last - params.breakoutLookback)
  const priorHigh = Math.max(...bars.slice(from, last).map(bar => bar.high))
  if (Number.isFinite(priorHigh) && today.close > priorHigh) {
    score += 8
    signals.push(`收盘突破近${params.breakoutLookback}日高点 ${round(priorHigh)}`)
  }

  if (Number.isFinite(today.turnover) && today.turnover > 0) {
    if (today.turnover >= 3 && today.turnover <= 15) score += 2
    if (today.turnover > 25) risks.push(`换手率 ${round(today.turnover, 2)}% 过高，警惕出货`)
  }

  return { score, signals, risks, metrics: { volumeRatio: round(volumeRatio, 2), turnover: round(today.turnover), priorHigh: round(priorHigh) } }
}

/**
 * P2-⑥ 板块共振：所属板块需进入当日涨幅前 N 名才加分。
 *
 * @param {Set<string>|string[]} boardNames 该股所属的热点板块名
 * @param {Map<string, number>} boardRanks 板块名 → 涨幅排名（1 起）
 * @param {object} params
 */
export function evaluateSector(boardNames, boardRanks, params) {
  const signals = []
  const list = boardNames ? [...boardNames] : []
  if (list.length === 0) return { score: 0, signals, metrics: {} }

  const topN = params?.sectorTopN ?? 10
  const ranked = list
    .map(name => ({ name, rank: boardRanks?.get?.(name) }))
    .filter(item => Number.isFinite(item.rank))
  const inTop = ranked.filter(item => item.rank <= topN)

  if (inTop.length > 0) {
    const best = inTop.reduce((a, b) => (b.rank < a.rank ? b : a))
    signals.push(`板块共振：${best.name} 位列当日涨幅第 ${best.rank} 名（前${topN}）`)
    return {
      score: Math.min(6, 3 + inTop.length),
      signals,
      metrics: { hotBoards: list.slice(0, 5), sectorRank: best.rank, sectorName: best.name, sectorResonance: true },
    }
  }

  if (ranked.length > 0) {
    const best = ranked.reduce((a, b) => (b.rank < a.rank ? b : a))
    return {
      score: 1,
      signals: [],
      metrics: { hotBoards: list.slice(0, 5), sectorRank: best.rank, sectorName: best.name, sectorResonance: false },
    }
  }

  // 有板块归属但拿不到排名：给基础分
  return {
    score: Math.min(3, list.length * 1.5),
    signals: [`所属板块：${list.slice(0, 3).join('、')}`],
    metrics: { hotBoards: list.slice(0, 5), sectorResonance: undefined },
  }
}

/** 基本面：业绩预告/财报披露与分红。 */
export function evaluateFundamental(info) {
  const signals = []
  const risks = []
  let score = 0
  if (info?.dividend) {
    score += 2
    signals.push(`有分红记录：${info.dividend}`)
  }
  if (info?.report) {
    score += 2
    signals.push(`财报披露：${info.report}`)
  }
  if (info?.disclosureDesc) {
    risks.push(info.disclosureDesc)
  }
  return { score, signals, risks, metrics: { dividend: info?.dividend, report: info?.report } }
}

/**
 * P2-⑤ 估值/筹码分位（V2：修复「假低位」误判）。
 *
 * 核心洞察：**「获利盘低」本身不是好消息**，必须结合「集中度」判断。
 *
 *   真低位：获利盘低 + 集中度低（筹码分散在不同价位，上方无密集解套盘）
 *   假低位：获利盘低 + 集中度高（绝大多数筹码堆在同一价位，价格反弹即遇解套抛压）
 *
 * 实例对比（实测）：
 *   澳洋健康 获利盘 1.08%、集中度 6.08（极集中）→ 全天 99% 套牢在 5.61，反弹即压制（真实 8.8% 暴跌）
 *   正邦科技 获利盘 8.76%、集中度 8.9（分散）  → 真低位
 *
 * 旧逻辑把两者都判为「低位加分」，导致澳洋健康拿到不该有的 10 分。
 */
export function evaluateValuation(chip, close) {
  const signals = []
  const risks = []
  let score = 0
  if (!chip) return { score: 0, signals, risks, metrics: {} }

  const { profitRate, avgCost, concentration90 } = chip
  const gap = (Number.isFinite(avgCost) && Number.isFinite(close) && avgCost > 0)
    ? pct(close, avgCost)
    : undefined

  // 「套牢压制」判定：获利盘低(<25%) 且 平均成本高于现价(集体套牢)
  // 此时筹码是「上方解套压力」，不是机会。再按集中度区分严重程度：
  //   concentration90 < 12（数值小=抱团极紧）→ 反弹即遇密集抛压，重罚
  //   concentration90 >= 12（相对分散）→ 抛压分散但仍在上方，轻罚（不给加分）
  // 注意 concentration90 语义：**数值越小 = 筹码越集中**
  // （实测：长江电力 6.89 极集中；慈文传媒 29.44 很分散；澳洋 6.08 抱团套牢）
  const trappedBelowCost = Number.isFinite(profitRate) && profitRate < 25
    && gap !== undefined && gap < 0
  const trappedAndConcentrated = trappedBelowCost
    && Number.isFinite(concentration90) && concentration90 < 12

  if (Number.isFinite(profitRate)) {
    if (trappedAndConcentrated) {
      // 假低位：全体套牢且筹码抱团在同一价位
      score -= 6
      risks.push(
        `获利盘仅 ${round(profitRate, 1)}% 但筹码高度集中（90%集中度 ${round(concentration90)}，越小越集中）`
        + `且均成本 ${round(avgCost)} 高于现价 ${round(Math.abs(gap))}% `
        + '→ 集体套牢区，反弹即遇密集解套抛压（假低位，非机会）',
      )
    } else if (trappedBelowCost) {
      // 集体套牢但筹码较分散：不加分（上方仍有解套压力）
      score -= 2
      risks.push(
        `获利盘仅 ${round(profitRate, 1)}%，但均成本 ${round(avgCost)} 高于现价 ${round(Math.abs(gap))}% `
        + '→ 整体处于套牢状态，上方为解套压力区，不构成低位买点',
      )
    } else if (profitRate < 20) {
      score += 6
      signals.push(`获利盘仅 ${round(profitRate, 1)}% 且多数筹码已获利 → 真低位特征`)
    } else if (profitRate < 40) {
      score += 3
      signals.push(`获利盘 ${round(profitRate, 1)}%，估值偏中性`)
    } else if (profitRate > 85) {
      score -= 5
      risks.push(`获利盘高达 ${round(profitRate, 1)}% → 浮盈集中，回调抛压大`)
    }
  }

  if (gap !== undefined) {
    if (gap < -8 && !trappedBelowCost) {
      score += 4
      signals.push(`现价低于平均成本 ${round(gap)}% → 抛压释放较充分`)
    } else if (gap > 15) {
      score -= 4
      risks.push(`现价高于平均成本 +${round(gap)}% → 获利盘集中，警惕兑现`)
    }
  }

  // 集中度（数值越小越集中）：仅「已获利 + 高集中」才算主力控盘的利好
  if (Number.isFinite(concentration90) && concentration90 < 8 && !trappedBelowCost) {
    if (Number.isFinite(profitRate) && profitRate >= 25) {
      score += 2
      signals.push(`筹码高度集中（${round(concentration90)}）且已获利 → 主力控盘特征`)
    }
  }

  return {
    score,
    signals,
    risks,
    metrics: {
      chipProfitRate: round(profitRate, 1),
      chipAvgCost: round(avgCost),
      chipConcentration90: round(concentration90),
      chipTrappedConcentrated: trappedAndConcentrated || undefined,
    },
  }
}

/**
 * P2-⑦ 机构持仓变化。
 */
export function evaluateInstitution(shareholder) {
  const signals = []
  const risks = []
  let score = 0
  if (!shareholder) return { score: 0, signals, risks, metrics: {} }

  const { institutionCount, netChange, holders } = shareholder
  if (institutionCount >= 3) {
    score += 2
    signals.push(`十大股东中机构 ${institutionCount} 家`)
  }
  if (Number.isFinite(netChange) && netChange !== 0) {
    if (netChange > 0) {
      score += 4
      signals.push(`机构合计增持 ${formatMoney(netChange)} 股`)
    } else {
      score -= 3
      risks.push(`机构合计减持 ${formatMoney(Math.abs(netChange))} 股`)
    }
  }
  return {
    score,
    signals,
    risks,
    metrics: { institutionCount, institutionNetChange: netChange, topHolders: holders?.slice(0, 2) },
  }
}

/**
 * P2-⑧ 组合构建：按行业/板块聚类 + 相关性控制 + 仓位建议。
 *
 * @param {Array} candidates 已排序的候选（含 metrics.hotBoards / sectorName）
 * @param {object} params
 * @returns {{selected: Array, groups: object, maxPosition: number, notes: string[]}}
 */
export function buildPortfolio(candidates, params) {
  const maxPerGroup = params.maxPerSector ?? 2
  const maxHoldings = params.maxHoldings ?? 5
  const notes = []
  const groups = {}
  const selected = []

  for (const item of candidates) {
    if (selected.length >= maxHoldings) break
    const boards = item.metrics?.hotBoards ?? []
    const group = item.metrics?.sectorName || boards[0] || '未分类'
    const count = groups[group] ?? 0
    if (count >= maxPerGroup) continue
    groups[group] = count + 1
    selected.push({ ...item, portfolioGroup: group })
  }

  // 仓位建议：等权，但按评分做轻微倾斜
  const totalScore = selected.reduce((s, x) => s + (x.score ?? 0), 0) || 1
  for (const item of selected) {
    const base = 1 / (selected.length || 1)
    const tilt = ((item.score ?? 0) / totalScore) * 0.4
    item.suggestedWeight = Math.round((base * 0.6 + tilt) * 1000) / 10 // 百分比，一位小数
  }

  if (selected.length < maxHoldings) {
    notes.push(`仅选出 ${selected.length} 只（上限 ${maxHoldings}），同板块最多 ${maxPerGroup} 只以控制相关性`)
  }
  const groupSummary = Object.entries(groups).map(([g, n]) => `${g}×${n}`).join('、')
  if (groupSummary) notes.push(`组合分散：${groupSummary}`)

  return {
    selected,
    groups,
    maxPosition: params.maxSinglePositionPct ?? 30,
    notes,
  }
}

export function formatMoney(value) {
  if (!Number.isFinite(value)) return '-'
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''
  if (abs >= 1e8) return `${sign}${round(abs / 1e8, 2)}亿`
  if (abs >= 1e4) return `${sign}${round(abs / 1e4, 2)}万`
  return `${sign}${round(abs, 0)}`
}

/**
 * 综合打分并生成结论。
 * @param {object} ctx { code, name, bars, tech, flow, boardNames, boardRanks, market, fundamental, params }
 */
export function scoreCandidate(ctx) {
  const { code, name, bars, tech, flow, boardNames, boardRanks, market, fundamental, deep, params } = ctx
  if (!bars || bars.length === 0) {
    return { code, name, score: 0, status: 'data_missing', signals: ['无K线数据'], risks: [], breakdown: {}, metrics: {} }
  }

  const lastBar = bars[bars.length - 1]
  const ma5 = evaluateMa5(bars, params)
  const techEval = evaluateTechnical(tech, bars, params)
  const capital = evaluateCapital(flow, params)
  const volume = evaluateVolume(bars, params)
  const sector = evaluateSector(boardNames, boardRanks, params)
  const fund = evaluateFundamental(fundamental)
  const tradability = evaluateTradability(bars, params)
  const marketEnv = market ? evaluateMarket(market, params) : { ok: true, unknown: true, reason: undefined, metrics: {} }
  // P2 因子
  const valuation = evaluateValuation(deep?.chip, lastBar.close)
  const institution = evaluateInstitution(deep?.shareholder)

  // 各分项归一化到 0-100 后再按 STRATEGY_WEIGHTS 加权
  const parts = {
    ma5: ma5.score,
    technical: Math.max(0, Math.min(100, Math.round(50 + techEval.score))),
    capital: Math.max(0, Math.min(100, Math.round(50 + capital.score))),
    volume: Math.max(0, Math.min(100, Math.round(50 + volume.score))),
    sector: Math.max(0, Math.min(100, Math.round(50 + sector.score))),
    fundamental: Math.max(0, Math.min(100, Math.round(50 + fund.score))),
    valuation: Math.max(0, Math.min(100, Math.round(50 + valuation.score))),
    institution: Math.max(0, Math.min(100, Math.round(50 + institution.score))),
  }
  // 缺失数据的因子不参与加权（避免用 50 分中位数稀释信号）
  const hasDeep = Boolean(deep && (deep.chip || deep.shareholder))
  const activeWeights = Object.keys(parts).filter(key => {
    if (!hasDeep && (key === 'valuation' || key === 'institution')) return false
    return (STRATEGY_WEIGHTS[key] ?? 0) > 0
  })
  const weightTotal = sum(activeWeights.map(key => STRATEGY_WEIGHTS[key] ?? 0))
  const raw = sum(activeWeights.map(key => parts[key] * (STRATEGY_WEIGHTS[key] ?? 0))) / (weightTotal || 1)
  const score01 = Math.max(0, Math.min(100, Math.round(raw)))

  const signals = [
    ...ma5.signals, ...techEval.signals, ...capital.signals, ...volume.signals,
    ...sector.signals, ...fund.signals, ...valuation.signals, ...institution.signals,
  ]
  const risks = [
    ...ma5.risks, ...techEval.risks, ...capital.risks, ...volume.risks,
    ...fund.risks, ...valuation.risks, ...institution.risks, ...tradability.risks,
  ]

  // 大盘环境：仅作信息展示；只有 requireMarketUp=true 时才真正否决信号
  if (marketEnv.reason) {
    if (marketEnv.ok) signals.push(marketEnv.reason)
    else {
      risks.push(params.requireMarketUp
        ? `${marketEnv.reason} → 环境不利，${params.blockBuyInBearMarket ? '买点已被屏蔽' : '买点降级为观察'}`
        : `${marketEnv.reason}（仅供参考，未用于否决信号）`)
    }
  }

  let status = ma5.status
  // 记录原始战法结论，供大盘屏蔽判断使用（避免被后续评分门槛改写后漏判）
  const rawStatus = status

  // P0-③ 不可交易（一字板/高位连板/停牌）：必须先否决，避免后续 advice 仍给出买点话术
  const tradable = tradability.tradable
  if (!tradable) {
    if (status === 'buy' || status === 'hold' || status === 'bigcandle') status = 'watch'
    risks.push(`不可交易：${tradability.reason}`)
  }

  // P0-① 大盘环境硬开关
  // 回测证明：大盘空头时买点信号超额收益为负（-1.66%），
  // 因此 blockBuyInBearMarket=true 时直接屏蔽买点，而不是仅降级为观察。
  // 注意：判断用 rawStatus，否则「buy 先被评分门槛降成 watch」会绕过屏蔽。
  const marketBlocked = params.requireMarketUp && marketEnv.ok === false
  let buyBlocked = false
  if (marketBlocked && (rawStatus === 'buy' || rawStatus === 'bigcandle')) {
    if (params.blockBuyInBearMarket) {
      status = rawStatus === 'buy' ? 'neutral' : 'watch'
      buyBlocked = rawStatus === 'buy'
      risks.push(
        rawStatus === 'buy'
          ? '大盘空头硬开关：买点信号已被屏蔽（回测显示此环境下买点超额为负）'
          : '大盘空头：大阳线待回踩信号暂不跟踪',
      )
    } else if (rawStatus === 'buy') {
      status = 'watch'
      risks.push('买点因大盘环境不利被降级为观察')
    }
  }

  // 评分门槛（放在大盘屏蔽之后，避免 screening 覆盖硬屏蔽结果）
  if (status === 'buy' && score01 < 60) status = 'watch'
  if (status === 'hold' && score01 < 55) status = 'watch'

  if (!['buy', 'exit', 'watch', 'hold', 'bigcandle'].includes(status)) status = score01 >= 60 ? 'watch' : 'neutral'
  // 硬屏蔽必须锁定：末端归一化不得把被屏蔽的买点改回 watch
  if (buyBlocked && status !== 'exit') status = 'neutral'

  let advice
  if (!tradable) {
    // 不可交易时明确说明，不能给出买点/持有话术
    advice = `不可交易：${tradability.reason}`
    if (status === 'exit') advice = `清仓：${tradability.reason}；同时已连续跌破5日线，按口诀5清仓`
  } else {
    switch (status) {
      case 'buy':
        advice = '买点：大阳线后缩量回踩5日线不破，可按计划分批买入，跌破5日线即减半仓'
        break
      case 'hold':
        advice = '持有：站稳5日线，回踩贴近5日线可加仓，远离5日线减半仓'
        break
      case 'bigcandle':
        advice = '观察：今日刚出放量大阳线，等回踩5日线缩量不破再买入（口诀2），不追高'
        break
      case 'watch':
        advice = '观察：等待放量大阳线后缩量回踩5日线不破，或重新站上5日线再介入'
        break
      case 'exit':
        advice = '清仓：收盘跌破5日线已超3日且未站回，按口诀5清仓'
        break
      default:
        advice = '不具备条件：无有效大阳线（含量能确认）或趋势未确认，暂不参与'
    }
  }

  const stopLossPrice = ma5.metrics?.stopLossPrice
  if (tradable && Number.isFinite(stopLossPrice) && (status === 'buy' || status === 'hold' || status === 'bigcandle')) {
    advice += `；止损参考 ${stopLossPrice}（${ma5.metrics.stopLossBasis}）`
  }
  if (marketBlocked && status === 'watch') {
    advice += '；当前大盘环境不利，建议轻仓或空仓等待'
  }

  return {
    code,
    name,
    score: score01,
    status,
    advice,
    tradable: tradability.tradable,
    untradableReason: tradability.reason,
    signals,
    risks,
    breakdown: parts,
    metrics: {
      ...ma5.metrics,
      ...techEval.metrics,
      ...capital.metrics,
      ...volume.metrics,
      ...sector.metrics,
      ...valuation.metrics,
      ...institution.metrics,
      ...tradability.metrics,
      ...marketEnv.metrics,
    },
  }
}

export function matchesScreen(candidate, screen) {
  switch (screen) {
    case 'buy': return candidate.status === 'buy'
    case 'watch': return candidate.status === 'watch' || candidate.status === 'neutral' || candidate.status === 'bigcandle'
    case 'exit': return candidate.status === 'exit'
    case 'bigcandle': return Boolean(candidate.metrics?.bigCandle?.volumeConfirmed)
    case 'hold': return candidate.status === 'hold' || candidate.status === 'buy'
    default: return true
  }
}
