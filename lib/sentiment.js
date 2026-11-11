/**
 * 市场情绪状态机。
 *
 * 依据《A股短线强势股筛选系统规格》第 6 节：
 * - 指标：涨停数 L、跌停数 D、炸板数 B、触及涨停总数 U、炸板率、首板晋级率
 * - 状态：PANIC / RECOVERY / EXPANSION / CLIMAX / DECLINE / UNKNOWN
 *
 * ⚠️ 重要设计约束（第 6.3 节）：
 * 「状态输出用于限制策略开关和仓位，不是直接买入信号。」
 * 且我们此前的回测证明「用 MA20 一票否决买点」有害（-1.66% 超额），
 * 因此本模块**只做提示，不做硬性否决**。
 *
 * 数据来源：东财 clist 按涨跌幅排序，取两端统计。
 */

const round = (v, d = 1) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)

const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get'
const FS_ALL_A = 'm:0+t:6,m:0+t:80,m:1+t:2'   // 深主板 + 创业板 + 沪主板（不含科创/北交）

/** 情绪状态枚举 */
export const MARKET_REGIMES = {
  PANIC: 'PANIC',
  RECOVERY: 'RECOVERY',
  EXPANSION: 'EXPANSION',
  CLIMAX: 'CLIMAX',
  DECLINE: 'DECLINE',
  UNKNOWN: 'UNKNOWN',
}

export const REGIME_LABELS = {
  PANIC: '冰点/恐慌',
  RECOVERY: '修复',
  EXPANSION: '扩张',
  CLIMAX: '高潮/拥挤',
  DECLINE: '衰退',
  UNKNOWN: '数据不足',
}

export const REGIME_ADVICE = {
  PANIC: '市场极度悲观，建议空仓或极轻仓，不参与短线',
  RECOVERY: '情绪修复初期，可小仓位试探，严格止损',
  EXPANSION: '情绪扩张期，正常参与，但仍需控制单票仓位',
  CLIMAX: '情绪过热、交易拥挤，建议减仓不追高',
  DECLINE: '情绪衰退，减少操作，已持仓者考虑减仓',
  UNKNOWN: '数据不足，无法判断市场情绪',
}

async function fetchRanked(order, pageSize = 100, retries = 3) {
  const url = `${CLIST}?pn=1&pz=${pageSize}&po=${order}&np=1&fltt=2&invt=2&fid=f3&fs=${encodeURIComponent(FS_ALL_A)}&fields=f2,f3,f12,f14`
  let lastErr
  const delays = [500, 1200, 2500]
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      const list = j?.data?.diff
      if (!Array.isArray(list) || list.length === 0) throw new Error('返回空数据')
      return { total: j?.data?.total ?? 0, list }
    } catch (e) {
      lastErr = e
      if (attempt < retries) await new Promise(r => setTimeout(r, delays[attempt] ?? 2000))
    }
  }
  throw lastErr
}

/**
 * 采集当日市场情绪原始指标。
 *
 * 涨停判定：涨幅 ≥ 9.8%（主板口径近似；创业板20%涨停也会被计入，不影响「数量级」判断）
 * 炸板判定：需要「最高价触及涨停但收盘未涨停」—— clist 的 f3 是收盘涨幅，
 *           f2 是现价，无法直接得到最高价，因此炸板率在本实现中标记为不可得。
 */
export async function fetchMarketSentiment() {
  let up, down
  try {
    // ⚠️ 串行请求：并发会触发东财限流（实测 fetch failed）
    up = await fetchRanked(1, 100)
    await new Promise(r => setTimeout(r, 250))
    down = await fetchRanked(0, 100)
  } catch (e) {
    return { available: false, reason: `行情接口失败：${e.message}` }
  }

  const total = up.total
  const limitUpList = up.list.filter(x => Number(x.f3) >= 9.8)
  const limitDownList = down.list.filter(x => Number(x.f3) <= -9.8)

  // ⚠️ 单页只有 100 条：若第100名涨幅仍 ≥9.8%，说明涨停家数被低估
  const lastUpPct = Number(up.list[up.list.length - 1]?.f3 ?? 0)
  const lastDownPct = Number(down.list[down.list.length - 1]?.f3 ?? 0)
  const upTruncated = lastUpPct >= 9.8
  const downTruncated = lastDownPct <= -9.8

  const limitUp = limitUpList.length
  const limitDown = limitDownList.length

  // 广度：涨幅>0 的比例无法精确算（单页限制），用「涨幅>5%的家数」做代理
  const strongUp = up.list.filter(x => Number(x.f3) >= 5).length

  return {
    available: true,
    total,
    limitUp: upTruncated ? `>${limitUp}` : limitUp,
    limitDown: downTruncated ? `>${limitDown}` : limitDown,
    limitUpCount: limitUp,
    limitDownCount: limitDown,
    strongUpCount: strongUp,        // 涨幅≥5% 家数（情绪强度代理）
    limitUpSamples: limitUpList.slice(0, 8).map(x => `${x.f14}(${x.f3}%)`),
    truncated: upTruncated || downTruncated,
    dataLimitations: [
      upTruncated ? '涨幅榜前100名涨幅仍≥9.8%，涨停家数为下限估计' : null,
      '无盘中最高价序列，炸板率不可得（DATA_LIMITATION）',
      '无历史序列，无法计算「较近120日分位」（首次使用需累积数据）',
    ].filter(Boolean),
  }
}

/**
 * 依据当日指标推断情绪状态。
 *
 * ⚠️ 所有阈值均为 HYPOTHESIS（规格 6.3），未经样本外验证。
 * 当前使用「绝对数量」而非「历史分位」，因为缺乏历史序列。
 */
export function classifyRegime(sentiment) {
  if (!sentiment?.available) {
    return { regime: MARKET_REGIMES.UNKNOWN, reason: sentiment?.reason ?? '无情绪数据', confidence: 'none' }
  }

  const L = sentiment.limitUpCount   // 涨停数
  const D = sentiment.limitDownCount // 跌停数
  const S = sentiment.strongUpCount  // 涨幅≥5% 家数

  // 硬规则（HYPOTHESIS，待验证）
  let regime
  let reason

  if (L >= 80 && D <= 5) {
    regime = MARKET_REGIMES.CLIMAX
    reason = `涨停 ${L} 家但跌停仅 ${D} 家，极度活跃，警惕拥挤`
  } else if (L >= 50 && D <= 15) {
    regime = MARKET_REGIMES.EXPANSION
    reason = `涨停 ${L} 家、跌停 ${D} 家，赚钱效应扩散`
  } else if (L < 20 && D > 20) {
    regime = MARKET_REGIMES.PANIC
    reason = `涨停仅 ${L} 家、跌停 ${D} 家，恐慌情绪`
  } else if (L < 30 && D > L) {
    regime = MARKET_REGIMES.DECLINE
    reason = `涨停 ${L} 家少于跌停 ${D} 家，情绪衰退`
  } else if (L >= 30 && L < 50) {
    regime = MARKET_REGIMES.RECOVERY
    reason = `涨停 ${L} 家、跌停 ${D} 家，情绪中等偏暖`
  } else {
    regime = MARKET_REGIMES.UNKNOWN
    reason = `涨停 ${L} 家、跌停 ${D} 家，无明显特征`
  }

  return {
    regime,
    label: REGIME_LABELS[regime],
    reason,
    advice: REGIME_ADVICE[regime],
    confidence: sentiment.truncated ? 'low' : 'medium',
    note: '阈值均为 HYPOTHESIS，未经样本外验证；本状态仅作提示，不否决买点',
  }
}

/**
 * 一次性获取情绪快照（采集 + 分类）。
 *
 * 实测：东财 clist 接口对「并发请求」敏感，同时拉涨幅榜和跌幅榜会触发限流
 * （`fetch failed`）。因此改为**串行请求 + 逆序重试**，并加 30 秒进程内缓存，
 * 避免同一会话内反复请求。
 */
let _cache = { at: 0, value: undefined }
const CACHE_TTL_MS = 30_000

export async function getMarketRegime() {
  const now = Date.now()
  if (_cache.value && now - _cache.at < CACHE_TTL_MS) {
    return _cache.value
  }
  const sentiment = await fetchMarketSentiment()
  const classification = classifyRegime(sentiment)
  const result = { sentiment, ...classification }
  if (sentiment.available) {
    _cache = { at: now, value: result }
  }
  return result
}
