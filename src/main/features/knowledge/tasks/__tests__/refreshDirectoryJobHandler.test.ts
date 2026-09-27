import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { KnowledgeItemOf } from '@shared/data/types/knowledge'

import { classifyDirectoryEntries, compareDirectoryFile } from '../refreshDirectoryJobHandler'

const temporaryDirectories: string[] = []

async function createPair(source: string, stored: string): Promise<{ sourcePath: string; storedPath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cherry-incremental-refresh-'))
  temporaryDirectories.push(directory)
  const sourcePath = path.join(directory, 'source.md')
  const storedPath = path.join(directory, 'stored.md')
  await Promise.all([fs.writeFile(sourcePath, source), fs.writeFile(storedPath, stored)])
  return { sourcePath, storedPath }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))
  )
})

describe('incremental directory file comparison', () => {
  it('bootstraps a fingerprint without reindexing when the source still matches the stored raw file', async () => {
    const { sourcePath, storedPath } = await createPair('unchanged', 'unchanged')

    const result = await compareDirectoryFile(sourcePath, storedPath, undefined, new AbortController().signal)

    expect(result.changed).toBe(false)
    expect(result.fingerprintChanged).toBe(true)
    expect(result.fingerprint.size).toBe(Buffer.byteLength('unchanged'))
  })

  it('classifies removed children as stale and leaves newly scanned files unbound', () => {
    const root = 'C:\\knowledge'
    const existing = [
      createFileItem('keep', path.join(root, 'keep.md')),
      createFileItem('remove', path.join(root, 'remove.md')),
      createDirectoryItem('removed-folder', path.join(root, 'removed'))
    ]
    const scanned = [
      { externalPath: path.join(root, 'keep.md'), relativePath: 'keep.md' },
      { externalPath: path.join(root, 'new.md'), relativePath: 'new.md' }
    ]

    const result = classifyDirectoryEntries(existing, root, scanned)

    expect(result.staleItems.map((item) => item.id)).toEqual(['remove', 'removed-folder'])
    expect(result.filesBySource.get(path.normalize(path.join(root, 'keep.md')).toLowerCase())?.id).toBe('keep')
    expect(result.filesBySource.get(path.normalize(path.join(root, 'new.md')).toLowerCase())).toBeUndefined()
  })

  it('detects a same-size content modification after the source mtime changes', async () => {
    const { sourcePath, storedPath } = await createPair('before', 'before')
    const initial = await compareDirectoryFile(sourcePath, storedPath, undefined, new AbortController().signal)
    await fs.writeFile(sourcePath, 'after!')
    const future = new Date(Date.now() + 5000)
    await fs.utimes(sourcePath, future, future)

    const result = await compareDirectoryFile(sourcePath, storedPath, initial.fingerprint, new AbortController().signal)

    expect(result.changed).toBe(true)
    expect(result.fingerprint.contentHash).not.toBe(initial.fingerprint.contentHash)
  })

  it('uses the persisted size and mtime fast path for unchanged files', async () => {
    const { sourcePath, storedPath } = await createPair('unchanged', 'unchanged')
    const initial = await compareDirectoryFile(sourcePath, storedPath, undefined, new AbortController().signal)

    const result = await compareDirectoryFile(sourcePath, storedPath, initial.fingerprint, new AbortController().signal)

    expect(result).toEqual({
      fingerprint: initial.fingerprint,
      changed: false,
      fingerprintChanged: false
    })
  })
})

function createFileItem(id: string, source: string): KnowledgeItemOf<'file'> {
  return {
    id,
    baseId: 'base',
    groupId: 'root',
    type: 'file',
    data: { source, relativePath: `${id}.md` as KnowledgeItemOf<'file'>['data']['relativePath'] },
    status: 'completed',
    error: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  }
}

function createDirectoryItem(id: string, source: string): KnowledgeItemOf<'directory'> {
  return {
    id,
    baseId: 'base',
    groupId: 'root',
    type: 'directory',
    data: { source },
    status: 'completed',
    error: null,
    createdAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:00:00.000Z'
  }
}
