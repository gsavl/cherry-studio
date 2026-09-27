import { compareFilesByPublishedAt, extractPublishedAt } from '../knowledge-browser-sort'

describe('knowledge browser file sorting', () => {
  test('extracts the publication date from podcast file names', () => {
    expect(extractPublishedAt('172_2026-07-28_175.节目标题.md')).toBe('2026-07-28')
    expect(extractPublishedAt('course-lesson.md')).toBeUndefined()
  })

  test('sorts dated files by publication date in descending order', () => {
    const files = [
      { name: '001_2022-01-11_vol.0.md', mtimeMs: 300 },
      { name: '172_2026-07-28_175.md', mtimeMs: 100 },
      { name: '171_2026-07-21_174.md', mtimeMs: 200 }
    ]

    expect([...files].sort(compareFilesByPublishedAt).map((file) => file.name)).toEqual([
      '172_2026-07-28_175.md',
      '171_2026-07-21_174.md',
      '001_2022-01-11_vol.0.md'
    ])
  })

  test('uses modification time only when publication dates are unavailable', () => {
    const files = [
      { name: 'older.md', mtimeMs: 100 },
      { name: 'newer.md', mtimeMs: 200 }
    ]

    expect([...files].sort(compareFilesByPublishedAt).map((file) => file.name)).toEqual(['newer.md', 'older.md'])
  })
})
