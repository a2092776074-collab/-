// 测账本注入：聚合意图 vs 普通提问
import { makeCore } from '../lib/core.js'

const core = makeCore({ root: process.cwd() })

const cases = [
  ['普通', '今天天气怎么样'],
  ['聚合-欠', 'B站那边我还欠谁哪些没回'],
  ['聚合-还剩', '记忆体系还剩哪些没做完'],
]

for (const [name, q] of cases) {
  const out = core.injectFor(q)
  console.log(`\n=== ${name}：${q} ===`)
  console.log(out.slice(0, 420))
  console.log(`   [长度 ${out.length}]`)
}
