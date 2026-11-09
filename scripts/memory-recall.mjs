// memory-recall.mjs · 混合召回（词法 + 语义 RRF 融合；2026-11-09 v0.3.0）
//
// 为什么改（实测依据）：
//   旧版只在"字面一条都没中"时才退到语义，等于每次都得先赌字面能中。
//   查「判据 思维 判断」这种多词问句时，整串当关键字 → 0 命中 → 才走语义，走了两遍。
//   540/714 两套压测都指向同一件事：**多路召回融合（RRF）比单路强**，
//   540 卷实测 纯语义 66.5% → 混合 79.6%，且提升来自"两路都认的往上浮"。
//
// 现在：
//   · 词法一路（标题/ID + 原文行）和语义一路（bge-small + BM25 RRF）**同时跑**
//   · 用 RRF 把两路名次融合：score = Σ 1/(60+rank)，两路都中的自然排前面
//   · 多词问句按 token 拆开分别打分，不再拿整串做 includes
//
// 用法：
//   node scripts/memory-recall.mjs <关键词> [--review 1-4] [--limit 20] [--agg] [--no-semantic]
import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createMemoryDecay } from './memory-decay.mjs'

// 工作区根目录：插件是被 core.js 用 cwd=<工作区> 调起来的（core.run: cwd: root），
// 所以优先用 cwd / DSH_WORKSPACE；找不到 数据/ 才退回插件自己的上级目录（旧行为，兼容单测）。
const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = join(HERE, '..')
const findRoot = () => {
  for (const c of [process.env.DSH_WORKSPACE, process.cwd(), join(PLUGIN_ROOT, '..')]) {
    if (c && existsSync(join(c, '数据', '记忆单元.json'))) return c
  }
  return process.env.DSH_WORKSPACE || process.cwd()
}
const ROOT = findRoot()
const kw = process.argv[2]
if (!kw) {
  console.log('用法：node scripts/memory-recall.mjs <关键词> [--review 1-4] [--limit 20] [--agg] [--no-semantic]')
  process.exit(2)
}
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const reviewRating = arg('--review', null)
const limit = Number(arg('--limit', 20)) || 20
const includeFrozen = process.argv.includes('--include-frozen')
const includeSuperseded = process.argv.includes('--include-superseded')
const aggMode = process.argv.includes('--agg')
const noSemantic = process.argv.includes('--no-semantic')
const kwLower = kw.toLowerCase()

// ── 分词：空格/标点切开；中文按 2-4 字滑窗补，长词保留 ──
const RAW_TOKENS = kw.toLowerCase().split(/[\s,，。、;；:：/|]+/).filter(Boolean)
const TOKENS = new Set()
for (const t of RAW_TOKENS) {
  if (t.length >= 2) TOKENS.add(t)
  if (/^[\u4e00-\u9fa5]{4,}$/.test(t)) {
    for (let i = 0; i + 2 <= t.length; i++) TOKENS.add(t.slice(i, i + 2))
  }
}
if (!TOKENS.size) TOKENS.add(kwLower)

const hitCount = (text, toks) => {
  const s = String(text || '').toLowerCase()
  let n = 0
  for (const t of toks) if (s.includes(t)) n++
  return n
}

// ── 单元 ──
const unitsPath = join(ROOT, '数据', '记忆单元.json')
const units = existsSync(unitsPath) ? JSON.parse(readFileSync(unitsPath, 'utf8')) : []
const decay = createMemoryDecay({ statePath: join(ROOT, '数据', 'memory-decay.json') })
const unitViews = units.map((u) => ({
  u,
  at: Number(u.updated) || Number(u.created) || 0,
  v: decay.view(u.id, { created: u.created, importance: u.importance, core: u.core, open: u.open }),
}))

const visible = unitViews.filter(({ u, v }) => (includeSuperseded || !u.superseded_by) && (includeFrozen || !v.frozen))
const supersededHidden = unitViews.filter(({ u }) => u.superseded_by && !includeSuperseded).length
const frozenHidden = unitViews.filter(({ u, v }) => !u.superseded_by && v.frozen && !includeFrozen).length

// 词法一路（标题 + id）
const lexUnits = visible
  .map((x) => ({ ...x, m: hitCount(x.u.id + ' ' + (x.u.title || ''), TOKENS) }))
  .filter((x) => x.m > 0)
  .sort((a, b) => b.m - a.m || b.at - a.at)

// ── 原文行（只在 --agg 时才全量扫；普通查询交给语义一路的 md 结果）──
const SKIP_DIRS = new Set(['node_modules', 'tmpwork', '.git', '.dsh', 'qqb', 'bench-data', '归档', '备份', '发布'])
const lexMd = []
function walk(dir, depth = 0) {
  if (depth > 4) return
  let ents = []
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, depth + 1)
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.md' && !/备份|backup/i.test(e.name)) {
      let txt = ''
      try {
        txt = readFileSync(p, 'utf8')
      } catch {
        continue
      }
      if (txt.length > 400_000) continue
      const lines = txt.split('\n')
      let perFile = 0
      for (let i = 0; i < lines.length; i++) {
        const m = hitCount(lines[i], TOKENS)
        if (m > 0) {
          lexMd.push({ file: p.slice(ROOT.length + 1), line: i + 1, text: lines[i].trim().slice(0, 140), m })
          if (++perFile >= 3) break
        }
      }
    }
  }
}
if (aggMode) walk(ROOT)

// ── 语义一路 ──
let semUnits = []
let semMd = []
let semMeta = null
const py = join(ROOT, 'local-ai', '.venv', 'Scripts', 'python.exe')
const script = join(ROOT, 'local-ai', 'semantic.py')
if (!noSemantic && !aggMode && existsSync(join(ROOT, 'local-ai', 'index.npz'))) {
  let j = null
  // ① 先问常驻服务（~80ms，2026-11-09 加）
  try {
    const url = `${process.env.SEMANTIC_URL || 'http://127.0.0.1:8791'}/q?text=${encodeURIComponent(kw)}&top=12`
    const r = await fetch(url, { signal: AbortSignal.timeout(1200) })
    const t = await r.json()
    if (t && t.ok) j = t
  } catch {}
  // ② 服务没起 → 退回 spawn python（~2s）
  if (!j && existsSync(py) && existsSync(script)) {
    try {
      const out = execFileSync(py, [script, 'query', kw, '--top', '12', '--json'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, no_proxy: '*', NO_PROXY: '*', HF_HOME: 'D:\\hf-cache', PYTHONIOENCODING: 'utf-8' },
      })
      j = JSON.parse(out.trim().split('\n').pop())
    } catch {
      j = null
    }
  }
  if (j) {
    semMeta = { best: j.best, gap: j.gap, weak: j.weak, narrow: j.narrow }
    for (const r of j.rows || []) {
      if (r.kind === 'unit' && r.id) semUnits.push(r.id)
      else if (r.kind === 'md') semMd.push({ file: r.path, line: Number((r.where || '').split(':').pop()) || 0, text: r.text, score: r.score })
    }
  }
}

// ── RRF 融合（单元）──
const K = 60
const fused = new Map()
const add = (id, rank, src) => {
  const cur = fused.get(id) || { id, score: 0, srcs: [] }
  cur.score += 1 / (K + rank + 1)
  cur.srcs.push(src)
  fused.set(id, cur)
}
lexUnits.forEach((x, i) => add(x.u.id, i, 'lex'))
semUnits.forEach((id, i) => add(id, i, 'sem'))
const unitRanked = [...fused.values()]
  .map((f) => ({ ...f, view: visible.find((x) => x.u.id === f.id) }))
  .filter((f) => f.view)
  .sort((a, b) => b.score - a.score)
const both = unitRanked.filter((f) => f.srcs.length > 1).length

// ── 融合原文行（词汇 + 语义 md）──
const mdKey = (h) => `${h.file}:${h.line}`
const mdFused = new Map()
lexMd.sort((a, b) => b.m - a.m).slice(0, 80).forEach((h, i) => {
  const cur = mdFused.get(mdKey(h)) || { ...h, score: 0, srcs: [] }
  cur.score += 1 / (K + i + 1)
  cur.srcs.push('lex')
  mdFused.set(mdKey(h), cur)
})
semMd.slice(0, 12).forEach((h, i) => {
  const k = mdKey(h)
  const cur = mdFused.get(k) || { ...h, score: 0, srcs: [] }
  cur.score += 1 / (K + i + 1)
  cur.srcs.push('sem')
  mdFused.set(k, cur)
})
const mdRanked = [...mdFused.values()].sort((a, b) => b.score - a.score).slice(0, aggMode ? 200 : Math.min(limit, 10))

// ── 输出 ──
const supersededNote = supersededHidden ? `（另有 ${supersededHidden} 个已被取代的单元未列，加 --include-superseded 看）` : ''
const frozenNote = frozenHidden ? `（另有 ${frozenHidden} 个冻结单元未列，加 --include-frozen 看）` : ''
const semNote = semMeta
  ? semMeta.weak
    ? '语义：⚠️ 最高分偏低，可能没有这条'
    : semMeta.narrow
      ? '语义：⚠️ 第一名和第二名太近，当心硬凑'
      : '语义：正常'
  : noSemantic
    ? '语义：按参数关闭'
    : '语义：不可用（检查 local-ai 索引）'

const head = aggMode
  ? `关键词「${kw}」：聚合模式（按时间列全部 ${unitRanked.length} 条）`
  : `关键词「${kw}」：单元 ${unitRanked.length} 个（词法 ${lexUnits.length} · 语义 ${semUnits.length} · 两路都中 ${both}）· 原文 ${mdRanked.length} 条`
console.log(head + supersededNote + frozenNote)
console.log(`  ${semNote}\n`)

if (aggMode) {
  const byTime = unitRanked.sort((a, b) => a.view.at - b.view.at)
  for (const f of byTime) {
    const u = f.view.u
    const day = f.view.at ? new Date(f.view.at).toLocaleDateString('sv-SE') : '????-??-??'
    console.log(`  ${day}  ${u.id} — ${u.title || ''}`)
  }
} else {
  for (const f of unitRanked.slice(0, limit)) {
    const u = f.view.u
    const at = f.view.at
    const day = at ? new Date(at).toLocaleDateString('sv-SE') : ''
    const sup = u.superseded_by ? `【已被 ${u.superseded_by} 取代】` : ''
    const src = f.srcs.length > 1 ? '[词法+语义]' : f.srcs[0] === 'lex' ? '[词法]' : '[语义]'
    const short = String(u.title || '').length > 64 ? String(u.title).slice(0, 64) + '…' : String(u.title || '')
    console.log(`  [单元]${sup} ${u.id} — ${short}${day ? `（更新 ${day}）` : ''} ${src} φ${f.score.toFixed(4)}`)
    // 2026-11-09：单元带结构化事实时，列出最近 3 条（按时间），最新那条标「现行」
    if (Array.isArray(u.facts) && u.facts.length) {
      const fs2 = [...u.facts].sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0)).slice(0, 3)
      fs2.forEach((fa, i) => {
        const d = fa.at ? new Date(Number(fa.at)).toLocaleDateString('sv-SE') : ''
        console.log(`      ${i === 0 ? '现行' : '旧值'}：${fa.attr}=${fa.value}${d ? `（${d}）` : ''}${fa.note ? ' · ' + fa.note : ''}`)
      })
    }
  }
  if (mdRanked.length) {
    console.log('')
    for (const h of mdRanked) {
      const src = h.srcs.length > 1 ? '[词法+语义]' : h.srcs[0] === 'lex' ? '[词法]' : '[语义]'
      console.log(`  ${h.file}:${h.line} ${src}  ${h.text}`)
    }
  }
}

const sessShown = unitRanked.filter((f) => String(f.id).startsWith('session:')).length
if (sessShown) console.log(`\n  （其中 ${sessShown} 条是历史会话索引 session:*，非记忆单元）`)

try {
  appendFileSync(
    join(ROOT, '数据', 'memory-trace.jsonl'),
    JSON.stringify({
      at: new Date().toISOString(),
      action: 'recall',
      keyword: kw,
      mode: aggMode ? 'agg' : 'hybrid',
      tokens: [...TOKENS],
      lex: lexUnits.length,
      sem: semUnits.length,
      both,
      ids: unitRanked.slice(0, limit).map((f) => f.id),
      semMeta,
    }) + '\n',
    'utf8',
  )
} catch {}

if (reviewRating && unitRanked.length) {
  console.log('')
  for (const f of unitRanked.slice(0, limit)) {
    const u = f.view.u
    const v = decay.review(u.id, Number(reviewRating), { created: u.created, importance: u.importance, core: u.core, open: u.open })
    console.log(`  review ${u.id} → R=${v.R.toFixed(2)} S=${v.S.toFixed(2)}`)
  }
}
