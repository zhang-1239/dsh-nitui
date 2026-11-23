/**
 * Host half of the nitui bundle — 逆推（假设失败、反向推演）。
 *
 * Two independent jobs live here:
 *
 *   1. 明线：the three-question premortem. The browser half collects ①你在选什么
 *      ②失败原因 ③一个追问; this half asks the model for the follow-up question
 *      and for the premortem card, then stores the session.
 *   2. 存储：every session is append-only JSONL under `~/.nitui/sessions.jsonl`,
 *      one event per line, never rewritten. The list in the browser is folded
 *      from those events, so a restart loses nothing.
 *
 * Routes (JSON, DSH-checked):
 *   GET  /nitui/state    folded sessions + whether the model route is usable
 *   POST /nitui/action   one of the actions handled by `act()`
 *
 * Every request passes the DSH access check before any route logic:
 * `ctx.connection.requestRejection(req)` runs the Host/Origin fence (403) and
 * the browser-session/API-Peer check (401), so a page from another origin or
 * a caller without DSH's `dsh-auth-*` credential reaches nothing. The explicit
 * same-origin check stays in front as a cheap first fence.
 */
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROUTE = '/nitui'
const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = join(homedir(), '.nitui')
const insideNodeModules = (path) => path.split(/[\\/]+/).includes('node_modules')

/**
 * 数据目录优先级：
 *   1. 插件配置 dataRoot（cordis.patch.yml 的 config.dataRoot）
 *   2. 环境变量 DSH_NITUI_DATA
 *   3. 仓库内 data/（仅开发：插件目录不在 node_modules，且该目录已由 seed.js 建好）
 *   4. 用户目录 ~/.nitui
 * 任何一步落在 node_modules 里都退回用户目录；安装后的包永远不写自己的目录。
 */
const resolveRoot = (config) => {
  const explicit = typeof config?.dataRoot === 'string' ? config.dataRoot.trim() : ''
  if (explicit !== '') return resolve(explicit)
  const fromEnv = typeof process.env.DSH_NITUI_DATA === 'string' ? process.env.DSH_NITUI_DATA.trim() : ''
  if (fromEnv !== '') return resolve(fromEnv)
  const repoData = join(HERE, 'data')
  if (!insideNodeModules(HERE) && existsSync(repoData)) return repoData
  return DEFAULT_ROOT
}
const MAX_BODY_BYTES = 64 * 1024
const MAX_FIELD_CHARS = 600
const MAX_CAUSES = 5
const COMPLETE_TIMEOUT_MS = 100000

/** One 30-minute check per cause, used when the model is unavailable or vague. */
const CHECK_TEMPLATES = [
  { re: /钱|成本|费用|投入|预算|亏/, text: '30 分钟内：把这笔投入的钱、时间、注意力各写一个数，再问自己能不能承受最坏的那个数。' },
  { re: /人|沟通|团队|关系|招|合伙|客户/, text: '30 分钟内：找一个相关的人，问一句你一直不敢问的话，把原话记下来。' },
  { re: /技术|工具|系统|迁移|部署|代码|数据/, text: '30 分钟内：用最小样例把最坏的那条路径跑一次，看它到底在哪一步断。' },
  { re: /拖|时间|进度|忙|效率|拖延/, text: '30 分钟内：给这件事定一个两周后的检查点，写进日历，并写下到那天要看的一个数字。' },
  { re: /政策|审批|资质|合规|风险|不确定/, text: '30 分钟内：找一份公开文件或问一个懂的人，把你依赖的那条前提确认一遍。' },
]

const cheapCheck = (text) => {
  const hit = CHECK_TEMPLATES.find((item) => item.re.test(String(text)))
  return hit === undefined
    ? '30 分钟内：写下你会看到的第一个「不对劲」的信号，并说明多久能看到它。'
    : hit.text
}

const str = (value, max = MAX_FIELD_CHARS) => {
  if (typeof value === 'string') return value.trim().slice(0, max)
  if (typeof value === 'number') return String(value)
  return ''
}

/** Split ② into the causes the user actually wrote. */
const splitCauses = (text) =>
  String(text ?? '')
    .split(/\n+|[；;]|(?<=。)/)
    .map((line) => line.trim().replace(/^[0-9一二三四五]+[.、)）]\s*/, '').replace(/[。；;]\s*$/, ''))
    .filter((line) => line.length >= 2)
    .slice(0, 4)

const pad = (value) => String(value).padStart(2, '0')

const nowLocal = () => {
  const date = new Date()
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  const local = new Date(date.getTime() + offset * 60000).toISOString().slice(0, 19)
  return `${local}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export const inject = ['webServer', 'tools', 'connection']

export function apply(ctx, config) {
  const requestedRoot = resolveRoot(config)
  const root = insideNodeModules(requestedRoot) ? DEFAULT_ROOT : requestedRoot
  if (root !== requestedRoot) {
    ctx.logger?.warn?.('nitui: 数据目录不能位于 node_modules，已改用 ~/.nitui')
  }
  mkdirSync(root, { recursive: true })
  const sessionsFile = join(root, 'sessions.jsonl')
  const choicesFile = join(root, 'choices.jsonl')
  const recallsFile = join(root, 'recalls.jsonl')
  const configFile = join(root, 'config.json')

  /* -------------------------------------------------------------- reading */

  const readEvents = () => {
    if (!existsSync(sessionsFile)) return []
    let raw = ''
    try {
      raw = readFileSync(sessionsFile, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object' && typeof parsed.t === 'string') out.push(parsed)
      } catch {
        /* a torn line must not take the whole list down */
      }
    }
    return out
  }

  const append = (event) => {
    const at = nowLocal()
    appendFileSync(sessionsFile, `${JSON.stringify({ ...event, at })}\n`, 'utf8')
    return at
  }

  const foldSessions = (events) => {
    const map = new Map()
    const ensure = (id) => {
      let session = map.get(id)
      if (session === undefined) {
        session = {
          id,
          title: '',
          status: 'draft',
          q1: '',
          q2: '',
          q3: '',
          question: '',
          card: null,
          createdAt: '',
          updatedAt: '',
          deleted: false,
        }
        map.set(id, session)
      }
      return session
    }
    for (const event of events) {
      if (typeof event.id !== 'string' || event.id === '') continue
      const session = ensure(event.id)
      if (typeof event.at === 'string') {
        if (session.createdAt === '') session.createdAt = event.at
        session.updatedAt = event.at
      }
      if (event.t === 'start') {
        session.status = 'draft'
        session.q1 = str(event.q1)
        session.title = session.title === '' ? titleOf(event.q1) : session.title
      } else if (event.t === 'answers') {
        if (event.q1 !== undefined) session.q1 = str(event.q1)
        if (event.q2 !== undefined) session.q2 = str(event.q2)
        if (event.q3 !== undefined) session.q3 = str(event.q3)
        if (session.title === '' && session.q1 !== '') session.title = titleOf(session.q1)
      } else if (event.t === 'followup') {
        session.question = str(event.question)
      } else if (event.t === 'done') {
        session.card = event.card !== null && typeof event.card === 'object' ? event.card : null
        session.status = 'done'
      } else if (event.t === 'cancel') {
        session.status = 'cancelled'
      } else if (event.t === 'delete') {
        session.deleted = true
      } else if (event.t === 'rename') {
        const next = str(event.title, 60)
        if (next !== '') session.title = next
      }
    }
    return map
  }

  const titleOf = (q1) => {
    const text = String(q1 ?? '').replace(/\s+/g, ' ').trim()
    return text.length === 0 ? '未命名推演' : text.slice(0, 16)
  }

  const sessionsOf = () => [...foldSessions(readEvents()).values()].filter((session) => session.deleted !== true)

  const sessionOf = (id) => {
    const found = sessionsOf().find((session) => session.id === id)
    return found === undefined ? null : found
  }

  /* ------------------------------------------------------------- dark line */
  /*
   * 暗线只记录「选择事件」，字段六个以内：时间、域标签、取舍指纹、候选、选择、
   * 理由（标注来源）。它和明线互不依附：这里读取用户消息、判断取舍方向、在同类
   * 取舍上召回历史，全程不经过推演卡片。
   */

  const readJsonl = (file) => {
    if (!existsSync(file)) return []
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const out = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed !== null && typeof parsed === 'object') out.push(parsed)
      } catch {
        /* skip a torn line */
      }
    }
    return out
  }

  const appendTo = (file, record) => {
    appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  }

  const DEFAULT_DOMAINS = ['技术/产品', '生活/居住', '职业/承诺', '投资/配置', '内容判断', '工具/流程']
  const DEFAULT_SETTINGS = { darkLine: { enabled: true, recall: 'standard', sensitivity: 'standard', domains: DEFAULT_DOMAINS } }
  const RECALL_MODES = ['standard', 'premortem-only', 'off']
  const SENSITIVITIES = ['strict', 'standard', 'eager']
  /** 同域要攒够几条、同一指纹几天内不重复提示。 */
  const THRESHOLDS = { strict: { records: 8, days: 14 }, standard: { records: 5, days: 7 }, eager: { records: 3, days: 3 } }

  const clamp = (value, fallback, min, max) => {
    const number = Number(value)
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback
  }

  const normalizeSettings = (raw) => {
    const dark = raw !== null && typeof raw === 'object' && raw.darkLine !== null && typeof raw.darkLine === 'object' ? raw.darkLine : {}
    const layout = raw !== null && typeof raw === 'object' && raw.layout !== null && typeof raw.layout === 'object' ? raw.layout : {}
    const domains = []
    const domainWords = {}
    for (const entry of Array.isArray(dark.domains) ? dark.domains : []) {
      const parts = String(entry ?? '')
        .split('|')
        .map((part) => str(part, 14))
        .filter((part) => part !== '' && part !== '其他')
      if (parts.length === 0) continue
      const [name, ...words] = parts
      if (domains.includes(name)) continue
      domains.push(name)
      if (words.length > 0) domainWords[name] = words.slice(0, 8)
      if (domains.length >= 12) break
    }
    for (const name of domains) {
      if (domainWords[name] !== undefined) continue
      const words = Array.isArray(dark.domainWords?.[name]) ? dark.domainWords[name] : []
      const clean = words.map((word) => str(word, 14)).filter((word) => word !== '').slice(0, 8)
      if (clean.length > 0) domainWords[name] = clean
    }
    return {
      darkLine: {
        enabled: dark.enabled !== false,
        recall: RECALL_MODES.includes(dark.recall) ? dark.recall : 'standard',
        sensitivity: SENSITIVITIES.includes(dark.sensitivity) ? dark.sensitivity : 'standard',
        domains: domains.length > 0 ? domains : [...DEFAULT_DOMAINS],
        domainWords,
      },
      layout: {
        gap: clamp(layout.gap, 34, 0, 160),
        width: clamp(layout.width, 900, 560, 1200),
      },
    }
  }

  const readSettings = () => {
    try {
      return normalizeSettings(JSON.parse(readFileSync(configFile, 'utf8')))
    } catch {
      return normalizeSettings(null)
    }
  }

  const writeSettings = (next) => writeFileSync(configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8')

  const DOMAIN_PATTERNS = {
    '技术/产品': /代码|技术|架构|重构|数据库|接口|部署|开发|产品|功能|版本|框架|语言|性能/,
    '生活/居住': /搬家|租房|房子|通勤|住处|城市|装修|买房|小区|家具/,
    '职业/承诺': /工作|offer|跳槽|岗位|老板|团队|项目|答应|承诺|合作|客户|入职/,
    '投资/配置': /投资|基金|股票|仓位|理财|预算|花钱|价格|买入|卖出/,
    '内容判断': /写|文章|选题|标题|内容|稿|发布|表达|文案/,
    '工具/流程': /工具|流程|软件|插件|脚本|自动化|整理|模板|系统/,
  }
  const customPatterns = new Map()
  /** 自定义域没有词表，就用域名字自己的词（「人际/关系」→ 人际|关系）。 */
  const domainPattern = (name, words) => {
    const builtin = DOMAIN_PATTERNS[name]
    if (builtin !== undefined) return builtin
    const key = `${name}|${(words ?? []).join(',')}`
    if (customPatterns.has(key)) return customPatterns.get(key)
    const parts = (Array.isArray(words) && words.length > 0 ? words : name.split(/[/·、]/))
      .map((part) => String(part).trim())
      .filter((part) => part.length >= 2)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const pattern = parts.length === 0 ? /(?!)/ : new RegExp(parts.join('|'))
    customPatterns.set(key, pattern)
    return pattern
  }
  const domainOf = (text) => {
    const dark = readSettings().darkLine
    for (const name of dark.domains) {
      if (domainPattern(name, dark.domainWords[name]).test(text)) return name
    }
    return '其他'
  }

  /** 取舍指纹：方向同构才值得召回，方向相反不召回。 */
  const AXES = [
    { axis: '速度', fast: /赶紧|尽快|先跑通|先上|快一点|马上|立刻|这周|急/, slow: /稳一点|打磨|充分|再评估|观望|不急|慢/ },
    { axis: '集中', fast: /集中|专注|只做一个|押注|全力/, slow: /分散|组合|几个方向|多元/ },
    { axis: '自建', fast: /自己写|自建|自研|手写|亲自/, slow: /外包|委托|买现成|第三方|用现成/ },
    { axis: '时点', fast: /现在就做|现在做|立刻做|先做/, slow: /等等看|暂缓|以后再说|再看看/ },
    { axis: '风险', fast: /激进|冒险|搏一把|拼一次/, slow: /保守|稳妥|低调|求稳/ },
  ]
  const AXIS_NAMES = AXES.map((entry) => entry.axis)
  const fingerprintOf = (text) => {
    for (const entry of AXES) {
      if (entry.fast.test(text)) return { axis: entry.axis, pole: 'fast' }
      if (entry.slow.test(text)) return { axis: entry.axis, pole: 'slow' }
    }
    return null
  }

  const DECIDE = /(决定了|决定用|定了|就这个|就用|就选|选了|选它|改用|换成|改成|按这个|确定用|拍板|最后选)/
  const CHOICE_POINT = /(还是|要么|纠结|不知道选|选哪个|二选一|两个方案|方案[AB甲乙]|对比一下|取舍)/

  const choiceRecords = () => {
    const map = new Map()
    for (const event of readJsonl(choicesFile)) {
      if (event.t === 'log' && typeof event.id === 'string') map.set(event.id, event)
      else if (event.t === 'delete' && typeof event.id === 'string') map.delete(event.id)
    }
    return [...map.values()].sort((left, right) => (String(left.at) < String(right.at) ? -1 : 1))
  }

  const logChoice = (input) => {
    const text = str(input.chosen, 80)
    if (text === '') return { ok: false, error: 'chosen-required' }
    const known = readSettings().darkLine.domains
    const asked = str(input.domain, 14)
    const domain = asked !== '' && asked !== '其他' ? asked : domainOf(`${text} ${input.reason ?? ''}`)
    const axis = AXIS_NAMES.includes(input.axis) ? input.axis : (fingerprintOf(text)?.axis ?? '')
    const pole = input.pole === 'fast' || input.pole === 'slow' ? input.pole : (fingerprintOf(text)?.pole ?? '')
    const record = {
      t: 'log',
      id: `ch_${randomUUID().slice(0, 8)}`,
      at: nowLocal(),
      domain: domain === '其他' ? '其他' : domain,
      fingerprint: axis === '' ? null : { axis, pole },
      options: Array.isArray(input.options) ? input.options.map((option) => str(option, 40)).filter((option) => option !== '').slice(0, 4) : [],
      chosen: text,
      reason: {
        text: str(input.reason, 120),
        source: input.reasonSource === 'stated' ? 'stated' : input.reasonSource === 'inferred' ? 'inferred' : 'none',
      },
      by: input.by === 'model' ? 'model' : 'inferred',
      session: str(input.session, 80),
    }
    appendTo(choicesFile, record)
    return { ok: true, id: record.id, record }
  }

  const shortDate = (at) => String(at ?? '').slice(5, 10).replace('-', '/')

  /** 当前话里没提方向时，用这个域里最常出现的那个方向——用户的习惯也是方向。 */
  const dominantFingerprint = (records) => {
    const cells = new Map()
    for (const record of records) {
      if (record.fingerprint === null || record.fingerprint === undefined) continue
      const key = `${record.fingerprint.axis}|${record.fingerprint.pole}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    }
    let best = null
    let bestCount = 0
    for (const [key, count] of cells) {
      if (count > bestCount) {
        bestCount = count
        const [axis, pole] = key.split('|')
        best = { axis, pole }
      }
    }
    return best
  }

  /** 三道闸门：域、指纹方向、频率与数据量。任何一道不过就不召回。 */
  const recallFor = (sessionId, text, settings, dry = false) => {
    if (!settings.darkLine.enabled || settings.darkLine.recall !== 'standard') return null
    const limits = THRESHOLDS[settings.darkLine.sensitivity] ?? THRESHOLDS.standard
    const domain = domainOf(text)
    if (domain === '其他') return null
    const records = choiceRecords().filter((record) => record.domain === domain)
    if (records.length < limits.records) return null
    const print = fingerprintOf(text) ?? dominantFingerprint(records)
    if (print === null) return null
    const same = records.filter((record) => record.fingerprint !== null && record.fingerprint !== undefined && record.fingerprint.axis === print.axis && record.fingerprint.pole === print.pole)
    if (same.length === 0) return null
    const recalls = readJsonl(recallsFile)
    const muted = recalls.some(
      (entry) =>
        entry.t === 'mute' &&
        entry.fingerprint?.axis === print.axis &&
        entry.fingerprint?.pole === print.pole &&
        String(entry.at) > new Date(Date.now() - 7 * 86400000).toISOString(),
    )
    if (muted) return null
    if (recalls.some((entry) => entry.session === sessionId)) return null
    const today = nowLocal().slice(0, 10)
    if (recalls.filter((entry) => String(entry.at).slice(0, 10) === today).length >= 3) return null
    const cutoff = new Date(Date.now() - limits.days * 86400000).toISOString()
    if (recalls.some((entry) => entry.fingerprint?.axis === print.axis && entry.fingerprint?.pole === print.pole && String(entry.at) > cutoff)) return null
    const last = same[same.length - 1]
    const hint = {
      at: nowLocal(),
      session: sessionId,
      domain,
      fingerprint: print,
      lines: [
        `上次在「${domain}」的同类取舍（${print.axis}）上，你选了：${last.chosen}`,
        last.reason.text === '' ? '当时没写理由。' : `当时说：${last.reason.text}`,
        `${same.length} 条同类记录 · 最近一次 ${shortDate(last.at)}`,
      ],
    }
    if (dry !== true) appendTo(recallsFile, { t: 'recall', at: hint.at, session: sessionId, domain, fingerprint: print, lines: hint.lines })
    return hint
  }

  /** 用户消息里能看出「已经在几个选项之间定了」时，记一条低置信度的选择。 */
  const inferredChoice = (sessionId, text) => {
    if (!DECIDE.test(text)) return null
    const match = DECIDE.exec(text)
    const start = Math.max(0, (match?.index ?? 0) - 20)
    const chosen = text.slice(start, start + 60).replace(/\s+/g, ' ').trim()
    const domain = domainOf(text)
    const print = fingerprintOf(text)
    return {
      domain,
      chosen,
      reason: text.slice(0, 60),
      reasonSource: 'inferred',
      axis: print?.axis ?? '',
      pole: print?.pole ?? '',
      by: 'inferred',
      session: sessionId,
    }
  }

  /** 供渲染的三行提示与设置页记录列表使用。 */
  const publicChoices = () =>
    choiceRecords()
      .slice(-200)
      .reverse()
      .map((record) => ({
        id: record.id,
        at: record.at,
        domain: record.domain,
        axis: record.fingerprint?.axis ?? '',
        pole: record.fingerprint?.pole ?? '',
        options: record.options ?? [],
        chosen: record.chosen,
        reason: record.reason ?? { text: '', source: 'none' },
        by: record.by ?? 'inferred',
      }))

  /** 验尸卡底部那条更暗更小的参考区块：同域的历史选择，不受召回闸门限制。 */
  const historyOf = (text) => {
    const domain = domainOf(text)
    if (domain === '其他') return null
    const records = choiceRecords().filter((record) => record.domain === domain).slice(-3).reverse()
    if (records.length === 0) return null
    return {
      domain,
      lines: records.map((record) => `${shortDate(record.at)} 你选了：${record.chosen}${record.reason?.text ? `（${record.reason.text}）` : ''}`),
    }
  }

  const pendingRecalls = new Map()


  /* ----------------------------------------------------------------- model */

  const getLlm = () => {
    try {
      return ctx.get('llm') ?? null
    } catch {
      return null
    }
  }

  const configProvider = typeof config?.provider === 'string' ? config.provider.trim() : ''
  const configModel = typeof config?.model === 'string' ? config.model.trim() : ''

  /** Provider + model: explicit config, else the agent default, else the first offered. */
  const resolveModel = async () => {
    if (configProvider !== '' && configModel !== '') return { provider: configProvider, model: configModel }
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.() ?? null
      const provider = typeof selection?.provider === 'string' ? selection.provider : selection?.provider?.id
      const model = typeof selection?.model === 'string' ? selection.model : selection?.model?.id
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        return { provider, model }
      }
    } catch {
      /* fall through to the provider catalog */
    }
    const llm = getLlm()
    if (llm === null) return null
    let providers = []
    try {
      providers = llm.listProviders()
    } catch {
      return null
    }
    for (const entry of Array.isArray(providers) ? providers : []) {
      const id = typeof entry?.id === 'string' ? entry.id : ''
      if (id === '') continue
      try {
        const models = await llm.listModels(id)
        const first = Array.isArray(models) ? models.find((model) => typeof model?.id === 'string') : undefined
        if (first !== undefined) return { provider: id, model: first.id }
      } catch {
        continue
      }
    }
    return null
  }

  /**
   * One text-only completion; returns { ok, text } or { ok:false, error }.
   *
   * A reasoning model spends the token budget on hidden reasoning first, so a
   * small budget can finish as `max-tokens` with no text at all. When that
   * happens the call is retried once with a much larger budget instead of
   * leaving the user with an empty card.
   */
  const complete = async (prompt, maxTokens = 1400) => {
    const llm = getLlm()
    if (llm === null) return { ok: false, error: 'llm-unavailable' }
    const route = await resolveModel()
    if (route === null) return { ok: false, error: 'model-unresolved' }

    const attempt = async (budget) => {
      let text = ''
      let finish = ''
      let failure = ''
      let usage = 0
      let textChunks = 0
      let reasoningChunks = 0
      try {
        const stream = llm.stream({
          provider: route.provider,
          model: route.model,
          maxTokens: budget,
          signal: AbortSignal.timeout(COMPLETE_TIMEOUT_MS),
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
            text += chunk.text
            textChunks += 1
          } else if (chunk?.type === 'reasoning-delta') reasoningChunks += 1
          else if (chunk?.type === 'usage' && typeof chunk.usage?.outputTokens === 'number') usage = chunk.usage.outputTokens
          else if (chunk?.type === 'finish') {
            finish = String(chunk.reason?.kind ?? '')
            if (finish === 'error' || finish === 'aborted') failure = String(chunk.reason?.failure?.code ?? finish)
          }
        }
      } catch (error) {
        failure = String(error?.code ?? error?.message ?? 'model-failed')
      }
      return { text, finish, failure, usage, budget, textChunks, reasoningChunks }
    }

    let result = await attempt(maxTokens)
    if (result.text.trim() === '' && result.finish === 'max-tokens' && maxTokens < 12000) {
      ctx.logger?.warn?.(`nitui: llm stopped at max-tokens (${result.budget} tokens), retrying with budget`)
      result = await attempt(16000)
    }
    if (result.failure !== '') return { ok: false, error: result.failure, debug: result }
    if (result.text.trim() === '') {
      if (result.finish === 'max-tokens') ctx.logger?.warn?.(`nitui: llm produced no text within ${result.budget} tokens`)
      return { ok: false, error: result.finish === 'max-tokens' ? 'truncated' : 'empty-response', debug: result }
    }
    return { ok: true, text: result.text, route }
  }

  const aiStatus = async () => {
    const llm = getLlm()
    if (llm === null) return { available: false, error: 'llm-unavailable', provider: '', model: '' }
    const route = await resolveModel()
    if (route === null) return { available: false, error: 'model-unresolved', provider: '', model: '' }
    return { available: true, error: '', provider: route.provider, model: route.model }
  }

  /* --------------------------------------------------------------- follow-up */

  const fallbackQuestion = (q2) => {
    const first = splitCauses(q2)[0] ?? ''
    return first === ''
      ? '如果六个月后回头看，哪个最早出现的信号会让你意识到「不对」？'
      : `关于「${first.slice(0, 18)}」，最早出现的那个信号会是什么样？`
  }

  /** ③ is generated from ②; a plain fallback keeps the flow usable without a model. */
  const followupOf = async (session) => {
    const prompt = [
      '你是「事前验尸」的追问者。',
      `用户正在做一个选择：${session.q1}`,
      `他写的失败原因：${session.q2}`,
      '请只提出一个追问，逼他把其中一条失败原因说得更具体：具体到时间、钱数、某个人的原话，或一个能看到的现象。',
      '要求：中文，一句话，不超过 40 字；不要问候、不要解释、不要编号、不要引号、不要问两个问题。',
    ].join('\n')
    const result = await complete(prompt, 3000)
    if (result.ok !== true) return { question: fallbackQuestion(session.q2), source: 'fallback' }
    const line = result.text
      .split('\n')
      .map((part) => part.trim().replace(/^追问[：:]\s*/, '').replace(/^[-*\d.、）)\s]+/, ''))
      .find((part) => part.length >= 4)
    if (line === undefined) return { question: fallbackQuestion(session.q2), source: 'fallback' }
    return { question: line.slice(0, 80), source: 'ai' }
  }

  /** ②下面的三条参考：由模型按①的实际内容生成，失败时返回空数组由前端兜底。 */
  const hintsOf = async (q1) => {
    const prompt = [
      '用户正在纠结这件事：' + q1,
      '请给出 3 条「六个月后这件事失败了，最可能的原因」的候选，帮他把话说出口。',
      '要求：每条不超过 18 字，从最常见、最现实的角度写（钱、时间、身体、别人不配合、自己高估），不要评价、不要编号、不要解释。',
      '只输出一个 JSON 数组，例如 ["其实是我高估了自己的时间","预算比想的不够","关键的人不一定会配合"]。',
    ].join('\n')
    const result = await complete(prompt, 800)
    if (result.ok !== true) return []
    const start = result.text.indexOf('[')
    const end = result.text.lastIndexOf(']')
    if (start < 0 || end <= start) return []
    try {
      const parsed = JSON.parse(result.text.slice(start, end + 1))
      if (!Array.isArray(parsed)) return []
      return parsed.map((item) => str(item, 24)).filter((item) => item !== '').slice(0, 3)
    } catch {
      return []
    }
  }

  /* -------------------------------------------------------------- premortem */

  const cardPrompt = (session) => {
    const causes = splitCauses(session.q2)
    const lines = [
      '你是「事前验尸」主持者。用户假设自己的决定在六个月后已经失败，前面写着失败原因。',
      '请输出一张验尸卡，只输出一个 JSON 对象，不要代码块、不要解释。格式：',
      '{"failureScene":"六个月后失败时的具体场景，1-2 句，用用户自己的词",',
      ' "causes":[{"text":"一条死因，不超过 30 字","source":"user 或 ai","check":"30 分钟内能做完的一个检验动作"}],',
      ' "lean":{"towards":"读完这些死因后的倾向，一句话，不超过 20 字","why":"依据，不超过 40 字"}}',
      '规则：',
      `1. causes 共 3-5 条，按可能性从高到低排序。用户写了 ${causes.length} 条，其中 ${causes.length} 条必须保留原意，source 写 "user"。`,
      `2. source 为 "ai" 的条目最多 ${causes.length} 条，只能补充用户没写到的死因；宁可少写，不要凑数。`,
      '3. 每条 check 必须是 30 分钟内、一个人、现在就能做的动作（查一份记录、问一个人、跑一次最小样例、写下一个数字），不许写"多观察""保持警惕"这类空话。',
      '4. 不要复述用户原话之外的大道理；不要下结论说这个决定该不该做，lean 只是倾向，允许为空对象。',
      '',
      `① 选择：${session.q1}`,
      `② 失败原因：${session.q2}`,
      session.q3 === '' ? '' : `③ 追问的回答：${session.q3}`,
    ]
    return lines.filter((line) => line !== '').join('\n')
  }

  const parseJson = (text) => {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try {
      return JSON.parse(text.slice(start, end + 1))
    } catch {
      return null
    }
  }

  const normalizeCard = (raw, session) => {
    const userCauses = splitCauses(session.q2)
    if (raw === null || typeof raw !== 'object') {
      return {
        failureScene:
          userCauses.length === 0
            ? str(session.q2, 160)
            : `六个月后，这件事栽在：${userCauses.join('；')}。`,
        causes: userCauses.map((text) => ({ text, source: 'user', check: cheapCheck(text) })),
        lean: null,
        degraded: true,
        note: '模型暂时不可用，这张卡只整理了你写的内容，没有补充死因。',
        model: '',
      }
    }
    const userCount = Math.max(1, userCauses.length)
    let aiBudget = userCount
    const causes = []
    const rawCauses = Array.isArray(raw.causes) ? raw.causes : []
    for (const item of rawCauses) {
      const text = str(typeof item === 'string' ? item : item?.text, 80)
      if (text === '') continue
      const source = item?.source === 'ai' ? 'ai' : 'user'
      if (source === 'ai') {
        if (aiBudget <= 0) continue
        aiBudget -= 1
      }
      const check = str(item?.check, 90) || cheapCheck(text)
      causes.push({ text, source, check })
      if (causes.length >= MAX_CAUSES) break
    }
    if (!causes.some((cause) => cause.source === 'user')) {
      for (const text of userCauses) {
        if (causes.length >= MAX_CAUSES) break
        causes.push({ text, source: 'user', check: cheapCheck(text) })
      }
    }
    if (causes.length === 0) return normalizeCard(null, session)
    const lean = raw.lean !== null && typeof raw.lean === 'object' ? raw.lean : null
    const towards = str(lean?.towards, 40)
    return {
      failureScene: str(raw.failureScene, 220) || str(session.q2, 160),
      causes,
      lean: towards === '' ? null : { towards, why: str(lean?.why, 80) },
      degraded: false,
      note: '',
      model: '',
    }
  }

  const premortemOf = async (session) => {
    const result = await complete(cardPrompt(session), 6000)
    if (result.ok !== true) {
      return { card: normalizeCard(null, session), error: result.error, debug: result.debug ?? null }
    }
    const card = normalizeCard(parseJson(result.text), session)
    if (result.route !== undefined) card.model = `${result.route.provider}/${result.route.model}`
    return { card, error: '', debug: null }
  }

  /* ---------------------------------------------------------------- actions */

  const requireId = (body) => {
    const id = str(body.id, 80)
    return id === '' ? null : id
  }

  const act = async (body) => {
    const type = str(body.type, 40)

    if (type === 'settings') {
      const current = readSettings()
      const dark = body.darkLine !== null && typeof body.darkLine === 'object' ? body.darkLine : {}
      const layout = body.layout !== null && typeof body.layout === 'object' ? body.layout : {}
      const next = normalizeSettings({
        darkLine: { ...current.darkLine, ...dark },
        layout: { ...current.layout, ...layout },
      })
      writeSettings(next)
      return { ok: true, settings: next }
    }

    if (type === 'recall.dismiss') {
      const axis = str(body.fingerprint?.axis, 20)
      const pole = body.fingerprint?.pole === 'fast' || body.fingerprint?.pole === 'slow' ? body.fingerprint.pole : ''
      if (axis === '' || pole === '') return { ok: false, error: 'fingerprint-required' }
      appendTo(recallsFile, { t: 'mute', at: nowLocal(), fingerprint: { axis, pole } })
      return { ok: true }
    }

    if (type === 'choice.delete') {
      const choiceId = str(body.id, 80)
      if (choiceId === '') return { ok: false, error: 'id-required' }
      appendTo(choicesFile, { t: 'delete', id: choiceId, at: nowLocal() })
      return { ok: true }
    }

    if (type === 'choices.clear') {
      writeFileSync(choicesFile, '', 'utf8')
      writeFileSync(recallsFile, '', 'utf8')
      pendingRecalls.clear()
      return { ok: true }
    }

    if (type === 'start') {
      const q1 = str(body.q1)
      if (q1 === '') return { ok: false, error: 'q1-required' }
      const id = `nu_${randomUUID().slice(0, 8)}`
      append({ t: 'start', id, q1 })
      return { ok: true, id, session: sessionOf(id) }
    }

    if (type === 'hints') {
      const q1 = str(body.q1, 200)
      if (q1 === '') return { ok: false, error: 'q1-required' }
      return { ok: true, hints: await hintsOf(q1) }
    }

    const id = requireId(body)
    if (id === null) return { ok: false, error: 'id-required' }
    const session = sessionOf(id)
    if (session === null) return { ok: false, error: 'session-not-found' }

    if (type === 'answer') {
      const patch = {}
      if (body.q1 !== undefined) patch.q1 = str(body.q1)
      if (body.q2 !== undefined) patch.q2 = str(body.q2)
      if (body.q3 !== undefined) patch.q3 = str(body.q3)
      append({ t: 'answers', id, ...patch })
      return { ok: true, session: sessionOf(id) }
    }

    if (type === 'followup') {
      if (session.q2 === '') return { ok: false, error: 'q2-required' }
      const result = await followupOf(session)
      append({ t: 'followup', id, question: result.question })
      return { ok: true, question: result.question, source: result.source, session: sessionOf(id) }
    }

    if (type === 'finish') {
      if (session.q2 === '') return { ok: false, error: 'q2-required' }
      if (body.q3 !== undefined) append({ t: 'answers', id, q3: str(body.q3) })
      const current = sessionOf(id) ?? session
      const result = await premortemOf(current)
      const history = historyOf(`${current.q1} ${current.q2}`)
      const card = history === null ? result.card : { ...result.card, history }
      append({ t: 'done', id, card })
      return { ok: true, card, error: result.error, debug: result.debug, session: sessionOf(id) }
    }

    if (type === 'cancel') {
      append({ t: 'cancel', id })
      return { ok: true, session: sessionOf(id) }
    }

    if (type === 'delete') {
      append({ t: 'delete', id })
      return { ok: true }
    }

    if (type === 'rename') {
      const title = str(body.title, 60)
      if (title === '') return { ok: false, error: 'title-required' }
      append({ t: 'rename', id, title })
      return { ok: true, session: sessionOf(id) }
    }

    return { ok: false, error: 'unknown-type' }
  }

  /* ----------------------------------------------------------------- route */

  const handler = async (req, res) => {
    try {
      if (!sameOrigin(req)) {
        send(res, 403, { ok: false, error: 'forbidden' })
        return
      }
      /* The composition's connection service gates every route; without it the
         plugin fails closed rather than serving local records unprotected. */
      const connection = ctx.connection
      if (connection === undefined || typeof connection.requestRejection !== 'function') {
        send(res, 503, { ok: false, error: 'access-check-unavailable' })
        return
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        send(res, rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' })
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://nitui.local').pathname
      if (!pathname.startsWith(ROUTE)) {
        send(res, 404, { ok: false, error: 'not-found' })
        return
      }
      if (pathname === `${ROUTE}/state` || pathname === `${ROUTE}/state/`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const sessions = sessionsOf()
          .map((session) => ({ ...session, domain: domainOf(`${session.q1} ${session.q2 ?? ''}`) }))
          .sort((left, right) => (left.updatedAt < right.updatedAt ? 1 : -1))
        send(res, 200, {
          ok: true,
          root,
          sessions,
          ai: await aiStatus(),
          build: 'v0.2.0',
          darkLine: {
            ...readSettings().darkLine,
            choices: choiceRecords().length,
          },
        })
        return
      }
      if (pathname === `${ROUTE}/action` || pathname === `${ROUTE}/action/`) {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!isJson(req)) {
          send(res, 415, { ok: false, error: 'unsupported-media-type' })
          return
        }
        const result = await act(await readJson(req))
        if (result.ok !== true) {
          send(res, 400, result)
          return
        }
        send(res, 200, result)
        return
      }
      if (pathname === `${ROUTE}/choices` || pathname === `${ROUTE}/choices/`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const settings = readSettings()
        const choices = publicChoices()
        const counts = {}
        for (const choice of choices) counts[choice.domain] = (counts[choice.domain] ?? 0) + 1
        const limits = THRESHOLDS[settings.darkLine.sensitivity] ?? THRESHOLDS.standard
        send(res, 200, {
          ok: true,
          choices,
          settings,
          diagnostics: { threshold: limits.records, days: limits.days, counts },
        })
        return
      }
      if (pathname === `${ROUTE}/recall` || pathname === `${ROUTE}/recall/`) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          send(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        const sessionId = new URL(req.url ?? '/', 'http://nitui.local').searchParams.get('session') ?? ''
        const hint = pendingRecalls.get(sessionId) ?? null
        if (hint !== null) pendingRecalls.delete(sessionId)
        send(res, 200, { ok: true, hint })
        return
      }
      send(res, 404, { ok: false, error: 'not-found' })
    } catch (error) {
      const status = typeof error?.status === 'number' ? error.status : 500
      if (status >= 500) ctx.logger?.warn?.(`nitui: ${error instanceof Error ? error.message : String(error)}`)
      send(res, status, { ok: false, error: status === 413 ? 'body-too-large' : 'internal' })
    }
  }

  /* --------------------------------------------------- message feed + tools */

  const messageText = (message) => {
    const content = Array.isArray(message?.content) ? message.content : []
    return content
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
      .trim()
      .slice(0, 2000)
  }

  /**
   * 暗线的主循环：用户发一条消息 → 看得出「在几个选项之间做选择」就准备召回；
   * 看出「已经定了」就记一条。全程不依赖明线，也不需要模型配合。
   */
  const handleUserMessage = (sessionId, text) => {
    const settings = readSettings()
    if (!settings.darkLine.enabled || text === '') return
    if (DECIDE.test(text)) {
      const inferred = inferredChoice(sessionId, text)
      if (inferred !== null) logChoice(inferred)
    }
    if (!CHOICE_POINT.test(text)) return
    const hint = recallFor(sessionId, text, settings)
    if (hint !== null) pendingRecalls.set(sessionId, hint)
  }

  ctx.on('agent/inbox/inserted', (payload) => {
    try {
      const message = payload?.message
      const sourceKind = message?.source?.kind
      if (sourceKind !== undefined && sourceKind !== 'user') return
      const sessionId = typeof payload?.agent?.id === 'string' ? payload.agent.id : ''
      const text = messageText(message)
      if (sessionId === '' || text === '') return
      handleUserMessage(sessionId, text)
    } catch (error) {
      ctx.logger?.warn?.(`nitui: 暗线跳过一条消息：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const toolText = (text) => [{ type: 'text', text }]

  ctx.effect(() =>
    ctx.tools.register({
      name: 'log_choice',
      description:
        'Record one choice the user actually made among options, for the local choice log (~/.nitui/choices.jsonl). Call it when the conversation shows a real trade-off and the user settled it; do not record single-option execution or mere discussion.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', enum: DEFAULT_DOMAINS, description: 'The hard domain gate; recall only compares within one domain.' },
          chosen: { type: 'string', description: 'What the user settled on, in their own words, under 60 characters.' },
          options: { type: 'array', items: { type: 'string' }, description: 'The options that were on the table, at most four.' },
          reason: { type: 'string', description: 'Why, as the user stated it or as the conversation implies; leave empty when unknown.' },
          reasonSource: { type: 'string', enum: ['stated', 'inferred', 'none'], description: 'Whether the reason was said by the user, inferred, or absent.' },
          axis: { type: 'string', enum: AXIS_NAMES, description: 'The trade-off direction, when the conversation shows one.' },
          pole: { type: 'string', enum: ['fast', 'slow'], description: 'Which side of that axis the user picked.' },
        },
        required: ['domain', 'chosen'],
      },
      output: {
        schema: { type: 'object', properties: { id: { type: 'string' }, recorded: { type: 'boolean' } } },
        render: (args) => toolText(`已记下：${String(args?.chosen ?? '')}`),
      },
      execute: async (args) => {
        const result = logChoice({ ...args, by: 'model' })
        if (result.ok !== true) throw new Error(result.error)
        return { id: result.id, recorded: true }
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'recall_choice',
      description:
        'Look for the user’s own past choices on the same trade-off, using the local log. Returns up to three short lines to show verbatim, or an empty result. Read-only: it does not record a recall.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', description: 'The choice the user faces now, in their words.' } },
        required: ['text'],
      },
      output: {
        schema: { type: 'object', properties: { found: { type: 'boolean' }, lines: { type: 'array', items: { type: 'string' } } } },
        render: (args, value) =>
          toolText(Array.isArray(value?.lines) && value.lines.length > 0 ? value.lines.join('\n') : '没有可召回的同域同类记录。'),
      },
      execute: async (args) => {
        const hint = recallFor('tool', str(args?.text, 200), readSettings(), true)
        return hint === null ? { found: false, lines: [] } : { found: true, lines: hint.lines }
      },
    }),
  )

  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt !== undefined) {
    ctx.effect(() =>
      systemPrompt.section({
        name: 'nitui-choices',
        order: 90,
        text: [
          '对话里出现明确的取舍、并且用户已经选定（「就用 B」「选 A 吧」「我决定接受」这类）时，调用 log_choice 记一条：',
          'domain 必填，chosen 尽量用用户原话，理由不确定就留空。',
          '单一方案执行、只是比较、没有落定，都不要记。',
        ].join(''),
      }),
    )
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }))
}

/* ------------------------------------------------------------------ utils */

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function isJson(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        reject(Object.assign(new Error('body-too-large'), { status: 413 }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(Object.assign(new Error('invalid-json'), { status: 400 }))
      }
    })
    req.on('error', reject)
  })
}

function send(res, status, payload) {
  if (res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}
