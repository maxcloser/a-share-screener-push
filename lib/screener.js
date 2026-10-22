import {
  parseBoards,
  parseFundFlow,
  parseKline,
  parseProfile,
  parseSearch,
  parseSuspensions,
  parseTechnical,
  runCli,
} from './cli.js'
import {
  mergeParameters,
  matchesScreen,
  scoreCandidate,
  formatMoney,
  evaluateMarket,
  buildPortfolio,
} from './strategies.js'

const KLINE_BATCH_SIZE = 15
const TECH_BATCH_SIZE = 15
const FUND_BATCH_SIZE = 20

const BOARD_FLAGS = {
  kcb: code => code.startsWith('sh688') || code.startsWith('sh689'),
  bj: code => code.startsWith('bj'),
  gem: code => code.startsWith('sz300') || code.startsWith('sz301'),
  sh: code => code.startsWith('sh'),
  sz: code => code.startsWith('sz'),
}

export function detectMarket(code) {
  if (/^sh688|^sh689/.test(code)) return '科创板'
  if (code.startsWith('bj')) return '北交所'
  if (/^sz300|^sz301/.test(code)) return '创业板'
  if (code.startsWith('sh')) return '沪市主板'
  if (code.startsWith('sz')) return '深市主板'
  return '其他'
}

/** 归一化代码：支持 600519 / 600519.SH / SH600519 / 000001 等写法。 */
export function normalizeCode(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return undefined
  const lower = raw.toLowerCase().replace(/\s+/g, '')
  let m = lower.match(/^(sh|sz|bj)(\d{6})$/)
  if (m) return `${m[1]}${m[2]}`
  m = lower.match(/^(\d{6})\.(sh|sz|bj)$/)
  if (m) return `${m[2]}${m[1]}`
  m = lower.match(/^(\d{6})$/)
  if (m) {
    const digits = m[1]
    if (/^(6|9)/.test(digits)) return `sh${digits}`
    if (/^(0|2|3)/.test(digits)) return `sz${digits}`
    if (/^(4|8)/.test(digits)) return `bj${digits}`
    return `sh${digits}`
  }
  return undefined
}

export function isExcludedCode(code, excludeBoards) {
  return excludeBoards.some(flag => BOARD_FLAGS[flag]?.(code))
}

/**
 * ST / 退市风险股判定。
 *
 * A 股规范命名中 ST 标记位于名称开头：`ST xxx`、`*ST xxx`、`SST xxx`、`S*ST xxx`。
 * 若 ST 之后紧跟英文字母，说明是英文单词（如 STAR、BEST），不是 ST 标记，予以放行。
 * 名称含「退」（如「退市美都」）也一并排除。
 */
export function isSTName(name) {
  if (!name) return false
  const normalized = String(name).toUpperCase().replace(/\s+/g, '')
  const match = normalized.match(/^(\*?ST|SST|S\*ST)(.*)$/)
  if (match) {
    const rest = match[2]
    if (rest && /^[A-Z]/.test(rest)) return false
    return true
  }
  if (normalized.includes('退')) return true
  return false
}

/**
 * 是否为沪深普通 A 股（排除 ETF/LOF、可转债、指数、科创板、北交所）。
 * CLI 的 `type` 字段：GP-A 主板/创业板, GP-A-KCB 科创板, ETF/LOF 等基金。
 */
/** 基金/指数类名称特征：`hot stock` 等榜单不返回 type 字段，只能靠名称兜底识别。 */
const FUND_NAME = /ETF|LOF|基金|债转股|可转债|指数|联接|QDII|REIT/i

/**
 * 是否为沪深普通 A 股（排除 ETF/LOF、可转债、指数、美股）。
 *
 * 注意：这里**不判断**科创/北交/ST —— 那些由调用方按用户配置的
 * `excludeBoards` / `excludeST` 统一过滤，避免两处硬编码不一致。
 */
export function isMainBoardAStock(row) {
  const type = row?.type ?? ''
  // 实测 type 取值：GP-A（主板）、GP-A-CYB（创业板）、GP-A-KCB（科创板）、
  // ETF / QDII-ETF / GP-ETF（基金）、GP（美股）等
  if (type && !/^GP-A/.test(type)) return false
  if (FUND_NAME.test(row?.name ?? '')) return false
  return Boolean(normalizeCode(row?.code))
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

const TIMEOUT = Symbol('timeout')

export function withTimeout(promise, ms) {
  if (!(ms > 0)) return promise
  let timer
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(TIMEOUT), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * P1-③ 行业均衡 ETF 池：**一行业一只 ETF**，避免样本被少数主题板块主导。
 *
 * 设计原则（这是回测结论可信度的前提）：
 * - 覆盖申万一级行业中 ETF 可投的 27 个
 * - 每个行业等量取样（每只 ETF 取前 20 大持仓），使行业权重接近等权
 * - 不使用宽基 ETF 叠加（各宽基前 20 大权重高度重叠，会重复放大大盘股）
 *
 * 实测：去重后约 460 只，覆盖 28 个行业，最大单行业占比约 6.5%。
 * （对比：早期用 10 只 ETF 混合行业主题，样本仅 127 只，电力设备+电子+医药+军工占 54%，无代表性。）
 */
export const DEFAULT_POOL_ETFS = [
  'sz159825', // 农林牧渔
  'sh516020', // 基础化工
  'sh515210', // 钢铁
  'sh512400', // 有色金属
  'sh515260', // 电子
  'sz159996', // 家用电器
  'sh515170', // 食品饮料
  'sh516630', // 纺织服饰
  'sh512010', // 医药生物
  'sz159159', // 公用事业
  'sz159666', // 交通运输
  'sh512200', // 房地产
  'sz159766', // 社会服务
  'sh516970', // 建筑装饰
  'sz159745', // 建筑材料
  'sh515790', // 电力设备
  'sz159886', // 机械设备
  'sh512660', // 国防军工
  'sh516110', // 汽车
  'sh512720', // 计算机
  'sh512980', // 传媒
  'sh515880', // 通信
  'sh512800', // 银行
  'sh512880', // 非银金融
  'sh515220', // 煤炭
  'sz159148', // 石油石化
  'sh512580', // 环保
]

/** 解析 `etf-holdings` 输出：| 600519 | 贵州茅台 | 3.47 | */
export function parseEtfHoldings(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.length < 2) continue
    if (!/^\d{6}$/.test(cells[0])) continue
    out.push({ code: cells[0], name: cells[1], ratio: Number(cells[2]) })
  }
  return out
}

/**
 * 通过多只 ETF 的持仓构建基础股票池。
 * @returns {Promise<{pool: {code:string,name:string}[], warnings:string[]}>}
 */
async function loadEtfPool(cli, etfList, signal, warnings, log) {
  const seen = new Map()
  let okCount = 0
  for (const etf of etfList) {
    if (signal?.aborted) break
    const result = await withTimeout(runCli(cli, ['etf-holdings', etf], signal), 60000)
    if (result === TIMEOUT || !result.ok) continue
    const rows = parseEtfHoldings(result.stdout)
    if (rows.length === 0) continue
    okCount += 1
    for (const row of rows) {
      const code = normalizeCode(row.code)
      if (!code) continue
      if (!seen.has(code)) seen.set(code, { code, name: row.name })
    }
    log?.(`ETF 股票池 ${okCount}/${etfList.length}，累计 ${seen.size} 只`)
  }
  if (okCount === 0) warnings.push('ETF 持仓获取失败，样本池退回热点模式')
  return { pool: [...seen.values()], okCount }
}

/**
 * 构建候选股票池。
 * @returns {Promise<{universe: {code, name, hotBoards:Set}[], hotBoards: object[], notes: string[], warnings: string[]}>}
 */
export async function buildUniverse({ config, params, options, signal, log }) {
  const cli = config.cli ?? {}
  const excludeBoards = normalizeBoardList(options.excludeBoards ?? config.excludeBoards)
  const excludeST = options.excludeST ?? config.excludeST ?? true
  const notes = []
  const warnings = []
  const map = new Map()

  const add = (code, name, boardName) => {
    if (!code) return
    let entry = map.get(code)
    if (!entry) {
      entry = { code, name: name || undefined, hotBoards: new Set() }
      map.set(code, entry)
    } else if (!entry.name && name) {
      entry.name = name
    }
    if (boardName) entry.hotBoards.add(boardName)
  }

  // ---- 1. 显式代码 ----
  // 默认同样遵守「排除科创/北交/ST」规则，避免绕过过滤；
  // 只有显式声明 includeExcluded=true 时才放行（用于诊断已有持仓）。
  const requestedCodes = (options.codes ?? []).map(normalizeCode).filter(Boolean)
  const includeExcluded = options.includeExcluded === true
  const explicitCodes = []
  const droppedExplicit = []
  for (const code of requestedCodes) {
    const excludedByBoard = isExcludedCode(code, excludeBoards)
    if (!includeExcluded && excludedByBoard) {
      droppedExplicit.push(`${code}（${detectMarket(code)}）`)
      continue
    }
    explicitCodes.push(code)
    add(code, undefined)
  }
  if (requestedCodes.length > 0) {
    if (droppedExplicit.length > 0) {
      notes.push(`指定股票中已排除 ${droppedExplicit.length} 只（科创/北交/创业板等）：${droppedExplicit.join('、')}；如需诊断这些股票请传 includeExcluded=true`)
    }
    notes.push(`指定股票 ${explicitCodes.length} 只${includeExcluded ? '（includeExcluded=true，跳过板块过滤）' : ''}`)
  }
  // 只传了 codes 时，不再混入热点股票池，避免把「指定股票诊断」变成全市场扫描
  const explicitOnly = explicitCodes.length > 0
    && (options.keywords ?? []).length === 0
    && options.universe === 'codes'

  // ---- 2. 关键词搜索 ----
  const keywords = (options.keywords ?? []).filter(Boolean)
  const keywordLimit = Number(options.keywordLimit ?? 20)
  const keywordSet = new Set()
  for (const keyword of keywords) {
    log?.(`搜索「${keyword}」`)
    // 行业词常先返回 ETF/美股，A股个股在后，因此一次多取一些
    const result = await runCli(cli, ['search', keyword, '--stock', '--limit', String(Math.max(keywordLimit * 5, 50))], signal)
    if (!result.ok) {
      warnings.push(`搜索「${keyword}」失败：${result.error}`)
      continue
    }
    const all = parseSearch(result.stdout)
    const hits = all.filter(row => isMainBoardAStock(row) && !(excludeST && isSTName(row.name)))
    let added = 0
    for (const row of hits) {
      const code = normalizeCode(row.code)
      if (!code || isExcludedCode(code, excludeBoards)) continue
      add(code, row.name)
      keywordSet.add(code)
      added += 1
      if (added >= keywordLimit) break
    }
    notes.push(`关键词「${keyword}」命中 ${Math.min(added, keywordLimit)} 只`)
  }

  // ---- 2.5 P1-③ 宽基 ETF 持仓池（大幅扩大样本，覆盖大中盘主流标的） ----
  if (!explicitOnly && options.useEtfPool !== false && (options.universe === 'hot' || options.universe === 'all')) {
    log?.('构建 ETF 持仓股票池')
    const etfList = Array.isArray(options.poolEtfs) && options.poolEtfs.length > 0
      ? options.poolEtfs
      : DEFAULT_POOL_ETFS
    const { pool: etfPool, okCount } = await loadEtfPool(cli, etfList, signal, warnings, log)
    let added = 0
    for (const item of etfPool) {
      if (isExcludedCode(item.code, excludeBoards)) continue
      if (excludeST && isSTName(item.name)) continue
      if (!map.has(item.code)) { add(item.code, item.name); added += 1 }
    }
    if (okCount > 0) notes.push(`ETF 持仓池 ${okCount} 只 ETF → 新增 ${added} 只候选`)
  }

  // ---- 3. 股票池：热点板块领涨股 / 热搜榜 ----
  const hotBoards = []
  /** P2-⑥ 板块名 → 当日涨幅排名（1 起），供板块共振打分使用。 */
  const boardRanks = new Map()
  const wantHot = !explicitOnly
  let sawLeadStock = 0
  if (wantHot && options.fromHotBoards !== false && (options.universe === 'hot' || options.universe === 'all')) {
    log?.('拉取热点板块')
    const boardLimit = Number(options.boardLimit ?? 10)
    // `hot board` 给排名、`board` 给领涨股，字段互补，两者都取后按板块名合并
    const hot = await runCli(cli, ['hot', 'board', '--limit', String(Math.max(boardLimit * 2, 10))], signal)
    const plain = await runCli(cli, ['board'], signal)
    const merged = new Map()
    for (const board of [
      ...(hot.ok ? parseBoards(hot.stdout) : []),
      ...(plain.ok ? parseBoards(plain.stdout) : []),
    ]) {
      if (!board.name) continue
      const existing = merged.get(board.name) ?? { ...board }
      if (!existing.leadStock && board.leadStock) existing.leadStock = board.leadStock
      if (existing.changePct === undefined && board.changePct !== undefined) existing.changePct = board.changePct
      if (existing.rank === undefined && board.rank !== undefined) existing.rank = board.rank
      merged.set(board.name, existing)
    }
    const boards = [...merged.values()]
    const seen = new Set()
    for (const board of boards) {
      if (!board.name || seen.has(board.name)) continue
      seen.add(board.name)
      if (hotBoards.length >= boardLimit) break
      hotBoards.push(board)
    }
    // 板块排名：优先用接口给的 rank，缺失则按涨幅降序自行编号
    const sortedByChange = boards
      .filter(board => Number.isFinite(board.changePct))
      .sort((a, b) => b.changePct - a.changePct)
    sortedByChange.forEach((board, index) => {
      boardRanks.set(board.name, Number.isFinite(board.rank) ? board.rank : index + 1)
    })
    for (const board of boards) {
      if (!boardRanks.has(board.name) && Number.isFinite(board.rank)) boardRanks.set(board.name, board.rank)
    }
    for (const board of hotBoards) {
      const lead = board.leadStock
      if (!lead) continue
      // leadStock 形如「田中精机(19.99)」：括号内是涨幅，不是代码，需要按名称搜索补代码
      const leadName = String(lead).replace(/\([^)]*\)\s*$/, '').trim()
      if (!leadName) continue
      const found = await runCli(cli, ['search', leadName, '--stock'], signal)
      if (!found.ok) continue
      const rows = parseSearch(found.stdout)
      const hit = rows.find(row => row.name === leadName && isMainBoardAStock(row))
        ?? rows.find(row => isMainBoardAStock(row))
      if (hit) {
        add(normalizeCode(hit.code), hit.name, board.name)
        sawLeadStock += 1
      }
    }
    notes.push(`热点板块 ${hotBoards.length} 个（已建立 ${boardRanks.size} 个板块排名），领涨股 ${sawLeadStock} 只，股票池累计 ${map.size} 只`)
  }

  if (wantHot && options.fromHotList !== false && (options.universe === 'hot' || options.universe === 'all')) {
    log?.('拉取热搜股票')
    const hotStock = await runCli(cli, ['hot', 'stock', '--limit', String(Math.max(Number(options.scanLimit ?? config.defaultScanLimit ?? 40) * 2, 30))], signal)
    if (hotStock.ok) {
      let added = 0
      for (const row of parseSearch(hotStock.stdout)) {
        if (!isMainBoardAStock(row)) continue
        add(normalizeCode(row.code), row.name)
        added += 1
      }
      notes.push(`热搜榜补充 ${added} 只`)
    }
  }

  // ---- 4. 若本次是用关键词限定范围，则热点池只作为「板块热度加分」参考，不并入股票池 ----
  if (keywords.length > 0 && options.matchedOnly && keywordSet.size > 0) {
    for (const code of [...map.keys()]) {
      if (!keywordSet.has(code)) map.delete(code)
    }
    notes.push('本次仅扫描关键词命中的股票（热点板块信息仅用于加分）')
  }

  // ---- 5. 最终兜底过滤：任何来源（热点/热搜/关键词/显式）都不允许绕过 ----
  // 例外：显式传入 codes 且 includeExcluded=true 时，这些代码允许保留（用于诊断持仓）
  const whitelisted = includeExcluded ? new Set(explicitCodes) : new Set()
  let excluded = 0
  const excludedSamples = []
  for (const [code, entry] of [...map]) {
    if (whitelisted.has(code)) continue
    let reason
    if (isExcludedCode(code, excludeBoards)) reason = detectMarket(code)
    else if (excludeST && isSTName(entry.name)) reason = 'ST'
    if (reason) {
      map.delete(code)
      excluded += 1
      if (excludedSamples.length < 5) excludedSamples.push(`${code}(${reason})`)
      continue
    }
  }
  if (excluded > 0) {
    const boardLabel = excludeBoards.length > 0 ? excludeBoards.join('/') : '未指定'
    notes.push(`排除（${boardLabel}/ST）共 ${excluded} 只${excludedSamples.length > 0 ? `：${excludedSamples.join('、')}${excluded > excludedSamples.length ? ' 等' : ''}` : ''}`)
  }

  const pool = [...map.values()]
  return { universe: pool, hotBoards, boardRanks, notes, warnings, keywordCodes: [...keywordSet] }
}

/**
 * P1-④ 取大盘指数日K（默认上证指数 sh000001），用于环境过滤。
 * 失败时返回 undefined，策略层会自动跳过过滤而不是报错。
 */
async function loadMarket(cli, signal, warnings, options) {
  const indexCode = options.indexCode || 'sh000001'
  const result = await withTimeout(runCli(cli, ['kline', indexCode, '--period', 'day', '--limit', '80'], signal), TIMEOUT_TECH)
  if (result === TIMEOUT || !result.ok) {
    warnings.push(`大盘指数（${indexCode}）获取失败，跳过环境过滤`)
    return undefined
  }
  const parsed = parseKline(result.stdout, indexCode)
  const bars = parsed.get(indexCode) ?? [...parsed.values()][0]
  if (!bars || bars.length === 0) {
    warnings.push(`大盘指数（${indexCode}）无数据，跳过环境过滤`)
    return undefined
  }
  return bars
}

function normalizeBoardList(list) {
  if (!Array.isArray(list)) return ['kcb', 'bj']
  return list
    .map(item => String(item).toLowerCase())
    .flatMap(item => {
      if (item === 'kcb' || item === 'star' || item === '科创' || item === '科创板') return ['kcb']
      if (item === 'bj' || item === 'bse' || item === '北交' || item === '北交所' || item === '北京') return ['bj']
      if (item === 'gem' || item === 'cyb' || item === '创业' || item === '创业板') return ['gem']
      return []
    })
}

/** 批量取日K。 */
async function loadKlines(cli, codes, signal, warnings, log) {
  const bars = new Map()
  const batches = chunk(codes, KLINE_BATCH_SIZE)
  let done = 0
  for (const batch of batches) {
    if (signal?.aborted) break
    const result = await withTimeout(runCli(cli, ['kline', batch.join(','), '--period', 'day', '--limit', '60'], signal), TIMEOUT_KLINE)
    if (result === TIMEOUT) {
      warnings.push(`K线批次超时（${batch.length} 只）：${batch.slice(0, 3).join(',')}...`)
    } else if (!result.ok) {
      warnings.push(`K线批次失败：${result.error}`)
    } else {
      // 单只查询时表格没有代码列，用 batch[0] 兜底
      for (const [code, list] of parseKline(result.stdout, batch.length === 1 ? batch[0] : undefined)) {
        bars.set(code, list)
      }
    }
    done += batch.length
    log?.(`K线 ${Math.min(done, codes.length)}/${codes.length}`)
  }
  return bars
}

const TIMEOUT_KLINE = 120000

/** 批量取技术指标与资金流。 */
async function loadEnrichments(cli, codes, signal, warnings, log) {
  const tech = new Map()
  const flow = new Map()
  for (const batch of chunk(codes, TECH_BATCH_SIZE)) {
    if (signal?.aborted) break
    const result = await withTimeout(runCli(cli, ['technical', batch.join(','), '--group', 'ma,macd,kdj,rsi'], signal), TIMEOUT_TECH)
    if (result === TIMEOUT) warnings.push(`技术指标批次超时（${batch.length} 只）`)
    else if (!result.ok) warnings.push(`技术指标批次失败：${result.error}`)
    else for (const [code, value] of parseTechnical(result.stdout, batch.length === 1 ? batch[0] : undefined)) tech.set(code, value)
  }
  log?.(`技术指标 ${tech.size}/${codes.length}`)

  for (const batch of chunk(codes, FUND_BATCH_SIZE)) {
    if (signal?.aborted) break
    const result = await withTimeout(runCli(cli, ['asfund', batch.join(',')], signal), TIMEOUT_TECH)
    if (result === TIMEOUT) warnings.push(`资金流批次超时（${batch.length} 只）`)
    else if (!result.ok) warnings.push(`资金流批次失败：${result.error}`)
    else for (const [code, value] of parseFundFlow(result.stdout, batch.length === 1 ? batch[0] : undefined)) flow.set(code, value)
  }
  log?.(`资金流 ${flow.size}/${codes.length}`)
  return { tech, flow }
}

const TIMEOUT_TECH = 90000

/** 补齐名称与停牌状态。 */
async function loadProfile(cli, codes, signal, warnings) {
  const names = new Map()
  for (const batch of chunk(codes, 15)) {
    if (signal?.aborted) break
    const result = await withTimeout(runCli(cli, ['profile', batch.join(',')], signal), TIMEOUT_TECH)
    if (result.ok) for (const [code, value] of parseProfile(result.stdout, batch.length === 1 ? batch[0] : undefined)) names.set(code, value)
  }
  const suspended = new Set()
  const suspendedResult = await withTimeout(runCli(cli, ['suspension', 'hs'], signal), TIMEOUT_TECH)
  if (suspendedResult.ok) for (const code of parseSuspensions(suspendedResult.stdout)) suspended.add(code)
  else warnings.push(`停牌名单获取失败：${suspendedResult.error}`)
  return { names, suspended }
}

/** 单只股票的分红/财报信息（用于基本面加分）。 */
async function loadFundamental(cli, codes, signal) {
  const info = new Map()
  if (codes.length === 0) return info
  const dividend = await withTimeout(runCli(cli, ['dividend', codes.join(','), '--years', '1'], signal), TIMEOUT_TECH)
  if (dividend.ok) {
    for (const row of parseDividend(dividend.stdout)) {
      const entry = info.get(row.code) ?? {}
      entry.dividend = row.text
      info.set(row.code, entry)
    }
  }
  const reserve = await withTimeout(runCli(cli, ['reserve', codes.join(',')], signal), TIMEOUT_TECH)
  if (reserve.ok) {
    for (const row of parseReserve(reserve.stdout)) {
      const entry = info.get(row.code) ?? {}
      entry.report = row.text
      entry.disclosureDesc = row.desc
      info.set(row.code, entry)
    }
  }
  return info
}

function parseDividend(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.length < 3) continue
    if (!/^(sh|sz|bj)\d{6}$/.test(cells[0])) continue
    out.push({ code: cells[0], text: cells.slice(1, 5).filter(Boolean).join(' ') })
  }
  return out
}

function parseReserve(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
    if (cells.length < 6) continue
    if (!/^(sh|sz|bj)\d{6}$/.test(cells[0])) continue
    out.push({ code: cells[0], text: `${cells[2]} 财报`, desc: cells[5] })
  }
  return out
}

/**
 * P2 解析 `chip` 筹码成本：获利盘比例、平均成本、集中度。
 *
 * ⚠️ 批量调用时 CLI 会把每只股票**横向展开**成独立的 8 列块：
 *   | sz002172.code | sz002172.name | ... | sz002172.chipConcentration70 | sh600522.code | ...
 * 每一行只有其中一个块有值，其余为 `-`。
 * 因此需要按「列名带代码前缀」动态建立 代码 → 列偏移 的映射，而不是只看第一列。
 */
export function parseChip(text) {
  const out = new Map()
  const lines = String(text ?? '').split(/\r?\n/).filter(l => l.trim().startsWith('|'))
  if (lines.length === 0) return out

  // 找表头行（含 code 列名）
  const headerIndex = lines.findIndex(l => /\.code|^\|\s*code\s*\|/.test(l))
  if (headerIndex === -1) return out
  const header = lines[headerIndex].replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())

  const num = v => {
    const n = Number(String(v).replace(/[,%]/g, ''))
    return Number.isFinite(n) ? n : undefined
  }

  // 建立 代码 → { profitRate: 列号, avgCost: 列号, concentration90: 列号, concentration70: 列号 }
  const columnMap = new Map()
  header.forEach((name, idx) => {
    const m = name.match(/^((?:sh|sz|bj)\d{6})\.(.+)$/)
    if (!m) return
    const [, code, field] = m
    if (!columnMap.has(code)) columnMap.set(code, {})
    columnMap.get(code)[field] = idx
  })

  for (const line of lines.slice(headerIndex + 1)) {
    const cells = line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.every(c => /^-+$/.test(c))) continue
    for (const [code, cols] of columnMap) {
      const pick = field => (cols[field] !== undefined ? num(cells[cols[field]]) : undefined)
      const profitRate = pick('chipProfitRate')
      const avgCost = pick('chipAvgCost')
      if (profitRate === undefined && avgCost === undefined) continue
      out.set(code, {
        profitRate,
        avgCost,
        concentration90: pick('chipConcentration90'),
        concentration70: pick('chipConcentration70'),
      })
    }
  }
  return out
}

/** P2 解析 `shareholder` 十大股东中的机构持仓变化。 */
export function parseShareholder(text) {
  const out = new Map()
  let currentCode
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const header = line.match(/^####\s+((?:sh|sz|bj)\d{6})/)
    if (header) { currentCode = header[1]; continue }
    if (!currentCode) continue
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim())
    if (cells.length < 5) continue
    if (!/^\d+$/.test(cells[0])) continue
    const holderName = cells[1] ?? ''
    if (!/基金|证券|保险|社保|QFII|香港中央结算|资产管理|投资|信托/.test(holderName)) continue
    const change = Number(String(cells[4]).replace(/,/g, ''))
    const entry = out.get(currentCode) ?? { institutionCount: 0, netChange: 0, holders: [] }
    entry.institutionCount += 1
    if (Number.isFinite(change)) entry.netChange += change
    if (entry.holders.length < 3) entry.holders.push({ name: holderName.slice(0, 18), change: Number.isFinite(change) ? change : 0 })
    out.set(currentCode, entry)
  }
  return out
}

/**
 * P2 估值/筹码/机构 数据装载。
 * 仅对最终候选股执行，避免全池调用导致耗时爆炸。
 */
async function loadDeepFundamentals(cli, codes, signal, warnings, options) {
  const out = new Map()
  if (codes.length === 0) return out
  const get = code => { if (!out.has(code)) out.set(code, {}); return out.get(code) }
  const batch = 20

  if (options.includeChip !== false) {
    for (let i = 0; i < codes.length; i += batch) {
      const chunkCodes = codes.slice(i, i + batch)
      const r = await withTimeout(runCli(cli, ['chip', chunkCodes.join(',')], signal), TIMEOUT_TECH)
      if (!r.ok) { warnings.push(`筹码数据获取失败：${r.error}`); break }
      for (const [code, v] of parseChip(r.stdout)) Object.assign(get(code), { chip: v })
    }
  }

  if (options.includeShareholder !== false) {
    // shareholder 单次多股可能超时，按小批处理
    for (let i = 0; i < Math.min(codes.length, 12); i += 4) {
      const chunkCodes = codes.slice(i, i + 4)
      const r = await withTimeout(runCli(cli, ['shareholder', chunkCodes.join(',')], signal), TIMEOUT_TECH)
      if (!r.ok) continue
      for (const [code, v] of parseShareholder(r.stdout)) Object.assign(get(code), { shareholder: v })
    }
  }

  return out
}

/**
 * 执行一次完整选股。
 */
export async function runScreen({ config, args, signal, log }) {
  const cli = config.cli ?? {}
  const params = mergeParameters(args.parameters)
  const hasCodes = Array.isArray(args.codes) && args.codes.length > 0
  const hasKeywords = Array.isArray(args.keywords) && args.keywords.length > 0
  // 只给 codes 而不给关键词时，只分析这些股票，不混入热点池
  const universe = args.universe === 'codes' || (hasCodes && !hasKeywords && !args.universe)
    ? 'codes'
    : (args.universe ?? 'hot')
  const options = {
    codes: args.codes ?? [],
    keywords: args.keywords ?? [],
    universe,
    screen: args.screen ?? 'all',
    minScore: Number(args.minScore ?? 0),
    topN: Math.max(1, Math.min(Number(args.topN ?? config.defaultTopN ?? 20), 100)),
    excludeBoards: args.excludeBoards,
    excludeST: args.excludeST,
    includeExcluded: args.includeExcluded,
    scanLimit: Number(args.scanLimit ?? config.defaultScanLimit ?? 40),
    keywordLimit: args.keywordLimit,
    boardLimit: args.boardLimit,
    fromHotBoards: args.fromHotBoards,
    fromHotList: args.fromHotList,
    indexCode: args.indexCode ?? config.indexCode,
    // P1-③ ETF 持仓池
    useEtfPool: args.useEtfPool ?? config.useEtfPool,
    poolEtfs: args.poolEtfs ?? config.poolEtfs,
    // P2 深度因子
    includeChip: args.includeChip ?? config.includeChip,
    includeShareholder: args.includeShareholder ?? config.includeShareholder,
    // 关键词模式下只扫描命中股（除非显式要求 universe=all）
    matchedOnly: hasKeywords && universe !== 'all',
  }

  const startedAt = Date.now()
  log?.('构建股票池')
  const built = await buildUniverse({ config, params, options, signal, log })
  const pool = built.universe
  const { hotBoards, boardRanks, notes, warnings } = built
  if (pool.length === 0) {
    return {
      asOf: new Date().toISOString(),
      dataDate: undefined,
      params,
      universe: { total: 0, scanned: 0 },
      notes,
      warnings: [...warnings, '股票池为空：请检查关键词、热点板块获取，或直接传入 codes'],
      candidates: [],
      hotBoards,
      market: undefined,
      disclaimer: DISCLAIMER,
    }
  }

  // 大盘环境：始终抓取用于**展示**；是否用它否决信号由 params.requireMarketUp 决定
  log?.('获取大盘指数')
  const marketBars = await loadMarket(cli, signal, warnings, options)
  const marketEnv = marketBars ? evaluateMarket(marketBars, params) : undefined
  const marketSummary = marketEnv
    ? {
      ok: marketEnv.ok,
      unknown: marketEnv.unknown,
      reason: marketEnv.reason,
      ...marketEnv.metrics,
    }
    : undefined

  const scanLimit = Math.max(1, options.scanLimit)
  const prefiltered = pool
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.hotBoards.size - a.entry.hotBoards.size || a.index - b.index)
    .slice(0, scanLimit)
    .map(item => item.entry)
  if (pool.length > scanLimit) notes.push(`股票池 ${pool.length} 只，按热点命中数优先扫描前 ${scanLimit} 只`)

  const codes = prefiltered.map(entry => entry.code)
  log?.(`扫描 ${codes.length} 只股票`)

  const bars = await loadKlines(cli, codes, signal, warnings, log)
  const missing = codes.filter(code => !bars.has(code) || (bars.get(code)?.length ?? 0) < params.minBars)
  if (missing.length > 0) notes.push(`${missing.length} 只因数据不足或停牌被跳过`)

  const tradable = codes.filter(code => !missing.includes(code))
  const { tech, flow } = await loadEnrichments(cli, tradable, signal, warnings, log)
  const { names, suspended } = await loadProfile(cli, tradable, signal, warnings)

  const topByScore = []

  // ---- 第一段：技术面粗筛（不含 P2 deep 数据，速度快） ----
  const preScored = tradable
    .filter(code => !suspended.has(code))
    .map(code => {
      const entry = prefiltered.find(item => item.code === code)
      const name = entry?.name || names.get(code)?.name || code
      const candidate = scoreCandidate({
        code,
        name,
        bars: bars.get(code),
        tech: tech.get(code),
        flow: flow.get(code),
        boardNames: entry?.hotBoards,
        boardRanks,
        market: marketBars,
        params,
      })
      return { ...candidate, market: detectMarket(code), hotBoards: entry?.hotBoards }
    })
    .sort((a, b) => b.score - a.score)

  // ---- 第二段：对入围候选加载 P2 deep 数据（筹码/机构）并重新评分 ----
  // 只对粗筛前 N*2 只调用，避免对全池调用导致耗时爆炸
  const shortlistSize = Math.min(preScored.length, Math.max(options.topN * 2, 10))
  const shortlist = preScored.slice(0, shortlistSize)
  const wantDeep = options.includeChip !== false || options.includeShareholder !== false
  let deepMap = new Map()
  if (wantDeep && shortlist.length > 0) {
    log?.(`加载估值/机构数据（${shortlist.length} 只）`)
    deepMap = await loadDeepFundamentals(cli, shortlist.map(x => x.code), signal, warnings, options)
  }

  const rescored = shortlist.map(item => {
    const deep = deepMap.get(item.code)
    if (!deep || (!deep.chip && !deep.shareholder)) return item
    const entry = prefiltered.find(e => e.code === item.code)
    const updated = scoreCandidate({
      code: item.code,
      name: item.name,
      bars: bars.get(item.code),
      tech: tech.get(item.code),
      flow: flow.get(item.code),
      boardNames: entry?.hotBoards,
      boardRanks,
      market: marketBars,
      params,
      deep,
    })
    return { ...updated, market: item.market, hotBoards: item.hotBoards, deep }
  })

  // 重排后应用筛选条件
  const finalList = rescored
    .sort((a, b) => b.score - a.score)
    .filter(candidate => matchesScreen(candidate, options.screen) && candidate.score >= options.minScore)
    .slice(0, options.topN)
  topByScore.push(...finalList)

  if (config.includeFundamentals !== false && topByScore.length > 0) {
    const fundamental = await loadFundamental(cli, topByScore.map(item => item.code), signal)
    for (const item of topByScore) item.fundamental = fundamental.get(item.code) ?? {}
  }

  // ---- P2-⑧ 组合构建：板块聚类 + 仓位建议 ----
  const portfolio = buildPortfolio(topByScore, params)
  notes.push(...portfolio.notes)

  let dataDate
  for (const list of bars.values()) {
    const last = list[list.length - 1]?.date
    if (last && (!dataDate || last > dataDate)) dataDate = last
  }

  return {
    asOf: new Date().toISOString(),
    dataDate,
    elapsedMs: Date.now() - startedAt,
    params,
    universe: { total: pool.length, scanned: codes.length, scored: tradable.length },
    notes,
    warnings,
    hotBoards,
    market: marketSummary,
    candidates: topByScore,
    portfolio: { selected: portfolio.selected, groups: portfolio.groups, notes: portfolio.notes },
    disclaimer: DISCLAIMER,
  }
}

export const DISCLAIMER =
  '本结果仅为基于公开行情数据的技术面统计与规则匹配，不构成投资建议；数据来源腾讯自选股，可能存在延迟，请以交易所官方数据为准。投资有风险，决策需谨慎。'

/**
 * 把结构化结果渲染成 Markdown 表格（模型直接读取）。
 */
/** 口诀类条目是「交易动作」，其余是风险提示，渲染时用不同符号区分。 */
function isAction(text) {
  return /口诀\d/.test(text)
}

export function renderScreenMarkdown(result) {
  const lines = []
  const statusLabel = {
    buy: '买点',
    hold: '持有',
    bigcandle: '大阳线待回踩',
    watch: '观察',
    exit: '清仓',
    neutral: '不参与',
    data_missing: '数据缺失',
  }
  lines.push(`## A股选股结果${result.dataDate ? `（数据日期 ${result.dataDate}）` : ''}`)
  lines.push('')
  const u = result.universe ?? {}
  lines.push(`股票池：${u.total ?? 0} 只 → 扫描 ${u.scanned ?? 0} 只 → 有效评分 ${u.scored ?? 0} 只 → 入选 ${result.candidates.length} 只`)
  if (result.params) {
    const p = result.params
    lines.push(`战法参数：大阳线 ${p.bigCandlePct}% / 回看 ${p.bigCandleLookback} 日；大阳线需放量 ≥${p.bigCandleVolumeRatio} 倍；回踩需缩量 ≤${p.pullbackVolumeRatio} 倍；回踩容差 ${p.touchTolerancePct}%；远离阈值 ${p.farAboveMa5Pct}%；破位宽限 ${p.exitGraceDays} 日；止损 ${p.stopLossPct}%`)
  }
  // P1-④ 大盘环境
  if (result.market) {
    const mk = result.market
    const icon = mk.ok ? '✅' : '⚠️'
    lines.push(`${icon} 大盘环境：${mk.reason ?? '未知'}${Number.isFinite(mk.indexClose) ? `（指数 ${mk.indexClose} / MA${result.params?.marketMaPeriod ?? 20} ${mk.indexMa}）` : ''}`)
  }
  lines.push('')

  if (result.candidates.length === 0) {
    lines.push('> 没有符合条件的股票。可放宽条件后重试：提高 scanLimit、降低 minScore、把 screen 改为 all。')
  } else {
    lines.push('| # | 代码 | 名称 | 市场 | 现价 | 涨跌% | MA5 | 偏离MA5% | 状态 | 评分 | 大阳线 | 量比(阳线) | 回踩量比 | 获利盘% | 止损参考 | 主力净流入 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    result.candidates.forEach((item, i) => {
      const m = item.metrics ?? {}
      const big = m.bigCandle
        ? `${m.bigCandle.changePct}%(${m.bigCandle.barsAgo}日前)${m.bigCandle.volumeConfirmed === false ? '❗缩量' : ''}`
        : '-'
      const flowText = formatMoney(m.mainNetFlow)
      const stopText = Number.isFinite(m.stopLossPrice) ? `${m.stopLossPrice}` : '-'
      const chipText = Number.isFinite(m.chipProfitRate) ? `${m.chipProfitRate}` : '-'
      lines.push(`| ${i + 1} | ${item.code} | ${item.name ?? ''} | ${item.market ?? ''} | ${m.close ?? '-'} | ${m.changePct ?? '-'} | ${m.ma5 ?? '-'} | ${m.deviationMa5Pct ?? '-'} | ${statusLabel[item.status] ?? item.status} | ${item.score} | ${big} | ${m.bigCandle?.amountRatio ?? '-'} | ${m.pullbackVolumeRatio ?? '-'} | ${chipText} | ${stopText} | ${flowText} |`)
    })
    lines.push('')
    lines.push('### 个股明细')
    for (const item of result.candidates.slice(0, 15)) {
      const m = item.metrics ?? {}
      lines.push(`**${item.name}（${item.code}）· ${statusLabel[item.status] ?? item.status} · 评分 ${item.score}**`)
      if (item.advice) lines.push(`- 结论：${item.advice}`)
      if (Number.isFinite(m.stopLossPrice)) lines.push(`- 🛡️ 止损：${m.stopLossPrice}（${m.stopLossBasis}）`)
      if (Number.isFinite(m.chipProfitRate)) {
        lines.push(`- 📊 筹码：获利盘 ${m.chipProfitRate}%${Number.isFinite(m.chipAvgCost) ? ` / 平均成本 ${m.chipAvgCost}` : ''}${Number.isFinite(m.chipConcentration90) ? ` / 90%集中度 ${m.chipConcentration90}` : ''}`)
      }
      if (Number.isFinite(m.institutionCount) && m.institutionCount > 0) {
        lines.push(`- 🏛️ 机构：十大股东中 ${m.institutionCount} 家${Number.isFinite(m.institutionNetChange) && m.institutionNetChange !== 0 ? `，合计${m.institutionNetChange > 0 ? '增持' : '减持'} ${formatMoney(Math.abs(m.institutionNetChange))} 股` : ''}`)
      }
      for (const signal of (item.signals ?? []).filter(text => !isAction(text)).slice(0, 5)) lines.push(`- ✅ 信号：${signal}`)
      for (const action of [...(item.signals ?? []), ...(item.risks ?? [])].filter(isAction)) lines.push(`- 🔔 动作：${action}`)
      for (const risk of (item.risks ?? []).filter(text => !isAction(text)).slice(0, 5)) lines.push(`- ⚠️ 风险：${risk}`)
      lines.push('')
    }
  }

  // P2-⑧ 组合建议
  if (result.portfolio?.selected?.length > 0) {
    lines.push('### 组合建议')
    lines.push('| 代码 | 名称 | 板块 | 评分 | 建议仓位% |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const item of result.portfolio.selected) {
      lines.push(`| ${item.code} | ${item.name ?? ''} | ${item.portfolioGroup ?? '-'} | ${item.score} | ${item.suggestedWeight ?? '-'} |`)
    }
    lines.push('')
    lines.push(`> 组合合计仓位 ${result.portfolio.selected.reduce((s, x) => s + (x.suggestedWeight ?? 0), 0).toFixed(1)}%，单票上限 ${result.params?.maxSinglePositionPct ?? 30}%（同板块最多 ${result.params?.maxPerSector ?? 2} 只以控制相关性）`)
    lines.push('')
  }

  if (result.hotBoards?.length > 0) {
    lines.push('### 热点板块')
    lines.push('| 板块 | 涨幅% | 领涨股 |')
    lines.push('| --- | --- | --- |')
    for (const board of result.hotBoards.slice(0, 10)) {
      lines.push(`| ${board.name} | ${board.changePct ?? '-'} | ${board.leadStock ?? '-'} |`)
    }
    lines.push('')
  }
  if (result.notes?.length > 0) lines.push(`> 处理说明：${result.notes.join('；')}`)
  if (result.warnings?.length > 0) lines.push(`> 数据提示：${result.warnings.slice(0, 8).join('；')}`)
  lines.push('')
  lines.push(`> ${result.disclaimer ?? DISCLAIMER}`)
  return lines.join('\n')
}
