/**
 * 深度技术指标分析层。
 *
 * 现有 parseTechnical 只取当日快照，无法判断：
 * - MACD 金叉/死叉的**发生时间**与**柱体变化趋势**
 * - 顶背离 / 底背离（需要价格与 DIF 的历史序列对比）
 * - 真阳线 / 假阳线（需结合量能与位置）
 * - 诱多形态（冲高回落、放量滞涨、上影线）
 *
 * 本模块基于多日 K 线 + 指标序列，补齐这些判定。
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? ((a - b) / b) * 100 : undefined)

/**
 * 解析多日 technical 输出为按日期升序的数组。
 * 每行包含 54 个字段中的关键项。
 */
export function parseTechnicalSeries(text, defaultCode) {
  const out = []
  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim().startsWith('|'))
  if (lines.length === 0) return out
  const header = lines[0].replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
  const idx = {}
  header.forEach((name, i) => { idx[name] = i })
  const pick = (cells, name) => {
    const i = idx[name]
    if (i === undefined) return undefined
    const raw = cells[i]
    if (raw === undefined || raw === '' || raw === '-' || /^-+$/.test(raw)) return undefined
    const n = Number(String(raw).replace(/[,%]/g, ''))
    return Number.isFinite(n) ? n : undefined
  }
  for (const line of lines.slice(1)) {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.every(c => /^-+$/.test(c))) continue
    const date = cells[idx.date] ?? cells[idx['date']]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue
    out.push({
      date,
      close: pick(cells, 'closePrice'),
      ma5: pick(cells, 'ma.MA_5'),
      ma10: pick(cells, 'ma.MA_10'),
      ma20: pick(cells, 'ma.MA_20'),
      ma60: pick(cells, 'ma.MA_60'),
      dif: pick(cells, 'macd.DIF'),
      dea: pick(cells, 'macd.DEA'),
      macd: pick(cells, 'macd.MACD'),
      k: pick(cells, 'kdj.KDJ_K'),
      d: pick(cells, 'kdj.KDJ_D'),
      j: pick(cells, 'kdj.KDJ_J'),
      rsi6: pick(cells, 'rsi.RSI_6'),
      rsi12: pick(cells, 'rsi.RSI_12'),
      bollUpper: pick(cells, 'boll.BOLL_UPPER'),
      bollMid: pick(cells, 'boll.BOLL_MID'),
      bollLower: pick(cells, 'boll.BOLL_LOWER'),
      bias6: pick(cells, 'bias.BIAS_6'),
      wr6: pick(cells, 'wr.WR_6'),
      sar: pick(cells, 'dmi.SAR'),
      adx: pick(cells, 'dmi.ADX'),
      pdi: pick(cells, 'dmi.PDI'),
      mdi: pick(cells, 'dmi.MDI'),
    })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1))
  return out
}

/**
 * MACD 深度分析：金叉/死叉状态、发生时间、柱体趋势、背离。
 */
export function analyzeMACD(series) {
  if (!Array.isArray(series) || series.length < 5) {
    return { available: false, reason: '指标序列不足' }
  }
  const n = series.length
  const last = series[n - 1]
  const prev = series[n - 2]
  if (!Number.isFinite(last.dif) || !Number.isFinite(last.dea)) {
    return { available: false, reason: 'MACD 数据缺失' }
  }

  const above = last.dif > last.dea
  // 找最近一次穿越
  let crossIndex = -1
  let crossType
  for (let i = n - 1; i >= 1; i -= 1) {
    const a = series[i], b = series[i - 1]
    if (!Number.isFinite(a.dif) || !Number.isFinite(a.dea) || !Number.isFinite(b.dif) || !Number.isFinite(b.dea)) continue
    const nowAbove = a.dif > a.dea
    const prevAbove = b.dif > b.dea
    if (nowAbove !== prevAbove) {
      crossIndex = i
      crossType = nowAbove ? 'golden' : 'death'
      break
    }
  }
  const daysSinceCross = crossIndex >= 0 ? n - 1 - crossIndex : undefined

  // 柱体趋势（最近 5 日）
  const bars = series.slice(-5).map(s => s.macd).filter(Number.isFinite)
  let barTrend = 'unknown'
  if (bars.length >= 3) {
    const first = bars[0], lastBar = bars[bars.length - 1]
    if (Math.abs(lastBar) > Math.abs(first) * 1.05) barTrend = lastBar > 0 ? 'red_expanding' : 'green_expanding'
    else if (Math.abs(lastBar) < Math.abs(first) * 0.95) barTrend = lastBar > 0 ? 'red_shrinking' : 'green_shrinking'
    else barTrend = 'flat'
  }
  const barSeq = series.slice(-6).map(s => round(s.macd, 3))

  // 零轴位置
  const zeroAxis = last.dif > 0 && last.dea > 0 ? 'above' : (last.dif < 0 && last.dea < 0 ? 'below' : 'crossing')

  // 背离检测：最近 20 日
  const window = series.slice(-20).filter(s => Number.isFinite(s.close) && Number.isFinite(s.dif))
  let divergence
  if (window.length >= 10) {
    const half = Math.floor(window.length / 2)
    const firstHalf = window.slice(0, half)
    const secondHalf = window.slice(half)
    const highFirst = firstHalf.reduce((m, s) => (s.close > m.close ? s : m), firstHalf[0])
    const highSecond = secondHalf.reduce((m, s) => (s.close > m.close ? s : m), secondHalf[0])
    const lowFirst = firstHalf.reduce((m, s) => (s.close < m.close ? s : m), firstHalf[0])
    const lowSecond = secondHalf.reduce((m, s) => (s.close < m.close ? s : m), secondHalf[0])

    // 顶背离：价格新高，DIF 未新高
    if (highSecond.close > highFirst.close && highSecond.dif < highFirst.dif) {
      divergence = { type: 'top', detail: `价格 ${round(highSecond.close)} 创新高，但 DIF ${round(highSecond.dif, 3)} 低于前高 ${round(highFirst.dif, 3)}` }
    } else if (lowSecond.close < lowFirst.close && lowSecond.dif > lowFirst.dif) {
      divergence = { type: 'bottom', detail: `价格 ${round(lowSecond.close)} 创新低，但 DIF ${round(lowSecond.dif, 3)} 高于前低 ${round(lowFirst.dif, 3)}` }
    }
  }

  return {
    available: true,
    dif: round(last.dif, 3),
    dea: round(last.dea, 3),
    macd: round(last.macd, 3),
    status: above ? 'golden' : 'death',
    statusLabel: above ? '金叉' : '死叉',
    crossType,
    daysSinceCross,
    crossDate: crossIndex >= 0 ? series[crossIndex].date : undefined,
    barTrend,
    barTrendLabel: {
      red_expanding: '红柱放大（多头增强）',
      red_shrinking: '红柱收缩（多头减弱）',
      green_expanding: '绿柱放大（空头增强）',
      green_shrinking: '绿柱收缩（空头减弱）',
      flat: '柱体走平',
      unknown: '数据不足',
    }[barTrend],
    barSeq,
    zeroAxis,
    divergence,
    diffNow: round(last.dif - last.dea, 3),
  }
}

/**
 * K 线与量价形态分析：真阳线/假阳线、诱多形态、缺口、上下影线。
 */
export function analyzeCandlePatterns(bars) {
  if (!Array.isArray(bars) || bars.length < 6) {
    return { available: false, reason: 'K线数据不足' }
  }
  const n = bars.length
  const last = bars[n - 1]
  const prev = bars[n - 2]
  const out = { available: true }

  const chg = pct(last.close, prev.close)
  const amplitude = Number.isFinite(last.high) && Number.isFinite(last.low) && prev.close > 0
    ? ((last.high - last.low) / prev.close) * 100 : undefined

  // 量比：当日成交额 / 前5日均量
  const prev5 = bars.slice(n - 6, n - 1).map(b => b.amount).filter(Number.isFinite)
  const avg5 = prev5.length > 0 ? prev5.reduce((a, b) => a + b, 0) / prev5.length : undefined
  const volRatio = Number.isFinite(avg5) && avg5 > 0 && Number.isFinite(last.amount) ? last.amount / avg5 : undefined

  out.changePct = round(chg)
  out.amplitude = round(amplitude)
  out.volumeRatio = round(volRatio)

  // 实体与影线
  const body = Math.abs(last.close - last.open)
  const range = last.high - last.low
  const upperShadow = last.high - Math.max(last.close, last.open)
  const lowerShadow = Math.min(last.close, last.open) - last.low
  out.bodyPct = range > 0 ? round((body / range) * 100) : undefined
  out.upperShadowPct = range > 0 ? round((upperShadow / range) * 100) : undefined
  out.lowerShadowPct = range > 0 ? round((lowerShadow / range) * 100) : undefined
  out.isBullish = last.close > last.open
  out.closePosition = range > 0 ? round(((last.close - last.low) / range) * 100) : undefined

  // ---- 真阳线 / 假阳线判定 ----
  if (Number.isFinite(chg) && chg > 0) {
    const strongVolume = Number.isFinite(volRatio) && volRatio >= 1.5
    const weakVolume = Number.isFinite(volRatio) && volRatio < 1.0
    const closesStrong = Number.isFinite(out.closePosition) && out.closePosition >= 60
    const longUpper = Number.isFinite(out.upperShadowPct) && out.upperShadowPct >= 40

    if (weakVolume) {
      out.candleType = 'false_bullish'
      out.candleTypeLabel = '假阳线（缩量上涨，资金不认可）'
      out.candleReason = `涨幅 ${round(chg)}% 但量比仅 ${round(volRatio)}（<1.0）`
    } else if (strongVolume && closesStrong && !longUpper) {
      out.candleType = 'true_bullish'
      out.candleTypeLabel = '真阳线（放量且收在高位）'
      out.candleReason = `涨幅 ${round(chg)}%，量比 ${round(volRatio)}，收盘位于当日 ${out.closePosition}% 位置`
    } else if (longUpper) {
      out.candleType = 'bull_trap'
      out.candleTypeLabel = '诱多（长上影线，冲高回落）'
      out.candleReason = `上影线占 ${out.upperShadowPct}%，盘中冲高后回落`
    } else {
      out.candleType = 'neutral_bullish'
      out.candleTypeLabel = '普通阳线'
      out.candleReason = `量比 ${round(volRatio)}，形态中性`
    }
  } else if (Number.isFinite(chg) && chg < 0) {
    out.candleType = 'bearish'
    out.candleTypeLabel = Number.isFinite(volRatio) && volRatio >= 1.5 ? '放量下跌（出货）' : '缩量下跌'
    out.candleReason = `跌幅 ${round(chg)}%，量比 ${round(volRatio)}`
  }

  // ---- 诱多形态检测（近 3 日）----
  const traps = []
  // 1. 冲高回落：近3日某日最高价涨幅>5%但收盘涨幅<1%
  for (let i = n - 3; i < n; i += 1) {
    if (i < 1) continue
    const b = bars[i], p = bars[i - 1]
    if (!p || p.close <= 0) continue
    const highChg = ((b.high - p.close) / p.close) * 100
    const closeChg = ((b.close - p.close) / p.close) * 100
    if (highChg >= 5 && closeChg <= 1) {
      traps.push(`${b.date} 盘中冲高 +${round(highChg)}% 但收盘仅 ${round(closeChg)}%，冲高回落`)
    }
  }
  // 2. 放量滞涨：量比>2 但涨幅<2%
  for (let i = n - 3; i < n; i += 1) {
    if (i < 5) continue
    const b = bars[i], p = bars[i - 1]
    if (!p || p.close <= 0) continue
    const p5 = bars.slice(i - 5, i).map(x => x.amount).filter(Number.isFinite)
    const a5 = p5.length > 0 ? p5.reduce((a, c) => a + c, 0) / p5.length : undefined
    if (!Number.isFinite(a5) || a5 <= 0) continue
    const vr = b.amount / a5
    const cc = ((b.close - p.close) / p.close) * 100
    if (vr >= 2 && cc < 2) {
      traps.push(`${b.date} 放量 ${round(vr)} 倍但涨幅仅 ${round(cc)}%，放量滞涨`)
    }
  }
  // 3. 高位长上影
  const recentHigh = Math.max(...bars.slice(-20).map(b => b.high))
  if (Number.isFinite(last.high) && last.high >= recentHigh * 0.97
      && Number.isFinite(out.upperShadowPct) && out.upperShadowPct >= 45) {
    traps.push(`今日接近近20日高点且上影线占 ${out.upperShadowPct}%，高位滞涨`)
  }
  out.trapSignals = traps.length > 0 ? traps : undefined

  // ---- 跳空缺口 ----
  if (Number.isFinite(last.low) && Number.isFinite(prev.high) && last.low > prev.high) {
    out.gap = { type: 'up', from: round(prev.high), to: round(last.low) }
  } else if (Number.isFinite(last.high) && Number.isFinite(prev.low) && last.high < prev.low) {
    out.gap = { type: 'down', from: round(prev.low), to: round(last.high) }
  }

  return out
}

/**
 * 量能结构分析：连续放量/缩量、量价配合。
 */
export function analyzeVolumePattern(bars) {
  if (!Array.isArray(bars) || bars.length < 10) return { available: false }
  const n = bars.length
  const amounts = bars.slice(-6).map(b => b.amount).filter(Number.isFinite)
  const vols = bars.slice(-6).map(b => b.volume).filter(Number.isFinite)
  const avgAll = bars.slice(-20).map(b => b.amount).filter(Number.isFinite)
  const avg20 = avgAll.length > 0 ? avgAll.reduce((a, b) => a + b, 0) / avgAll.length : undefined

  const changes = bars.slice(-6).map((b, i, arr) => {
    if (i === 0) return undefined
    const prev = arr[i - 1]
    return prev.close > 0 ? ((b.close - prev.close) / prev.close) * 100 : undefined
  }).filter(Number.isFinite)

  // 量价配合：近5日「涨放量/跌缩量」的比例
  let goodCount = 0
  let badCount = 0
  for (let i = n - 5; i < n; i += 1) {
    if (i < 1) continue
    const b = bars[i], p = bars[i - 1]
    const chg = p.close > 0 ? b.close - p.close : 0
    const volUp = b.amount > p.amount
    if (chg > 0 && volUp) goodCount += 1
    else if (chg < 0 && volUp) badCount += 1
  }

  return {
    available: true,
    avgAmount20: avg20,
    lastAmount: bars[n - 1].amount,
    amountVsAvg20: Number.isFinite(avg20) && avg20 > 0 ? round(bars[n - 1].amount / avg20) : undefined,
    last6Changes: changes.map(c => round(c)),
    volPriceMatch: goodCount > badCount ? 'healthy' : (badCount > goodCount ? 'unhealthy' : 'neutral'),
    volPriceLabel: goodCount > badCount ? '量价配合健康（涨放量/跌缩量）'
      : (badCount > goodCount ? '量价背离（跌放量/涨缩量）' : '量价中性'),
  }
}

/**
 * KDJ / RSI / BOLL / DMI 综合判断。
 */
export function analyzeOscillators(series) {
  if (!Array.isArray(series) || series.length < 5) return { available: false }
  const last = series[series.length - 1]
  const prev = series[series.length - 2]
  const out = { available: true }

  // KDJ
  if (Number.isFinite(last.k) && Number.isFinite(last.d)) {
    out.k = round(last.k); out.d = round(last.d); out.j = round(last.j)
    const golden = Number.isFinite(prev?.k) && Number.isFinite(prev?.d) && last.k > last.d && prev.k <= prev.d
    const death = Number.isFinite(prev?.k) && Number.isFinite(prev?.d) && last.k < last.d && prev.k >= prev.d
    out.kdjStatus = golden ? 'golden' : (death ? 'death' : (last.k > last.d ? 'above' : 'below'))
    out.kdjLabel = golden ? 'KDJ 金叉' : death ? 'KDJ 死叉' : (last.k > last.d ? 'KDJ 多头' : 'KDJ 空头')
    if (Number.isFinite(last.j)) {
      if (last.j > 100) out.kdjOverbought = true
      else if (last.j < 0) out.kdjOversold = true
    }
  }

  // RSI
  if (Number.isFinite(last.rsi6)) {
    out.rsi6 = round(last.rsi6)
    out.rsi6Label = last.rsi6 >= 90 ? '极度超买' : last.rsi6 >= 80 ? '超买'
      : last.rsi6 <= 20 ? '极度超卖' : last.rsi6 <= 30 ? '超卖' : '中性'
  }

  // BOLL
  if (Number.isFinite(last.bollUpper) && Number.isFinite(last.bollLower) && Number.isFinite(last.close)) {
    out.bollUpper = round(last.bollUpper)
    out.bollMid = round(last.bollMid)
    out.bollLower = round(last.bollLower)
    const width = last.bollUpper - last.bollLower
    out.bollPosition = width > 0 ? round(((last.close - last.bollLower) / width) * 100) : undefined
    out.bollLabel = last.close > last.bollUpper ? '突破布林上轨（超强/超买）'
      : last.close < last.bollLower ? '跌破布林下轨（超弱/超卖）'
      : (out.bollPosition >= 80 ? '接近上轨' : out.bollPosition <= 20 ? '接近下轨' : '中轨附近')
  }

  // DMI
  if (Number.isFinite(last.adx) && Number.isFinite(last.pdi) && Number.isFinite(last.mdi)) {
    out.adx = round(last.adx)
    out.pdi = round(last.pdi)
    out.mdi = round(last.mdi)
    out.dmiLabel = last.adx >= 25
      ? (last.pdi > last.mdi ? `强趋势向上（ADX ${round(last.adx)}）` : `强趋势向下（ADX ${round(last.adx)}）`)
      : `趋势不明（ADX ${round(last.adx)}）`
  }

  return out
}
