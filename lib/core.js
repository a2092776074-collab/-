// Core helpers: no DSH dependency, so they can be tested with plain node.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveRelative } from './timeanchor.mjs'

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000
const F = 19 / 81
// 2026-11-10 事实索引缓存（按文件 mtime 失效）
const factCache = new Map()
export const ZONES = ['identity', 'relation', 'task', 'reference', 'vault']
// identity/vault 不自动注入；vault 也不自动归档
export const AUTO_ZONES = new Set(['relation', 'task', 'reference'])

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback
  return JSON.parse(readFileSync(p, 'utf8'))
}

function writeJson(p, v) {
  writeFileSync(p, JSON.stringify(v, null, 1) + '\n', 'utf8')
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
  // 2026-11-08 重写（第 3 版）：
  //   ① 原版「遇到最后一条 assistant 就停」→ 宿主把运行时上下文当成 user/message 追加在末尾，
  //      一停就拿到上下文、清洗后为空，于是永远返回 ''，注入按空 query 算 → 每轮一模一样。
  //   ② 第二版「取最近一条」还是空，因为最近那条常常也是纯上下文。
  //   现在照 dsh-fish-memory 的做法：从后往前扫所有 user/message，跳过 assistant，
  //   逐条清洗，返回**第一条清洗后仍有内容的**（也就是最近一次真正说的话）。
  try {
    const s = agent && agent.session
    if (!s || typeof s.snapshotEvents !== 'function') return ''
    const ev = s.snapshotEvents() || []
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i]
      const type = e && (e.type || e.kind)
      if (type !== 'user/message') continue
      const txt = textOfMessage(e.payload !== undefined ? e.payload : e.data)
      if (!txt) continue
      const cleaned = cleanUserText(stripInjectedLines(txt))
      if (cleaned && cleaned.length >= 2) return cleaned
    }
  } catch {}
  return ''
}

/** 调试：把注入时的关键信息写到 数据/注入调试.log（排查「注入块恒定」这类问题用） */
export function debugInject(root, payload) {
  try {
    const dir = join(root, '数据')
    if (!existsSync(dir)) return
    appendFileSync(join(dir, '注入调试.log'), JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n', 'utf8')
  } catch {}
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

  // 账本（聚合注入）：问句出现「欠几件 / 还剩 / 哪些」这类词时，不靠相关度，
  // 而是按问句里的实体把相关单元**全部**捞出来、按时间排好，让模型能「数清楚」。
  // 依据：714 卷里「约定和欠账」只有 61%，实测加聚合检索后 +9 个点（对照实验 +10.5 题）。
  const AGG_RE = /欠|还剩|剩下|几件|几次|几个|几样|多少|哪些|都讲|讲过|说过|还清|齐了|列举|多久/
  // 中文没有空格，直接按分隔符切词会得到一整句。这里改成「滑窗取候选」：
  // 把问句里 2~6 字的片段挨个拿去和单元标题比对，出现过的才算实体词，再取最长的前 3 个。
  function pickEntityTokens(q, units) {
    const s = String(q || '')
    const cands = []
    for (let len = 6; len >= 2; len--) {
      for (let i = 0; i + len <= s.length; i++) {
        const w = s.slice(i, i + len)
        if (!/^[\p{L}\p{N}]+$/u.test(w)) continue
        let n = 0
        for (const u of units) {
          const hay = hayOf(u)
          if (hay.includes(w)) { n++; if (n >= 2) break }
        }
        if (n >= 2) cands.push({ w, n, len })
      }
    }
    cands.sort((a, b) => b.len - a.len || b.n - a.n)
    const picked = []
    for (const c of cands) {
      if (picked.some((p) => p.includes(c.w) || c.w.includes(p))) continue
      picked.push(c.w)
      if (picked.length >= 3) break
    }
    return picked
  }
  function aggLedger(q, units) {
    const s = String(q || '')
    if (!AGG_RE.test(s)) return ''
    let toks = pickEntityTokens(s, units)
    // 2026-11-08 补：问句太抽象时（「还欠谁什么没回」）挑不出实体词，
    // 退回用**意图词本身**去扫（没回 / 待办 / 欠 / 没做完），否则账本永远不出现。
    if (!toks.length) {
      const FALLBACK = ['没回', '待回', '待办', '还欠', '欠', '还剩', '没做完', '未完成', '跟进']
      toks = FALLBACK.filter((w) => s.includes(w) && units.some((u) => `${u.title || ''} ${u.note || ''}`.includes(w)))
    }
    // 还是挑不出来 → 退到「未了结的事」（open:true）。「还欠什么」的语义近似就是"没关掉的事"。
    // 2026-11-08：用户实测「我这几天还欠谁什么没回」时，实体词和意图词都没命中任何单元，账本没出来。
    if (!toks.length) {
      const opens = units.filter((u) => u.open)
      if (opens.length) {
        opens.sort((a, b) => (Number(a.updated) || Number(a.created) || 0) - (Number(b.updated) || Number(b.created) || 0))
        const ls = opens.slice(0, 10).map((u) => {
          const at = Number(u.updated) || Number(u.created) || 0
          return `- ${at ? new Date(at).toLocaleDateString('sv-SE') + ' ' : ''}${u.title || u.id}（未了结）`
        })
        return '【账本·未了结的事】\n' + ls.join('\n') + '\n'
      }
    }
    if (!toks.length) return ''
    const hits = units.filter((u) => {
      const hay = `${u.title || ''} ${u.note || ''}`
      return toks.some((t) => hay.includes(t))
    })
    if (hits.length < 2) return ''
    hits.sort((a, b) => (Number(a.updated) || Number(a.created) || 0) - (Number(b.updated) || Number(b.created) || 0))
    const lines = hits.slice(0, 10).map((u) => {
      const at = Number(u.updated) || Number(u.created) || 0
      const day = at ? new Date(at).toLocaleDateString('sv-SE') : ''
      return `- ${day ? day + ' ' : ''}${u.title || u.id}`
    })
    let block = '【账本·按时间列全】\n' + lines.join('\n') + '\n'
    if (block.length > 460) block = block.slice(0, 456) + '…\n'
    return block
  }

  // 2026-11-08 加：单元可带 aliases（别人可能怎么问的说法），
  // 注入打分和聚合账本都把它算进匹配库——否则换个说法就匹配不上。
  const hayOf = (u) =>
    (String(u.title || '') + ' ' + String(u.note || '') + ' ' + String(u.source || '') + ' ' +
      (process.env.DSH_MEM_ALIASES === '0' || !Array.isArray(u.aliases) ? '' : u.aliases.join(' '))).toLowerCase()

  // ── 原文摘录（2026-11-08 加）──
  // 起因：自家记忆卷测出「数字/技术/事故」三类全挂——因为这些事实只写在 md 里（备份记录、
  // 测试结论、判据细节），**一个单元都没有**，而注入只从单元里挑，于是永远看不见。
  // 做法：对根目录和 数据/ 下的 md 做字面命中扫描，缓存 60 秒（不每次读盘），
  // 命中就摘 2 行（每行截 120 字），最多 260 字，接在记忆条目后面。
  let mdCache = { at: 0, docs: [] }
  function loadMdDocs() {
    const t = Date.now()
    if (t - mdCache.at < 60_000 && mdCache.docs.length) return mdCache.docs
    const docs = []
    const addFile = (p) => {
      try {
        const st = statSync(p)
        if (!st.isFile() || st.size > 600_000) return
        docs.push({ path: p.replace(root + sep, ''), text: readFileSync(p, 'utf8') })
      } catch {}
    }
    try {
      for (const name of readdirSync(root)) {
        if (name.endsWith('.md')) addFile(join(root, name))
      }
      for (const dir of ['数据', '知识']) {
        const d = join(root, dir)
        try {
          for (const name of readdirSync(d)) if (name.endsWith('.md')) addFile(join(d, name))
        } catch {}
      }
    } catch {}
    mdCache = { at: t, docs }
    return docs
  }

  function mdExcerpt(q) {
    const s = String(q || '')
    if (s.length < 4) return ''
    // 候选片段：2~6 字，去掉口语/虚词片段，只留「稀有」的（在少数文档里出现才是特征词）
    const STOPW = /怎么|什么|多少|现在|今天|昨天|还是|就是|可以|我们|你们|他们|这个|那个|一下|时候|问题|知道|告诉|说的|做的|有没有/
    const docs = loadMdDocs()
    if (!docs.length) return ''
    const df = new Map()
    const raw = new Set()
    for (let len = 6; len >= 2; len--) {
      for (let i = 0; i + len <= s.length; i++) {
        const w = s.slice(i, i + len)
        if (w.length < 2 || !/^[\p{L}\p{N}]+$/u.test(w)) continue
        if (STOPW.test(w)) continue
        raw.add(w)
      }
    }
    for (const w of raw) {
      let n = 0
      for (const d of docs) {
        if (d.text.includes(w)) {
          n++
          if (n > 6) break
        }
      }
      if (n >= 1 && n <= 6) df.set(w, n)   // 稀有词：1~6 篇文档里出现
    }
    if (!df.size) return ''
    const hits = []
    for (const d of docs) {
      for (const line of d.text.split('\n')) {
        const t = line.trim()
        if (t.length < 10 || t.startsWith('#') || t.startsWith('|')) continue
        const got = []
        for (const [w, n] of df) if (t.includes(w)) got.push({ w, n })
        // 至少命中两个不同的稀有词，才算这一行真的和问题有关
        if (got.length < 2) continue
        const score = got.reduce((acc, g) => acc + (g.w.length * g.w.length) / g.n, 0)
        hits.push({ score, line: t.slice(0, 140), path: d.path })
      }
    }
    if (!hits.length) return ''
    hits.sort((a, b) => b.score - a.score)
    const top = hits.slice(0, 2)
    let block = '【原文摘录】\n' + top.map((h) => `- ${h.path}：${h.line}`).join('\n') + '\n'
    if (block.length > 320) block = block.slice(0, 316) + '…\n'
    return block
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
    recall(keyword, { includeFrozen = false, limit = 20, zone = '', agg = false } = {}) {
      const kw = String(keyword || '').trim()
      if (!kw || kw.length > 200) throw new Error('keyword 必填，且不超过 200 字')
      const args = [kw, '--limit', String(Math.max(1, Math.min(50, Number(limit) || 20)))]
      if (includeFrozen) args.push('--include-frozen')
      if (agg) args.push('--agg')
      if (zone) {
        if (!ZONES.includes(zone)) throw new Error('zone 只能是 ' + ZONES.join('/'))
        args.push('--zone', zone)
      }
      return run('memory-recall.mjs', args)
    },
    // 原文按需召回（2026-11-08 加）：单元里没有、但写在 md 里的东西，靠这条找。
    // 与 recall 的区别：recall 查「记忆单元 + 原文行」，grep 只查原文，返回 文件:行号。
    grepRaw(keyword, { limit = 5, dir = '' } = {}) {
      const kw = String(keyword || '').trim()
      if (!kw || kw.length < 2 || kw.length > 200) throw new Error('关键词 2~200 字')
      const args = [kw, '--limit', String(Math.max(1, Math.min(30, Number(limit) || 5)))]
      if (dir) {
        if (!/^(数据|知识|scripts|bench)$/.test(dir)) throw new Error('dir 只能是 数据/知识/scripts/bench')
        args.push('--dir', dir)
      }
      return run('memory-grep.mjs', args)
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
    // 2026-11-09 加：给单元记「结构化事实」（实体属性=值，带时间）。
    // 依据：540 卷实测——同一属性按时间排链、取最新，update 从 55%→100%、double 33→40、multi 25→60。
    // 记忆单元原本只有一句话标题，改口/更新只能靠 superseded_by 重建，多值就撑不住。
    addFact(id, { attr, value, at = Date.now(), note = '' } = {}) {
      const v = String(id || '').trim()
      if (!v) throw new Error('缺 id')
      const a = String(attr || '').trim()
      const val = String(value ?? '').trim()
      if (!a || !val) throw new Error('attr 和 value 都不能空')
      const units = loadUnits()
      const u = units.find((x) => x.id === v)
      if (!u) throw new Error('找不到单元 ' + v)
      const list = Array.isArray(u.facts) ? u.facts : []
      // 同属性同值只更新时间，不堆重复
      const dup = list.find((f) => f.attr === a && String(f.value) === val)
      if (dup) {
        dup.at = Number(at)
        if (note) dup.note = String(note).slice(0, 120)
      } else {
        list.push({ attr: a, value: val, at: Number(at) || Date.now(), ...(note ? { note: String(note).slice(0, 120) } : {}) })
      }
      u.facts = list.sort((x, y) => (Number(x.at) || 0) - (Number(y.at) || 0))
      u.updated = Date.now()
      writeJson(unitsPath, units)
      const latest = u.facts[u.facts.length - 1]
      const others = u.facts.filter((f) => f.attr === a && f !== latest).length
      return `已记：${v} · ${a}=${val}${others ? `（该属性另有 ${others} 条旧值，取最新）` : ''}`
    },
    archive({ apply = false, minDays = 30 } = {}) {
      const days = Math.max(1, Math.min(3650, Number(minDays) || 30))
      const args = ['--min-days', String(days)]
      if (apply) args.push('--apply')
      return run('memory-archive.mjs', args)
    },
    // 自动注入：只读 relation/task/reference，跳过冻结；按相关度 + 重要度 + R 排，限条数和字数
    injectFor(query = '', { maxItems = 8, maxChars = 950 } = {}) {
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
      // 2026-11-09 加：绝对数闸门。今天两次踩坑里有一次就是"拿印象当基线"
      // （把调参轮次当成历史最好成绩，得出"掉了 15 个点"的错误结论）。
      // 只提醒不阻塞：报数前先 recall，枚举类用 agg。
      const claimGuard = (() => {
        const t = String(query || '')
        if (!/只有|一次都没|从来没|从来没有|历史最好|最好成绩|最高|最少|最多|几次|第一次|唯一|全部|都(没有|是)/.test(t)) return ''
        return '【必查】这句在问绝对数——报数前先 memory_recall（要枚举用 agg），别凭印象。\n'
      })()
      const units = loadUnits().filter((u) => AUTO_ZONES.has(u.zone || 'task'))
      // 2026-11-08：原文摘录试过一版，命中质量太差（问“714 多少分”召回的是无关表格行），
      // 默认关掉；要试就设 DSH_MEM_EXCERPT=1。正确方向是把关键事实做成单元，而不是模糊摘录。
      const excerpt = process.env.DSH_MEM_EXCERPT === '1' ? mdExcerpt(query) : ''
      if (!units.length) return triggerBlock + nowLine + claimGuard + excerpt
      // 2026-11-08 加：聚合意图 → 账本块（按实体全量、按时间排），放在记忆条目前面
      const ledger = aggLedger(query, units)
      const state = loadState()
      const now = Date.now()
      const q = String(query || '').toLowerCase()
      const scored = units.map((u) => {
        const st = state.units?.[u.id]
        const r = rOf(u, st, now)
        const frozen = r < 0.5 && !u.core && !u.open
        let score = (Number(u.importance) || 2) * 2 + r * 3
        // 2026-11-08 加：现状事实卡很长（160 字），它一进来就挤掉别的槽位——
        // 自家记忆卷里「事故」类因此在 0/3 和 2/3 之间跳。所以只在问「数字/进度/现状」时给它满分，
        // 其他问题压到 35%，让它别抢位置。
        if (u.id === 'knowledge:status-facts' && !/多少|几|进度|现状|分数|完成|情况|现在/.test(String(query || ''))) {
          score *= 0.35
        }
        // 时间类问题：把「更新得近」的单元往上顶（原来 R 只占 3 分，抵不过重要度）
        if (timeIntent) score += r * 8
        // 2026-11-08 修（工程官审计）：中文没有空格，原来 `q.split(/[^\p{L}\p{N}]+/)` 会把整句
        // 当成一个 token，只有标题**整句包含**才加分 —— 等于中文问句根本不参与打分。
        // 改成中文 bigram 覆盖率：命中的二元组 / 问句二元组总数，乘 12 封顶。
        if (q) {
          const hay = hayOf(u)
          const qb = []
          for (let i = 0; i + 2 <= q.length; i++) {
            const g = q.slice(i, i + 2)
            if (/^[\p{L}\p{N}]{2}$/u.test(g)) qb.push(g)
          }
          if (qb.length) {
            let hit = 0
            for (const g of new Set(qb)) if (hay.includes(g)) hit++
            score += (hit / new Set(qb).size) * 12
          }
          if (q.length >= 2 && hay.includes(q)) score += 6
        }
        return { u, r, frozen, score }
      }).filter((x) => !x.frozen && !x.u.superseded_by)   // 2026-11-08 修：作废的旧结论不能当现行注入（recall 早滤了，注入漏了）
        .sort((a, b) => b.score - a.score)

      // 2026-11-08 改（B 方案）：钉住不再「无条件占 3 格」。
      // 之前是硬留 3 格，导致问什么都先塞未了结/最新日记/最新对话卡，真正相关的那条反而挤不进来
      // （see-now 详情被模块索引顶掉、conv:009 进不来，都是这个原因）。
      // 现在：先看「问句和哪个单元真的沾边」，沾得上就让相关度说话，钉住的只拿一个小加分；
      // 只有问句跟谁都不沾边时，才用钉住兜底（这种情况下不钉住注入就是空的）。
      const pinned = []
      const recentCut = now - 7 * 86400_000
      const newestOf = (pred) =>
        units
          .filter((u) => pred(u) && (Number(u.updated) || Number(u.created) || 0) >= recentCut)
          .sort((a, b) => (Number(b.updated) || Number(b.created) || 0) - (Number(a.updated) || Number(a.created) || 0))[0]
      const pinOpen = units.filter((u) => u.open).sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))[0]
      if (pinOpen) pinned.push(pinOpen)
      const pinDiary = newestOf((u) => String(u.id).startsWith('diary:'))
      const pinConv = newestOf((u) => String(u.id).startsWith('conv:'))
      for (const u of [pinDiary, pinConv]) if (u && !pinned.some((x) => x.id === u.id)) pinned.push(u)

      // 问句覆盖率：问句的 bigram 有多少比例出现在某个单元里（最高者）
      const qBigrams = (() => {
        const set = new Set()
        for (let i = 0; i + 2 <= q.length; i++) {
          const g = q.slice(i, i + 2)
          if (/^[\p{L}\p{N}]{2}$/u.test(g)) set.add(g)
        }
        return [...set]
      })()
      const coverageOf = (u) => {
        if (!qBigrams.length) return 0
        const hay = hayOf(u)
        let hit = 0
        for (const g of qBigrams) if (hay.includes(g)) hit++
        return hit / qBigrams.length
      }
      const bestCoverage = scored.reduce((m, x) => Math.max(m, coverageOf(x.u)), 0)
      const pinMode = bestCoverage < 0.34   // 沾不上边才兜底钉住

      const lines = []
      // 2026-11-08 修（工程官审计）：预算从 0 起算，等于没算 trigger/账本/摘录那三块，
      // 实测把一张 900 字的卡放第一名时，注入从 7 条掉到 1 条。现在预扣前缀实际长度。
      // 2026-11-08 再修：账本/摘录单独算预算，不跟记忆条数抢——否则账本一长，记忆就只剩一两条。
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
      let skipped = 0
      const used = new Set()
      const mkLine = (u) => {
        const zone = u.zone || 'task'
        const age = ageOf(u)
        // 2026-11-10 加（时间锚进生产）：单元里带相对时间（前天/上周三/下周三）时，
        // 就地补成「前天(2026-11-07)」。锚点用这条单元的更新时间，不是"现在"——
        // 沙箱实测：48 道时间题两遍，75.0% → 85.4%（+10.4pp），两遍一致。
        const anchorMs = Number(u.updated) || Number(u.created) || 0
        const absDay = anchorMs ? new Date(anchorMs).toLocaleDateString('sv-SE') : ''
        // 2026-11-10 实测修正：全量 714 上给所有记忆条做时间标注是 **-24 题**（602 vs 626）；
        // 只有时间类问句（48 题子集）才 +10pp。所以这里只对时间问句开标注，别一律开。
        const isTimeQuery = /前天|昨天|今天|明天|后天|上周|下周|这周|上个月|下个月|几天|多久|什么时候|哪天|几号|周[一二三四五六日天]/.test(String(query || ''))
        const annotateDates = (s) => {
          if (!s || !anchorMs || !isTimeQuery) return s
          try {
            const r = resolveRelative(s, new Date(anchorMs).toISOString())
            if (r && r.confident && r.rule && !s.includes(`${r.rule}(${r.date})`)) {
              return s.replace(r.rule, `${r.rule}(${r.date})`)
            }
          } catch {}
          return s
        }
        // 标题截 60 字：最长标题 190 字，一条就能吃掉四分之一预算
        const title = String(u.title || u.id)
        const shown = annotateDates(title.length > 60 ? title.slice(0, 58) + '…' : title)
        // 2026-11-08 加：带一行实质摘要。只有标题时模型答不出细节（114 题里 14 题锚点 0/3 就是这个）。
        // 2026-11-08 实测：加摘要反而掉分（62-71 vs 72-74），默认关掉，留开关做后续实验。
        const sum = process.env.DSH_MEM_SUMMARY === '0' ? '' : String(u.summary || '').trim()
        const sumShown = sum ? (sum.length > 44 ? sum.slice(0, 42) + '…' : sum) : ''
        // 2026-11-09 加：单元带 facts 时，挂一行「现行值」（取时间最新那条）。
        // 由来：540 卷证明「时间判断交给结构」比让模型自己挑强得多（update 55%→100%）。
        const factsLine = (() => {
          if (!Array.isArray(u.facts) || !u.facts.length) return ''
          const qq = String(query || '')
          const bigrams = (s) => {
            const out = []
            for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2))
            return out
          }
          const qb = bigrams(qq)
          const scoreOf = (f) => {
            const a = String(f.attr || '')
            let hit = 0
            for (const g of qb) if (a.includes(g)) hit++
            return hit
          }
          const sorted = [...u.facts].sort((a, b) => {
            const sa = scoreOf(a)
            const sb = scoreOf(b)
            if (sa !== sb) return sb - sa
            return (Number(b.at) || 0) - (Number(a.at) || 0)
          })
          const f = sorted[0]
          if (scoreOf(f) === 0 && u.facts.length > 1) {
            // 问句和任何属性都不沾边时，宁可不展示，别拿无关值误导
            return ''
          }
          const d = f.at ? new Date(Number(f.at)).toLocaleDateString('sv-SE') : ''
          return `\n  · 现行：${f.attr}=${f.value}${d ? '（' + d + '）' : ''}`
        })()
        return `- [${zone}] ${shown}（${u.id}）${age ? ' · ' + age : ''}${absDay && isTimeQuery ? '（' + absDay + '）' : ''}${sumShown ? ' — ' + sumShown : ''}${factsLine}`
      }
      // 钉住的两档：pinMode（问句啥都不沾）→ 无条件先放；
      // 否则只给钉住单元 +3 分参与竞争，不自占名额。
      const pinIds = new Set(pinned.map((u) => u.id))
      const ordered = pinMode
        ? [...pinned.map((u) => ({ u, score: Number.MAX_SAFE_INTEGER - pinned.indexOf(u) })), ...scored.filter((x) => !pinIds.has(x.u.id))]
        : scored
            .map((x) => ({ u: x.u, score: x.score + (pinIds.has(x.u.id) ? 3 : 0) }))
            .sort((a, b) => b.score - a.score)
      for (const x of ordered) {
        if (used.has(x.u.id)) continue
        const line = mkLine(x.u)
        if (lines.length >= maxItems) break
        // 超预算不 break，跳过这一条继续看后面的短卡（原来一张长卡会清空整块）
        if (chars + line.length > maxChars) {
          skipped++
          continue
        }
        lines.push(line)
        chars += line.length
      }
      if (skipped) debugInject(root, { skippedLong: skipped })
      // 2026-11-10 事实索引（事件状态索引）：{实体,属性,值,日期} 里挑和问句沾边的 ≤3 条，
      // 只在"现行值"上注入。来源 scripts/fact-extract.mjs → 数据/索引/事实.json。
      const factBlock = (() => {
        try {
          const fpath = join(root, '数据', '索引', '事实.json')
          if (!existsSync(fpath)) return ''
          const m = statSync(fpath).mtimeMs
          const hit = factCache.get(fpath)
          let facts
          if (hit && hit.m === m) facts = hit.facts
          else {
            const raw = JSON.parse(readFileSync(fpath, 'utf8'))
            facts = Object.values(raw).flat()
            factCache.set(fpath, { m, facts })
          }
          if (!facts || !facts.length) return ''
          const qq = String(query || '')
          const grams = (s) => {
            const out = []
            for (let i = 0; i + 2 <= s.length; i++) out.push(s.slice(i, i + 2))
            return out
          }
          const qg = grams(qq)
          // 属性词意图：中文里"我叫什么"和「称呼=鱼仔」字面不重合，靠意图搭桥
          const INTENTS = [
            { re: /我叫|名字|称呼|怎么叫|叫什么/, attrs: ['称呼', '姓名'] },
            { re: /住哪|住在|哪住|城市|哪个地方/, attrs: ['城市', '居住'] },
            { re: /做什么|干什么|工作|职业|上班/, attrs: ['职业', '单位'] },
            { re: /多大|几岁|年龄/, attrs: ['年龄'] },
          ]
          const scored = facts
            .filter((f) => f && (!f.state || f.state === 'current'))
            .map((f) => {
              const hay = `${f.entity || ''}${f.attr || ''}${f.value || ''}`
              let hitN = 0
              for (const g of qg) if (hay.includes(g)) hitN++
              for (const it of INTENTS) {
                if (it.re.test(qq) && it.attrs.includes(String(f.attr || ''))) hitN += 3
              }
              return { f, hitN }
            })
            .filter((x) => x.hitN >= 2)
            .sort((a, b) => b.hitN - a.hitN)
            .slice(0, 3)
          if (!scored.length) return ''
          // 同名同值只留最新一条；值太长截 60 字（注入块要省字数）
          const seen = new Map()
          for (const x of scored) {
            const val = String(x.f.value || '').replace(/（[^）]*）\s*$/, '').trim()
            const key = `${x.f.attr}|${val}`
            const prev = seen.get(key)
            if (!prev || String(x.f.date || '') > String(prev.f.date || '')) seen.set(key, x)
          }
          const body = [...seen.values()]
            .slice(0, 3)
            .map((x) => {
              const v = String(x.f.value || '')
              return `· ${x.f.entity}·${x.f.attr}：${v.length > 60 ? v.slice(0, 58) + '…' : v}（${x.f.date || ''}）`
            })
            .join('\n')
          return '\n【事实索引】从长期记忆里查到的现行事实：\n' + body
        } catch {
          return ''
        }
      })()
      if (!lines.length) return triggerBlock + nowLine + claimGuard + ledger + excerpt + factBlock
      return triggerBlock + nowLine + claimGuard + ledger + excerpt + '【记忆】下面几条可能和当前对话有关；需要细节用 memory_recall，不要当成全部事实。\n' + lines.join('\n') + factBlock
    },
    // 语义补充（2026-11-09）：查常驻服务，拿 top-N 单元。同步实现——用 curl 子进程，
    // 因为宿主注入钩子是同步函数（sp.context({text:()=>string})），没有 await 的机会。
    // 服务没起 / 超时 → 返回 []，静默退回纯字面，绝不阻塞注入。
    semanticExtra(query = '', top = 2) {
      try {
        if (process.env.DSH_MEM_SEMANTIC === '0') return []
        const q = String(query || '').trim()
        if (!q) return []
        const url = `${process.env.SEMANTIC_URL || 'http://127.0.0.1:8791'}/q?text=${encodeURIComponent(q.slice(0, 120))}&top=${top + 3}`
        const out = execFileSync('curl.exe', ['-s', '--max-time', '1', url], { encoding: 'utf8', timeout: 1600 })
        const j = JSON.parse(out)
        if (!j || !j.ok) return []
        return (j.rows || []).filter((r) => r.kind === 'unit' && r.id).slice(0, top)
      } catch {
        return []
      }
    },
    // 字面注入 + 语义补充。dedupe=true 时按 id 去重（更省字数，但补上的条数少）；
    // dedupe=false 时照抄语义前 N 条（实验里 93/114 是这种，重复的也算"多给一点原文"）。
    injectWithSemantic(query = '', { maxItems = 8, maxChars = 950, semanticTop = 2, dedupe = true } = {}) {
      const base = this.injectFor(query, { maxItems, maxChars })
      const extra = this.semanticExtra(query, semanticTop + (dedupe ? 3 : 0))
      if (!extra.length) return base
      const seen = dedupe ? new Set([...String(base).matchAll(/（([a-z]+:[a-z0-9-]+)）/g)].map((m) => m[1])) : new Set()
      const lines = []
      for (const r of extra) {
        if (seen.has(r.id)) continue
        const title = String(r.text || r.id).replace(/\s+/g, ' ').slice(0, 56)
        lines.push(`- [语义 ${r.score}] ${title}（${r.id}）`)
        if (lines.length >= semanticTop) break
      }
      if (!lines.length) return base
      return `${base}\n【语义补充】相似度最高的 ${lines.length} 条（和上面可能重复，已按 id 去重）：\n${lines.join('\n')}`
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
  // 2) 2026-11-08 修：先整块去掉**我们自己注入的那几块**（【现在】/【判据】/【账本】/【记忆】）。
  //    原来这里是「从最后一条 - [zone] 往前切」，结果把用户真话也切掉了，
  //    留下的反而是一条记忆条目 —— 于是每轮注入都基于同一段旧文本，注入块恒定不变。
  t = t.replace(/【记忆】[\s\S]*$/u, '')
  t = t.replace(/【账本[^\n]*\n(?:- [^\n]*\n?)*/gu, '')
  t = t.replace(/【判据·该响了】[\s\S]*?(?=\n\n|$)/gu, '')
  t = t.replace(/^【现在】[^\n]*$/gmu, '')
  // 3) 宿主运行时上下文：从这句起全部丢弃（它在真话之后，是追加的）
  const ctxAt = t.search(/Current runtime context\.?/i)
  if (ctxAt >= 0) t = t.slice(0, ctxAt)
  // 4) 逐行去掉宿主说明行（注意：stripInjectedLines 已经把 "Current runtime context" 那行删了，
  //    所以不能再靠那句话当锚点，得逐行按前缀筛）
  t = stripInjectedLines(t)
  t = t
    .split('\n')
    .filter(
      (l) =>
        !/^(Current\b|Your \b|Approval prompts are disabled|You are the Team Lead|Use list_agents|To message another teammate|The Team Lead|This snapshot|Agent Teams is available|Time sampled|Browser time zone|Elapsed since)/i.test(
          l.trim(),
        ),
    )
    .join('\n')
  return t.trim()
}

/** 把宿主/定时器注入的「不是人说的话」的行剔掉（2026-11-07 深夜加）
 * 起因：今天流水 87 行里 47 行是注入（54%），其中「Elapsed since the preceding
 * model-visible message…」「[SCHEDULE REMINDER BATCH]…」两类 cleanUserText 没覆盖，
 * 结果被当成用户发言压成了事卡。
 */
export function stripInjectedLines(text) {
  // 2026-11-08 补：重启后发现新的一类注入——<system-reminder> 整块（技能目录变更等），
  // 它是多行的，必须整块删掉，不能按行过滤（避免残留半截）。
  const t0 = String(text || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
  const JUNK = [
    /^Time sampled while preparing turn/i,
    /^Browser time zone for this request/i,
    /^Elapsed since the preceding/i,
    /^\[SCHEDULE REMINDER BATCH\]/i,
    /^This is a scheduled message from the user/i,
    /^reminders_json:/i,
    /^Current runtime context/i,
    /^<system-reminder>/i,
    /^<\/system-reminder>/i,
  ]
  const lines = t0.split('\n')
  const kept = lines.filter((l) => {
    const s = l.trim()
    if (!s) return true
    return !JUNK.some((re) => re.test(s))
  })
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

