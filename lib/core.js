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
  // 2026-11-07 修（工程官指出）：宿主会把「运行时上下文」当成**另一条 user/message**
  // 追加在每轮末尾，原版只取最后一条 → 取到的常常是上下文，真话被顶掉。
  // 现在：从后往前，只看最后一条 assistant 之后的 user 消息，剥完上下文取最长的那条。
  try {
    const s = agent && agent.session
    if (!s || typeof s.snapshotEvents !== 'function') return ''
    const ev = s.snapshotEvents() || []
    const cands = []
    for (let i = ev.length - 1; i >= 0 && cands.length < 5; i--) {
      const e = ev[i]
      const type = e && (e.type || e.kind)
      if (type === 'assistant/message') break
      if (type !== 'user/message') continue
      const txt = textOfMessage(e.payload !== undefined ? e.payload : e.data)
      if (!txt) continue
      const cleaned = cleanUserText(txt)
      if (cleaned) cands.push(cleaned)
    }
    if (!cands.length) return ''
    return cands.sort((a, b) => b.length - a.length)[0]
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
    // 桌面版里 process.execPath 是 "DeepSeek Harness.exe"（插件跑在 Electron-as-node 的
    // host 进程里）。显式带上 ELECTRON_RUN_AS_NODE，免得它被当成 GUI 再启动一个窗口。
    return execFileSync(process.execPath, [script, ...args], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
  }

  const loadUnits = () => readJson(unitsPath, [])
  const loadState = () => readJson(statePath, { units: {} })

  // 判据触发：把「这句话碰到了哪条判据」查出来（缓存 60 秒，避免每 tick 读盘）
  // 表在 数据/判据触发.json；命中就把那一行顶到注入块最前面。
  const triggerPath = join(root, '数据', '判据触发.json')
  let triggerCache = { at: 0, rows: [] }
  function matchCriteria(q) {
    const s = String(q || '')
    if (s.length < 2) return ''
    try {
      const t = Date.now()
      if (t - triggerCache.at > 60_000) triggerCache = { at: t, rows: readJson(triggerPath, []) }
      const hits = []
      for (const r of triggerCache.rows) {
        if ((r.triggers || []).some((w) => w && s.includes(w))) hits.push(r)
        if (hits.length >= 2) break
      }
      if (!hits.length) return ''
      return '【判据·该响了】\n' + hits.map((r) => '- ' + r.line).join('\n') + '\n'
    } catch { return '' }
  }

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
      // 2026-11-07 加（议会点出）：判据不能只躺在 .md 里等我想起来。
      // 先把「这句话碰到了哪条判据」查出来，命中就顶在注入块最前面——最多 2 条。
      const triggerBlock = matchCriteria(query)
      // 2026-11-07 加：始终告诉「现在是什么时候」。
      // 714 题测试里「时间题 19/48」——一半原因是回答时根本不知道今天是哪天，
      // 相对日期（上次/多久前/哪天）无从算起。
      const nowLine = (() => {
        const d = new Date()
        const wd = '日一二三四五六'[d.getDay()]
        const p2 = (n) => String(n).padStart(2, '0')
        return `【现在】${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}（周${wd}）\n`
      })()
      const timeIntent = /上次|上回|多久|什么时候|哪天|几号|几天前|隔了|之前|后来|那天|当时|还剩|还欠|约的|定在|多少天|哪一天/.test(String(query || ''))
      const units = loadUnits().filter((u) => AUTO_ZONES.has(u.zone || 'task'))
      if (!units.length) return triggerBlock + nowLine
      const state = loadState()
      const now = Date.now()
      const q = String(query || '').toLowerCase()
      const scored = units.map((u) => {
        const st = state.units?.[u.id]
        const r = rOf(u, st, now)
        const frozen = r < 0.5 && !u.core && !u.open
        let score = (Number(u.importance) || 2) * 2 + r * 3
        // 时间类问题：把「更新得近」的单元往上顶（原来 R 只占 3 分，抵不过重要度）
        if (timeIntent) score += r * 8
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
      // 2026-11-07 加相对时间：注入块原来**一条时间都没有**，我分不清哪条是新的，
      // 「已作废」的旧结论和刚改的结论长得一模一样。现在每条挂一个粗粒度时长。
      const ageOf = (u) => {
        const t = Number(u.updated) || Number(u.created) || 0
        if (!t) return ''
        const h = (Date.now() - t) / 3_600_000
        if (h < 1) return '刚刚'
        if (h < 24) return Math.floor(h) + '小时前'
        const d = Math.floor(h / 24)
        if (d < 30) return d + '天前'
        return Math.floor(d / 30) + '个月前'
      }
      for (const x of scored) {
        const zone = x.u.zone || 'task'
        const age = ageOf(x.u)
        const line = `- [${zone}] ${x.u.title || x.u.id}（${x.u.id}）${age ? ' · ' + age : ''}`
        if (lines.length >= maxItems || chars + line.length > maxChars) break
        lines.push(line)
        chars += line.length
      }
      if (!lines.length) return triggerBlock + nowLine
      return triggerBlock + nowLine + '【记忆】下面几条可能和当前对话有关；需要细节用 memory_recall，不要当成全部事实。\n' + lines.join('\n')
    },
    paths() {
      return { root, pluginRoot, units: unitsPath, state: statePath, scripts: join(root, 'scripts') }
    },
  }
}

/** 把宿主塞在用户消息前面的运行时上下文剥掉（2026-11-06：流水抓到的是整整 1200 字的上下文） */
export function cleanUserText(raw) {
  let t = String(raw || '')
  // 1) 剥宿主注入的「时间采样 / 时区」前缀（2026-11-07 加：流水里混进了这种行）
  t = t.replace(/^Time sampled while preparing turn[^\n]*\n(Browser time zone for this request:[^\n]*\n?)?/i, '')
  t = t.replace(/^Browser time zone for this request:[^\n]*\n?/i, '')
  // 2) 剥运行时上下文 / 记忆块
  if (t.includes('Current runtime context') || t.includes('【记忆】')) {
    const lines = t.split('\n')
    let cut = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^- \[[a-z]+\]/.test(lines[i].trim())) { cut = i; break }
    }
    if (cut >= 0) t = lines.slice(cut + 1).join('\n')
    else {
      const idx = t.lastIndexOf('\n\n')
      if (idx > 0) t = t.slice(idx + 2)
    }
  }
  return t.trim()
}
