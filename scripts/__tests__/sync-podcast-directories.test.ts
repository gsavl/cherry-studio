import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appendPodcastDirectories, getNewPodcastDirectories, syncPodcastDirectories } from '../sync-podcast-directories'

describe('sync-podcast-directories', () => {
  it('identifies only podcast paths that are absent from the config', () => {
    const existing = ['Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\已有节目']
    const discovered = [
      'z:\\007 podcasts\\_cherry_knowledge_inputs\\preferred\\general\\已有节目',
      'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\酸菜馆播客',
      'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\酸菜馆播客\\'
    ]

    expect(getNewPodcastDirectories(existing, discovered)).toEqual([
      'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\酸菜馆播客'
    ])
  })

  it('appends directories to the podcast list without changing other knowledge bases', () => {
    const config = [
      '播客:',
      "  - 'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\已有节目'",
      '得到课程:',
      "  - 'Z:\\008 dedao\\课程'",
      ''
    ].join('\n')

    expect(
      appendPodcastDirectories(config, ['Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\酸菜馆播客'])
    ).toBe(
      [
        '播客:',
        "  - 'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\已有节目'",
        "  - 'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general\\酸菜馆播客'",
        '得到课程:',
        "  - 'Z:\\008 dedao\\课程'",
        ''
      ].join('\n')
    )
  })

  it('discovers and persists a new podcast directory', async () => {
    const tempDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sync-podcast-directories-'))
    const sourceDirectory = path.join(tempDirectory, 'podcasts')
    const configPath = path.join(tempDirectory, 'kb-dirs.yaml')
    const existingDirectory = path.join(sourceDirectory, '已有节目')
    const newDirectory = path.join(sourceDirectory, '酸菜馆播客')

    try {
      await fs.promises.mkdir(existingDirectory, { recursive: true })
      await fs.promises.mkdir(newDirectory)
      await fs.promises.writeFile(
        configPath,
        ['播客:', `  - '${existingDirectory}'`, '得到课程:', "  - 'Z:\\008 dedao\\课程'", ''].join('\n'),
        'utf8'
      )

      await expect(
        syncPodcastDirectories({ config: configPath, source: sourceDirectory, dryRun: false })
      ).resolves.toEqual({ added: [newDirectory], discovered: 2 })

      await expect(fs.promises.readFile(configPath, 'utf8')).resolves.toContain(`  - '${newDirectory}'`)
    } finally {
      await fs.promises.rm(tempDirectory, { recursive: true, force: true })
    }
  })
})
