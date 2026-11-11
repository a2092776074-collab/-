// 相对时间换算原型（2026-11-09）
// 规则：锚点 = 说这句话的时间（saidTime），不是"现在"
// 返回 { date: 'YYYY-MM-DD', rule: '...', confident: bool, note?: string }
// 约定：周一为一周第一天（中文习惯），周日=7

const WEEK = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }
const pad = (n) => String(n).padStart(2, '0')
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const addDays = (d, n) => {
  const x = new Date(d.getTime())
  x.setDate(x.getDate() + n)
  return x
}
// 本周周一（周一=0 偏移）
function mondayOf(d) {
  const wd = d.getDay() === 0 ? 7 : d.getDay()
  return addDays(d, -(wd - 1))
}

function resolveRelative(text, saidISO) {
  const said = new Date(saidISO)
  if (Number.isNaN(said.getTime())) return null
  const t = String(text || '')

  // 1) 日级相对词
  const dayMap = [
    ['大前天', -3],
    ['前天', -2],
    ['昨天', -1],
    ['昨日', -1],
    ['今天', 0],
    ['今日', 0],
    ['当天', 0],
    ['明天', 1],
    ['明日', 1],
    ['后天', 2],
    ['大后天', 3],
  ]
  for (const [w, off] of dayMap) {
    if (t.includes(w)) return { date: fmt(addDays(said, off)), rule: w, offset: off, confident: true }
  }

  // 2) N 天/日 前/后（支持阿拉伯数字和中文数字）
  const CN = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
  const cnNum = (s) => {
    if (/^\d+$/.test(s)) return Number(s)
    if (s === '十') return 10
    if (s.startsWith('十')) return 10 + (CN[s[1]] || 0)
    if (s.includes('十')) {
      const [a, b] = s.split('十')
      return (CN[a] || 0) * 10 + (b ? CN[b] || 0 : 0)
    }
    return CN[s] || null
  }
  const m1 = t.match(/(\d+|[一二两三四五六七八九十]+)\s*(天|日)\s*(前|后)/)
  if (m1) {
    const n0 = cnNum(m1[1])
    if (n0 != null) {
      const n = n0 * (m1[3] === '前' ? -1 : 1)
      return { date: fmt(addDays(said, n)), rule: `${m1[1]}${m1[2]}${m1[3]}`, offset: n, confident: true }
    }
  }

  // 3) 周几：上周/这周(本)/下周 + 周X
  const m2 = t.match(/(上个?周|这个?周|本个?周|下个?周|上个?星期|这个?星期|下个?星期)\s*([一二三四五六日天])/)
  if (m2) {
    const wk = m2[1].startsWith('上') ? -1 : m2[1].startsWith('下') ? 1 : 0
    const target = mondayOf(said)
    const d = addDays(target, wk * 7 + (WEEK[m2[2]] - 1))
    return { date: fmt(d), rule: m2[1] + m2[2], weekOffset: wk, confident: true }
  }

  // 3b) 裸周几（「周一」「星期三」）：取"最近的那一次"（可能在本周也可能在下周）
  // 例：周四说"周一"→ 本周一（过去3天）；周日说"周一"→ 明天（下周）
  if (!/(上周|下周|这周|本周|上星期|下星期|上个|下个|这个|本个)/.test(t)) {
    const m3b = t.match(/(?:周|星期)([一二三四五六日天])/)
    if (m3b) {
      const targetWd = WEEK[m3b[1]]
      const thisWeek = addDays(mondayOf(said), targetWd - 1)
      const nextWeek = addDays(thisWeek, 7)
      const d0 = Math.abs(thisWeek.getTime() - said.getTime())
      const d1 = Math.abs(nextWeek.getTime() - said.getTime())
      const pick = d1 < d0 ? nextWeek : thisWeek
      const tie = d0 === d1
      return {
        date: fmt(pick),
        rule: '周' + m3b[1],
        confident: !tie,
        note: tie ? '正好处在两周中间，可能指下周' : undefined,
      }
    }
  }

  // 4) 半个月前/后
  if (t.includes('半个月前')) return { date: fmt(addDays(said, -15)), rule: '半个月前', offset: -15, confident: true }
  if (t.includes('半个月后')) return { date: fmt(addDays(said, 15)), rule: '半个月后', offset: 15, confident: true }

  // 5) 上个月/下个月（同一天，越界取月末）
  const m3 = t.match(/(上个?月|下个?月)/)
  if (m3) {
    const off = m3[1].startsWith('上') ? -1 : 1
    const y = said.getFullYear()
    const mo = said.getMonth() + off
    const lastDay = new Date(y, mo + 1, 0).getDate()
    const d = new Date(y, mo, Math.min(said.getDate(), lastDay))
    return { date: fmt(d), rule: m3[1], monthOffset: off, confident: true }
  }

  // 6) 绝对日期：2026年5月25日 / 5月25日 / 5/25
  const m4 = t.match(/(?:(\d{4})\s*年)?\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*[日号]?/)
  if (m4) {
    const y = m4[1] ? Number(m4[1]) : said.getFullYear()
    const d = new Date(y, Number(m4[2]) - 1, Number(m4[3]))
    let note = ''
    let confident = true
    if (!m4[1]) {
      // 没写年份：如果比说话时间晚 30 天以上，按去年算
      if (d.getTime() - said.getTime() > 30 * 86400000) {
        d.setFullYear(y - 1)
        note = '未写年份，按去年'
        confident = false
      }
    }
    return { date: fmt(d), rule: m4[0].trim(), confident, note }
  }

  return null
}

export { resolveRelative, mondayOf }

// ── 自测 ──
if (process.argv[1] && process.argv[1].endsWith('timeanchor.mjs')) {
  const cases = [
    ['2026-05-27T21:11:00+08:00', '前天我把迷迭香搬到窗边', '2026-05-25'],
    ['2026-06-22T18:39:00+08:00', '下周三之前寄出', '2026-07-01'],
    ['2026-06-22T18:39:00+08:00', '这周三之前寄出', '2026-06-24'],
    ['2026-06-22T18:39:00+08:00', '上周三寄的', '2026-06-17'],
    ['2026-05-13T21:35:00+08:00', '5月10号戒到那天', '2026-05-10'],
    ['2026-01-31T10:00:00+08:00', '后天出发', '2026-02-02'],
    ['2028-02-28T10:00:00+08:00', '后天出发', '2028-03-01'],
    ['2026-03-31T10:00:00+08:00', '上个月签的', '2026-02-28'],
    ['2026-05-13T21:35:00+08:00', '半个月前开始戒', '2026-04-28'],
    ['2026-06-11T21:10:00+08:00', '三天前搬的', '2026-06-08'],
    ['2026-01-05T10:00:00+08:00', '12月31日交的', '2025-12-31'],
    ['2026-11-09T17:00:00+08:00', '今天下午', '2026-11-09'],
  ]
  let ok = 0
  for (const [said, text, want] of cases) {
    const r = resolveRelative(text, said)
    const got = r ? r.date : '(null)'
    const pass = got === want
    if (pass) ok++
    console.log(`${pass ? '✅' : '❌'} ${said.slice(0, 10)} 「${text}」 → ${got}${pass ? '' : '  (期望 ' + want + ')'} [${r?.rule || '-'}]`)
  }
  console.log(`\n${ok}/${cases.length} 通过`)
}
