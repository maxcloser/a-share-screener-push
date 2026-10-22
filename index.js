import { DISCLAIMER, renderScreenMarkdown, runScreen } from './lib/screener.js'
import { analyzeStock, renderAnalysisMarkdown } from './lib/analyze.js'

export const name = 'a-share-screener'

export const inject = ['tools']

/**
 * 配置归一化。
 *
 * 本插件不导出 `Config`：Cordis 的 Config 需要 schemastery/zod 风格的 schema 对象，
 * 而插件包不应依赖 dsh 内部包。配置改为在 `cordis.patch.yml` 的 `config` 里给出，
 * 此处做宽松归一化（缺省/非法值回落到默认值），未知字段忽略。
 */
const CONFIG_DEFAULTS = {
  provider: 'westock',
  cli: { package: 'westock-data-clawhub@1.0.4', command: 'npx', extraArgs: ['-y'], timeoutMs: 60000 },
  includeFundamentals: true,
  excludeST: true,
  excludeBoards: ['kcb', 'bj'],
  defaultScanLimit: 40,
  defaultTopN: 20,
  indexCode: 'sh000001',
  useEtfPool: true,
  includeChip: true,
  includeShareholder: true,
}

export function normalizeConfig(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const cliInput = input.cli && typeof input.cli === 'object' ? input.cli : {}
  const positive = (candidate, fallback) => {
    const number = Number(candidate)
    return Number.isFinite(number) && number > 0 ? number : fallback
  }
  return {
    provider: typeof input.provider === 'string' && input.provider ? input.provider : CONFIG_DEFAULTS.provider,
    cli: {
      package: typeof cliInput.package === 'string' && cliInput.package ? cliInput.package : CONFIG_DEFAULTS.cli.package,
      command: typeof cliInput.command === 'string' && cliInput.command ? cliInput.command : CONFIG_DEFAULTS.cli.command,
      extraArgs: Array.isArray(cliInput.extraArgs) ? cliInput.extraArgs.map(String) : CONFIG_DEFAULTS.cli.extraArgs,
      timeoutMs: positive(cliInput.timeoutMs, CONFIG_DEFAULTS.cli.timeoutMs),
    },
    includeFundamentals: input.includeFundamentals !== false,
    excludeST: input.excludeST !== false,
    excludeBoards: Array.isArray(input.excludeBoards) ? input.excludeBoards.map(String) : CONFIG_DEFAULTS.excludeBoards,
    defaultScanLimit: positive(input.defaultScanLimit, CONFIG_DEFAULTS.defaultScanLimit),
    defaultTopN: positive(input.defaultTopN, CONFIG_DEFAULTS.defaultTopN),
    indexCode: typeof input.indexCode === 'string' && input.indexCode ? input.indexCode : CONFIG_DEFAULTS.indexCode,
    useEtfPool: input.useEtfPool !== false,
    includeChip: input.includeChip !== false,
    includeShareholder: input.includeShareholder !== false,
  }
}

const numberField = (description, extra = {}) => ({ type: 'number', description, ...extra })

/** a_share_screen 工具参数。 */
const parameters = {
  type: 'object',
  properties: {
    codes: {
      type: 'array',
      items: { type: 'string' },
      description: '指定股票代码，可用 600519 / sh600519 / 600519.SH 等写法。默认仍会排除科创板/北交所/ST；如需强制诊断这些股票，请同时传 includeExcluded=true。',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      description: '关键词，按股票名称模糊搜索（如「中国平安」「宁德」）。注意：数据源的搜索按名称匹配，行业词（如「半导体」）往往只命中名称含该词的个股，且会夹带 ETF/美股；这些会被自动过滤。想按行业/题材选股，请直接用 universe=hot 走热点板块，或传入 codes。',
    },
    universe: {
      type: 'string',
      enum: ['hot', 'all', 'codes'],
      description: '股票池来源。hot=热点板块领涨股 + 热搜榜（默认）；all=同上且不做关键词收窄；codes=仅分析 codes 指定的股票。只传 codes 而不传 keywords 时自动按 codes 处理。',
    },
    scanLimit: numberField('最多扫描多少只股票（按热点命中数排序后截断），默认取插件配置'),
    topN: numberField('最多返回多少只候选，默认 20，最大 100'),
    minScore: numberField('最低综合评分（0-100），默认 0'),
    screen: {
      type: 'string',
      enum: ['all', 'buy', 'watch', 'exit', 'bigcandle', 'hold'],
      description: '结果过滤：all=全部；buy=口诀2买点（大阳线后回踩5日线不破）；watch=需观察；exit=口诀5应清仓；bigcandle=近N日出现5%以上大阳线；hold=持有/买点。',
    },
    parameters: {
      type: 'object',
      description: '战法参数覆盖，未给出的项使用默认值。',
      properties: {
        bigCandlePct: numberField('大阳线涨幅阈值（%），默认 5'),
        bigCandleLookback: numberField('大阳线回看天数，默认 20'),
        bigCandleVolumeRatio: numberField('【量能确认】大阳线当日成交额需 ≥ 前5日均量的倍数，低于此值判「假阳线不参与」，默认 1.5'),
        touchTolerancePct: numberField('回踩5日线的容忍偏离（%），默认 1'),
        pullbackVolumeRatio: numberField('【缩量确认】回踩日成交额需 ≤ 前5日均量的倍数才算健康回踩，默认 0.8'),
        farAboveMa5Pct: numberField('偏离5日线多少视为「远离」需减半仓（%），默认 8'),
        exitGraceDays: numberField('跌破5日线后多少天站不回即清仓（仅在MA5<MA20时生效），默认 3'),
        hardStopPct: numberField('【P0 硬止损】自大阳线收盘价回撤该百分比即清仓，默认 5'),
        holdingDays: numberField('【P0 时间止损】大阳线后持有超过该交易日数仍未盈利则离场，默认 10'),
        maxRunUpPct: numberField('大阳线后累计涨幅上限（%），超过则不算回踩买点，默认 12'),
        stopLossPct: numberField('止损参考价：现价下方多少百分比作为展示用止损位（%），默认 5'),
        limitUpAmplitudePct: numberField('一字板判定：当日振幅 ≤ 该百分比且涨停视为一字板（不可交易），默认 1'),
        consecutiveLimitLookback: numberField('高位连板回看天数，默认 5'),
        consecutiveLimitCount: numberField('回看期内涨停次数 ≥ 该值判为高位连板，默认 3'),
        limitUpPct: numberField('涨停涨幅判定阈值（%），默认 9.8'),
        marketMaPeriod: numberField('大盘环境过滤使用的均线周期，默认 20'),
        requireMarketUp: { type: 'boolean', description: '是否要求大盘在 MA 上方才给买点（默认 true；关闭后不做大盘过滤）' },
        blockBuyInBearMarket: { type: 'boolean', description: '【P0】大盘空头时直接屏蔽买点（默认 true）。回测显示此环境下买点超额 -1.66%' },
        sectorTopN: numberField('板块共振：板块涨幅排名前 N 名才加分，默认 10'),
        maxPerSector: numberField('【组合】同板块最多持有几只，默认 2'),
        maxHoldings: numberField('【组合】组合最多持有几只，默认 5'),
        maxSinglePositionPct: numberField('【组合】单票最大仓位（%），默认 30'),
        volumeRatio: numberField('量价放量倍数阈值，默认 1.5'),
        minMainNetFlow: numberField('主力当日净流入最低值（元），默认 0'),
      },
    },
    indexCode: {
      type: 'string',
      description: '大盘环境过滤使用的指数代码，默认 sh000001（上证指数）。',
    },
    useEtfPool: {
      type: 'boolean',
      description: '【P1】是否用宽基 ETF 持仓扩充样本池（默认 true）。可把样本从约 50 只扩到数百只大中盘股。',
    },
    includeChip: {
      type: 'boolean',
      description: '【P2】是否加载筹码数据（获利盘/平均成本）做估值因子，默认 true。仅对入围候选调用。',
    },
    includeShareholder: {
      type: 'boolean',
      description: '【P2】是否加载十大股东机构持仓变化，默认 true。仅对入围候选调用。',
    },
    excludeBoards: {
      type: 'array',
      items: { type: 'string' },
      description: '排除市场：kcb(科创板) / bj(北交所) / gem(创业板)。默认排除 kcb、bj。',
    },
    excludeST: { type: 'boolean', description: '是否排除 ST 股，默认 true' },
    includeExcluded: {
      type: 'boolean',
      description: '仅在诊断 codes 指定的持仓时使用：设为 true 可强制分析科创板/北交所/ST 股票（默认 false，仍会排除）。',
    },
  },
}

/** 工具输出结构。 */
const outputSchema = {
  type: 'object',
  properties: {
    dataDate: { type: 'string', description: '行情数据日期' },
    universe: { type: 'object', additionalProperties: true },
    market: { type: 'object', additionalProperties: true, description: '大盘环境：是否站上MA20、指数点位与偏离度' },
    candidates: { type: 'array', items: { type: 'object', additionalProperties: true } },
    portfolio: { type: 'object', additionalProperties: true, description: '组合建议：板块分散后的持仓与建议仓位' },
    hotBoards: { type: 'array', items: { type: 'object', additionalProperties: true } },
    warnings: { type: 'array', items: { type: 'string' } },
    markdown: { type: 'string', description: '可直接展示的 Markdown 表格结果' },
    disclaimer: { type: 'string' },
  },
  additionalProperties: true,
}

function formatNumber(value) {
  return Number.isInteger(value) ? value : Number(value.toFixed(2))
}

/**
 * 深拷贝为无损 JSON：丢弃 undefined / 函数 / Symbol，Set 转数组。
 * 工具返回值必须能被无损序列化，否则框架会以 "not lossless JSON" 拒绝。
 */
function toLosslessJson(value, seen = new WeakSet()) {
  if (value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return Number.isFinite(value) || type !== 'number' ? value : null
  }
  if (type === 'bigint') return Number(value)
  if (type !== 'object') return undefined
  if (seen.has(value)) return undefined
  seen.add(value)
  if (value instanceof Set) return [...value].map(item => toLosslessJson(item, seen)).filter(item => item !== undefined)
  if (Array.isArray(value)) {
    return value.map(item => {
      const clean = toLosslessJson(item, seen)
      return clean === undefined ? null : clean
    })
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const clean = toLosslessJson(item, seen)
    if (clean !== undefined) out[key] = clean
  }
  return out
}

/**
 * 仅为运行期参考渲染：把完整的 Markdown 表格写进 content，
 * 让模型读取到的就是可读表格而不是原始 JSON。
 */
function renderContent(args, value) {
  const markdown = value?.markdown
  if (typeof markdown === 'string' && markdown.trim()) {
    return [{ type: 'text', text: markdown }]
  }
  return [{ type: 'text', text: '选股未返回结果。' }]
}

export function apply(ctx, config = {}) {
  const resolved = normalizeConfig(config)

  ctx.effect(() => ctx.tools.register({
    name: 'a_share_screen',
    description:
      'A股选股（5日均线战法 + 多因子）。核心口诀：5%以上大阳线（需放量≥1.5倍，否则假阳线）→ 回踩5日线缩量（≤0.8倍）不破即买点 → 远离5日线减半仓。'
      + '离场用「-5%硬止损 + 10日时间止损」（回测显示优于破MA5离场）。'
      + '大盘空头时直接屏蔽买点（回测显示此环境买点超额 -1.66%）。'
      + '样本池由宽基ETF持仓扩充至数百只大中盘股，自动排除科创/北交/ST。'
      + '叠加技术指标、主力资金、量价突破、板块共振、筹码获利盘、机构持仓，并给出板块分散的组合与建议仓位。'
      + '可传 codes 诊断指定持仓。返回 Markdown 表格（含评分、量比、获利盘、止损参考、状态与理由）。仅提供技术面统计，不构成投资建议。',
    parameters,
    output: {
      schema: outputSchema,
      render(args, value) {
        return renderContent(args, value)
      },
    },
    timeoutMs: 10 * 60 * 1000,
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      const parts = []
      if (Array.isArray(args?.codes) && args.codes.length > 0) parts.push(`指定 ${args.codes.length} 只`)
      if (Array.isArray(args?.keywords) && args.keywords.length > 0) parts.push(args.keywords.join('、'))
      if (args?.screen && args.screen !== 'all') parts.push(`筛选=${args.screen}`)
      return {
        card: 'generic',
        title: `A股选股${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`,
        kind: 'search',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const input = args && typeof args === 'object' ? args : {}
      const result = await runScreen({
        config: resolved,
        args: {
          ...input,
          excludeBoards: input.excludeBoards ?? resolved.excludeBoards,
          excludeST: input.excludeST ?? resolved.excludeST,
          scanLimit: input.scanLimit ?? resolved.defaultScanLimit,
          topN: input.topN ?? resolved.defaultTopN,
        },
        signal: exec.signal,
      })
      const markdown = renderScreenMarkdown(result)
      return toLosslessJson({
        asOf: result.asOf,
        dataDate: result.dataDate,
        universe: result.universe,
        market: result.market,
        candidateCount: result.candidates.length,
        candidates: result.candidates.map(item => ({
          code: item.code,
          name: item.name,
          market: item.market,
          status: item.status,
          score: item.score,
          advice: item.advice,
          tradable: item.tradable,
          untradableReason: item.untradableReason,
          close: Number.isFinite(item.metrics?.close) ? formatNumber(item.metrics.close) : undefined,
          changePct: item.metrics?.changePct,
          ma5: item.metrics?.ma5,
          deviationMa5Pct: item.metrics?.deviationMa5Pct,
          belowMa5Days: item.metrics?.belowMa5Days,
          bigCandle: item.metrics?.bigCandle,
          pullbackVolumeRatio: item.metrics?.pullbackVolumeRatio,
          pullbackVolumeOk: item.metrics?.pullbackVolumeOk,
          stopLossPrice: item.metrics?.stopLossPrice,
          stopLossBasis: item.metrics?.stopLossBasis,
          sectorResonance: item.metrics?.sectorResonance,
          sectorRank: item.metrics?.sectorRank,
          mainNetFlow: item.metrics?.mainNetFlow,
          volumeRatio: item.metrics?.volumeRatio,
          chipProfitRate: item.metrics?.chipProfitRate,
          chipAvgCost: item.metrics?.chipAvgCost,
          institutionCount: item.metrics?.institutionCount,
          institutionNetChange: item.metrics?.institutionNetChange,
          breakdown: item.breakdown,
          signals: item.signals,
          risks: item.risks,
        })),
        portfolio: result.portfolio,
        hotBoards: (result.hotBoards ?? []).slice(0, 10),
        notes: result.notes,
        warnings: result.warnings,
        markdown,
        disclaimer: DISCLAIMER,
      })
    },
  }))

  // ---------- 工具 2：个股深度分析 ----------
  ctx.effect(() => ctx.tools.register({
    name: 'a_share_analyze',
    description:
      '【个股深度分析】输入股票名称或代码（如「慈文传媒」/「sz002343」），输出全维度体检报告：'
      + '准确市值分档（超大盘/大盘/中盘/小盘/微盘）、PE/PB、'
      + '公告风险扫描（立案调查/退市风险/减值/问询函等，已过滤例行披露避免误报）、'
      + 'ST 与科创/北交剔除判定、技术面（均线/MACD/KDJ/RSI）、资金流（主力/超大单/散户）、'
      + '筹码结构（获利盘/平均成本/集中度），并给出结论（买入/持有/观察/减仓/清仓/回避）、'
      + '买卖参考位、止损位与仓位建议。参数按市值档位自动适配（小盘更保守）。'
      + '仅提供数据统计与规则化建议，不构成投资建议。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '股票名称或代码，如「慈文传媒」「中天科技」「sz002343」「600519」。',
        },
      },
      required: ['name'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          markdown: { type: 'string', description: '完整分析报告（Markdown）' },
          verdict: { type: 'string' },
          verdictLevel: { type: 'string' },
        },
        additionalProperties: true,
      },
      render(args, value) {
        const md = value?.markdown
        if (typeof md === 'string' && md.trim()) return [{ type: 'text', text: md }]
        return [{ type: 'text', text: value?.error ?? '分析未返回结果。' }]
      },
    },
    timeoutMs: 5 * 60 * 1000,
    isConcurrencySafe() {
      return true
    },
    presentCall(args) {
      return {
        card: 'generic',
        title: `个股分析 · ${args?.name ?? ''}`,
        kind: 'search',
        rawInput: args,
      }
    },
    async execute(args, exec) {
      const input = String(args?.name ?? '').trim()
      if (!input) return { error: '请提供股票名称或代码' }
      const result = await analyzeStock({
        config: resolved,
        input,
        signal: exec.signal,
      })
      if (result.error) {
        return { error: result.error, markdown: `## ❌ 分析失败\n\n${result.error}` }
      }
      const markdown = renderAnalysisMarkdown(result)
      return toLosslessJson({
        asOf: result.asOf,
        dataDate: result.dataDate,
        stock: result.stock,
        excluded: result.excluded,
        risk: result.risk,
        market: result.market,
        technical: {
          status: result.technical.status,
          score: result.technical.score,
          tradable: result.technical.tradable,
          metrics: result.technical.metrics,
          breakdown: result.technical.breakdown,
        },
        verdict: result.advice.verdict,
        verdictLevel: result.advice.verdictLevel,
        positionAdvice: result.advice.positionAdvice,
        buyPoints: result.advice.buyPoints,
        stopLoss: result.advice.stopLoss,
        targets: result.advice.targets,
        keyRisks: result.advice.keyRisks,
        markdown,
        disclaimer: DISCLAIMER,
      })
    },
  }))
}
