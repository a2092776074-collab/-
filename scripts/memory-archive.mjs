// memory-archive.mjs · 冷归档：把「冻结且长期没复查」的单元移出活跃清单，保留原文和索引
//
// 用法：
//   node scripts/memory-archive.mjs                 # 只看会归档谁（dry-run）
//   node scripts/memory-archive.mjs --apply         # 真归档
//   node scripts/memory-archive.mjs --min-days 30   # 冻结至少 30 天（默认 30）
//   node scripts/memory-archive.mjs --self-test     # 用临时数据自测，不碰真数据
//
// 原则：只归档 L1 单元；core / open 永不归档；原文 .md 不删，只移出活跃清单。

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMemoryDecay } from './memory-decay.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DAY = 86_400_000
const arg = (n, d) => {
  const i = process.argv.indexOf(n)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d
}
const has = (n) => process.argv.includes(n)

function readJson(p, fallback) {
  if (!existsSync(p)) return fallback
  return JSON.parse(readFileSync(p, 'utf8')) // 文件在但坏了就抛，不静默当空
}
function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8')
  renameSync(tmp, p)
}

function run({ manifestPath, statePath, archiveDir, minDays = 30, apply = false, now = Date.now() }) {
  const units = readJson(manifestPath, [])
  const state = readJson(statePath, { units: {} })
  if (!state.units) state.units = {}
  const decay = createMemoryDecay({ statePath, now: () => now })

  const move = []
  const keep = []
  for (const u of units) {
    const v = decay.view(u.id, {
      created: u.created, importance: u.importance, core: u.core, open: u.open,
    })
    const st = state.units[u.id]
    const last = Number(st?.last)
    const ageDays = last ? (now - last) / DAY : 0
    // 必须真有复习过（reps>=1）且距上次复习够久；从未 review 的单元不归档
    const zone = u.zone || 'task'
    const eligible = v.frozen && !u.core && !u.open && zone !== 'identity' && zone !== 'vault'
      && !!st && (st.reps || 0) >= 1 && ageDays >= minDays
    if (eligible) move.push({ unit: u, view: v, ageDays })
    else keep.push(u)
  }

  if (!apply || move.length === 0) return { move, keep, applied: false }

  const year = new Date(now).getFullYear()
  const outDir = join(archiveDir, String(year))
  mkdirSync(outDir, { recursive: true })
  const arcUnitsPath = join(outDir, '记忆单元.json')
  const arcStatePath = join(outDir, 'memory-decay.json')
  const arcUnits = readJson(arcUnitsPath, [])
  const arcState = readJson(arcStatePath, { units: {} })
  if (!arcState.units) arcState.units = {}

  for (const { unit, view, ageDays } of move) {
    const rec = {
      ...unit,
      archivedAt: new Date(now).toISOString(),
      archiveReason: `冻结 ${ageDays.toFixed(0)} 天未复查（R=${view.R}）`,
    }
    const at = arcUnits.findIndex(x => x.id === unit.id)
    if (at >= 0) arcUnits[at] = rec
    else arcUnits.push(rec)
    if (state.units[unit.id]) {
      arcState.units[unit.id] = state.units[unit.id]
      delete state.units[unit.id]
    }
  }
  writeJson(arcUnitsPath, arcUnits)
  writeJson(arcStatePath, arcState)
  writeJson(manifestPath, keep)
  writeJson(statePath, state)

  const index = join(outDir, '索引.md')
  const lines = ['']
  for (const { unit, view, ageDays } of move) {
    lines.push(`- ${unit.id} — ${unit.title || ''}（冻结 ${ageDays.toFixed(0)} 天，R=${view.R}；原文未删）`)
  }
  if (!existsSync(index)) {
    writeFileSync(index, '# 冷归档索引\n\n> 归档不等于删除：原文 .md 还在，索引在这里；要恢复就把它移回 `数据/记忆单元.json`。\n', 'utf8')
  }
  writeFileSync(index, readFileSync(index, 'utf8') + '\n' + lines.join('\n') + '\n', 'utf8')
  return { move, keep, applied: true }
}

// 恢复：清单 + decay 状态一起搬回（只移清单会被旧 R 立刻冻回去）
function restore({ manifestPath, statePath, archiveDir, id }) {
  if (!existsSync(archiveDir)) return false
  const years = readdirSync(archiveDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)
  for (const year of years) {
    const unitsPath = join(archiveDir, year, '记忆单元.json')
    const stateArcPath = join(archiveDir, year, 'memory-decay.json')
    if (!existsSync(unitsPath)) continue
    const units = readJson(unitsPath, [])
    const at = units.findIndex(x => x.id === id)
    if (at < 0) continue
    const [unit] = units.splice(at, 1)
    writeJson(unitsPath, units)

    const state = readJson(statePath, { units: {} })
    if (!state.units) state.units = {}
    const arcState = readJson(stateArcPath, { units: {} })
    if (arcState.units && arcState.units[id]) {
      state.units[id] = arcState.units[id]
      delete arcState.units[id]
      writeJson(stateArcPath, arcState)
      writeJson(statePath, state)
    }

    const manifest = readJson(manifestPath, [])
    if (!manifest.some(x => x.id === id)) manifest.push(unit)
    writeJson(manifestPath, manifest)

    const index = join(archiveDir, year, '索引.md')
    if (existsSync(index)) {
      writeFileSync(index, readFileSync(index, 'utf8') + `\n- 恢复 ${id}（状态已并回；记得 review 一次解冻）\n`, 'utf8')
    }
    return true
  }
  return false
}

function selfTest() {
  const base = join(ROOT, '数据', '.archive-test')
  try { rmSync(base, { recursive: true, force: true }) } catch {}
  mkdirSync(base, { recursive: true })
  const manifestPath = join(base, '记忆单元.json')
  const statePath = join(base, 'memory-decay.json')
  const now = Date.now()
  const old = now - 100 * DAY
  writeJson(manifestPath, [
    { id: 'case:test-frozen', title: '冻结测试', created: old, importance: 2 },
    { id: 'case:test-core', title: '核心测试', created: old, importance: 4, core: true },
    { id: 'case:test-open', title: '未了测试', created: old, importance: 3, open: true },
    { id: 'case:test-fresh', title: '新鲜测试', created: now - 1 * DAY, importance: 2 },
  ])
  writeJson(statePath, {
    units: {
      'case:test-frozen': { S: 1, D: 5, last: old, reps: 1 },
      'case:test-core': { S: 1, D: 5, last: old, reps: 1 },
      'case:test-open': { S: 1, D: 5, last: old, reps: 1 },
    },
  })
  const r = run({ manifestPath, statePath, archiveDir: join(base, 'archive'), minDays: 30, apply: true, now })
  const left = readJson(manifestPath, [])
  const arc = readJson(join(base, 'archive', String(new Date(now).getFullYear()), '记忆单元.json'), [])
  const ok = r.move.length === 1 && r.move[0].unit.id === 'case:test-frozen'
    && left.length === 3 && arc.length === 1
    && left.some(x => x.id === 'case:test-core') && left.some(x => x.id === 'case:test-open')

  const year = String(new Date(now).getFullYear())
  const restored = restore({ manifestPath, statePath, archiveDir: join(base, 'archive'), id: 'case:test-frozen' })
  const left2 = readJson(manifestPath, [])
  const st2 = readJson(statePath, { units: {} })
  const arcState2 = readJson(join(base, 'archive', year, 'memory-decay.json'), { units: {} })
  const ok2 = restored && left2.some(x => x.id === 'case:test-frozen')
    && st2.units['case:test-frozen']?.S === 1 && st2.units['case:test-frozen']?.reps === 1
    && !arcState2.units['case:test-frozen']
  rmSync(base, { recursive: true, force: true })
  console.log(ok && ok2 ? 'SELF-TEST PASS：只归档冻结且超期的非核心；恢复时状态一起回来' : 'SELF-TEST FAIL：' + JSON.stringify({ move: r.move.map(x => x.unit.id), left: left.map(x => x.id), arc: arc.map(x => x.id), restored, restoredS: st2.units['case:test-frozen']?.S }))
  if (!(ok && ok2)) process.exit(1)
}

if (has('--self-test')) {
  selfTest()
} else if (arg('--restore', null)) {
  const id = arg('--restore', null)
  const ok = restore({
    manifestPath: join(ROOT, '数据', '记忆单元.json'),
    statePath: join(ROOT, '数据', 'memory-decay.json'),
    archiveDir: join(ROOT, '数据', 'archive'),
    id,
  })
  console.log(ok ? `已恢复 ${id}（状态已并回；记得 review 一次解冻）` : `归档里没找到 ${id}`)
  if (!ok) process.exit(1)
} else {
  const apply = has('--apply')
  const minDays = Number(arg('--min-days', 30)) || 30
  const r = run({
    manifestPath: join(ROOT, '数据', '记忆单元.json'),
    statePath: join(ROOT, '数据', 'memory-decay.json'),
    archiveDir: join(ROOT, '数据', 'archive'),
    minDays,
    apply,
  })
  console.log(`候选 ${r.move.length} 个（冻结 ≥${minDays} 天、非 core/open）`)
  for (const x of r.move) console.log(`  ${x.unit.id} — ${x.unit.title || ''}（R=${x.view.R}，${x.ageDays.toFixed(0)} 天）`)
  if (!apply) console.log('DRY RUN：没动文件；确认后加 --apply')
  else console.log(`已归档 ${r.move.length} 个 → 数据/archive/${new Date().getFullYear()}/`)
}
