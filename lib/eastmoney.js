/**
 * 东方财富数据接口封装。
 *
 * 提供 westock CLI 没有的关键数据：
 * - 准确市值（总市值/流通市值）、PE、PB
 * - 上市公司公告全文列表（用于财务风险扫描）
 * - ST / 风险警示板名单
 *
 * 所有请求走 Node 原生 fetch（实测 Host 进程可直连，单次 100-250ms）。
 */

const QUOTE_API = 'https://push2.eastmoney.com/api/qt/stock/get'
const CLIST_API = 'https://push2.eastmoney.com/api/qt/clist/get'
const NOTICE_API = 'https://np-anotice-stock.eastmoney.com/api/security/ann'

const DEFAULT_TIMEOUT = 10000

/** 把 sh600519 / sz002343 转成东财 secid（1=沪，0=深） */
export function toSecId(code) {
  const m = String(code ?? '').trim().toLowerCase().match(/^(sh|sz|bj)(\d{6})$/)
  if (!m) return undefined
  const [, market, digits] = m
  if (market === 'sh') return `1.${digits}`
  if (market === 'sz') return `0.${digits}`
  return undefined // 北交所东财 secid 规则不同，本项目不使用
}

async function fetchJson(url, timeout = DEFAULT_TIMEOUT) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      Referer: 'https://quote.eastmoney.com/',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/**
 * 获取单只股票的实时行情与估值指标。
 * @returns {Promise<{code,name,price,totalCap,floatCap,pe,pb,turnover,changePct}|undefined>}
 */
export async function fetchQuote(code) {
  const secid = toSecId(code)
  if (!secid) return undefined
  const fields = 'f57,f58,f43,f116,f117,f162,f167,f168,f170,f169'
  try {
    const j = await fetchJson(`${QUOTE_API}?secid=${secid}&fields=${fields}`)
    const d = j?.data
    if (!d || !d.f57) return undefined
    const num = (v, div = 1) => (Number.isFinite(v) && v !== '-' ? v / div : undefined)
    return {
      code: `${secid.startsWith('1') ? 'sh' : 'sz'}${d.f57}`,
      name: d.f58,
      price: num(d.f43, 100),
      totalCap: num(d.f116, 1e8),      // 亿元
      floatCap: num(d.f117, 1e8),      // 亿元
      pe: num(d.f162, 100),
      pb: num(d.f167, 100),
      turnover: num(d.f168, 100),      // 换手率 %
      changePct: num(d.f170, 100),     // 涨跌幅 %
    }
  } catch {
    return undefined
  }
}

/**
 * 判断股票是否处于 ST / 退市风险状态。
 *
 * 实现说明：东财的 clist 批量列表接口（用于拉全市场 ST 名单）会触发限流
 * （`fetch failed / other side closed`），因此改为**基于单股行情返回的名称**判定，
 * 这在个股分析场景下更稳定、也足够准确（单股接口实测 100% 可用）。
 *
 * 判定规则与 A 股命名规范一致：ST 标记位于名称开头
 * （`ST` / `*ST` / `SST` / `S*ST`），若 ST 后紧跟英文字母则视为英文单词（如 STAR）。
 */
export function detectSTStatus(name) {
  if (!name) return { isST: false, reason: undefined }
  const normalized = String(name).toUpperCase().replace(/\s+/g, '')
  const m = normalized.match(/^(\*?ST|SST|S\*ST)(.*)$/)
  if (m) {
    const rest = m[2]
    if (rest && /^[A-Z]/.test(rest)) return { isST: false, reason: undefined }
    return { isST: true, reason: `名称含 ST 标记（${name}）` }
  }
  if (normalized.includes('退')) return { isST: true, reason: `名称含「退」（${name}）` }
  return { isST: false, reason: undefined }
}

/**
 * 按流通市值分档。
 * @returns {'超大盘'|'大盘'|'中盘'|'小盘'|'微盘'|undefined}
 */
export function capTier(floatCap) {
  if (!Number.isFinite(floatCap)) return undefined
  if (floatCap >= 1000) return '超大盘'
  if (floatCap >= 500) return '大盘'
  if (floatCap >= 100) return '中盘'
  if (floatCap >= 30) return '小盘'
  return '微盘'
}

/**
 * 获取股票公告列表。
 * @param {string} code 形如 sz002343
 * @param {number} size 拉取条数（默认 100）
 * @returns {Promise<Array<{date,title,type}>>}
 */
export async function fetchAnnouncements(code, size = 100) {
  const digits = String(code ?? '').replace(/^(sh|sz|bj)/, '')
  if (!/^\d{6}$/.test(digits)) return []
  try {
    const url = `${NOTICE_API}?sr=-1&page_size=${size}&page_index=1&ann_type=A&client_source=web&stock_list=${digits}`
    const j = await fetchJson(url)
    const list = j?.data?.list ?? []
    return list.map(item => ({
      date: String(item.notice_date ?? '').slice(0, 10),
      title: String(item.title ?? ''),
      type: item.ann_type?.join(',') ?? '',
    }))
  } catch {
    return []
  }
}

/**
 * 财务风险判定规则。
 *
 * ⚠️ 教训（实测踩过的坑）：
 * A 股公告标题存在大量**子串陷阱**与**程序性披露**，单纯 includes() 会严重误报：
 *
 *   1. 「无保留意见」是**好**的审计意见，却包含坏词「保留意见」
 *      → 曾把双星新材、五粮液等判成「财务重大风险」
 *   2. 「控股股东资金占用情况的专项说明」是**例行**年报附件
 *      → 曾把五粮液判成致命
 *   3. 「重大资产重组减值测试审核报告」是重组程序文件
 *      → 曾把长江电力判成严重
 *   4. 「向特定对象发行股票审核问询函的回复」是再融资审核流程
 *      → 曾把工商银行判成严重
 *
 * 因此改为「正则规则表」：每条规则自带级别，并支持否定前瞻/排除表达式。
 */

/** 风险规则：{ re, level, label, definitive? } —— re 用正则，便于处理否定与上下文
 *  definitive: true 表示「单条出现即足以定性」，不参与降级
 */
export const RISK_RULES = [
  // ---------- 致命 ----------
  { re: /立案调查/, level: 'fatal', label: '立案调查', definitive: true },
  { re: /行政处罚决定|市场禁入/, level: 'fatal', label: '行政处罚', definitive: true },
  { re: /退市风险警示|终止上市|暂停上市|强制退市/, level: 'fatal', label: '退市风险', definitive: true },
  { re: /无法表示意见/, level: 'fatal', label: '审计无法表示意见', definitive: true },
  { re: /否定意见/, level: 'fatal', label: '审计否定意见', definitive: true },
  // 保留意见：必须排除「无保留意见」
  { re: /(?<!无)保留意见(?!.*无保留)/, level: 'fatal', label: '审计保留意见', definitive: true },
  { re: /财务造假|财务舞弊|虚增(利润|收入)/, level: 'fatal', label: '财务造假', definitive: true },
  { re: /违规担保|违规占用/, level: 'fatal', label: '违规担保/占用', definitive: true },
  { re: /重大违法强制退市/, level: 'fatal', label: '重大违法', definitive: true },

  // ---------- 严重 ----------
  // 强调事项段：审计师提醒关注，属警示但不否定报表
  { re: /带强调事项段|强调事项的专项说明|强调事项段的无保留意见/, level: 'severe', label: '审计强调事项段' },
  { re: /风险警示(?!板)/, level: 'severe', label: '风险警示' },
  // 问询函：排除「审核问询函」（再融资/重组的程序性审核）
  { re: /(?<!审核)问询函(?!的?回复)/, level: 'severe', label: '交易所问询函' },
  { re: /监管函|警示函|关注函/, level: 'severe', label: '监管函件' },
  // 减值：排除「减值测试」类程序文件
  { re: /计提(资产|信用|商誉)?减值|资产减值准备|商誉减值/, level: 'severe', label: '计提减值' },
  { re: /预亏|首亏|续亏|预计亏损/, level: 'severe', label: '业绩预亏' },
  { re: /业绩预减|业绩大幅下滑|净利润.*下降.*[5-9]\d%/, level: 'severe', label: '业绩下滑' },

  // ---------- 提示 ----------
  { re: /异常波动/, level: 'warning', label: '股价异常波动' },
  { re: /诉讼|仲裁/, level: 'warning', label: '诉讼仲裁' },
  { re: /股份冻结|司法冻结/, level: 'warning', label: '股份冻结' },
  { re: /质押/, level: 'warning', label: '股权质押' },
  { re: /核销/, level: 'warning', label: '资产核销' },
  { re: /澄清公告/, level: 'warning', label: '澄清公告' },
]

/**
 * 例行/程序性披露白名单：命中则**完全跳过**风险判定。
 * 这些是合规性、程序性文件，不构成风险事件。
 */
export const ROUTINE_PATTERNS = [
  // 资金占用类专项说明（年报标准附件，各种措辞变体）
  /资金占用/,
  /关联资金往来/,
  /专项审计说明$|专项审核报告$/,       // 注意：不能写成 /专项说明$/，否则会吞掉「强调事项的专项说明」
  /会计师事务所.*专项(说明|报告)$/,
  // 审计报告编号
  /信会师报字|审字\[|审字（/,
  // 内控
  /内部控制审计报告|内部控制评价报告/,
  // 募集资金
  /募集资金.*(存放|使用|专项)/,
  /募集说明书|上市公告书|发行情况报告书/,
  // 再融资/重组程序文件
  /审核问询函/,
  /减值测试(审核)?报告/,
  /标的资产.*审核/,
  /重大资产重组.*(进展|报告书|审核)/,
  // 定期报告与治理
  /季度报告|半年度报告|年度报告(?!.*更正)|业绩说明会/,
  /董事会.*决议|监事会.*决议|股东大会.*决议/,
  /独立董事.*(意见|专门会议)/,
  /续聘.*会计师事务所/,
  /利润分配|权益分派|分红.*实施/,
  // ESG
  /社会责任报告|环境.*社会.*治理报告|ESG报告/,
  // 衍生
  /可转债.*(付息|兑付|转股)/,
  // 权益变动（例行）
  /权益变动报告书|简式权益变动/,
]

/** 判断标题是否为例行/程序性披露 */
function isRoutineDisclosure(title) {
  return ROUTINE_PATTERNS.some(re => re.test(title))
}

/**
 * 扫描公告，识别财务/合规风险。
 *
 * @param {Array<{date,title}>} announcements
 * @returns {{fatal:Array,severe:Array,warning:Array,level:string,score:number,matched:Array}}
 */
export function scanAnnouncementRisk(announcements) {
  const fatal = []
  const severe = []
  const warning = []
  const matched = []

  for (const ann of announcements ?? []) {
    const title = ann.title ?? ''
    if (isRoutineDisclosure(title)) continue
    for (const rule of RISK_RULES) {
      if (!rule.re.test(title)) continue
      const entry = { ...ann, label: rule.label, definitive: rule.definitive === true }
      if (rule.level === 'fatal') fatal.push(entry)
      else if (rule.level === 'severe') severe.push(entry)
      else warning.push(entry)
      matched.push({ date: ann.date, title, level: rule.level, label: rule.label, definitive: entry.definitive })
      break   // 一条公告只归入最高级别的一条规则
    }
  }

  // 分级：可降级的信号要求「反复出现」，但 definitive 信号单条即定性
  const definitiveHit = fatal.find(x => x.definitive)
  let level = 'none'
  let score = 0
  if (definitiveHit) { level = 'fatal'; score = -35 }
  else if (fatal.length >= 2) { level = 'fatal'; score = -30 }
  else if (fatal.length === 1) { level = 'severe'; score = -18 }   // 单条非定性致命 → 严重
  else if (severe.length >= 3) { level = 'severe'; score = -15 }
  else if (severe.length > 0) { level = 'warning'; score = -8 }    // 少量严重 → 提示
  else if (warning.length >= 5) { level = 'warning'; score = -5 }
  else if (warning.length > 0) { level = 'warning'; score = -2 }

  return { fatal, severe, warning, level, score, matched }
}

/**
 * 不同市值档位对应的策略参数（越小的盘越保守）。
 */
export const TIER_PARAMS = {
  超大盘: { volumeRatio: 1.5, hardStopPct: 5, maxWeightPct: 30, note: '流动性好，可用标准参数' },
  大盘: { volumeRatio: 1.5, hardStopPct: 5, maxWeightPct: 25, note: '流动性好，可用标准参数' },
  中盘: { volumeRatio: 1.8, hardStopPct: 5, maxWeightPct: 20, note: '波动加大，量能要求提高' },
  小盘: { volumeRatio: 2.0, hardStopPct: 6, maxWeightPct: 10, note: '假突破率高，需更严格确认' },
  微盘: { volumeRatio: 2.5, hardStopPct: 8, maxWeightPct: 5, note: '流动性风险大，仅小仓位试探' },
}
