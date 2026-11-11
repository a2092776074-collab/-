// 模拟一条真实用户消息（真话 + 宿主运行时上下文 + 我们自己的注入块），看清洗后剩什么
import { cleanUserText, stripInjectedLines } from '../lib/core.js'

const raw = [
  'B站那边我还欠谁哪些没回',
  '',
  'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.',
  'Current working directory: "C:\\x"',
  'Current DSH file policy: danger-full-access.',
  'You are the Team Lead named "lead".',
  '【现在】2026-11-08 08:13（周日）',
  '【记忆】下面几条可能和当前对话有关；需要细节用 memory_recall，不要当成全部事实。',
  '- [relation] 老大（认识的人）（ledger:laoda） · 18天前',
  '- [task] 记忆就是灵魂，会话就是肉体（anchor:memory-is-soul） · 4天前',
].join('\n')

console.log('原始长度:', raw.length)
console.log('清洗后 →', JSON.stringify(cleanUserText(stripInjectedLines(raw))))
