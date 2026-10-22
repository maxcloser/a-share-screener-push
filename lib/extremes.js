/**
 * 极端形态识别：一字板、连板、停牌核查。
 *
 * 这些形态的共性是「不可交易」或「监管已介入」，
 * 优先级高于任何技术指标信号，必须能直接否决买入结论。
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)

/** 涨跌停幅度阈值（按板块区分） */
function limitUpThreshold(code) {
  if (/^(sh688|sz30)/.test(code)) return 19.8   // 科创板/创业板 20%
  return 9.8                                     // 主板 10%
}

/**
 * 分析近 N 日的涨停形态：一字板、连板、开板。
 *
 * @param {string} code 股票代码
 * @param {Array} bars 日 K 线（升序）
 * @param {number} lookback 回看天数
 */
export function analyzeLimitPattern(code, bars, lookback = 30) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { available: false, reason: 'K线数据不足' }
  }
  const threshold = limitUpThreshold(code)
  const from = Math.max(1, bars.length - lookback)
  const boards = []

  for (let i = from; i < bars.length; i += 1) {
    const b = bars[i]
    const p = bars[i - 1]
    if (!p || p.close <= 0) continue
    const chg = ((b.close - p.close) / p.close) * 100
    const amp = ((b.high - b.low) / p.close) * 100
    if (chg >= threshold) {
      boards.push({
        date: b.date,
        chg: round(chg),
        amp: round(amp),
        turnover: round(b.turnover),
        amount: b.amount,
        isOneWord: amp <= 0.5,       // 一字板：振幅极小
        index: i,
      })
    }
  }

  const oneWordBoards = boards.filter(b => b.isOneWord)
  const lastBoard = boards.length > 0 ? boards[boards.length - 1] : undefined
  const lastOneWord = oneWordBoards.length > 0 ? oneWordBoards[oneWordBoards.length - 1] : undefined

  // 连续一字板计数（从最后一个一字板往前数）
  let consecutiveOneWord = 0
  if (lastOneWord) {
    let i = lastOneWord.index
    while (i >= 1) {
      const b = bars[i], p = bars[i - 1]
      const chg = ((b.close - p.close) / p.close) * 100
      const amp = ((b.high - b.low) / p.close) * 100
      if (chg >= threshold && amp <= 0.5) { consecutiveOneWord += 1; i -= 1 } else break
    }
  }

  // 是否已开板（最后一个一字板之后有交易日，且当日振幅明显放大）
  const lastIdx = lastOneWord?.index
  let openedAfter = false
  let openDayInfo
  if (lastIdx !== undefined && lastIdx < bars.length - 1) {
    for (let i = lastIdx + 1; i < bars.length; i += 1) {
      const b = bars[i], p = bars[i - 1]
      const amp = p.close > 0 ? ((b.high - b.low) / p.close) * 100 : 0
      if (amp > 3) {
        openedAfter = true
        openDayInfo = { date: b.date, amp: round(amp), turnover: round(b.turnover), amount: b.amount }
        break
      }
    }
  }

  const result = {
    available: true,
    lookbackDays: lookback,
    limitThreshold: threshold,
    boardCount: boards.length,
    oneWordCount: oneWordBoards.length,
    consecutiveOneWord,
    lastBoard: lastBoard ? { date: lastBoard.date, chg: lastBoard.chg, isOneWord: lastBoard.isOneWord } : undefined,
    lastOneWord: lastOneWord ? { date: lastOneWord.date, chg: lastOneWord.chg } : undefined,
    openedAfter,
    openDayInfo,
    boards: boards.slice(-10).map(b => ({ date: b.date, chg: b.chg, amp: b.amp, oneWord: b.isOneWord })),
  }

  // 风险等级判定
  const risks = []
  if (consecutiveOneWord >= 3) {
    risks.push(`连续 ${consecutiveOneWord} 个一字板（振幅≈0），期间无法买入，开板即高位`)
  } else if (oneWordBoards.length >= 2) {
    risks.push(`近${lookback}日有 ${oneWordBoards.length} 个一字板`)
  }
  if (openedAfter && openDayInfo && Number.isFinite(openDayInfo.turnover) && openDayInfo.turnover >= 15) {
    risks.push(`开板日（${openDayInfo.date}）换手 ${openDayInfo.turnover}%、成交 ${(openDayInfo.amount / 1e8).toFixed(1)} 亿，属巨量派发`)
  }
  if (boards.length >= 5) {
    risks.push(`近${lookback}日涨停 ${boards.length} 次，累计涨幅巨大`)
  }
  result.risks = risks.length > 0 ? risks : undefined

  // 累计涨幅（从第一个涨停前一日算起）
  if (boards.length > 0) {
    const startIdx = boards[0].index - 1
    if (startIdx >= 0) {
      const startClose = bars[startIdx].close
      const lastClose = bars[bars.length - 1].close
      result.cumulativeGain = round(((lastClose - startClose) / startClose) * 100)
    }
  }

  return result
}

/**
 * 识别监管停牌核查 / 严重异常波动。
 *
 * @param {Array<{date,title}>} announcements
 */
export function analyzeRegulatoryAction(announcements) {
  const patterns = [
    { re: /停牌核查/, type: 'halt_investigation', label: '停牌核查', level: 'fatal' },
    { re: /严重异常波动/, type: 'severe_abnormal', label: '严重异常波动', level: 'fatal' },
    { re: /异常波动.{0,6}复函|复函/, type: 'reply_letter', label: '交易所问询复函', level: 'severe' },
    { re: /风险提示.{0,10}(停牌|复牌)/, type: 'risk_halt', label: '风险提示+停复牌', level: 'severe' },
    { re: /监管函|警示函/, type: 'regulatory_letter', label: '监管函/警示函', level: 'severe' },
    { re: /立案调查/, type: 'investigation', label: '立案调查', level: 'fatal' },
  ]

  const hits = []
  for (const ann of announcements ?? []) {
    const title = ann.title ?? ''
    for (const p of patterns) {
      if (p.re.test(title)) {
        hits.push({ date: ann.date, title, type: p.type, label: p.label, level: p.level })
        break
      }
    }
  }

  if (hits.length === 0) return { available: false, hits: [] }

  const hasFatal = hits.some(h => h.level === 'fatal')
  // 去重（同一类型只保留最新一条）
  const byType = new Map()
  for (const h of hits) {
    if (!byType.has(h.type) || byType.get(h.type).date < h.date) byType.set(h.type, h)
  }
  const unique = [...byType.values()].sort((a, b) => (a.date < b.date ? 1 : -1))

  return {
    available: true,
    level: hasFatal ? 'fatal' : 'severe',
    haltCount: hits.filter(h => h.type === 'halt_investigation').length,
    hits: unique.slice(0, 6),
    summary: hasFatal
      ? `交易所已介入：${unique.filter(h => h.level === 'fatal').map(h => h.label).join('、')}`
      : `监管关注：${unique.map(h => h.label).join('、')}`,
  }
}
