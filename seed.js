#!/usr/bin/env node
/**
 * nitui 演示数据 —— 只给本地开发和截图用。
 *
 *   node seed.js                 写入 <插件目录>/data（仅源码目录）
 *   node seed.js --force         覆盖已有的演示数据
 *   node seed.js --dir D:\tmp\x  写入指定目录（不会碰 ~/.nitui）
 *   DSH_NITUI_DATA=... node seed.js
 *
 * 默认不会写用户目录：真实记录在 ~/.nitui，演示数据不该把它覆盖掉。
 * 数据格式与插件运行时完全一致（sessions.jsonl / choices.jsonl /
 * recalls.jsonl / config.json），所以种子写完后重启 DSH 就能直接看到。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const insideNodeModules = (path) => path.split(/[\\/]+/).includes('node_modules')

const argv = process.argv.slice(2)
const force = argv.includes('--force')
const dirIndex = argv.indexOf('--dir')
let explicit = ''
if (dirIndex >= 0) {
  const value = argv[dirIndex + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error('--dir 后面要跟一个目录')
    process.exit(1)
  }
  explicit = value
}

const env = typeof process.env.DSH_NITUI_DATA === 'string' ? process.env.DSH_NITUI_DATA.trim() : ''
const target =
  explicit !== ''
    ? resolve(explicit)
    : env !== ''
      ? resolve(env)
      : insideNodeModules(HERE)
        ? ''
        : join(HERE, 'data')

if (target === '') {
  console.error('这个脚本只用于插件源码目录；安装后的包请用 --dir 指定一个临时目录。')
  process.exit(1)
}
if (insideNodeModules(target)) {
  console.error(`拒绝写入 node_modules：${target}`)
  process.exit(1)
}

const sessionsFile = join(target, 'sessions.jsonl')
if (existsSync(sessionsFile) && !force) {
  console.error(`已经有数据：${sessionsFile}`)
  console.error('确认要覆盖演示数据就加 --force；真实记录请先备份。')
  process.exit(1)
}

const at = (day, time) => `2026-11-${day}T${time}+08:00`

/* --------------------------------------------------------------- sessions */

const sessions = [
  {
    t: 'start',
    id: 'nu_demo01',
    at: at('18', '09:12:00'),
    q1: '要不要把现在的外包团队换成自建',
  },
  {
    t: 'answers',
    id: 'nu_demo01',
    at: at('18', '09:14:00'),
    q2: '自建后招不到合适的人\n头两个月交付会断档\n我低估了管理和沟通成本',
  },
  {
    t: 'followup',
    id: 'nu_demo01',
    at: at('18', '09:14:30'),
    question: '「头两个月交付会断档」具体会断在哪一周、哪条交付线上？',
  },
  {
    t: 'answers',
    id: 'nu_demo01',
    at: at('18', '09:15:00'),
    q3: '11 月底那次大版本，如果那时还没补齐两个人，就会断',
  },
  {
    t: 'done',
    id: 'nu_demo01',
    at: at('18', '09:16:00'),
    card: {
      failureScene: '六个月后，自建团队没补上人，11 月底的大版本延期，外包已经退场，客户开始催。',
      causes: [
        {
          text: '自建后招不到合适的人，岗位一直空着',
          source: 'user',
          check: '30 分钟内：把岗位 JD 发给 3 个熟人，问他们会不会投。',
        },
        {
          text: '头两个月交付断档，客户流失',
          source: 'user',
          check: '30 分钟内：列出 11 月底前必须交付的 3 条线，标出哪条没人接。',
        },
        {
          text: '低估了管理和沟通成本',
          source: 'user',
          check: '30 分钟内：写下你每周能花在管理上的小时数，再和现在比一比。',
        },
        {
          text: '外包退场太快，只有他们知道的东西没交接',
          source: 'ai',
          check: '30 分钟内：让外包负责人列一份「只有他知道」的清单。',
        },
      ],
      lean: {
        towards: '先并行一个月，再决定是否全换',
        why: '断档风险集中在 11 月底，提前一个月能看出人到底能不能到位',
      },
      history: {
        domain: '技术/产品',
        lines: ['11/12 你选了：先发版，重构往后放（客户在等这个版本）'],
      },
      degraded: false,
      note: '',
      model: 'demo/seed',
    },
  },
  {
    t: 'rename',
    id: 'nu_demo01',
    at: at('18', '09:18:00'),
    title: '外包换自建：先并行一个月',
  },

  {
    t: 'start',
    id: 'nu_demo02',
    at: at('15', '20:30:00'),
    q1: '要不要搬去杭州',
  },
  {
    t: 'answers',
    id: 'nu_demo02',
    at: at('15', '20:33:00'),
    q2: '通勤变长\n房租上涨\n离开现在的朋友',
  },
  {
    t: 'followup',
    id: 'nu_demo02',
    at: at('15', '20:33:20'),
    question: '通勤变长之后，你每天具体会少掉哪一段属于自己的时间？',
  },
  {
    t: 'answers',
    id: 'nu_demo02',
    at: at('15', '20:35:00'),
    q3: '晚上八点后的那一个小时，现在用来跑步和看书',
  },
  {
    t: 'done',
    id: 'nu_demo02',
    at: at('15', '20:36:00'),
    card: {
      failureScene: '六个月后，搬去杭州的钱没算清，通勤把每天的时间切碎，周末只想躺着，原来的朋友也约不上。',
      causes: [
        {
          text: '通勤把晚上的时间吃掉了',
          source: 'user',
          check: '30 分钟内：按新地址算一次真实的门到门时间，写下去和回两段。',
        },
        {
          text: '房租上涨，现金流变紧',
          source: 'user',
          check: '30 分钟内：把新房租、押金、中介费加一遍，看占月收入多少。',
        },
        {
          text: '离开现在的朋友，周末没人约',
          source: 'user',
          check: '30 分钟内：给杭州的 3 个熟人发消息，问他们最近周末在做什么。',
        },
        {
          text: '搬家本身的成本被忽略',
          source: 'ai',
          check: '30 分钟内：找两家搬家公司要报价，记下最低价和最早档期。',
        },
      ],
      lean: {
        towards: '先去住两周再决定',
        why: '通勤和房租都能在那两周里量出真实数字',
      },
      degraded: false,
      note: '',
      model: 'demo/seed',
    },
  },

  {
    t: 'start',
    id: 'nu_demo03',
    at: at('20', '10:05:00'),
    q1: '这个副业项目接不接',
  },
  {
    t: 'answers',
    id: 'nu_demo03',
    at: at('20', '10:08:00'),
    q2: '时间不够\n交付质量达不到\n对方预算可能砍半',
  },
  {
    t: 'followup',
    id: 'nu_demo03',
    at: at('20', '10:08:30'),
    question: '「时间不够」是说哪几周不够，那几周你原本排了什么？',
  },

  {
    t: 'start',
    id: 'nu_demo04',
    at: at('19', '14:00:00'),
    q1: '要不要报那个训练营',
  },
  {
    t: 'cancel',
    id: 'nu_demo04',
    at: at('19', '14:02:00'),
  },
]

/* ---------------------------------------------------------------- choices */

const choices = [
  {
    t: 'log',
    id: 'ch_demo01',
    at: at('18', '09:30:00'),
    domain: '技术/产品',
    fingerprint: { axis: '自建', pole: 'fast' },
    options: ['继续外包', '自建团队', '先并行一个月'],
    chosen: '先并行一个月，再看人头',
    reason: { text: '断档风险在 11 月底，先用一个月验证招聘', source: 'stated' },
    by: 'model',
    session: 'nu_demo01',
  },
  {
    t: 'log',
    id: 'ch_demo02',
    at: at('16', '21:10:00'),
    domain: '生活/居住',
    fingerprint: { axis: '时点', pole: 'slow' },
    options: ['现在搬', '明年再搬'],
    chosen: '明年春天再搬',
    reason: { text: '房租和通勤都还没算清', source: 'stated' },
    by: 'inferred',
    session: 'nu_demo02',
  },
  {
    t: 'log',
    id: 'ch_demo03',
    at: at('15', '22:00:00'),
    domain: '职业/承诺',
    fingerprint: { axis: '集中', pole: 'slow' },
    options: ['接', '不接', '只接一半'],
    chosen: '只接一半，先跑两个月',
    reason: { text: '先看交付质量，再决定要不要全接', source: 'stated' },
    by: 'model',
    session: 'nu_demo03',
  },
  {
    t: 'log',
    id: 'ch_demo04',
    at: at('12', '14:20:00'),
    domain: '技术/产品',
    fingerprint: { axis: '速度', pole: 'slow' },
    options: ['先重构', '先发版'],
    chosen: '先发版，重构往后放',
    reason: { text: '客户在等这个版本', source: 'stated' },
    by: 'inferred',
    session: '',
  },
  {
    t: 'log',
    id: 'ch_demo05',
    at: at('10', '09:00:00'),
    domain: '工具/流程',
    fingerprint: { axis: '自建', pole: 'slow' },
    options: ['自己写脚本', '买现成工具'],
    chosen: '买现成工具',
    reason: { text: '维护脚本的时间比订阅费贵', source: 'stated' },
    by: 'model',
    session: '',
  },
  {
    t: 'log',
    id: 'ch_demo06',
    at: at('08', '19:30:00'),
    domain: '投资/配置',
    fingerprint: { axis: '风险', pole: 'slow' },
    options: ['加仓', '减仓'],
    chosen: '先减一半仓位',
    reason: { text: '这笔钱半年内要用', source: 'stated' },
    by: 'inferred',
    session: '',
  },
]

const config = {
  darkLine: {
    enabled: true,
    recall: 'standard',
    sensitivity: 'standard',
    domains: ['技术/产品', '生活/居住', '职业/承诺', '投资/配置', '内容判断', '工具/流程'],
  },
  layout: { gap: 34, width: 900 },
}

/* ------------------------------------------------------------------- write */

mkdirSync(target, { recursive: true })
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n'

writeFileSync(sessionsFile, jsonl(sessions), 'utf8')
writeFileSync(join(target, 'choices.jsonl'), jsonl(choices), 'utf8')
writeFileSync(join(target, 'recalls.jsonl'), '', 'utf8')
writeFileSync(join(target, 'config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8')

console.log(`已写入演示数据：${target}`)
console.log(`  sessions.jsonl  ${sessions.length} 条事件（4 个推演）`)
console.log(`  choices.jsonl   ${choices.length} 条选择记录`)
console.log('重启或刷新 DSH 后生效；这些是虚构数据，可以直接删除。')
