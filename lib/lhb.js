/**
 * 龙虎榜与筹码分布的深度解析。
 *
 * 龙虎榜（lhb）：识别游资 vs 机构、净买卖、知名席位。
 * 筹码（chip）：支持历史序列，可追踪筹码迁移趋势。
 */

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : undefined)

/** 从 markdown 表格中提取行 */
function tableRows(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.every(c => /^-+$/.test(c))) continue
    out.push(cells)
  }
  return out
}

/**
 * 解析龙虎榜输出。
 * 输出包含三段表格：基本信息、龙虎榜统计、营业部明细。
 */
export function parseLhb(text) {
  const rows = tableRows(text)
  const result = {
    available: false,
    date: undefined,
    summary: undefined,
    seats: [],
    institutions: { buy: 0, sell: 0, net: 0, count: 0 },
    hotMoney: [],
  }
  if (rows.length === 0) return result

  let section = 'basic'
  let header = []
  for (const cells of rows) {
    const joined = cells.join(' ')
    // 识别分节标题行（非表格行已被过滤，这里靠列名判断）
    if (cells.includes('code') && cells.includes('date')) { header = cells; section = 'basic'; continue }
    if (cells.includes('Reason') && cells.includes('TotalBuy')) { header = cells; section = 'summary'; continue }
    if (cells.includes('RankType') && cells.includes('Name')) { header = cells; section = 'seats'; continue }

    const get = name => {
      const i = header.indexOf(name)
      return i >= 0 ? cells[i] : undefined
    }
    const num = v => {
      const n = Number(String(v ?? '').replace(/[,%]/g, ''))
      return Number.isFinite(n) ? n : undefined
    }

    if (section === 'basic' && /^(sh|sz|bj)\d{6}$/.test(cells[0] ?? '')) {
      result.available = true
      result.date = get('date')
      result.turnoverRate = num(get('turnoverRate'))
      result.changePct = num(get('changePct'))
    } else if (section === 'summary') {
      const reason = get('Reason')
      if (reason) {
        result.summary = {
          reason,
          totalBuy: num(get('TotalBuy')),
          totalSell: num(get('TotalSell')),
          netBuy: num(get('NetBuy')),
        }
      }
    } else if (section === 'seats') {
      const name = get('Name')
      if (!name) continue
      const buy = num(get('Buy')) ?? 0
      const sell = num(get('Sell')) ?? 0
      const tag = get('HotMoneyTags') || undefined
      result.seats.push({
        type: get('RankType'),
        rank: num(get('Rank')),
        name,
        buy,
        sell,
        net: buy - sell,
        tag,
      })
    }
  }

  // 聚合：机构 vs 游资
  for (const s of result.seats) {
    if (s.name.includes('机构专用')) {
      result.institutions.count += 1
      result.institutions.buy += s.buy
      result.institutions.sell += s.sell
    }
    if (s.tag && !result.hotMoney.includes(s.tag)) result.hotMoney.push(s.tag)
  }
  result.institutions.net = result.institutions.buy - result.institutions.sell

  // 去重（同一席位可能同时出现在买榜和卖榜）
  const seen = new Set()
  result.seats = result.seats.filter(s => {
    const k = `${s.name}|${s.buy}|${s.sell}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })

  // 按净买入排序
  result.seats.sort((a, b) => b.net - a.net)

  return result
}

/**
 * 解析筹码历史序列。
 * 输入：chip --start X --end Y 的多行输出（无 code 列）
 * 输出：按日期升序的数组
 */
export function parseChipHistory(text) {
  const rows = tableRows(text)
  const out = []
  if (rows.length === 0) return out
  let header = rows[0]
  // 若首行是表头（含 date）
  if (!header.includes('date')) return out
  for (const cells of rows.slice(1)) {
    const get = name => {
      const i = header.indexOf(name)
      return i >= 0 ? cells[i] : undefined
    }
    const date = get('date')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue
    const num = v => {
      const n = Number(String(v ?? '').replace(/[,%]/g, ''))
      return Number.isFinite(n) ? n : undefined
    }
    out.push({
      date,
      close: num(get('closePrice')),
      profitRate: num(get('chipProfitRate')),
      avgCost: num(get('chipAvgCost')),
      concentration90: num(get('chipConcentration90')),
      concentration70: num(get('chipConcentration70')),
    })
  }
  out.sort((a, b) => (a.date < b.date ? -1 : 1))
  return out
}

/**
 * 筹码分布深度分析。
 *
 * @param {object} current 当日 chip 数据 { profitRate, avgCost, concentration90, concentration70 }
 * @param {Array} history 历史序列
 * @param {number} close 当前股价
 */
export function analyzeChipDistribution(current, history, close) {
  if (!current || !Number.isFinite(current.profitRate)) {
    return { available: false, reason: '筹码数据缺失' }
  }
  const out = { available: true }
  const { profitRate, avgCost, concentration90, concentration70 } = current

  out.profitRate = round(profitRate, 1)
  out.avgCost = round(avgCost)
  out.concentration90 = round(concentration90, 2)
  out.concentration70 = round(concentration70, 2)

  // 套牢盘比例（成本高于现价的筹码）
  const trapped = Number.isFinite(profitRate) ? round(100 - profitRate, 1) : undefined
  out.trappedRate = trapped

  // 现价相对平均成本
  if (Number.isFinite(avgCost) && Number.isFinite(close) && avgCost > 0) {
    out.gapToAvgCost = round(((close - avgCost) / avgCost) * 100, 2)
  }

  // 分级判定
  const level = []
  if (Number.isFinite(profitRate)) {
    if (profitRate >= 95) level.push('获利盘极高（几乎全员浮盈，兑现压力最大）')
    else if (profitRate >= 80) level.push('获利盘高（浮盈集中，警惕获利了结）')
    else if (profitRate >= 50) level.push('获利盘中性')
    else if (profitRate >= 20) level.push('获利盘偏低（多数套牢）')
    else level.push('获利盘极低（几乎全员套牢）')
  }

  // 集中度：数值越小越集中
  if (Number.isFinite(concentration90)) {
    if (concentration90 < 10) level.push(`筹码高度集中（90%集中度 ${round(concentration90, 2)}），主力控盘强但一旦松动跌幅大`)
    else if (concentration90 < 20) level.push(`筹码较集中（${round(concentration90, 2)}）`)
    else if (concentration90 < 35) level.push(`筹码分散（${round(concentration90, 2)}）`)
    else level.push(`筹码极度分散（${round(concentration90, 2)}），无主力控盘`)
  }
  out.level = level

  // 历史趋势
  if (Array.isArray(history) && history.length >= 3) {
    const first = history[0]
    const last = history[history.length - 1]
    out.trend = {
      from: first.date,
      to: last.date,
      days: history.length,
      profitRateChange: Number.isFinite(first.profitRate) && Number.isFinite(last.profitRate)
        ? round(last.profitRate - first.profitRate, 1) : undefined,
      avgCostChange: Number.isFinite(first.avgCost) && Number.isFinite(last.avgCost)
        ? round(((last.avgCost - first.avgCost) / first.avgCost) * 100, 2) : undefined,
      concentrationChange: Number.isFinite(first.concentration90) && Number.isFinite(last.concentration90)
        ? round(last.concentration90 - first.concentration90, 2) : undefined,
    }
    // 筹码迁移判断
    const t = out.trend
    const notes = []
    if (Number.isFinite(t.avgCostChange)) {
      if (t.avgCostChange > 5) notes.push(`平均成本上移 ${t.avgCostChange}%（筹码在高位换手，套牢盘抬升）`)
      else if (t.avgCostChange < -5) notes.push(`平均成本下移 ${t.avgCostChange}%（低位换手，抛压减轻）`)
    }
    if (Number.isFinite(t.concentrationChange)) {
      if (t.concentrationChange < -3) notes.push(`集中度提高 ${Math.abs(t.concentrationChange)}（筹码向少数人集中）`)
      else if (t.concentrationChange > 3) notes.push(`集中度下降 ${t.concentrationChange}（筹码趋于分散）`)
    }
    out.trend.notes = notes.length > 0 ? notes : undefined
    // 采样近 10 日
    out.trend.sample = history.slice(-10).map(h => ({
      date: h.date,
      profitRate: round(h.profitRate, 1),
      avgCost: round(h.avgCost),
      conc90: round(h.concentration90, 2),
    }))
  }

  return out
}

/**
 * 游资/机构席位识别规则。
 * 基于营业部名称与已知游资标签。
 */
export const KNOWN_HOT_MONEY = {
  拉萨天团: '东方财富拉萨系列营业部（散户/游资混合，常出现在高位）',
  玉兰路: '东莞证券南京分公司（知名游资）',
  章盟主: '知名游资',
  赵老哥: '知名游资',
  炒新一族: '短线游资',
  深圳帮: '深圳系游资',
  宁波桑田路: '宁波系游资',
  佛山系: '佛山游资',
}

/**
 * 对龙虎榜席位做结构化解读。
 */
export function interpretLhb(lhb) {
  if (!lhb?.available) return { available: false, reason: '近期未上龙虎榜' }
  const out = { available: true }
  const s = lhb.summary

  out.date = lhb.date
  out.reason = s?.reason
  out.totalBuy = s?.totalBuy
  out.totalSell = s?.totalSell
  out.netBuy = s?.netBuy

  // 净买卖判定
  if (Number.isFinite(s?.netBuy)) {
    out.netLabel = s.netBuy > 0
      ? `龙虎榜净买入 ${(s.netBuy / 1e4).toFixed(0)} 万（买方占优）`
      : `龙虎榜净卖出 ${(Math.abs(s.netBuy) / 1e4).toFixed(0)} 万（卖方占优）`
  }

  // 机构动向
  const inst = lhb.institutions
  if (inst.count > 0) {
    out.institutionLabel = inst.net > 0
      ? `机构专用席位 ${inst.count} 个，净买入 ${(inst.net / 1e4).toFixed(0)} 万`
      : `机构专用席位 ${inst.count} 个，净卖出 ${(Math.abs(inst.net) / 1e4).toFixed(0)} 万`
    out.institutionNet = inst.net
  } else {
    out.institutionLabel = '无机构专用席位参与'
  }

  // 游资标签
  if (lhb.hotMoney.length > 0) {
    out.hotMoney = lhb.hotMoney.map(t => ({
      tag: t,
      desc: KNOWN_HOT_MONEY[t] ?? '已知游资席位',
    }))
  }

  // Top 买卖席位
  out.topBuy = lhb.seats.filter(x => x.net > 0).slice(0, 5).map(x => ({
    name: x.name.replace(/证券股份有限公司|证券营业部|有限公司/g, ''),
    net: x.net,
    tag: x.tag,
  }))
  out.topSell = lhb.seats.filter(x => x.net < 0).sort((a, b) => a.net - b.net).slice(0, 5).map(x => ({
    name: x.name.replace(/证券股份有限公司|证券营业部|有限公司/g, ''),
    net: x.net,
    tag: x.tag,
  }))

  return out
}
