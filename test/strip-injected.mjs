// 验证 stripInjectedLines
import { stripInjectedLines } from '../lib/core.js'

const raw = [
  'Elapsed since the preceding model-visible message: 3m',
  '[SCHEDULE REMINDER BATCH]',
  'This is a scheduled message from the user',
  'reminders_json: [{"a":1}]',
  '',
  '今天做的六轮测试怎么样',
].join('\n')

const out = stripInjectedLines(raw)
console.log('剥完 →', JSON.stringify(out))

const raw2 = 'Time sampled while preparing turn 1, step 1: 2026-11-07T00:00:00+08:00\nBrowser time zone for this request: Asia/Shanghai'
console.log('纯注入 →', JSON.stringify(stripInjectedLines(raw2)))
