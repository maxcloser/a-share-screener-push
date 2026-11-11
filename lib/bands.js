/**
 * 三区间判定（确认 / 观察 / 背离）—— 加密版：6 个亚状态
 *
 * 用户口径：
 *   确认 = 连续上涨到达推荐区间 | 观察 = 持续震荡 | 背离 = 明显破位
 *
 * 加密依据（全市场 4402 只实测，事后统计）：
 *   A1 回踩MA5缩量   10 只 / 0.2%   20日 -3.36%   5日上涨 80.0%   → 可加
 *   A2 确认区强势   274 只 / 6.2%   20日 +1.90%   5日上涨 99.6%   → 持有
 *   A3 远离MA5       72 只 / 1.6%   20日 +17.79%  5日上涨100.0%   → 减半
 *   B1 观察区        57 只 / 1.3%   20日 +1.48%   5日上涨 63.2%   → 观望
 *   C1 背离-轻      148 只 / 3.4%   20日 +0.47%   5日上涨 59.5%   → 减仓
 *   C2 背离-重      742 只 /16.9%   20日 -6.99%   5日上涨 19.3%   → 清仓
 *   D1 无有效大阳线 3099 只 /70.4%   20日 -6.51%   5日上涨 31.0%   → 不参与
 * 观察区(B1)不再细分：它与 C1 的收益几乎相同，再拆没有信息量。
 * 注意：以上均为横截面事后统计(不是未来胜率)，A3 的 100% 属幸存者偏差。
 */

const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined)


/** 简易 ATR(14)：无数据返回 undefined */
export function atr14(bars, n = 14) {
  if (!Array.isArray(bars) || bars.length < n + 1) return undefined
  const trs = []
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]
    const pc = bars[i - 1]?.close
    if (!Number.isFinite(b?.high) || !Number.isFinite(b?.low) || !Number.isFinite(pc)) continue
    trs.push(Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc)))
  }
  if (trs.length === 0) return undefined
  return trs.reduce((a, b) => a + b, 0) / trs.length
}

function prevAvgAmount(bars, i, window = 5) {
  const from = Math.max(0, i - window)
  const slice = bars.slice(from, i)
  const list = slice.map(b => b.amount).filter(v => Number.isFinite(v) && v > 0)
  if (list.length === 0) return undefined
  return list.reduce((a, b) => a + b, 0) / list.length
}

/**
 * 大阳线质量检查（R1~R6）：把「大阳线」从信号降级为坐标。
 *
 * 回测结论（本地 49 只 / 2025-09~2026-10）：
 *   - 放量大阳线次日下跌概率 51.6%，跌 >=3% 的占 27.5%，其中 76% 是真破位（5 日收不回）
 *   - 提高大阳线门槛（涨幅>=7 / 收盘位置>=80% / 量能>=2）不会提高后续收益，只会减少样本
 *   - 真正拉开差距的是「等回踩缩量再买」：追当晚 36% 胜率，回踩缩量买 38% 且均值更高
 * 因此本函数不预测方向，只回答三件事：
 *   ① 这根大阳线算不算数（R4 冲高回落直接否决）
 *   ② 现在该不该动手（R1 当日不追 / R2 缩量回踩 / R3 收盘确认）
 *   ③ 错了在哪走（R5 硬止损 / R6 时间止损）
 */
export function evaluateBigCandleQuality({ bars = [], metrics = {}, big, hardStopPct = 5, holdingDays = 10 }) {
  const list = Array.isArray(bars) ? bars.filter(b => Number.isFinite(b?.close)) : []
  const px = metrics.close ?? list[list.length - 1]?.close
  const ma5 = metrics.ma5
  const close = metrics.close
  const rules = []
  const add = (id, name, pass, detail) => rules.push({ id, name, pass, detail })

  const info = big?.info ?? null

  if (!info) {
    add('R1', '大阳线坐标', false, '缺：近20日无有效大阳线，没有基准也没有止损锚点，不参与（口诀1）')
    add('R2', '缩量回踩', null, '不适用：无大阳线')
    add('R3', '收盘确认', null, '不适用：无大阳线')
    add('R4', '冲高回落否决', null, '不适用：无大阳线')
    add('R5', '硬止损', null, '无锚点，退化为「现价 -' + hardStopPct + '%」的临时止损')
    add('R6', '时间止损', null, '无锚点，按持有日历日计')
    return {
      available: true,
      valid: false,
      verdict: '缺坐标（D1）',
      rules,
      anchor: null,
      action: '不参与',
      reason: '没有有效大阳线 = 没有资金进场的证据，也没有止损的落点。看起来在涨也不动手。',
    }
  }

  let barsAgo = Number.isFinite(info.barsAgo) ? info.barsAgo : null
  if (barsAgo === null && info.date) {
    let k = list.length - 1
    while (k >= 0 && list[k].date !== info.date) k -= 1
    if (k >= 0) barsAgo = list.length - 1 - k
  }
  const bigIdx = barsAgo !== null && list.length > barsAgo ? list.length - 1 - barsAgo : null
  const bigBar = bigIdx !== null && bigIdx >= 0 ? list[bigIdx] : null
  const bigClose = info.close ?? bigBar?.close
  const range = bigBar ? (bigBar.high - bigBar.low) : undefined
  const closePos = bigBar && Number.isFinite(range) && range > 0 ? (bigBar.close - bigBar.low) / range * 100 : undefined

  const volConfirmed = info.valid !== false
  const r4pass = (closePos === undefined ? true : closePos >= 50) && volConfirmed
  add('R4', '冲高回落否决', r4pass, !volConfirmed
    ? '大阳线量能仅 ' + (info.ratio ?? '-') + ' 倍（<1.5），成交量没跟上，判为假阳线，坐标作废'
    : (closePos === undefined
      ? '缺少大阳线振幅数据，按通过处理'
      : '大阳线收盘位于振幅 ' + closePos.toFixed(0) + '% 处' + (r4pass ? '（收在高位，不算出货）' : '（长上影，诱多出货嫌疑，该大阳线作废）')))

  const r1pass = barsAgo !== null && barsAgo >= 1 && r4pass
  add('R1', '当天不追', r1pass, barsAgo === 0
    ? '大阳线就是今天，当日只记录不买入（次日下跌概率 51.6%）'
    : (r4pass ? '大阳线已过 ' + barsAgo + ' 个交易日，可进入下一步判断' : '大阳线作废，不进入买入流程'))

  const dev = Number.isFinite(ma5) && ma5 > 0 && Number.isFinite(close) ? (close / ma5 - 1) * 100 : undefined
  const volIdx = list.length - 1
  const baseVol = volIdx >= 0 ? prevAvgAmount(list, volIdx) : undefined
  const rawVol = Number.isFinite(metrics.volRatio) ? metrics.volRatio : (baseVol && Number.isFinite(list[volIdx]?.amount) ? list[volIdx].amount / baseVol : undefined)
  const volRatio = Number.isFinite(rawVol) ? rawVol : undefined
  const atMa5 = dev !== undefined && dev >= -1 && dev <= 1
  const shrink = volRatio === undefined ? null : volRatio <= 1.0
  const r2pass = r1pass && atMa5 && shrink === true
  let r2why
  if (!r1pass) r2why = '前置规则未通过，回踩判断不启动'
  else if (!atMa5) r2why = dev === undefined ? '缺 MA5 数据' : '距 MA5 ' + (dev > 0 ? '+' : '') + dev.toFixed(2) + '%，' + (dev > 1 ? '尚未回踩（追高性价比低）' : '已跌破 MA5（不是健康回踩）')
  else if (shrink === null) r2why = '回踩 MA5 到位，但缺成交额数据，无法确认缩量，按保守不通过'
  else if (!shrink) r2why = '已回踩 MA5（' + dev.toFixed(2) + '%）但成交额是前5日均量的 ' + volRatio.toFixed(2) + ' 倍，放量下跌约等于出货，等缩量'
  else r2why = '回踩 MA5（' + dev.toFixed(2) + '%）且缩量至 ' + (volRatio === undefined ? '-' : volRatio.toFixed(2)) + ' 倍，健康回踩'
  add('R2', '缩量回踩', r2pass, r2why)

  const r3pass = r2pass && Number.isFinite(ma5) && close >= ma5
  add('R3', '收盘确认', r3pass, r2pass
    ? (close >= ma5 ? '收盘 ' + close + ' 站上 MA5 ' + r2(ma5) + '，回踩成立' : '盘中触及但收盘 ' + close + ' < MA5 ' + r2(ma5) + '，不算企稳')
    : '需先满足 R2')

  const hardStop = Number.isFinite(bigClose) ? r2(bigClose * (1 - hardStopPct / 100)) : null
  add('R5', '硬止损', true, hardStop === null
    ? '缺锚点，临时用现价 -' + hardStopPct + '%'
    : '自大阳线收盘 ' + r2(bigClose) + ' 回撤 ' + hardStopPct + '% 即收盘跌破 ' + hardStop + ' 无条件离场')

  const holdLeft = barsAgo !== null ? Math.max(0, holdingDays - barsAgo) : null
  add('R6', '时间止损', true, holdLeft === null
    ? '大阳线后 ' + holdingDays + ' 个交易日仍未盈利即离场'
    : (holdLeft === 0 ? '大阳线后已满 ' + holdingDays + ' 日，仍未盈利则时间止损触发' : '距时间止损还有 ' + holdLeft + ' 个交易日'))

  let verdict, action, reason
  if (!r4pass) { verdict = '大阳线作废'; action = '不参与'; reason = volConfirmed ? '大阳线长上影、收盘未处高位，判为诱多出货，该坐标不可用。' : '大阳线最大涨幅有、成交量没跟上（<1.5倍），是假阳线，坐标不可用。' }
  else if (!r1pass) { verdict = '观察中（R1 未过）'; action = '只看不买'; reason = '大阳线就是今天，当日只记录；次日看它是否回踩并站住 MA5。' }
  else if (r3pass) { verdict = '确认（R1~R3 通过）'; action = '可分批建仓'; reason = '大阳线后缩量回踩 MA5 且收盘站住，是战法定义的买点，止损锚点清晰。' }
  else if (!r2pass && dev !== undefined && dev > 1) { verdict = '观察中（未回踩）'; action = '等回踩'; reason = '大阳线成立但价格仍在均线上方，等缩量回踩 MA5 再动手。' }
  else if (!r2pass) { verdict = '观察中（回踩不健康）'; action = '等缩量'; reason = '已贴近 MA5 但放量或未确认，疑似出货，等缩量企稳。' }
  else { verdict = '观察中（未收盘确认）'; action = '等收盘确认'; reason = '形态到位，但收盘未站稳 MA5，盘中不抢。' }

  return {
    available: true,
    valid: r4pass && info.valid !== false,
    verdict,
    action,
    reason,
    rules,
    anchor: {
      bigDate: info.date ?? (bigBar?.date ?? null),
      bigClose: r2(bigClose),
      closePos: closePos === undefined ? undefined : r2(closePos),
      barsAgo,
      hardStop,
      dev5: dev === undefined ? undefined : r2(dev),
      volRatio: volRatio === undefined ? undefined : r2(volRatio),
    },
  }
}

/**
 * 判断当前所处阶段。
 * 返回 { band: 'confirm'|'watch'|'divergence', label, zones: {confirm, watch, divergence}, notes }
 */
export function evaluateBands({ bars, metrics = {}, chip, macd, stopLoss, tier, big, hardStopPct = 5, holdingDays = 10 }) {
  const list = Array.isArray(bars) ? bars.filter(b => Number.isFinite(b?.close)) : []
  if (list.length < 21) return { available: false, reason: '日线不足21根，无法划定区间' }

  const px = metrics.close ?? list[list.length - 1].close
  const ma5 = metrics.ma5
  const ma10 = metrics.ma10
  const ma20 = metrics.ma20
  const chipAvgCost = Number.isFinite(metrics.chipAvgCost) ? metrics.chipAvgCost : undefined
  const atr = atr14(list)
  if (!Number.isFinite(px) || !Number.isFinite(ma5) || !Number.isFinite(ma20)) {
    return { available: false, reason: '均线数据不足，无法划定区间' }
  }
  const A = Number.isFinite(atr) ? atr : px * 0.02

  const win = list.slice(-20)
  const hi20 = Math.max(...win.map(b => b.high))
  const lo20 = Math.min(...win.map(b => b.low))
  const mid20 = (hi20 + lo20) / 2

  // ---- 三条界线，从高到低 ----
  // D1 背离线 = 观察区下沿：MA20 再让 0.5ATR（给正常回踩留容差，避免一根阴线就喊破位）
  // D2 观察区上沿 = 确认区下沿：MAX(MA5, MA20+0.3ATR) —— 站上它才算"走出攻势"
  // D3 确认区上沿 = MAX(突破位, 20日区间中线) + 0.5ATR，保证是"价格在前方"的区域，
  //     不会因为 MA5 滞后而把确认区压到现价下面去
  const d1 = ma20 - 0.5 * A
  const d2 = Math.max(Number.isFinite(ma5) ? ma5 : ma20, ma20 + 0.3 * A)
  let d3 = Math.max(d2 + 0.6 * A, Math.max(px, mid20) + 0.5 * A)
  // 弱趋势（MA5 < MA20）时把确认区收窄：确认得靠"站住+连续涨"，不能靠价格高
  const weak = Number.isFinite(ma5) && ma5 < ma20
  if (weak) d3 = Math.max(d2 + 0.4 * A, px + 0.3 * A)

  const watchLo = d1
  const confirmLo = d2
  const confirmHi = d3

  // ---- 背离区：MA20 之下，直到硬止损 ----
  const divHi = d1
  const divLo = Number.isFinite(stopLoss) ? Math.min(stopLoss, ma20 - 1.5 * A) : ma20 - 1.5 * A

  // ---- 判定当前阶段 ----
  const last = list.length - 1
  const c1 = list[last].close
  const c2 = list[last - 1]?.close
  const c3 = list[last - 2]?.close
  const up3 = [c1, c2, c3].every((v, i, arr) => i === 0 || (Number.isFinite(v) && Number.isFinite(arr[i - 1]) && v >= arr[i - 1]))
  const rise3 = Number.isFinite(c3) && c3 > 0 ? (c1 / c3 - 1) * 100 : 0
  const belowMa5Days = Number.isFinite(metrics.belowMa5Days) ? metrics.belowMa5Days : 0
  const macdTopDiv = macd?.divergence?.type === 'top'

  let band, label, reason
  const confirmOk = px >= confirmLo && (up3 || rise3 >= 1.5 || px >= confirmHi)
  const aboveMa20 = px >= ma20
  const brokeMa5Hard = belowMa5Days >= 3 && Number.isFinite(ma5) && px < ma5

  if (px < divLo) {
    band = 'divergence'
    label = '深度背离'
    reason = `收盘 ${px} 跌破深度背离线 ${r2(divLo)}（已破硬止损下沿），趋势彻底证伪`
  } else if (px < divHi && (brokeMa5Hard || !aboveMa20)) {
    band = 'divergence'
    label = '确认背离'
    reason = brokeMa5Hard
      ? `已连续 ${belowMa5Days} 日低于 MA5 且在观察带下沿之下，按纪律离场`
      : `跌破 MA20 ${r2(ma20)}，中期结构被破坏`
  } else if (confirmOk && aboveMa20) {
    band = 'confirm'
    label = '确认'
    reason = up3
      ? `连续上涨进入确认区 ${r2(confirmLo)}~${r2(confirmHi)}`
      : `价格站上确认区下沿 ${r2(confirmLo)}，${rise3 >= 1.5 ? `3日蓄力 ${rise3.toFixed(1)}%` : '等待量能跟进'}`
  } else {
    band = 'watch'
    label = '观察'
    reason = px >= confirmHi
      ? `价格已在确认区上沿 ${r2(confirmHi)} 之上，但缺少连续上涨/量能配合，先看能否站稳`
      : (px < confirmLo
        ? `价格在观察带 ${r2(watchLo)}~${r2(confirmLo)}，未形成攻势`
        : `价格在确认区下沿之上 ${r2(confirmLo)}~${r2(confirmHi)}，但还没连续走强，先看能否站稳再算确认`)
  }

  const notes = []
  if (macdTopDiv) notes.push('MACD 顶背离：上涨动能与价格不同步，确认区容易失败')
  if (Number.isFinite(chipAvgCost) && px < chipAvgCost) {
    notes.push(`上方 ${chipAvgCost} 是筹码密集区（获利盘之外的成本线），确认区上沿之上套牢盘会加重`)
  }
  if (Number.isFinite(ma5) && px > ma5 + 1.5 * A) {
    notes.push('价格已远离 MA5（>1.5ATR）：追高性价比低，等回踩更划算')
  }

  // ---- 建议动作（把"阶段"翻译成"做什么"，避免只给刻度不给动作）----
  let action, actionWhy
  if (band === 'confirm') {
    if (Number.isFinite(ma5) && px <= ma5 + 0.5 * A && !macdTopDiv) {
      action = '可加'; actionWhy = '在确认区且贴近 MA5，回踩不破=可加位置'
    } else if (px > ma5 + 1.5 * A) {
      action = '持有不加'; actionWhy = '在确认区但已远离 MA5（>1.5ATR），追高性价比低'
    } else {
      action = '持有'; actionWhy = '确认区成立，但等回踩 MA5 再加更划算'
    }
    if (macdTopDiv) { action = '持有减半'; actionWhy = '确认区内但 MACD 顶背离，先减一半' }
  } else if (band === 'watch') {
    action = px >= confirmLo ? '等站稳' : '观望'
    actionWhy = px >= confirmLo
      ? '已进确认区下沿但未连续走强，等收盘站稳再说'
      : '在观察带内，未形成攻势'
  } else {
    action = label === '深度背离' ? '清仓' : '离场'
    actionWhy = label === '深度背离' ? '跌破深度背离线，趋势彻底否定' : '背离区，按纪律离场不找理由'
  }

  // ---- 6 个亚状态（加密）----
  // 依据: 有效大阳线(>=5% 且放量>=1.5倍) + 距MA5 + 量比 + 跌破MA5天数
  let sub = 'D1', subLabel = '无有效大阳线', subAction = '不参与', subWhy = '口诀1：无有效大阳线不参与'
  const bigInfo = big?.info // 由上层传入：{valid, chg, ratio, date}
  const validBig = bigInfo ? bigInfo.valid === true : null
  const dev5pct = Number.isFinite(ma5) && ma5 > 0 ? (px / ma5 - 1) * 100 : null
  const volRatioHint = Number.isFinite(metrics.volRatio) ? metrics.volRatio : null
  const belowDays = Number.isFinite(metrics.belowMa5Days) ? metrics.belowMa5Days : 0

  if (validBig === false) {
    sub = 'D1'; subLabel = '无有效大阳线'; subAction = '不参与'
    subWhy = `大阳线量能 ${bigInfo.ratio} 倍 < 1.5，假阳线不参与（口诀1）`
  } else if (validBig === null) {
    sub = 'D1'; subLabel = '无有效大阳线'; subAction = '不参与'; subWhy = '近20日无 5% 以上大阳线（口诀1）'
  } else if (px < (Number.isFinite(stopLoss) ? stopLoss : ma20 - 1.5 * A) && px < watchLo) {
    sub = 'C2'; subLabel = '背离-重'; subAction = '清仓'; subWhy = '已触发硬止损，趋势彻底否定'
  } else if (dev5pct !== null && dev5pct >= 8) {
    sub = 'A3'; subLabel = '远离MA5'; subAction = '减半'
    subWhy = `距 MA5 +${dev5pct.toFixed(1)}%（>8%），随时回踩，按口诀3减半`
  } else if (dev5pct !== null && dev5pct > 2) {
    sub = 'A2'; subLabel = '确认区强势'; subAction = '持有'
    subWhy = `距 MA5 +${dev5pct.toFixed(1)}%，攻势已展开，持有但不追高`
  } else if (dev5pct !== null && dev5pct >= 0 && (volRatioHint === null || volRatioHint <= 1.0)) {
    sub = 'A1'; subLabel = '回踩MA5缩量'; subAction = '可加'
    subWhy = '贴近 MA5 且当日缩量，战法定义的买点位置'
  } else if (dev5pct !== null && dev5pct < 0 && belowDays < 3) {
    sub = 'B1'; subLabel = '观察区'; subAction = '观望'
    subWhy = `跌破 MA5 第 ${belowDays} 日（未到 3 日宽限），等回踩或站回`
  } else {
    sub = 'C1'; subLabel = '背离-轻'; subAction = '减仓'
    subWhy = `跌破 MA5 已 ${belowDays} 日未站回，纪律离场第一步`
  }

  return {
    available: true,
    band,
    sub,
    subLabel,
    subAction,
    subWhy,
    action,
    actionWhy,
    label,
    reason,
    price: r2(px),
    atr: r2(A),
    zones: {
      confirm: { lo: r2(confirmLo), hi: r2(confirmHi) },
      watch: { lo: r2(watchLo), hi: r2(confirmLo) },
      divergence: { lo: r2(divLo), hi: r2(divHi) },
    },
    anchors: {
      ma5: r2(ma5), ma10: r2(ma10), ma20: r2(ma20),
      hi20: r2(hi20), lo20: r2(lo20), chipAvgCost: r2(chipAvgCost),
      stopLoss: r2(stopLoss),
    },
    notes,
    bigCandle: evaluateBigCandleQuality({ bars: list, metrics: { close: px, ma5, volRatio: metrics.volRatio }, big, hardStopPct, holdingDays }),
  }
}

/** 渲染为 Markdown 段（插在"结论"之后） */
export function renderBandsMarkdown(b) {
  if (!b) return ''
  if (!b.available) return `> ⚪ 三区间：${b.reason}`
  const L = []
  const icon = { confirm: '🟢', watch: '🟡', divergence: '🔴' }[b.band]
  L.push(`## ${icon} 阶段判定：${b.label}`)
  L.push('')
  L.push(`> ${b.reason}`)
  if (b.sub) {
    L.push('')
    L.push(`**亚状态 ${b.sub} · ${b.subLabel} → 建议动作：${b.subAction}**（${b.subWhy}）`)
  }
  L.push('')
  L.push('| 区间 | 价位 | 含义 |')
  L.push('| --- | --- | --- |')
  L.push(`| 🟢 **确认区** | **${b.zones.confirm.lo} ~ ${b.zones.confirm.hi}** | 连续上涨、站上关键均线，趋势成立 → 可持有/可加 |`)
  L.push(`| 🟡 **观察区** | ${b.zones.watch.lo} ~ ${b.zones.watch.hi} | 持续震荡、未形成攻势 → 只观察，不动手 |`)
  L.push(`| 🔴 **背离区** | ${b.zones.divergence.lo} ~ ${b.zones.divergence.hi} | 明显破位、结构被破坏 → 按纪律离场 |`)
  L.push('')
  L.push(`当前价 ${b.price}（ATR14 ${b.atr}）· MA5 ${b.anchors.ma5} / MA10 ${b.anchors.ma10} / MA20 ${b.anchors.ma20} · 20日区间 ${b.anchors.lo20}~${b.anchors.hi20}`)
  L.push('')
  L.push('**6 个亚状态（加密版，全市场实测参考）：**')
  L.push('')
  L.push('| 代码 | 亚状态 | 动作 | 20日均值 |')
  L.push('| --- | --- | --- | --- |')
  const ref = [
    ['A1', '回踩MA5缩量', '可加', '-3.36%'],
    ['A2', '确认区强势', '持有', '+1.90%'],
    ['A3', '远离MA5', '减半', '+17.79%'],
    ['B1', '观察区', '观望', '+1.48%'],
    ['C1', '背离-轻', '减仓', '+0.47%'],
    ['C2', '背离-重', '清仓', '-6.99%'],
    ['D1', '无有效大阳线', '不参与', '-6.51%'],
  ]
  for (const [code, name, act, r20] of ref) {
    const mark = code === b.sub ? ' **← 当前**' : ''
    L.push(`| ${code} | ${name} | ${act} | ${r20} |${mark}`)
  }
  if (b.notes?.length > 0) {
    L.push('')
    for (const n of b.notes) L.push(`- ⚠️ ${n}`)
  }
  L.push(...renderBigCandle(b.bigCandle))
  return L.join('\n')
}


/** 渲染大阳线质量检查（R1~R6） */
export function renderBigCandle(bb) {
  if (!bb?.available) return []
  const L = []
  L.push('')
  L.push('**大阳线质量检查（R1~R6）**：' + (bb.valid === false ? '❌ ' : '✅ ') + bb.verdict + ' → 动作：**' + bb.action + '**')
  L.push('')
  L.push('> ' + bb.reason)
  L.push('')
  L.push('| 规则 | 检查项 | 结果 | 说明 |')
  L.push('| --- | --- | --- | --- |')
  for (const r of bb.rules) {
    L.push('| ' + r.id + ' | ' + r.name + ' | ' + (r.pass === true ? '✅ 通过' : r.pass === false ? '❌ 未过' : '— 不适用') + ' | ' + r.detail + ' |')
  }
  if (bb.anchor) {
    const a = bb.anchor
    L.push('')
    L.push('| 坐标 | 大阳线日期 | 大阳线收盘 | 收盘位置 | 距今 | 硬止损 | 距MA5 | 量比 |')
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
    L.push('| 值 | ' + (a.bigDate ?? '-') + ' | ' + (a.bigClose ?? '-') + ' | ' + (a.closePos === undefined ? '-' : a.closePos + '%') + ' | ' + (a.barsAgo === null ? '-' : a.barsAgo + '日') + ' | ' + (a.hardStop ?? '-') + ' | ' + (a.dev5 === undefined ? '-' : (a.dev5 > 0 ? '+' : '') + a.dev5 + '%') + ' | ' + (a.volRatio ?? '-') + ' |')
  }
  return L
}
