/**
 * 回测框架：对比「三区间（原版）」与「三区间（对齐口诀版）」的买入信号质量。
 *
 * 目的不是证明哪个更好，而是**量化"加规则"到底值多少**：
 *   同一批票、同一段行情、同样的入场/离场执行，只换信号生成器，比较
 *     胜率 / 平均收益 / 期望值 / 回撤 / 信号数
 *
 * 执行约束（刻意保守，避免把回测做成"纸上富贵"）：
 *   - 信号在 t 日收盘产生 → **t+1 开盘价成交**（不用收盘价买，避免未来函数）
 *   - 出场：次日先判止损（跳空按开盘价止损），再判止盈/MA5 破位
 *   - 不计算滑点以外的假设，但计入双边万分之五的交易费
 *
 * 三个信号：
 *   A  baseline    只做当日涨幅 >= 3% 的"追涨"（对照组，代表"看到涨就买"）
 *   B  bands_v1    原版三区间：价格 >= 确认区下沿 且 >= MA20 且（连涨/3日蓄力/过确认上沿）
 *   C  bands_v2    对齐口诀版：v1 + 必须有有效大阳线（>=5% 且放量>=1.5倍）
 */

import { evaluateMa5, mergeParameters } from './strategies.js'

const FEE = 0.0005   // 单边费率（双向各收一次）

const r2 = v => Math.round(v * 100) / 100
const avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

export function atrAt(bars, i, n = 14) {
  if (i < n) return barrels(undefined)
  const trs = []
  for (let k = i - n + 1; k <= i; k += 1) {
    const b = bars[k]
    const pc = bars[k - 1]?.close
    if (!Number.isFinite(b?.high) || !Number.isFinite(b?.low) || !Number.isFinite(pc)) continue
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)))
  }
  return trs.length ? trs.reduce((a, b) => a + b, 0) / trs.length : undefined
}
function barrels(v) { return v }

const maAt = (bars, i, n) => {
  if (i < n - 1) return undefined
  let s = 0
  for (let k = i - n + 1; k <= i; k += 1) s += bars[k].close
  return s / n
}

/** 有效大阳线：近 20 日内存在 涨幅>=5% 且 成交额/前5日均量>=1.5 的K线（对齐口诀1） */
export function hasValidBigCandle(bars, i, pct = 5, volRatio = 1.5, lookback = 20) {
  const from = Math.max(6, i - lookback + 1)
  for (let k = from; k <= i; k += 1) {
    const prev = bars[k - 1]?.close
    if (!Number.isFinite(prev) || prev <= 0) continue
    const chg = (bars[k].close / prev - 1) * 100
    if (chg < pct) continue
    let vs = 0
    for (let m = k - 5; m < k; m += 1) vs += bars[m].volume
    const base = vs / 5
    if (base > 0 && bars[k].volume / base >= volRatio) return true
  }
  return false
}

/** 原版三区间判定（与 bands.js 同一套公式的逐日版本） */
export function bandsV1(bars, i) {
  const px = bars[i].close
  const ma5 = maAt(bars, i, 5)
  const ma20 = maAt(bars, i, 20)
  const A = atrAt(bars, i)
  if (!Number.isFinite(ma5) || !Number.isFinite(ma20) || !Number.isFinite(A) || A <= 0) return null
  const win = bars.slice(Math.max(0, i - 19), i + 1)
  const hi20 = Math.max(...win.map(b => b.high))
  const lo20 = Math.min(...win.map(b => b.low))
  const mid20 = (hi20 + lo20) / 2
  const d2 = Math.max(ma5, ma20 + 0.3 * A)
  let d3 = Math.max(d2 + 0.6 * A, Math.max(px, mid20) + 0.5 * A)
  if (ma5 < ma20) d3 = Math.max(d2 + 0.4 * A, px + 0.3 * A)
  const c1 = px, c2 = bars[i - 1]?.close, c3 = bars[i - 2]?.close
  const up3 = Number.isFinite(c3) && c1 >= c2 && c2 >= c3
  const rise3 = Number.isFinite(c3) && c3 > 0 ? (c1 / c3 - 1) * 100 : 0
  const ok = px >= d2 && px >= ma20 && (up3 || rise3 >= 1.5 || px >= d3)
  return { ok, band: ok ? 'confirm' : (px < ma20 - 0.5 * A ? 'divergence' : 'watch'), d2, d3, ma5, ma20, A }
}

/** 逐日信号 */
export function signalAt(strategy, bars, i) {
  if (i < 25) return false
  const px = bars[i].close
  const prev = bars[i - 1]?.close
  const chg = prev > 0 ? (px / prev - 1) * 100 : 0
  if (strategy === 'A') return chg >= 3
  const v1 = bandsV1(bars, i)
  if (!v1 || !v1.ok) return false
  if (strategy === 'B') return true
  if (strategy === 'C') return hasValidBigCandle(bars, i)
  return false
}

/** 单笔交易：t 收盘出信号，t+1 开盘买入；出场规则 = MA5 破位(2日) / -6% 硬止损 / +12% 止盈 / 20日时间止损 */
export function simulateTrade(bars, entryIdx, opts = {}) {
  const stopPct = opts.stopPct ?? 6
  const takePct = opts.takePct ?? 12
  const maxHold = opts.maxHold ?? 20
  const buy = bars[entryIdx]?.open
  if (!Number.isFinite(buy) || buy <= 0) return null
  let peak = buy, trough = buy, below = 0
  for (let k = entryIdx; k < Math.min(bars.length, entryIdx + maxHold + 1); k += 1) {
    const b = bars[k]
    // 日内先判极值（保守：假设先到最不利的一边）
    const lowRet = (b.low / buy - 1) * 100
    trough = Math.min(trough, lowRet)
    if (lowRet <= -stopPct) {
      const exitPx = Math.min(b.open, buy * (1 - stopPct / 100))
      return { ret: (exitPx / buy - 1) * 100, days: k - entryIdx, exit: 'stop', mae: lowRet }
    }
    peak = Math.max(peak, (b.high / buy - 1) * 100)
    if ((b.high / buy - 1) * 100 >= takePct) {
      const exitPx = Math.max(b.open, buy * (1 + takePct / 100))
      return { ret: (exitPx / buy - 1) * 100, days: k - entryIdx, exit: 'take', mae: lowRet }
    }
    const ma5 = maAt(bars, k, 5)
    if (Number.isFinite(ma5) && b.close < ma5) below += 1; else below = 0
    if (below >= 2 && k > entryIdx) {
      const nx = bars[k + 1]?.open ?? b.close
      return { ret: (nx / buy - 1) * 100, days: k - entryIdx + 1, exit: 'ma5', mae: lowRet }
    }
  }
  const lastIdx = Math.min(bars.length - 1, entryIdx + maxHold)
  const exitPx = bars[lastIdx].close
  return { ret: (exitPx / buy - 1) * 100, days: lastIdx - entryIdx, exit: 'time', mae: trough }
}

export function runBacktest(data, strategy, opts = {}) {
  const trades = []
  for (const [code, bars] of Object.entries(data)) {
    if (!Array.isArray(bars) || bars.length < 80) continue
    let cooldown = 0
    for (let i = 25; i < bars.length - 2; i += 1) {
      if (cooldown > 0) { cooldown -= 1; continue }
      if (!signalAt(strategy, bars, i)) continue
      const t = simulateTrade(bars, i + 1, opts)
      if (!t) continue
      t.code = code; t.entryDate = bars[i + 1].date; t.signalDate = bars[i].date
      t.net = t.ret - FEE * 100 * 2
      trades.push(t)
      cooldown = Math.max(3, t.days)      // 同一只票不重复开仓
    }
  }
  return trades
}

export function summarize(strategy, trades) {
  if (!trades.length) return { strategy, n: 0 }
  const rets = trades.map(t => t.net)
  const wins = rets.filter(r => r > 0)
  const losses = rets.filter(r => r <= 0)
  const sum = rets.reduce((a, b) => a + b, 0)
  return {
    strategy,
    n: trades.length,
    winRate: +(wins.length / trades.length * 100).toFixed(1),
    avgRet: +avg(rets).toFixed(2),
    medianRet: +rets.slice().sort((a, b) => a - b)[Math.floor(rets.length / 2)].toFixed(2),
    avgWin: +(avg(wins) || 0).toFixed(2),
    avgLoss: +(avg(losses) || 0).toFixed(2),
    profitFactor: losses.length ? +(Math.abs(avg(wins) * wins.length / (avg(losses) * losses.length))).toFixed(2) : null,
    expectancy: +avg(rets).toFixed(2),
    totalRet: +sum.toFixed(1),
    avgDays: +avg(trades.map(t => t.days)).toFixed(1),
    avgMae: +avg(trades.map(t => t.mae)).toFixed(2),
    exits: trades.reduce((m, t) => (m[t.exit] = (m[t.exit] || 0) + 1, m), {}),
  }
}
