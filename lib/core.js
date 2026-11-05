// Core helpers: no DSH dependency, so they can be tested with plain node.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000
const F = 19 / 81
export const ZONES = ['identity', 'relation', 'task', 'reference', 'vault']
// identity/vault 不自动注入；vault 也不自动归档
export const AUTO_ZONES = new Set(['relation', 'task', 'reference'])

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback
  return JSON.parse(readFileSync(p, 'utf8'))
}

function rOf(u, st, now) {
  const S = Number(st?.S) || ({ 1: 30, 2: 90, 3: 365, 4: 3650 }[u.importance] || 90)
  const last = Number(st?.last) || Number(u.created) || now
  const days = Math.max(0, (now - last) / DAY)
  return Math.pow(1 + F * days / S, -0.5)
}

function textOfMessage(p) {
  if (!p) return ''
  if (typeof p === 'string') return p.slice(0, 2000)
  if (typeof p.text === 'string') return p.text.slice(0, 2000)
  if (typeof p.content === 'string') return p.content.slice(0, 2000)
  if (Array.isArray(p.content)) {
    const parts = []
    for (const b of p.content) {
      if (typeof b === 'string') parts.push(b)
      else if (b && typeof b.text === 'string') parts.push(b.text)
    }
    if (parts.length) return parts.join(' ').slice(0, 2000)
  }
  return ''
}

function copyMissing(src, dst, out) {
  if (!existsSync(src)) return
  const st = statSync(src)
  if (st.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    for (const name of readdirSync(src)) copyMissing(join(src, name), join(dst, name), out)
    return
  }
  if (existsSync(dst)) {
    out.skipped.push(dst)
    return
  }
  mkdirSync(dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  out.created.push(dst)
}

export function lastUserText(agent) {
  try {
    const s = agent && agent.session
    if (!s || typeof s.snapshotEvents !== 'function') return ''
    const ev = s.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      const type = e && (e.type || e.kind)
      if (type !== 'user/message') continue
      const txt = textOfMessage(e.payload !== undefined ? e.payload : e.data)
      if (txt) return txt
    }
  } catch {}
  return ''
}

export function makeCore({ root = process.env.DSH_WORKSPACE || process.cwd(), pluginRoot = PLUGIN_ROOT } = {}) {
  const unitsPath = join(root, '数据', '记忆单元.json')
  const statePath = join(root, '数据', 'memory-decay.json')

  const run = (name, args = []) => {
    const script = join(root, 'scripts', name)
    if (!existsSync(script)) {
      throw new Error(`找不到 ${join('scripts', name)}；先运行 memory_init，或把 scripts/ 放到工作区`)
    }
    return execFileSync(process.execPath, [script, ...args], {
      cwd: root, encoding: 'utf8', timeout: 60_000, windowsHide: true,
    })
  }

  const loadUnits = () => readJson(unitsPath, [])
  const loadState = () => readJson(statePath, { units: {} })

  return {
    root,
    unitsPath,
    statePath,
    init() {
      const out = { created: [], skipped: [] }
      copyMissing(join(pluginRoot, 'template'), root, out)
      copyMissing(join(pluginRoot, 'scripts'), join(root, 'scripts'), out)
      return out
    },
    status() {
      return run('memory-decay.mjs', ['list'])
    },
    recall(keyword, { includeFrozen = false, limit = 20, zone = '' } = {}) {
      const kw = String(keyword || '').trim()
      if (!kw || kw.length > 200) throw new Error('keyword 必填，且不超过 200 字')
      const args = [kw, '--limit', String(Math.max(1, Math.min(50, Number(limit) || 20)))]
      if (includeFrozen) args.push('--include-frozen')
      if (zone) {
        if (!ZONES.includes(zone)) throw new Error('zone 只能是 ' + ZONES.join('/'))
        args.push('--zone', zone)
      }
      return run('memory-recall.mjs', args)
    },
    review(id, rating) {
      const v = String(id || '').trim()
      if (!/^(case|diary|knowledge|ledger|anchor|episode):[a-z0-9-]+$/.test(v)) {
        throw new Error('id 必须是 kind:slug（case:/diary:/knowledge:/ledger:/anchor:/episode:）')
      }
      const r = Number(rating)
      if (![1, 2, 3, 4].includes(r)) throw new Error('rating 只能是 1-4')
      return run('memory-decay.mjs', ['review', v, String(r)])
    },
    archive({ apply = false, minDays = 30 } = {}) {
      const days = Math.max(1, Math.min(3650, Number(minDays) || 30))
      const args = ['--min-days', String(days)]
      if (apply) args.push('--apply')
      return run('memory-archive.mjs', args)
    },
    // 自动注入：只读 relation/task/reference，跳过冻结；按相关度 + 重要度 + R 排，限条数和字数
    injectFor(query = '', { maxItems = 6, maxChars = 700 } = {}) {
      const units = loadUnits().filter((u) => AUTO_ZONES.has(u.zone || 'task'))
      if (!units.length) return ''
      const state = loadState()
      const now = Date.now()
      const q = String(query || '').toLowerCase()
      const scored = units.map((u) => {
        const st = state.units?.[u.id]
        const r = rOf(u, st, now)
        const frozen = r < 0.5 && !u.core && !u.open
        let score = (Number(u.importance) || 2) * 2 + r * 3
        if (q) {
          const hay = (u.title + ' ' + (u.note || '') + ' ' + (u.source || '')).toLowerCase()
          const words = q.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 2)
          for (const w of words) if (hay.includes(w)) score += 4
          if (q.length >= 2 && hay.includes(q)) score += 6
        }
        return { u, r, frozen, score }
      }).filter((x) => !x.frozen)
        .sort((a, b) => b.score - a.score)

      const lines = []
      let chars = 0
      for (const x of scored) {
        const zone = x.u.zone || 'task'
        const line = `- [${zone}] ${x.u.title || x.u.id}（${x.u.id}）`
        if (lines.length >= maxItems || chars + line.length > maxChars) break
        lines.push(line)
        chars += line.length
      }
      if (!lines.length) return ''
      return '【记忆】下面几条可能和当前对话有关；需要细节用 memory_recall，不要当成全部事实。\n' + lines.join('\n')
    },
    paths() {
      return { root, pluginRoot, units: unitsPath, state: statePath, scripts: join(root, 'scripts') }
    },
  }
}
