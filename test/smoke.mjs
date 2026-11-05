import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeCore } from '../lib/core.js'

const root = join(process.cwd(), 'tmp', 'smoke-' + Date.now())
rmSync(root, { recursive: true, force: true })
mkdirSync(root, { recursive: true })
const pluginRoot = process.cwd()
const core = makeCore({ root, pluginRoot })

const init = core.init()
assert.ok(init.created.length >= 10, 'init should create template files')

const unitsPath = join(root, '数据', '记忆单元.json')
const units = JSON.parse(readFileSync(unitsPath, 'utf8'))
units.push({ id: 'case:vault-smoke', title: '私密仓不应自动注入', created: Date.now(), importance: 3, zone: 'vault' })
units.push({ id: 'case:relation-smoke', title: '关系区可以被注入', created: Date.now(), importance: 3, zone: 'relation' })
writeFileSync(unitsPath, JSON.stringify(units, null, 1), 'utf8')

const injected = core.injectFor('关系区')
assert.ok(injected.includes('case:relation-smoke'), 'relation unit should be injected')
assert.ok(!injected.includes('case:vault-smoke'), 'vault unit must not be injected')
assert.ok(injected.length <= 700 + 200, 'injection should stay within budget')

const task = core.recall('示例', { zone: 'task' })
assert.ok(task.includes('单元 1 个'), 'task zone should match the example')
const vault = core.recall('vault-smoke', { zone: 'vault' })
assert.ok(vault.includes('单元 1 个'), 'vault zone should be queryable explicitly')

const archive = core.archive({ apply: false })
assert.ok(archive.includes('候选'), 'archive dry-run should return candidates count')

rmSync(root, { recursive: true, force: true })
console.log('SMOKE PASS: init / zones / injection / recall / archive')
