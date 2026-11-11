// memory-decay.mjs · 记忆代谢（FSRS-5 遗忘曲线）
//
// 给每个记忆单元算「牢固度 S / 难度 D / 可提取度 R」。
// 久不被想起 → R 下降；低于冻结线（默认 0.5）→ 冻结：不再自动想起、不注入，
// 但原文永远不删，查到一次就解冻。
// 核心单元（core）和未了结的事（open）不参与冻结。
//
// 公式按公开的 FSRS-5 实现（F = 19/81，t = S 时 R = 0.9）；
// 设计参考 dsh-memory-brain 的思路（PolyForm Noncommercial），未复制其代码。
// 只依赖 node 内置模块；状态文件只存 ID 和数字，不存原文。
//
// ⚠️ 一处刻意偏离：FSRS 的初始 S 是「单词卡」尺度（1–3 天），
// 我们记的是笔记/案例，所以初始 S 按重要性映射成 30 / 90 / 365 / 3650 天；
// 复习后的增长和遗忘仍走 FSRS-5 公式。这组数字是拿 12 个单元做回溯校准出来的，
// 不是验证——真正的验证要等这些日期到了，看「预测该冻」和「人判该冻」对不对得上。
//
// 用法：
//   node scripts/memory-decay.mjs list
//   node scripts/memory-decay.mjs review case:xxx 3      # 1 again / 2 hard / 3 good / 4 easy
//   node scripts/memory-decay.mjs test                   # 自检（临时目录，不碰真状态）
//   选项：--state <path>  --manifest <path>

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86400000
const F = 19 / 81
const S_MIN = 0.5
const S_MAX = 3650
const FREEZE_BELOW = 0.5
// 同一单元一天只算一次（议会 11-05 要求：防止同一条被反复 review 抬成虚高）
const COOLDOWN_MS = 24 * 3600 * 1000

// FSRS-5 默认参数（w0..w18）
const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575,
  0.1192, 1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
]

const clamp = (x, a, b) => Math.max(a, Math.min(b, Number.isFinite(x) ? x : a))
// FSRS-5 的可提取度：指数是 -0.5（不是 -1）。t = S 时 (1+19/81)^-0.5 = 0.9。
const R = (t, S) => Math.pow(1 + (F * Math.max(0, t)) / S, -0.5)
// 笔记/案例的初始寿命（天），不是单词卡尺度
const INITIAL_S = { 1: 30, 2: 90, 3: 365, 4: 3650 }
const S0 = (g) => clamp(INITIAL_S[clamp(g, 1, 4)], S_MIN, S_MAX)
const D0 = (g) => clamp(W[4] - Math.exp(W[5] * (clamp(g, 1, 4) - 1)) + 1, 1, 10)
const nextD = (D, g) => clamp(W[7] * D0(4) + (1 - W[7]) * (D - W[6] * (g - 3)), 1, 10)

function nextS(S, D, r, g) {
  if (g === 1) return Math.max(S_MIN, S * 0.5)
  const hard = g === 2 ? W[15] : 1
  const easy = g === 4 ? W[16] : 1
  const inc = Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy
  return clamp(S * (1 + inc), S_MIN, S_MAX)
}

// 单元 ID：kind:slug，kind 限定几种，避免把文件路径写进来
// 2026-11-07 补 session：昨天灌进 211 个 session:* 单元（历史会话索引），
// 这份白名单没跟上，导致 memory-recall 一碰到就抛「ID 不合法」直接崩。
// 2026-11-07 深夜：每日 ingest 会生成 conv:*（对话事卡），白名单又没跟上，recall 再次崩。
// 教训：KINDS 应该跟着「产生单元的人」一起改，而不是等崩了再补。
import { KINDS as KINDS_SHARED, validId as validIdShared } from './memory-kinds.mjs'
const KINDS = KINDS_SHARED
const validId = validIdShared

function loadJson(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

function saveJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8')
  renameSync(tmp, p)
}

export function createMemoryDecay({ statePath, freezeBelow = FREEZE_BELOW, cooldownMs = COOLDOWN_MS, now = () => Date.now() } = {}) {
  if (!statePath) throw new Error('statePath 必填')
  const state = loadJson(statePath, { units: {} })
  if (!state.units) state.units = {}

  const metaOf = (meta = {}) => ({
    created: Number(meta.created) || now(),
    importance: clamp(Number(meta.importance) || 3, 1, 4),
    core: !!meta.core,
    open: !!meta.open,
  })

  function ensure(id, meta) {
    if (!validId(id)) throw new Error('ID 不合法（要 kind:slug）: ' + id)
    const m = metaOf(meta)
    const st = state.units[id] || { S: S0(m.importance), D: D0(m.importance), last: m.created, reps: 0 }
    return { st, m }
  }

  function view(id, meta) {
    const { st, m } = ensure(id, meta)
    const elapsed = Math.max(0, now() - st.last)
    const r = R(elapsed / DAY, st.S)
    const frozen = r < freezeBelow && !m.core && !m.open
    // R 降到 0.5 的时刻：(1+F t/S)^-0.5 = 0.5 → t = 3S/F
    const dueAt = st.last + (3 * st.S / F) * DAY
    return { id, S: +st.S.toFixed(3), D: +st.D.toFixed(3), R: +r.toFixed(3), frozen, dueAt, reps: st.reps }
  }

  function review(id, rating, meta) {
    const { st, m } = ensure(id, meta)
    const g = clamp(Number(rating) || 3, 1, 4)
    if (st.reps > 0 && now() - st.last < cooldownMs) return view(id, meta)
    const r = R(Math.max(0, now() - st.last) / DAY, st.S)
    state.units[id] = { S: nextS(st.S, st.D, r, g), D: nextD(st.D, g), last: now(), reps: st.reps + 1 }
    saveJson(statePath, state)
    // 轨迹只记 ID / 时间 / 动作，不记原文；脑图回放用
    try {
      appendFileSync(join(dirname(statePath), 'memory-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), id, action: 'review', rating: g }) + '\n', 'utf8')
    } catch {}
    return view(id, meta)
  }

  return { view, review, statePath, units: () => Object.keys(state.units) }
}

// ---------- CLI ----------
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

function fmt(ms) {
  const d = Math.round(ms / DAY)
  return d >= 0 ? `${d} 天后` : `${-d} 天前`
}

function cliList(manifestPath, statePath) {
  const units = loadJson(manifestPath, null)
  if (!units || !Array.isArray(units)) {
    console.log('没有记忆单元清单：' + manifestPath)
    console.log('先建一个 JSON 数组，每项 { id, title, created, importance, core?, open? }')
    return
  }
  const decay = createMemoryDecay({ statePath })
  const now = Date.now()
  let frozen = 0
  for (const u of units) {
    const v = decay.view(u.id, { created: u.created, importance: u.importance, core: u.core, open: u.open })
    if (v.frozen) frozen++
    console.log(
      `${v.frozen ? '❄' : '·'} ${v.id.padEnd(34)} R=${String(v.R).padEnd(5)} S=${String(v.S).padEnd(7)} ` +
        `到冻结 ${fmt(v.dueAt - now)}${u.core ? '  [核心]' : ''}${u.open ? '  [未了]' : ''}`
    )
  }
  console.log(`\n${units.length} 个单元，${frozen} 个已冻结`)
}

function cliReview(id, rating, statePath, manifestPath) {
  if (!id || !rating) {
    console.log('用法：node scripts/memory-decay.mjs review <id> <1-4> [--state path] [--manifest path]')
    process.exitCode = 2
    return
  }
  const units = loadJson(manifestPath, [])
  const u = Array.isArray(units) ? units.find((x) => x.id === id) : null
  const meta = u ? { created: u.created, importance: u.importance, core: u.core, open: u.open } : undefined
  const decay = createMemoryDecay({ statePath })
  const v = decay.review(id, Number(rating), meta)
  console.log(`review ${id} → R=${v.R} S=${v.S} D=${v.D} 冻结=${v.frozen}`)
}

function cliTest() {
  const dir = mkdtempSync(join(tmpdir(), 'decay-test-'))
  try {
    const statePath = join(dir, 'state.json')
    const old = Date.now() - 1500 * DAY
    const units = [
      { id: 'case:old', title: '很久没想起的案子', created: old, importance: 2 },
      { id: 'case:core', title: '核心', created: old, importance: 2, core: true },
      { id: 'case:open', title: '未了结', created: old, importance: 2, open: true },
      { id: 'diary:today', title: '今天的日记', created: Date.now(), importance: 2 },
    ]
    const decay = createMemoryDecay({ statePath })
    const curve = Math.abs(R(1, 1) - 0.9) < 1e-9
    const a = decay.view('case:old', { created: old, importance: 2 })
    const b = decay.view('case:core', { created: old, importance: 2, core: true })
    const c = decay.view('case:open', { created: old, importance: 2, open: true })
    const d = decay.view('diary:today', { created: Date.now(), importance: 2 })
    const ok1 = a.frozen === true && b.frozen === false && c.frozen === false && d.frozen === false
    const thaw = decay.review('case:old', 3, { created: old, importance: 2 })
    const ok2 = thaw.frozen === false && thaw.R > 0.99
    const ok3 = existsSync(statePath) && /"S"/.test(readFileSync(statePath, 'utf8'))
    console.log(`自检：曲线 R(t=S)=0.9 ${curve} ｜ 冻结正确=${ok1} 解冻=${ok2} 状态落盘=${ok3}`)
    const pass = curve && ok1 && ok2 && ok3
    console.log(pass ? 'PASS' : 'FAIL')
    if (!pass) process.exitCode = 1
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  }
}

// 只有直接运行时才走 CLI（被 import 时不执行）
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const cmd = process.argv[2] || 'list'
  const statePath = arg('--state', join(ROOT, '数据', 'memory-decay.json'))
  const manifestPath = arg('--manifest', join(ROOT, '数据', '记忆单元.json'))
  if (cmd === 'list') cliList(manifestPath, statePath)
  else if (cmd === 'review') cliReview(process.argv[3], process.argv[4], statePath, manifestPath)
  else if (cmd === 'test') cliTest()
  else {
    console.log('用法：list | review <id> <1-4> | test')
    process.exitCode = 2
  }
}
