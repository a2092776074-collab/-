// episode-add.mjs · 把一次能力的产出记成情节（episode），再接进脑图
// 用法：
//   node scripts/episode-add.mjs --kind vision --title "..." --source "..." --detail "..." [--confidence mid] [--failed]
// kind: vision | hearing | action | text

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const has = (n) => process.argv.includes(n)

const kind = arg('--kind', 'vision')
const title = arg('--title', '')
const source = arg('--source', '')
const detail = arg('--detail', '')
const confidence = arg('--confidence', 'mid')
const failed = has('--failed')
if (!['vision', 'hearing', 'action', 'text'].includes(kind)) {
  console.log('kind 只能是 vision / hearing / action / text')
  process.exit(2)
}
if (!title) {
  console.log('至少给 --title')
  process.exit(2)
}

const now = new Date()
const compact = now.toISOString().replace(/[-:T]/g, '').slice(0, 14)
const id = `episode:${kind}-${compact}`

const unitsPath = join(ROOT, '数据', '记忆单元.json')
const units = existsSync(unitsPath) ? JSON.parse(readFileSync(unitsPath, 'utf8')) : []
units.push({ id, title, created: now.getTime(), importance: 2, source, confidence, failed })
writeFileSync(unitsPath, JSON.stringify(units, null, 1), 'utf8')

const dir = join(ROOT, '数据', 'episodes')
mkdirSync(dir, { recursive: true })
const md = `# ${title}

- id：${id}
- 来源：${source || '（未写）'}
- 能力：${kind}
- 置信度：${confidence}${failed ? '\n- **失败**：这次没拿到可靠结果' : ''}
- 时间：${now.toLocaleString('zh-CN')}

${detail || '（没有写细节）'}
`
writeFileSync(join(dir, id.replace(':', '-') + '.md'), md, 'utf8')

console.log(`已记情节：${id}`)
console.log(`细节：数据/episodes/${id.replace(':', '-')}.md`)
