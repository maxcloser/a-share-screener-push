import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/**
 * 封装腾讯自选股 CLI（westock-data-clawhub）。
 *
 * CLI 的约束（见参考文档 SKILL.md）：
 * - 输出为 Markdown 表格，批量查询时第一列是 `symbol`，单只查询时第一列是 `code`
 * - `search` / `minute` 不支持批量
 * - `quote` 在部分发布渠道不可用，因此行情一律用 `kline` 获取
 * - 带 `--fq qfq` 时仍返回不复权原始价格，需要自行按不复权/前复权计算涨跌幅
 */

const MINUS = /^[-—–]+$/

function toNumber(text) {
  if (text === undefined || text === null) return undefined
  const raw = String(text).trim()
  if (raw === '' || raw === '-' || MINUS.test(raw)) return undefined
  const cleaned = raw.replace(/[,%¥\s]/g, '')
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : undefined
}

function splitRow(line) {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|')) body = body.slice(0, -1)
  return body.split('|').map(cell => cell.trim())
}

/**
 * 解析 CLI 的 Markdown 表格输出为对象数组。
 * 非表格行（标题、Batch 状态、空行）会被忽略。
 */
export function parseMarkdownTables(text) {
  const rows = []
  let header = null
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      header = null
      continue
    }
    const cells = splitRow(trimmed)
    if (cells.every(cell => MINUS.test(cell))) continue
    if (header === null) {
      header = cells
      continue
    }
    const row = {}
    for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i] ?? ''
    rows.push(row)
  }
  return rows
}

/** 取行内第一个存在的字段名（兼容单股 `code` 与批量 `symbol`）。 */
function pickValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== '') return row[key]
  }
  return undefined
}

function asNumber(row, ...keys) {
  for (const key of keys) {
    const value = toNumber(row[key])
    if (value !== undefined) return value
  }
  return undefined
}

/** 解析 `kline --period day` 输出为按代码分组的日线数组（日期升序）。
 *
 * 单只查询时 CLI 不返回 `code`/`symbol` 列，需要由调用方用 `defaultCode` 补齐。
 */
export function parseKline(text, defaultCode) {
  const byCode = new Map()
  for (const row of parseMarkdownTables(text)) {
    const code = pickValue(row, ['symbol', 'code']) ?? defaultCode
    const date = row.date
    if (!code || !date) continue
    const bar = {
      date,
      open: asNumber(row, 'open'),
      close: asNumber(row, 'last', 'close'),
      high: asNumber(row, 'high'),
      low: asNumber(row, 'low'),
      volume: asNumber(row, 'volume'),
      amount: asNumber(row, 'amount'),
      turnover: asNumber(row, 'exchange'),
    }
    if (bar.close === undefined) continue
    const list = byCode.get(code) ?? []
    list.push(bar)
    byCode.set(code, list)
  }
  for (const list of byCode.values()) list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  return byCode
}

/** 解析 `technical` 输出（单股时还能拿到 name）。 */
export function parseTechnical(text, defaultCode) {
  const byCode = new Map()
  for (const row of parseMarkdownTables(text)) {
    const code = pickValue(row, ['code', 'symbol', 'SecuCode']) ?? defaultCode
    if (!code) continue
    byCode.set(code, {
      code,
      name: row.name || undefined,
      date: row.date || undefined,
      close: asNumber(row, 'closePrice', 'last'),
      ma5: asNumber(row, 'ma.MA_5'),
      ma10: asNumber(row, 'ma.MA_10'),
      ma20: asNumber(row, 'ma.MA_20'),
      ma30: asNumber(row, 'ma.MA_30'),
      ma60: asNumber(row, 'ma.MA_60'),
      ema12: asNumber(row, 'ma.EMA_12'),
      ema26: asNumber(row, 'ma.EMA_26'),
      dif: asNumber(row, 'macd.DIF'),
      dea: asNumber(row, 'macd.DEA'),
      macd: asNumber(row, 'macd.MACD'),
      k: asNumber(row, 'kdj.KDJ_K'),
      d: asNumber(row, 'kdj.KDJ_D'),
      j: asNumber(row, 'kdj.KDJ_J'),
      rsi: asNumber(row, 'rsi.RSI_6'),
      bollUpper: asNumber(row, 'boll.BOLL_UPPER'),
      bollMid: asNumber(row, 'boll.BOLL_MID'),
      bollLower: asNumber(row, 'boll.BOLL_LOWER'),
      bias6: asNumber(row, 'bias.BIAS_6'),
      sar: asNumber(row, 'dmi.SAR'),
    })
  }
  return byCode
}

/** 解析 `asfund` 输出的主力资金字段（金额单位：元）。 */
export function parseFundFlow(text, defaultCode) {
  const byCode = new Map()
  for (const row of parseMarkdownTables(text)) {
    const code = pickValue(row, ['code', 'symbol', 'SecuCode']) ?? defaultCode
    if (!code) continue
    byCode.set(code, {
      code,
      mainNetFlow: asNumber(row, 'MainNetFlow'),
      jumboNetFlow: asNumber(row, 'JumboNetFlow'),
      mainNetFlow5D: asNumber(row, 'MainNetFlow5D'),
      mainNetFlow10D: asNumber(row, 'MainNetFlow10D'),
      mainNetFlow20D: asNumber(row, 'MainNetFlow20D'),
      mainInflow: asNumber(row, 'MainInFlow'),
      mainOutflow: asNumber(row, 'MainOutFlow'),
      retailNetFlow: asNumber(row, 'RetailInFlow', 'RetailOutFlow') === undefined
        ? undefined
        : (asNumber(row, 'RetailInFlow') ?? 0) - (asNumber(row, 'RetailOutFlow') ?? 0),
    })
  }
  return byCode
}

/** 解析 `search` 输出，返回 [{ code, name, type }]。 */
export function parseSearch(text) {
  const out = []
  for (const row of parseMarkdownTables(text)) {
    if (!row.code) continue
    out.push({ code: row.code, name: row.name, type: row.type })
  }
  return out
}

/** 解析 `board`/`hot board` 输出为热门板块列表。 */
export function parseBoards(text) {
  const out = []
  for (const row of parseMarkdownTables(text)) {
    if (!row.name) continue
    out.push({
      name: row.name,
      code: row.symbol,
      changePct: asNumber(row, 'changePct', 'zdf'),
      rank: asNumber(row, 'rank'),
      leadStock: row.leadStock,
      turnoverRate: asNumber(row, 'turnoverRate'),
    })
  }
  return out
}

/** 解析 `suspension hs` 为停牌代码集合。 */
export function parseSuspensions(text) {
  const set = new Set()
  for (const row of parseMarkdownTables(text)) {
    if (row.code) set.add(row.code)
  }
  return set
}

/** 解析 `profile`，仅用于补齐股票名称。 */
export function parseProfile(text, defaultCode) {
  const byCode = new Map()
  for (const row of parseMarkdownTables(text)) {
    const code = pickValue(row, ['code', 'symbol']) ?? defaultCode
    if (!code) continue
    byCode.set(code, { name: row.name, industry: row.industry })
  }
  return byCode
}

/**
 * 把启动器命令解析成可以直接 spawn 的形式。
 *
 * Windows 上 `npx` / `npm` 只是 .cmd 垫片，Node 在 `shell: false` 下无法直接执行
 * （ENOENT 或 EINVAL）。这里优先查找同目录下的 `node_modules/npm/bin/npx-cli.js`，
 * 用当前 node 进程去跑，避免依赖 cmd.exe 和 shell 转义；退化时才走 `cmd /c`。
 */
function resolveLauncher(command, extraArgs) {
  const isWindows = process.platform === 'win32'
  if (!isWindows) return { file: command, args: [...extraArgs] }

  const lower = command.toLowerCase()
  const bare = lower.replace(/\.(cmd|exe|bat|ps1)$/, '')
  const nodeDir = path.dirname(process.execPath)

  if (bare === 'npx' || bare === 'npm' || bare === 'pnpm') {
    const candidates = [
      path.join(nodeDir, 'node_modules', 'npm', 'bin', `${bare}-cli.js`),
      path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', `${bare}-cli.js`),
    ]
    if (bare === 'pnpm') {
      candidates.push(path.join(nodeDir, '..', 'pnpm', 'bin', `${bare}.cjs`))
    }
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        return { file: process.execPath, args: [candidate, ...extraArgs] }
      }
    }
    // 退化：命令本身带 .cmd/.bat 或无法定位 CLI 脚本时用 cmd.exe 执行
    const target = /\.(cmd|bat)$/.test(lower) ? command : `${command}.cmd`
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', target, ...extraArgs] }
  }

  return { file: command, args: [...extraArgs] }
}

/**
 * 调用 CLI。返回 { ok, stdout, stderr, error }，永不抛出。
 */
export function runCli(cli, args, signal) {
  const command = cli.command || 'npx'
  const extraArgs = Array.isArray(cli.extraArgs) ? cli.extraArgs : ['-y']
  const pkg = cli.package || 'westock-data-clawhub@1.0.4'
  const launcher = resolveLauncher(command, [...extraArgs, pkg])
  const fullArgs = [...launcher.args, ...args]
  const timeoutMs = Number(cli.timeoutMs) > 0 ? Number(cli.timeoutMs) : 60000

  return new Promise(resolve => {
    let child
    try {
      child = spawn(launcher.file, fullArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', error: `无法启动 ${launcher.file}: ${error?.message ?? error}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(result)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ ok: false, stdout, stderr, error: `命令超时（${timeoutMs}ms）` })
    }, timeoutMs)

    const onAbort = () => {
      try { child.kill() } catch {}
      finish({ ok: false, stdout, stderr, error: '已取消' })
    }
    if (signal) {
      if (signal.aborted) { onAbort(); return }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    child.on('error', error => {
      finish({ ok: false, stdout, stderr, error: `执行失败: ${error?.message ?? error}` })
    })
    child.on('close', code => {
      const usable = stdout.trim() !== ''
      if (code !== 0 && !usable) {
        finish({ ok: false, stdout, stderr, error: (stderr.trim() || `退出码 ${code}`).slice(0, 400) })
        return
      }
      finish({ ok: true, stdout, stderr, error: undefined })
    })
  })
}

/**
 * 按批次并发执行任务。
 */
export async function mapPool(items, limit, worker) {
  const size = Math.max(1, Math.min(Number(limit) || 1, items.length || 1))
  const results = new Array(items.length)
  let cursor = 0
  async function run() {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: size }, run))
  return results
}

export async function sleep(ms) {
  await delay(ms)
}

export { toNumber }
