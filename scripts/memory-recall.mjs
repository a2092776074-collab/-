// memory-recall.mjs · 按关键词把记忆翻出来；翻到了就顺手 review（用到才记得牢）
//
// 用法：
//   node scripts/memory-recall.mjs <关键词> [--review 1-4] [--limit 20]
//   --review 3 = 顺利想起；2 = 费劲想起；不传 = 只翻不记
//
// 查两处：数据/记忆单元.json（单元标题）+ 工作区里的 .md 原文（标题/正文）。
// 只读；状态写入交给 memory-decay.mjs 的状态文件。

import { readFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryDecay } from './memory-decay.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const kw = process.argv[2]
if (!kw) {
  console.log('用法：node scripts/memory-recall.mjs <关键词> [--review 1-4] [--limit 20]')
  process.exit(2)
}
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const reviewRating = arg('--review', null)
const limit = Number(arg('--limit', 20)) || 20
const includeFrozen = process.argv.includes('--include-frozen')
const zone = arg('--zone', '')
const kwLower = kw.toLowerCase()

const unitsPath = join(ROOT, '数据', '记忆单元.json')
const units = existsSync(unitsPath) ? JSON.parse(readFileSync(unitsPath, 'utf8')) : []
const decay = createMemoryDecay({ statePath: join(ROOT, '数据', 'memory-decay.json') })
const unitViews = units.map((u) => ({
  u,
  v: decay.view(u.id, { created: u.created, importance: u.importance, core: u.core, open: u.open }),
}))
let matched = unitViews.filter(({ u }) => (u.id + ' ' + (u.title || '')).toLowerCase().includes(kwLower))
if (zone) matched = matched.filter(({ u }) => (u.zone || 'task') === zone)
const unitHits = matched.filter(({ v }) => includeFrozen || !v.frozen).map(({ u }) => u)
const frozenHidden = matched.filter(({ v }) => !includeFrozen && v.frozen).length

const SKIP_DIRS = new Set(['node_modules', 'tmpwork', '.git', '.dsh', 'qqb'])
const hits = []
function walk(dir) {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p)
    } else if (e.isFile() && extname(e.name).toLowerCase() === '.md') {
      let txt = ''
      try { txt = readFileSync(p, 'utf8') } catch { continue }
      if (txt.length > 400_000) continue
      const lines = txt.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(kwLower)) {
          hits.push({ file: p.slice(ROOT.length + 1), line: i + 1, text: lines[i].trim().slice(0, 140) })
          if (hits.length >= limit) return
        }
      }
    }
  }
}
walk(ROOT)

console.log(`关键词「${kw}」：单元 ${unitHits.length} 个，原文命中 ${hits.length} 条${frozenHidden ? `（另有 ${frozenHidden} 个冻结单元未列，加 --include-frozen 看）` : ''}\n`)
for (const u of unitHits) {
  const frozen = includeFrozen && decay.view(u.id, { created: u.created, importance: u.importance, core: u.core, open: u.open }).frozen
  console.log(`  [单元][${u.zone || 'task'}]${frozen ? '[冻结]' : ''} ${u.id} — ${u.title || ''}`)
}
if (hits.length) {
  console.log('')
  for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`)
}

try {
  appendFileSync(join(ROOT, '数据', 'memory-trace.jsonl'), JSON.stringify({ at: new Date().toISOString(), action: 'recall', keyword: kw, ids: unitHits.map((u) => u.id) }) + '\n', 'utf8')
} catch {}

if (reviewRating && unitHits.length) {
  console.log('')
  for (const u of unitHits) {
    const v = decay.review(u.id, Number(reviewRating), {
      created: u.created,
      importance: u.importance,
      core: u.core,
      open: u.open,
    })
    console.log(`  review ${u.id} → R=${v.R} S=${v.S}`)
  }
}
