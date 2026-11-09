// DSH plugin entry: tools + optional auto-injection of relevant memory.
import { existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeCore, lastUserText, cleanUserText, stripInjectedLines, debugInject } from './core.js'
import { loadHostDeps } from './hostdeps.mjs'

export const name = 'memory-system'
export const inject = ['systemPrompt', 'agents', 'timer', 'tools']

const hostDeps = await loadHostDeps()
const defineTool = hostDeps.defineTool
for (const n of hostDeps.notes || []) console.warn('[dsh-memory-system] ' + n)

const wrap = (fn) => async (args) => {
  try {
    const message = await fn(args || {})
    return { ok: true, message: String(message || '').trim() || 'done' }
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) }
  }
}

function sessionIdOf(agent) {
  const s = agent && agent.session
  for (const k of ['id', 'sessionId', 'key', 'sessionKey', 'sid']) {
    try {
      const v = s?.[k]
      if (typeof v === 'string' && v) return v
    } catch {}
  }
  return ''
}

export function apply(ctx, config = {}) {
  // 工作区根：桌面版里插件跑在 host 进程里，process.cwd() 是 profile 目录
  // （2026-11-06 实测：C:\Users\Lin\.dsh\profiles\desktop），不是工作区。
  // 所以先按「会话自己的 cwd」找，找到带 数据/记忆单元.json 的那个才算数。
  //
  // 2026-11-06 增：接受 config.root / config.baseDir 显式指定——评测器的 mock 宿主里
  // 没有 agents 服务，靠会话 cwd 永远找不到根目录；外部跑评测时要能直接喂根目录。
  const forcedRoot = typeof config?.root === 'string' && config.root
    ? config.root
    : (typeof config?.baseDir === 'string' && config.baseDir ? config.baseDir : '')
  function sessionCwdOf(agent) {
    try {
      const s = agent && agent.session
      const c = (s && s.header && s.header.cwd) || (s && s.cwd)
      return typeof c === 'string' ? c : ''
    } catch { return '' }
  }
  function validRoot(dir) {
    try { return typeof dir === 'string' && !!dir && existsSync(join(dir, '数据', '记忆单元.json')) } catch { return false }
  }
  let core = makeCore({ root: forcedRoot || process.env.DSH_WORKSPACE || process.cwd() })
  let warnedRoot = ''
  function refreshRoot() {
    if (forcedRoot) return
    try {
      const list = ctx && ctx.agents && typeof ctx.agents.list === 'function' ? ctx.agents.list() || [] : []
      for (const agent of list) {
        const c = sessionCwdOf(agent)
        if (!validRoot(c)) continue
        if (core.root !== c) {
          core = makeCore({ root: c })
          console.warn('[dsh-memory-system] workspace = ' + c)
        }
        return
      }
    } catch {}
    if (warnedRoot !== core.root) {
      warnedRoot = core.root
      console.warn('[dsh-memory-system] 工作区还没定位到，暂用 ' + core.root)
    }
  }
  refreshRoot()

  // 宿主的 defineTool 要求 output.schema + render（拿不到宿主那份时本地实现会原样透传，
  // 所以这里给一份两边都认的）
  const resultOutput = () => ({
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { ok: { type: 'boolean' }, message: { type: 'string' } },
    },
    render(_args, value) {
      const ok = !(value && value.ok === false)
      return [{ type: 'text', text: (ok ? '' : '✗ ') + String((value && value.message) || '') }]
    },
  })

  // ---- tools ----
  if (defineTool && ctx?.tools && typeof ctx.tools.register === 'function') {
    const tools = [
      defineTool({
        name: 'memory_init',
        description:
          '在工作区初始化文件式记忆体系：复制六件套模板、判据库、数据文件和脚本。已存在的文件不覆盖。先跑一次这个，再用其他 memory_* 工具。',
        parameters: {},
        output: resultOutput(),
        execute: wrap(() => {
          if (/[\\/]\.dsh[\\/]profiles[\\/]/i.test(core.root)) {
            throw new Error(`工作区没定位到（现在指向 ${core.root}，这是 profile 目录），先别初始化`)
          }
          const r = core.init()
          return `初始化完成：新建 ${r.created.length} 个，跳过 ${r.skipped.length} 个（已存在）\n根目录：${core.root}`
        }),
      }),
      defineTool({
        name: 'memory_status',
        description:
          '查看记忆单元状态：总数、冻结数、每个单元的 R/S、距冻结天数。用于判断哪些该复习、哪些该归档。',
        parameters: {},
        output: resultOutput(),
        execute: wrap(() => core.status()),
      }),
      defineTool({
        name: 'memory_recall',
        description:
          '按关键词从记忆单元和 .md 原文里找相关记忆。默认不列冻结单元；只读，不改状态。zone 可过滤 relation/task/reference/identity/vault。\n' +
          '什么时候该用：想不起某件事的细节（谁、哪天、说过什么）、要核对之前定的结论、或要引用旧记录的原话时。\n' +
          '什么时候不该用：要查当前时间/文件现状（直接读文件或看系统时间）；要执行动作（这不是执行工具）；关键词只有一个常见词（会命中大量无关条目，先换成更具体的人名/项目名）。\n' +
          '注意：返回的是候选，不是事实——引用前要看清出处行，必要时再读原文核对。',
        parameters: {
          keyword: { type: 'string', required: true, description: '关键词（中文/英文都行）。多词用空格分隔时按整串匹配，建议先用单个具体词' },
          include_frozen: { type: 'boolean', description: '是否也列出已冻结的单元（默认 false）' },
          limit: { type: 'number', description: '最多几条原文命中（1-50，默认 20）' },
          zone: { type: 'string', description: '只查某个分区：relation / task / reference / identity / vault（可选）' },
          agg: { type: 'boolean', description: '聚合模式：不按相关度排，而是把含这个词的条目全部按时间列出来（适合「欠几件/还剩什么/都说过哪些」这类要枚举的问题）' },
        },
        output: resultOutput(),
        execute: wrap((a) => core.recall(a.keyword, { includeFrozen: !!a.include_frozen, limit: a.limit, zone: a.zone, agg: !!a.agg })),
      }),
      defineTool({
        name: 'memory_grep',
        description:
          '在原文（.md/.json/.mjs 等文件）里按关键词搜，返回 文件:行号 + 那一行。\n' +
          '什么时候该用：memory_recall 没结果、或要查「具体数字 / 某段技术描述 / 某个结论写在哪」时——这些往往只在文档里，没被压成记忆单元。\n' +
          '什么时候不该用：找「发生过什么事」用 memory_recall（查单元更省）；要枚举用 recall 的 agg 模式。\n' +
          '返回的是原文行，可能很长也可能过期，引用前先看文件日期。',
        parameters: {
          keyword: { type: 'string', required: true, description: '关键词（2~200 字，字面匹配）' },
          limit: { type: 'number', description: '最多几条（1-30，默认 5）' },
          dir: { type: 'string', description: '只搜某个目录：数据 / 知识 / scripts / bench（可选）' },
        },
        output: resultOutput(),
        execute: wrap((a) => core.grepRaw(a.keyword, { limit: a.limit, dir: a.dir })),
      }),
      defineTool({
        name: 'memory_review',
        description:
          '复习一个记忆单元，更新 FSRS-5 牢固度。1=又忘了 / 2=费劲 / 3=顺利 / 4=太简单。用到才复习。',
        parameters: {
          id: { type: 'string', required: true, description: '单元 id，如 case:first-lesson' },
          rating: { type: 'number', required: true, description: '1-4' },
        },
        output: resultOutput(),
        execute: wrap((a) => core.review(a.id, a.rating)),
      }),
      defineTool({
        name: 'memory_archive',
        description:
          '冷归档：把「冻结 ≥N 天、复习过、非 core/open、非 identity/vault」的单元移出活跃清单（原文不删）。默认 dry-run；apply=true 才真归档。',
        parameters: {
          apply: { type: 'boolean', description: 'true 才真正移动；默认 false 只预览' },
          min_days: { type: 'number', description: '冻结至少多少天（默认 30）' },
        },
        output: resultOutput(),
        execute: wrap((a) => core.archive({ apply: !!a.apply, minDays: a.min_days })),
      }),
      defineTool({
        name: 'memory_fact',
        description:
          '给一个记忆单元记一条「结构化事实」：属性=值+时间。同一属性多值会按时间排，注入和 recall 只展示最新那条。\n' +
          '什么时候用：某个结论会被改口/更新（配置改了、数字变了、决定改主意了），而单元标题是一句话概括、装不下多值时。\n' +
          '例：memory_fact(id="knowledge:status-facts", attr="714得分", value="88.9%")。',
        parameters: {
          id: { type: 'string', required: true, description: '单元 id（必须是已存在的，kind:slug）' },
          attr: { type: 'string', required: true, description: '属性名，如 "714得分" / "负责人" / "上限"' },
          value: { type: 'string', required: true, description: '值（数字/名字/结论都行）' },
          at: { type: 'number', description: '时间戳（毫秒，可选，默认现在）' },
          note: { type: 'string', description: '备注（可选，≤120 字）' },
        },
        output: resultOutput(),
        execute: wrap((a) => core.addFact(a.id, { attr: a.attr, value: a.value, at: a.at, note: a.note })),
      }),
    ]
    for (const t of tools) ctx.tools.register(t)
  } else {
    console.warn('[dsh-memory-system] tools service unavailable; tools not registered')
  }

  // ---- auto-injection:每 3 秒检查活着的 agent，挂一段随当前消息变化的记忆上下文 ----
  const mounted = new Map()

  // ---- 对话流水（2026-11-06）：每轮对方说的话追加一行，给每天的 ingest 当原料 ----
  // 只能记用户侧：宿主的会话正文不落盘，磁盘上只有摘要，所以趁 tick 还在时抓。
  const streamLast = new Map()
  let streamFails = 0
  function appendStream(text) {
    if (streamFails > 5) return
    try {
      const d = new Date()
      const day = d.toISOString().slice(0, 10)
      const dir = join(core.root, '数据', '对话流水')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const line = JSON.stringify({ ts: d.getTime(), role: 'user', text: String(text).slice(0, 4000) }) + '\n'
      appendFileSync(join(dir, day + '.jsonl'), line, 'utf8')
    } catch {
      streamFails += 1
      if (streamFails === 6) console.warn('[dsh-memory-system] 对话流水写不进去，先停掉')
    }
  }

  function tick() {
    refreshRoot()
    try {
      if (!ctx.agents || typeof ctx.agents.list !== 'function') return
      for (const agent of ctx.agents.list() || []) {
        const sid = sessionIdOf(agent)
        if (!sid) continue
        // ── 对话流水：把「这一轮对方说了什么」记下来，供每天的一次 ingest 用 ──
        // 2026-11-07 修：这段原来写在 `if (mounted.has(sid)) continue` 后面，
        // 而挂载成功后 mounted 里就有了 sid —— 于是**从第二次 tick 起整段被跳过**，
        // 流水永远是空的。现在挪到 mounted 判断之前。
        try {
          const raw = cleanUserText(stripInjectedLines(lastUserText(agent)))
          if (raw && raw.length >= 2 && streamLast.get(sid) !== raw) {
            streamLast.set(sid, raw)
            appendStream(raw)
          }
        } catch {}
        if (mounted.has(sid)) continue
        try {
          const sp = agent.ctx && agent.ctx.systemPrompt
          if (!sp || typeof sp.context !== 'function') continue
          const off = sp.context({
            name: 'memory-system',
            // 排在最后：这段每轮都随最后一句话变，放前面会把后面几千字全变成缓存未命中
            // （fish-memory 那边实测过，order 放前面一轮成本从 0.003 飙到 0.02）
            order: 89990,
            text: () => {
              try {
                const q = lastUserText(agent)
                const out = core.injectFor(q)
                debugInject(core.root, { sid, q: String(q || '').slice(0, 60), len: String(q || '').length, hasLedger: out.includes('账本'), outLen: out.length })
                return out
              } catch (e) {
                debugInject(core.root, { sid, err: String(e && e.message).slice(0, 80) })
                return ''
              }
            },
          })
          if (typeof off === 'function') mounted.set(sid, off)
        } catch {}
      }
    } catch {}
  }
  tick()
  // 没有 agents 服务的宿主（比如评测器的 mock ctx）里，上面那条按 agent 注入的路径永远走不到。
  // 这时退回「注册一个全局 systemPrompt 段」——真宿主有 agents，所以不会重复注入。
  try {
    const hasAgents = !!(ctx && ctx.agents && typeof ctx.agents.list === 'function')
    const sp = ctx && ctx.systemPrompt
    if (!hasAgents && sp && typeof sp.section === 'function') {
      sp.section({
        name: 'memory-system',
        order: 89990,
        text: () => {
          try { return core.injectFor('') } catch { return '' }
        },
      })
      console.warn('[dsh-memory-system] 没有 agents 服务，改用全局 systemPrompt 段注入')
    }
  } catch {}
  try {
    if (typeof ctx.interval === 'function') ctx.effect(() => ctx.interval(tick, 3000))
  } catch {}
  try {
    ctx.effect(() => () => {
      for (const off of mounted.values()) {
        try { if (typeof off === 'function') off() } catch {}
      }
      mounted.clear()
    })
  } catch {}
}
