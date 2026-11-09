// 原文按需召回（2026-11-08 加）
// 由来：自家记忆卷测出「714 89.3%」「0.35 系数」这类事实只写在 md 里、没有单元，
// 注入永远看不见。注入槽位有限（8 条/950 字），不可能每轮都塞原文；
// 那就给一条**按需**通道：需要时显式搜原文，返回 文件:行号 + 那一行。
//
// 用法：
//   node scripts/memory-grep.mjs "714 题"             # 默认 5 条
//   node scripts/memory-grep.mjs "0.35" --limit 8
//   node scripts/memory-grep.mjs "RRF" --dir 数据
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const kw = process.argv[2]
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const limit = Math.max(1, Math.min(50, Number(arg('--limit', 5)) || 5))
const onlyDir = arg('--dir', '')

if (!kw || kw.length < 2) {
  console.error('用法: node scripts/memory-grep.mjs <关键词> [--limit N] [--dir 数据]')
  process.exit(2)
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'tmpwork', 'bili-browser', '.dsh', 'venv', '__pycache__', 'bench\\out'])
const EXTS = new Set(['.md', '.json', '.jsonl', '.mjs', '.js', '.py', '.txt', '.yml', '.yaml'])

function walk(dir, out = []) {
  let ents = []
  try {
    ents = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      walk(p, out)
    } else if (EXTS.has(e.name.slice(e.name.lastIndexOf('.')))) {
      out.push(p)
    }
  }
  return out
}

const base = onlyDir ? join(ROOT, onlyDir) : ROOT
if (!existsSync(base)) {
  console.error('目录不存在:', onlyDir)
  process.exit(2)
}

const files = walk(base)
const hits = []
const lowKw = kw.toLowerCase()
for (const f of files) {
  let text = ''
  try {
    if (statSync(f).size > 2_000_000) continue
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  if (!text.toLowerCase().includes(lowKw)) continue
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim()
    if (!t || !t.toLowerCase().includes(lowKw)) continue
    hits.push({ file: relative(ROOT, f), line: i + 1, text: t.slice(0, 160) })
    if (hits.length > 400) break
  }
  if (hits.length > 400) break
}

if (!hits.length) {
  console.log(`原文里没有匹配「${kw}」（扫了 ${files.length} 个文件）`)
  process.exit(0)
}

// 排序：优先 md、优先 数据/ 与 交接 文档、优先短行（事实通常比叙述短）、优先带数字的行。
// 起因：第一版把 make-chart-*.py 排在最前，问「714 多少分」给的是画图脚本。
hits.sort((a, b) => {
  const score = (h) => {
    let s = 0
    if (h.file.endsWith('.md')) s += 4
    if (/^(数据|知识)[\\/]/.test(h.file)) s += 3
    if (/交接|现状|测试|结果|判据/.test(h.file)) s += 2
    if (/\\(bench|scripts|local-ai)\\/.test(h.file)) s -= 2
    if (h.text.length < 90) s += 2
    if (/[0-9]/.test(h.text)) s += 1
    return s
  }
  return score(b) - score(a)
})

console.log(`原文命中「${kw}」${hits.length} 处（扫 ${files.length} 个文件），列前 ${Math.min(limit, hits.length)} 条：\n`)
for (const h of hits.slice(0, limit)) console.log(`  ${h.file}:${h.line}\n    ${h.text}`)
