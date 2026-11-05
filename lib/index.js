// DSH plugin entry: tools + optional auto-injection of relevant memory.
import { makeCore, lastUserText } from './core.js'
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

export function apply(ctx) {
  const core = makeCore()

  // ---- tools ----
  if (defineTool && ctx?.tools && typeof ctx.tools.register === 'function') {
    const tools = [
      defineTool({
        name: 'memory_init',
        description:
          '在工作区初始化文件式记忆体系：复制六件套模板、判据库、数据文件和脚本。已存在的文件不覆盖。先跑一次这个，再用其他 memory_* 工具。',
        parameters: {},
        execute: wrap(() => {
          const r = core.init()
          return `初始化完成：新建 ${r.created.length} 个，跳过 ${r.skipped.length} 个（已存在）`
        }),
      }),
      defineTool({
        name: 'memory_status',
        description:
          '查看记忆单元状态：总数、冻结数、每个单元的 R/S、距冻结天数。用于判断哪些该复习、哪些该归档。',
        parameters: {},
        execute: wrap(() => core.status()),
      }),
      defineTool({
        name: 'memory_recall',
        description:
          '按关键词从记忆单元和 .md 原文里找相关记忆。默认不列冻结单元；只读，不改状态。zone 可过滤 relation/task/reference/identity/vault。',
        parameters: {
          keyword: { type: 'string', required: true, description: '关键词（中文/英文都行）' },
          include_frozen: { type: 'boolean', description: '是否也列出已冻结的单元（默认 false）' },
          limit: { type: 'number', description: '最多几条原文命中（1-50，默认 20）' },
          zone: { type: 'string', description: '只查某个分区：relation / task / reference / identity / vault（可选）' },
        },
        execute: wrap((a) => core.recall(a.keyword, { includeFrozen: !!a.include_frozen, limit: a.limit, zone: a.zone })),
      }),
      defineTool({
        name: 'memory_review',
        description:
          '复习一个记忆单元，更新 FSRS-5 牢固度。1=又忘了 / 2=费劲 / 3=顺利 / 4=太简单。用到才复习。',
        parameters: {
          id: { type: 'string', required: true, description: '单元 id，如 case:first-lesson' },
          rating: { type: 'number', required: true, description: '1-4' },
        },
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
        execute: wrap((a) => core.archive({ apply: !!a.apply, minDays: a.min_days })),
      }),
    ]
    for (const t of tools) ctx.tools.register(t)
  } else {
    console.warn('[dsh-memory-system] tools service unavailable; tools not registered')
  }

  // ---- auto-injection:每 3 秒检查活着的 agent，挂一段随当前消息变化的记忆上下文 ----
  const mounted = new Map()
  function tick() {
    try {
      if (!ctx.agents || typeof ctx.agents.list !== 'function') return
      for (const agent of ctx.agents.list() || []) {
        const sid = sessionIdOf(agent)
        if (!sid || mounted.has(sid)) continue
        try {
          const sp = agent.ctx && agent.ctx.systemPrompt
          if (!sp || typeof sp.context !== 'function') continue
          const off = sp.context({
            name: 'memory-system',
            order: 900,
            text: () => {
              try { return core.injectFor(lastUserText(agent)) } catch { return '' }
            },
          })
          if (typeof off === 'function') mounted.set(sid, off)
        } catch {}
      }
    } catch {}
  }
  tick()
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
