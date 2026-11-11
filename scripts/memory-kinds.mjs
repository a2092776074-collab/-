// 记忆单元的 kind / zone 白名单 —— 单一真相源（2026-11-11）
// 背景：这份名单原来在 memory-decay.mjs 和 unit-add.mjs 各有一份，
// 每加一种 kind 就崩一次（session: → conv: → reference:）。
// 从现在起，只改这里。
export const KINDS = [
  'case', 'diary', 'knowledge', 'ledger', 'anchor', 'episode',
  'session', 'conv', 'task', 'goal', 'reference', 'identity', 'vault',
]

export const ZONES = ['identity', 'relation', 'task', 'reference', 'vault']

export const validId = (id) =>
  typeof id === 'string' && id.length <= 200 && KINDS.some((k) => id.startsWith(k + ':'))

export const kindOf = (id) => (typeof id === 'string' ? id.split(':')[0] : '')
