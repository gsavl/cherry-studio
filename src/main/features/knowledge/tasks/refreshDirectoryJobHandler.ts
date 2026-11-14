import './jobTypes'

import path from 'node:path'

import { knowledgeBaseService } from '@data/services/KnowledgeBaseService'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'
import { loggerService } from '@logger'
import type { JobHandler } from '@main/core/job/types'
import { hashWithSize, remove, stat } from '@main/utils/file'
import type { FileItemData, KnowledgeItem, KnowledgeItemOf } from '@shared/data/types/knowledge'
import { AbsoluteFilePathSchema } from '@shared/types/file'
import type { KeyedMutex } from '@shared/utils/async'

import type { KnowledgeItemScheduler } from '../ingestion/KnowledgeIngestionService'
import { markUnscheduledKnowledgeItemsFailed } from '../ingestion/statusCleanup'
import { purgeKnowledgeSubtreeWithinLock } from '../ingestion/subtreePurge'
import { assertSafeKnowledgeRelativePath, copyFileIntoKnowledgeBaseAt, getKnowledgeBaseFilePath } from '../pathStorage'
import { scanDirectoryFiles, type ScannedDirectoryFile } from '../pipeline/sources/directory'
import { deleteKnowledgeItemVectors } from '../pipeline/vectorstore/vectorCleanup'
import { knowledgeQueueName, reportKnowledgeProgress, toKnowledgeBaseId, toKnowledgeItemId } from '../types'
import type { KnowledgeRefreshDirectoryPayload } from './jobTypes'

const logger = loggerService.withContext('Knowledge:RefreshDirectoryJobHandler')
const EMPTY_DIRECTORY_ERROR = 'Directory contains no indexable files'

type SourceFingerprint = NonNullable<FileItemData['sourceFingerprint']>

type RefreshCandidate = {
  file: ScannedDirectoryFile
  existing?: KnowledgeItemOf<'file'>
  fingerprint: SourceFingerprint
  changed: boolean
  fingerprintChanged: boolean
}

export function createRefreshDirectoryJobHandler(
  knowledgeLockManager: KeyedMutex,
  ingestionService: KnowledgeItemScheduler
): JobHandler<KnowledgeRefreshDirectoryPayload> {
  return {
    recovery: 'abandon',
    defaultQueue: (input) => knowledgeQueueName(toKnowledgeBaseId(input.baseId)),
    defaultConcurrency: 1,
    defaultRetryPolicy: {
      maxAttempts: 3,
      backoff: 'exponential',
      baseDelayMs: 2000,
      maxDelayMs: 60_000
    },
    defaultTimeoutMs: 30 * 60 * 1000,

    async execute(ctx) {
      const { baseId, itemId } = ctx.input
      ctx.signal.throwIfAborted()
      const root = requireDirectoryItem(baseId, itemId)

      reportKnowledgeProgress(ctx, 0, { stage: 'scanning' })
      const scannedFiles = await scanDirectoryFiles(root.data.source, ctx.signal)
      const itemsToSchedule = await knowledgeLockManager.runExclusive(baseId, async () => {
        ctx.signal.throwIfAborted()
        const liveRoot = requireDirectoryItem(baseId, itemId)
        const base = knowledgeBaseService.getById(baseId)
        const descendants = knowledgeItemService.getSubtreeItems(baseId, [itemId])
        const rootPrefix = resolveDirectoryPrefix(liveRoot, descendants)
        const { staleItems, filesBySource } = classifyDirectoryEntries(descendants, liveRoot.data.source, scannedFiles)

        if (staleItems.length > 0) {
          await purgeKnowledgeSubtreeWithinLock(base, staleItems, { baseId, itemId, jobId: ctx.jobId })
        }

        const staleIds = new Set(staleItems.map((item) => item.id))
        const remaining = descendants.filter((item) => !staleIds.has(item.id))
        const directoriesBySource = new Map<string, KnowledgeItemOf<'directory'>>([
          [normalizeLocalPath(liveRoot.data.source), liveRoot],
          ...remaining
            .filter((item): item is KnowledgeItemOf<'directory'> => item.type === 'directory')
            .map((item) => [normalizeLocalPath(item.data.source), item] as const)
        ])

        const candidates: RefreshCandidate[] = []
        for (const [index, file] of scannedFiles.entries()) {
          ctx.signal.throwIfAborted()
          const existing = filesBySource.get(normalizeLocalPath(file.externalPath))
          const comparison = await compareDirectoryFile(
            file.externalPath,
            existing ? getKnowledgeBaseFilePath(baseId, existing.data.relativePath) : undefined,
            existing?.data.sourceFingerprint,
            ctx.signal
          )
          candidates.push({ file, existing, ...comparison })
          reportKnowledgeProgress(ctx, Math.round(((index + 1) / Math.max(scannedFiles.length, 1)) * 45), {
            stage: 'scanning'
          })
        }

        const scheduledItems: KnowledgeItem[] = []
        const createdDirectories: KnowledgeItemOf<'directory'>[] = []
        for (const [index, candidate] of candidates.entries()) {
          ctx.signal.throwIfAborted()
          if (candidate.existing) {
            const existing = candidate.existing
            if (candidate.changed) {
              await copyFileIntoKnowledgeBaseAt(baseId, candidate.file.externalPath, existing.data.relativePath, {
                signal: ctx.signal,
                overwrite: true
              })
              await deleteKnowledgeItemVectors(base, [existing.id])
              if (existing.data.indexedRelativePath) {
                await remove(getKnowledgeBaseFilePath(baseId, existing.data.indexedRelativePath)).catch((error) =>
                  logger.warn('Failed to remove stale processed directory file', {
                    baseId,
                    itemId: existing.id,
                    error: error instanceof Error ? error.message : String(error)
                  })
                )
              }
              knowledgeItemService.updateFileSourceFingerprint(existing.id, candidate.fingerprint, {
                clearIndexedRelativePath: true
              })
              knowledgeItemService.updateStatus(existing.id, 'processing')
              scheduledItems.push(existing)
            } else {
              if (candidate.fingerprintChanged) {
                knowledgeItemService.updateFileSourceFingerprint(existing.id, candidate.fingerprint)
              }
              if (existing.status !== 'completed') {
                if (existing.status === 'failed') {
                  knowledgeItemService.updateStatus(existing.id, 'processing')
                }
                scheduledItems.push(existing)
              }
            }
          } else {
            const parent = ensureParentDirectories(
              baseId,
              liveRoot,
              candidate.file,
              directoriesBySource,
              createdDirectories
            )
            const relativePath = `${rootPrefix}/${candidate.file.relativePath}`
            assertSafeKnowledgeRelativePath(relativePath)
            await copyFileIntoKnowledgeBaseAt(baseId, candidate.file.externalPath, relativePath, {
              signal: ctx.signal,
              overwrite: true
            })
            const created = knowledgeItemService.createActive(baseId, {
              groupId: parent.id,
              type: 'file',
              data: {
                source: candidate.file.externalPath,
                relativePath,
                sourceFingerprint: candidate.fingerprint
              }
            })
            scheduledItems.push(created)
          }

          reportKnowledgeProgress(ctx, 45 + Math.round(((index + 1) / Math.max(candidates.length, 1)) * 35), {
            stage: 'copying'
          })
        }

        for (const directory of createdDirectories.reverse()) {
          knowledgeItemService.updateStatus(directory.id, 'processing')
        }
        if (scannedFiles.length === 0) {
          knowledgeItemService.updateStatus(itemId, 'failed', { error: EMPTY_DIRECTORY_ERROR })
        }
        return scheduledItems
      })

      const scheduledIds = new Set<string>()
      reportKnowledgeProgress(ctx, 80, { stage: 'enqueuing', currentFile: 0, totalFiles: itemsToSchedule.length })
      for (const [index, item] of itemsToSchedule.entries()) {
        ctx.signal.throwIfAborted()
        try {
          await ingestionService.scheduleItem(toKnowledgeBaseId(baseId), toKnowledgeItemId(item.id), ctx.jobId)
          scheduledIds.add(item.id)
        } catch (error) {
          markUnscheduledKnowledgeItemsFailed({
            baseId,
            items: itemsToSchedule,
            completedItemIds: scheduledIds,
            errorMessage: error instanceof Error ? error.message : String(error),
            failedStatusError: `Failed to schedule incrementally refreshed knowledge item: ${error instanceof Error ? error.message : String(error)}`,
            logger,
            logMessage: 'Failed to mark unscheduled incrementally refreshed knowledge item'
          })
          throw error
        }
        reportKnowledgeProgress(ctx, 80 + Math.round(((index + 1) / Math.max(itemsToSchedule.length, 1)) * 20), {
          stage: 'enqueuing',
          currentFile: index + 1,
          totalFiles: itemsToSchedule.length
        })
      }

      reportKnowledgeProgress(ctx, 100, {
        stage: 'done',
        currentFile: itemsToSchedule.length,
        totalFiles: itemsToSchedule.length
      })
    }
  }
}

function requireDirectoryItem(baseId: string, itemId: string): KnowledgeItemOf<'directory'> {
  const item = knowledgeItemService.getById(itemId)
  if (item.baseId !== baseId || item.type !== 'directory') {
    throw new Error(`Knowledge directory '${itemId}' does not belong to base '${baseId}'`)
  }
  return item
}

function resolveDirectoryPrefix(root: KnowledgeItemOf<'directory'>, descendants: KnowledgeItem[]): string {
  const prefix =
    root.data.relativePath ??
    descendants.find((item): item is KnowledgeItemOf<'file'> => item.type === 'file')?.data.relativePath.split('/')[0]
  if (!prefix) {
    throw new Error(`Knowledge directory '${root.id}' has no stored material path; run a full refresh once`)
  }
  return prefix
}

function normalizeLocalPath(value: string): string {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function collectScannedDirectorySources(rootSource: string, files: ScannedDirectoryFile[]): Set<string> {
  const sources = new Set<string>([normalizeLocalPath(rootSource)])
  for (const file of files) {
    const parts = file.relativePath.split('/').slice(0, -1)
    for (let index = 1; index <= parts.length; index += 1) {
      sources.add(normalizeLocalPath(path.join(rootSource, ...parts.slice(0, index))))
    }
  }
  return sources
}

export function classifyDirectoryEntries(
  descendants: KnowledgeItem[],
  rootSource: string,
  scannedFiles: ScannedDirectoryFile[]
): {
  staleItems: KnowledgeItem[]
  filesBySource: Map<string, KnowledgeItemOf<'file'>>
} {
  const scannedFileSources = new Set(scannedFiles.map((file) => normalizeLocalPath(file.externalPath)))
  const scannedDirectorySources = collectScannedDirectorySources(rootSource, scannedFiles)
  const staleItems = descendants.filter((item) => {
    const source = normalizeLocalPath(item.data.source)
    if (item.type === 'file') return !scannedFileSources.has(source)
    if (item.type === 'directory') return !scannedDirectorySources.has(source)
    return false
  })
  const staleIds = new Set(staleItems.map((item) => item.id))
  const filesBySource = new Map(
    descendants
      .filter((item): item is KnowledgeItemOf<'file'> => item.type === 'file' && !staleIds.has(item.id))
      .map((item) => [normalizeLocalPath(item.data.source), item])
  )
  return { staleItems, filesBySource }
}

function ensureParentDirectories(
  baseId: string,
  root: KnowledgeItemOf<'directory'>,
  file: ScannedDirectoryFile,
  directoriesBySource: Map<string, KnowledgeItemOf<'directory'>>,
  createdDirectories: KnowledgeItemOf<'directory'>[]
): KnowledgeItemOf<'directory'> {
  let parent = root
  const parts = file.relativePath.split('/').slice(0, -1)
  for (let index = 1; index <= parts.length; index += 1) {
    const source = path.join(root.data.source, ...parts.slice(0, index))
    const key = normalizeLocalPath(source)
    const existing = directoriesBySource.get(key)
    if (existing) {
      parent = existing
      continue
    }
    const created = knowledgeItemService.createActive(baseId, {
      groupId: parent.id,
      type: 'directory',
      data: { source }
    }) as KnowledgeItemOf<'directory'>
    directoriesBySource.set(key, created)
    createdDirectories.push(created)
    parent = created
  }
  return parent
}

export async function compareDirectoryFile(
  sourcePath: string,
  storedPath: string | undefined,
  previous: SourceFingerprint | undefined,
  signal: AbortSignal
): Promise<Pick<RefreshCandidate, 'fingerprint' | 'changed' | 'fingerprintChanged'>> {
  const absoluteSourcePath = AbsoluteFilePathSchema.parse(sourcePath)
  const sourceStat = await stat(absoluteSourcePath)
  if (previous && previous.size === sourceStat.size && Math.abs(previous.modifiedAt - sourceStat.modifiedAt) <= 1) {
    return { fingerprint: previous, changed: false, fingerprintChanged: false }
  }

  const sourceHash = await hashWithSize(absoluteSourcePath, signal)
  const fingerprint: SourceFingerprint = {
    size: sourceHash.size,
    modifiedAt: sourceStat.modifiedAt,
    contentHash: sourceHash.contentHash
  }
  if (!storedPath) {
    return { fingerprint, changed: true, fingerprintChanged: true }
  }
  if (previous) {
    return {
      fingerprint,
      changed: previous.size !== fingerprint.size || previous.contentHash !== fingerprint.contentHash,
      fingerprintChanged:
        previous.size !== fingerprint.size ||
        previous.modifiedAt !== fingerprint.modifiedAt ||
        previous.contentHash !== fingerprint.contentHash
    }
  }

  try {
    const storedHash = await hashWithSize(AbsoluteFilePathSchema.parse(storedPath), signal)
    return {
      fingerprint,
      changed: storedHash.size !== fingerprint.size || storedHash.contentHash !== fingerprint.contentHash,
      fingerprintChanged: true
    }
  } catch {
    return { fingerprint, changed: true, fingerprintChanged: true }
  }
}
