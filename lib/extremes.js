/**
 * 极端形态识别：涨停事件分类、连板结构、监管动作。
 *
 * 设计依据（A股短线强势股筛选系统规格 v1.0）：
 * - 5.1 涨停价必须按证券类别与规则版本计算，不得对全A股统一用固定阈值
 * - 5.2 必须区分 7 种涨停事件，不得把「累计涨停次数」当作「当前连板数」
 *
 * 数据限制（标记 DATA_LIMITATION）：
 * - 无分钟线 → 无法判定「首次触板时间」与「回封」的精确时点
 * - 无上市日期 → 无法处理新股上市初期的特殊涨跌幅规则
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)

/** 数据能力标记 */
export const DATA_LIMITATIONS = {
  noMinuteBars: '无分钟线，无法判定首次触板时间与回封时点',
  noListingDate: '无上市日期，新股上市初期特殊涨跌幅规则未处理',
  noOrderBook: '无盘口/逐笔数据，无法模拟排队成交概率',
}

/**
 * 判定证券的涨跌停幅度（%）。
 *
 * @param {string} code 股票代码，如 sh600487 / sz002185 / sh688001 / sz300750 / bj430047
 * @param {string} name 股票名称（用于识别 ST）
 * @returns {{limitPct:number, category:string, source:string}}
 */
export function limitUpPercent(code, name) {
  const c = String(code ?? '').toLowerCase()
  const n = String(name ?? '').toUpperCase().replace(/\s+/g, '')
  // 1) ST / *ST：5%（名称前缀判定，排除 STAR 这类英文词）
  const stMatch = n.match(/^(\*?ST|SST|S\*ST)(.*)$/)
  if (stMatch && !(stMatch[2] && /^[A-Z]/.test(stMatch[2]))) {
    return { limitPct: 5, category: 'ST', source: '风险警示股 5% 限制' }
  }
  // 2) 退市整理期
  if (n.includes('退')) {
    return { limitPct: 10, category: 'DELISTING', source: '退市整理期' }
  }
  // 3) 北交所：30%
  if (c.startsWith('bj') || /^(4|8)\d{5}$/.test(c)) {
    return { limitPct: 30, category: 'BSE', source: '北交所 30% 限制' }
  }
  // 4) 创业板 / 科创板：20%
  if (/^sz30/.test(c) || /^sh68[89]/.test(c)) {
    return { limitPct: 20, category: 'GEM_STAR', source: '创业板/科创板 20% 限制' }
  }
  // 5) 沪深主板：10%
  return { limitPct: 10, category: 'MAIN', source: '主板 10% 限制' }
}

/**
 * 涨停事件类型（依据规格 5.2）
 */
export const LIMIT_EVENTS = {
  CLOSE_LIMIT_UP: 'close_limit_up',              // 收盘涨停
  INTRADAY_TOUCH: 'intraday_touch_limit_up',     // 盘中触及涨停
  ONE_WORD: 'one_word_limit_up',                 // 一字板
  BROKEN: 'broken_limit_up',                     // 炸板（触及但收盘未涨停）
  RESEALED: 'resealed_limit_up',                 // 回封（需分钟线，标记限制）
  FIRST_BOARD: 'first_board',                    // 首板
  SECOND_BOARD: 'second_board',                  // 二板
}

/** 事件中文名 */
export const LIMIT_EVENT_LABELS = {
  close_limit_up: '收盘涨停',
  intraday_touch_limit_up: '盘中触及',
  one_word_limit_up: '一字板',
  broken_limit_up: '炸板',
  resealed_limit_up: '回封',
  first_board: '首板',
  second_board: '二板',
  consecutive_board: '连板',
}

/**
 * 分析涨停形态：事件分类 + 连板结构 + 炸板统计。
 *
 * @param {string} code
 * @param {string} name
 * @param {Array} bars 日K线（升序）
 * @param {number} lookback 回看天数
 */
export function analyzeLimitPattern(code, name, bars, lookback = 30) {
  if (!Array.isArray(bars) || bars.length < 3) {
    return { available: false, reason: 'K线数据不足' }
  }
  const { limitPct, category, source } = limitUpPercent(code, name)
  const oneWordAmpThreshold = 0.5
  const from = Math.max(1, bars.length - lookback)

  const events = []

  for (let i = from; i < bars.length; i += 1) {
    const b = bars[i]
    const p = bars[i - 1]
    if (!p || p.close <= 0) continue
    const chg = ((b.close - p.close) / p.close) * 100
    const highChg = ((b.high - p.close) / p.close) * 100
    const amp = ((b.high - b.low) / p.close) * 100
    const isCloseLimit = chg >= limitPct - 0.2
    const isTouch = highChg >= limitPct - 0.2
    const isOneWord = isCloseLimit && amp <= oneWordAmpThreshold

    if (isCloseLimit) {
      events.push({
        date: b.date, index: i, chg: round(chg), amp: round(amp),
        turnover: round(b.turnover), amount: b.amount,
        event: isOneWord ? LIMIT_EVENTS.ONE_WORD : LIMIT_EVENTS.CLOSE_LIMIT_UP,
        isOneWord, isCloseLimit: true, isTouch: true,
      })
    } else if (isTouch) {
      events.push({
        date: b.date, index: i, chg: round(chg), highChg: round(highChg), amp: round(amp),
        turnover: round(b.turnover), amount: b.amount,
        event: LIMIT_EVENTS.BROKEN,
        isOneWord: false, isCloseLimit: false, isTouch: true,
      })
    }
  }

  const closeLimitEvents = events.filter(e => e.isCloseLimit)
  const brokenEvents = events.filter(e => e.event === LIMIT_EVENTS.BROKEN)
  const oneWordEvents = events.filter(e => e.isOneWord)

  // ---- 连板结构：严格按「连续收盘涨停」，不是累计次数 ----
  let currentStreak = 0
  {
    let i = bars.length - 1
    while (i >= 1) {
      const b = bars[i], p = bars[i - 1]
      if (!p || p.close <= 0) break
      const chg = ((b.close - p.close) / p.close) * 100
      if (chg >= limitPct - 0.2) { currentStreak += 1; i -= 1 } else break
    }
  }
  let maxStreak = 0
  {
    let run = 0
    for (let i = 1; i < bars.length; i += 1) {
      const b = bars[i], p = bars[i - 1]
      if (!p || p.close <= 0) { run = 0; continue }
      const chg = ((b.close - p.close) / p.close) * 100
      if (chg >= limitPct - 0.2) { run += 1; maxStreak = Math.max(maxStreak, run) } else run = 0
    }
  }
  let boardType
  if (currentStreak === 1) boardType = LIMIT_EVENTS.FIRST_BOARD
  else if (currentStreak === 2) boardType = LIMIT_EVENTS.SECOND_BOARD
  else if (currentStreak >= 3) boardType = 'consecutive_board'

  // ---- 炸板率 ----
  const touchCount = closeLimitEvents.length + brokenEvents.length
  const brokenRate = touchCount > 0 ? round((brokenEvents.length / touchCount) * 100, 1) : undefined

  // ---- 开板检测 ----
  const lastOneWord = oneWordEvents.length > 0 ? oneWordEvents[oneWordEvents.length - 1] : undefined
  let openedAfter = false
  let openDayInfo
  if (lastOneWord && lastOneWord.index < bars.length - 1) {
    for (let i = lastOneWord.index + 1; i < bars.length; i += 1) {
      const b = bars[i], p = bars[i - 1]
      const amp = p && p.close > 0 ? ((b.high - b.low) / p.close) * 100 : 0
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
    limitRule: { limitPct, category, source },

    // 累计 vs 连续（严格分离）
    limitUpCount30d: closeLimitEvents.length,   // 近30日收盘涨停次数（累计）
    currentStreak,                               // 当前连续涨停数
    maxStreak,                                   // 窗口内最高连板
    boardType,

    // 炸板
    brokenCount: brokenEvents.length,
    brokenRate,

    // 一字板
    oneWordCount: oneWordEvents.length,
    lastOneWord: lastOneWord ? { date: lastOneWord.date, chg: lastOneWord.chg } : undefined,
    openedAfter,
    openDayInfo,

    // 明细
    events: events.slice(-12).map(e => ({ date: e.date, event: e.event, chg: e.chg, amp: e.amp })),

    dataLimitations: [DATA_LIMITATIONS.noMinuteBars, DATA_LIMITATIONS.noListingDate],
  }

  // 累计涨幅（从第一个涨停前一日算起）
  if (closeLimitEvents.length > 0) {
    const startIdx = closeLimitEvents[0].index - 1
    if (startIdx >= 0 && bars[startIdx].close > 0) {
      result.cumulativeGain = round(((bars[bars.length - 1].close - bars[startIdx].close) / bars[startIdx].close) * 100)
    }
  }

  // ---- 风险提示 ----
  const risks = []
  if (currentStreak >= 3) {
    risks.push(`当前 ${currentStreak} 连板（${source}）`)
  }
  // 连续一字板（取最近的一串）
  if (oneWordEvents.length >= 2) {
    let consecutive = 1
    for (let i = oneWordEvents.length - 1; i >= 1; i -= 1) {
      if (oneWordEvents[i].index - oneWordEvents[i - 1].index === 1) consecutive += 1
      else break
    }
    if (consecutive >= 2) {
      risks.push(`连续 ${consecutive} 个一字板（振幅≈0），期间无法买入`)
    }
  }
  if (openedAfter && openDayInfo && Number.isFinite(openDayInfo.turnover) && openDayInfo.turnover >= 15) {
    risks.push(`开板日（${openDayInfo.date}）换手 ${openDayInfo.turnover}%、成交 ${(openDayInfo.amount / 1e8).toFixed(1)} 亿，属巨量派发`)
  }
  if (brokenEvents.length >= 2) {
    risks.push(`近${lookback}日炸板 ${brokenEvents.length} 次（炸板率 ${brokenRate}%），封板质量差`)
  }
  if (closeLimitEvents.length >= 5) {
    risks.push(`近${lookback}日涨停 ${closeLimitEvents.length} 次，累计涨幅巨大`)
  }
  result.risks = risks.length > 0 ? risks : undefined

  return result
}

/**
 * 识别监管停牌核查 / 严重异常波动。
 */
export function analyzeRegulatoryAction(announcements) {
  const patterns = [
    { re: /停牌核查/, type: 'halt_investigation', label: '停牌核查', level: 'fatal' },
    { re: /严重异常波动/, type: 'severe_abnormal', label: '严重异常波动', level: 'fatal' },
    { re: /异常波动.{0,6}复函/, type: 'reply_letter', label: '交易所问询复函', level: 'severe' },
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
