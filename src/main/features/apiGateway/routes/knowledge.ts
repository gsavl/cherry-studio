import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { application } from '@application'
import { knowledgeBaseService } from '@data/services/KnowledgeBaseService'
import { knowledgeItemService } from '@data/services/KnowledgeItemService'
import { loggerService } from '@logger'
import { DataApiError, DataApiErrorFactory, ERROR_STATUS_MAP, ErrorCode } from '@shared/data/api/errors'
import type { KnowledgeItem } from '@shared/data/types/knowledge'
import { Elysia } from 'elysia'

import { DOC_DESCRIPTIONS, DOC_TAGS } from '../openapiDocs'
import {
  AddKnowledgeDirectorySchema,
  KnowledgeBaseIdParamSchema,
  KnowledgeBaseResponseSchema,
  KnowledgeConceptReadResponseSchema,
  KnowledgeConceptReadSchema,
  KnowledgeDirectoryParamsSchema,
  KnowledgeJobParamsSchema,
  KnowledgeSearchSchema,
  ListKnowledgeBasesResponseSchema,
  PaginationQuerySchema,
  RefreshKnowledgeDirectoryFileSchema,
  RefreshKnowledgeDirectorySchema,
  SearchKnowledgeResponseSchema
} from './knowledgeSchemas'

const logger = loggerService.withContext('KnowledgeRoutes')

type MaintenanceOperation = 'add_directory' | 'refresh_directory' | 'refresh_directory_file'

interface MaintenanceJob {
  id: string
  operation: MaintenanceOperation
  knowledge_base_id: string
  item_id: string
  directory_item_id: string
  file_path?: string
  backend_job_id?: string
  created_at: number
}

const maintenanceJobs = new Map<string, MaintenanceJob>()
const MAX_MAINTENANCE_JOBS = 1000

function normalizeLocalPath(value: string): string {
  const normalized = path.normalize(path.resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function findDirectoryItem(baseId: string, itemId: string): Extract<KnowledgeItem, { type: 'directory' }> {
  const item = knowledgeItemService.getById(itemId)
  if (item.baseId !== baseId || item.type !== 'directory') {
    throw DataApiErrorFactory.notFound('KnowledgeDirectory', itemId)
  }
  return item
}

function createMaintenanceJob(
  operation: MaintenanceOperation,
  baseId: string,
  itemId: string,
  filePath?: string,
  backendJobId?: string
): MaintenanceJob {
  if (maintenanceJobs.size >= MAX_MAINTENANCE_JOBS) {
    const oldestJobId = maintenanceJobs.keys().next().value
    if (oldestJobId) maintenanceJobs.delete(oldestJobId)
  }

  const job: MaintenanceJob = {
    id: `kbjob_${randomUUID()}`,
    operation,
    knowledge_base_id: baseId,
    item_id: itemId,
    directory_item_id: itemId,
    file_path: filePath,
    backend_job_id: backendJobId,
    created_at: Date.now()
  }
  maintenanceJobs.set(job.id, job)
  return job
}

async function serializeMaintenanceJob(job: MaintenanceJob) {
  if (job.backend_job_id) {
    const backendJob = await application.get('JobManager').get(job.backend_job_id)
    if (!backendJob) {
      return { ...job, status: 'failed', progress: 0, error: 'Knowledge backend job no longer exists' }
    }
    if (backendJob.status === 'failed' || backendJob.status === 'cancelled') {
      return {
        ...job,
        status: 'failed',
        progress: 0,
        updated_at: Date.now(),
        error: backendJob.error?.message ?? `Knowledge backend job ${backendJob.status}`
      }
    }
    if (backendJob.status !== 'completed') {
      return { ...job, status: 'running', progress: 0, updated_at: Date.now(), error: null }
    }
  }

  let item: KnowledgeItem
  try {
    item = knowledgeItemService.getById(job.item_id)
  } catch {
    return { ...job, status: 'failed', progress: 0, error: 'Knowledge item no longer exists' }
  }

  const progressByStatus: Record<KnowledgeItem['status'], number> = {
    idle: 0,
    preparing: 10,
    processing: 35,
    reading: 55,
    embedding: 80,
    completed: 100,
    failed: 0,
    deleting: 50
  }
  const status = item.status === 'completed' ? 'completed' : item.status === 'failed' ? 'failed' : 'running'
  return {
    ...job,
    status,
    progress: progressByStatus[item.status],
    updated_at: Date.now(),
    error: item.status === 'failed' ? item.error : null
  }
}

async function queueDirectoryRefresh(
  baseId: string,
  itemId: string,
  mode: 'full' | 'incremental' = 'full'
): Promise<MaintenanceJob> {
  findDirectoryItem(baseId, itemId)
  const knowledgeService = application.get('KnowledgeService')
  const backendJobId =
    mode === 'incremental'
      ? await knowledgeService.refreshDirectoryItem(baseId, itemId)
      : await knowledgeService.reindexItems(baseId, [itemId])
  return createMaintenanceJob('refresh_directory', baseId, itemId, undefined, backendJobId ?? undefined)
}

/**
 * Knowledge base routes (Elysia plugin, mounted under `/v1`). Backed by the v2
 * data layer (`knowledgeBaseService`) + `KnowledgeService` — no
 * Redux, no renderer required. Handlers return success values (validated by the
 * `response` schemas) and throw for failures; the global `onError` shapes errors
 * (including `DataApiError` → the matching HTTP status).
 *
 * `detail.tags`/`summary` hold i18n *keys*, not translated text — see chat.ts.
 */
export const knowledgeRoutes = new Elysia({ prefix: '/knowledge-bases' })
  .get(
    '/',
    ({ query }) => {
      // Gateway exposes a true offset/limit; the data service is page-based
      // (offset = (page-1)*limit), so a non-page-aligned offset can't be expressed
      // as a single page. Fetch the window from the start and slice the exact range.
      // The KB list is small (bounded by the user's configured bases), matching the
      // `limit: 1000` fetch-all pattern used by `/search` below.
      const limit = query.limit ?? 20
      const offset = query.offset ?? 0

      const { items, total } = knowledgeBaseService.list({ page: 1, limit: offset + limit })
      const knowledgeService = application.get('KnowledgeService')
      const knowledgeBases = items.slice(offset, offset + limit).map((base) => ({
        ...base,
        items: knowledgeService.listRootItems(base.id)
      }))
      return { knowledge_bases: knowledgeBases, total }
    },
    {
      query: PaginationQuerySchema,
      response: { 200: ListKnowledgeBasesResponseSchema },
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'List Knowledge Bases',
        description: DOC_DESCRIPTIONS.list_knowledge_bases
      }
    }
  )
  .post(
    '/search',
    async ({ body }) => {
      const { query, knowledge_base_ids, document_count } = body

      // Resolve target bases: the requested ids (must exist) or every base.
      let targetBases: { id: string; name: string }[]
      if (knowledge_base_ids?.length) {
        const resolved = knowledge_base_ids.map((id) => {
          try {
            const base = knowledgeBaseService.getById(id)
            return { id: base.id, name: base.name }
          } catch (error: unknown) {
            // Only a genuine "not found" maps to null (→ filtered out); real
            // service/DB failures must propagate so they aren't misreported as 404.
            if (error instanceof DataApiError && error.code === ErrorCode.NOT_FOUND) {
              return null
            }
            throw error
          }
        })
        targetBases = resolved.filter((base): base is { id: string; name: string } => base !== null)
        if (targetBases.length === 0) {
          throw DataApiErrorFactory.notFound('KnowledgeBase', knowledge_base_ids.join(', '))
        }
      } else {
        const { items } = knowledgeBaseService.list({ page: 1, limit: 1000 })
        targetBases = items.map((base) => ({ id: base.id, name: base.name }))
        if (targetBases.length === 0) {
          return {
            query,
            results: [],
            total: 0,
            searched_bases: [],
            warnings: ['No knowledge bases configured. Please add knowledge bases in Cherry Studio.']
          }
        }
      }

      const orchestrator = application.get('KnowledgeService')
      const resultsPerBase = await Promise.all(
        targetBases.map(async (base) => {
          try {
            const searchResults = await orchestrator.search(base.id, query)
            return {
              base,
              results: searchResults.map((result) => ({
                ...result,
                knowledge_base_id: base.id,
                knowledge_base_name: base.name
              })),
              error: undefined as string | undefined
            }
          } catch (error) {
            logger.error(`Error searching knowledge base ${base.id}`, error as Error)
            return { base, results: [], error: (error as Error).message }
          }
        })
      )

      // Every targeted search failed (e.g. broken embedding/vector-store config). Surface a
      // retryable upstream-dependency failure (503) instead of a 200 with empty results, so
      // clients can tell infrastructure failure apart from "no matches".
      if (resultsPerBase.every((r) => r.error)) {
        throw new DataApiError(
          ErrorCode.SERVICE_UNAVAILABLE,
          'All knowledge base searches failed',
          ERROR_STATUS_MAP[ErrorCode.SERVICE_UNAVAILABLE],
          { originalError: resultsPerBase.map((r) => r.error).join('; ') }
        )
      }

      const warnings = resultsPerBase
        .filter((r) => r.error)
        .map((r) => `Knowledge base "${r.base.name}" search failed: ${r.error}`)
      const sortedResults = resultsPerBase
        .flatMap((r) => r.results)
        .sort((a, b) => b.score - a.score)
        .slice(0, document_count)

      return {
        query,
        results: sortedResults,
        total: sortedResults.length,
        searched_bases: resultsPerBase.map((r) => ({ id: r.base.id, name: r.base.name })),
        ...(warnings.length > 0 && { warnings })
      }
    },
    {
      body: KnowledgeSearchSchema,
      response: { 200: SearchKnowledgeResponseSchema },
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Search Knowledge Bases',
        description: DOC_DESCRIPTIONS.search_knowledge_bases
      }
    }
  )
  .post(
    '/:id/read',
    ({ body, params }) =>
      application.get('KnowledgeService').readConcept(params.id, body.concept_id, {
        charStart: body.char_start,
        charEnd: body.char_end
      }),
    {
      params: KnowledgeBaseIdParamSchema,
      body: KnowledgeConceptReadSchema,
      response: { 200: KnowledgeConceptReadResponseSchema },
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Read Knowledge Document'
      }
    }
  )
  .get(
    '/jobs/:jobId',
    ({ params }) => {
      const job = maintenanceJobs.get(params.jobId)
      if (!job) throw DataApiErrorFactory.notFound('KnowledgeJob', params.jobId)
      return serializeMaintenanceJob(job)
    },
    {
      params: KnowledgeJobParamsSchema,
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Get Knowledge Maintenance Job'
      }
    }
  )
  .post(
    '/:id/directories',
    async ({ body, params }) => {
      knowledgeBaseService.getById(params.id)
      const directoryPath = path.resolve(body.path)
      const normalizedPath = normalizeLocalPath(directoryPath)
      const knowledgeService = application.get('KnowledgeService')
      const existing = knowledgeService
        .listRootItems(params.id)
        .find((item) => item.type === 'directory' && normalizeLocalPath(item.data.source) === normalizedPath)

      if (existing) {
        if (!body.refresh_if_exists) {
          throw DataApiErrorFactory.conflict(`Directory already exists in knowledge base: ${directoryPath}`)
        }
        return serializeMaintenanceJob(await queueDirectoryRefresh(params.id, existing.id))
      }

      const result = await knowledgeService.addItems(
        params.id,
        [{ type: 'directory', data: { source: directoryPath } }],
        'detect'
      )
      if (result.status === 'conflicts') {
        throw DataApiErrorFactory.conflict(`Directory already exists in knowledge base: ${directoryPath}`)
      }

      const added = knowledgeService
        .listRootItems(params.id)
        .find((item) => item.type === 'directory' && normalizeLocalPath(item.data.source) === normalizedPath)
      if (!added) {
        throw DataApiErrorFactory.internal(new Error('Added directory item could not be resolved'))
      }

      return serializeMaintenanceJob(createMaintenanceJob('add_directory', params.id, added.id))
    },
    {
      params: KnowledgeBaseIdParamSchema,
      body: AddKnowledgeDirectorySchema,
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Add Knowledge Directory'
      }
    }
  )
  .post(
    '/:id/directories/:itemId/refresh',
    async ({ body, params }) =>
      serializeMaintenanceJob(await queueDirectoryRefresh(params.id, params.itemId, body.mode ?? 'full')),
    {
      params: KnowledgeDirectoryParamsSchema,
      body: RefreshKnowledgeDirectorySchema,
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Refresh Knowledge Directory'
      }
    }
  )
  .post(
    '/:id/directories/:itemId/files/refresh',
    async ({ body, params }) => {
      const directory = findDirectoryItem(params.id, params.itemId)
      const directoryPath = normalizeLocalPath(directory.data.source)
      const filePath = path.resolve(body.path)
      const normalizedFilePath = normalizeLocalPath(filePath)
      const relativePath = path.relative(directoryPath, normalizedFilePath)
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw DataApiErrorFactory.validation({ path: ['File must be inside the directory knowledge item'] })
      }

      const child = knowledgeItemService
        .getSubtreeItems(params.id, [params.itemId])
        .find((item) => item.type === 'file' && normalizeLocalPath(item.data.source) === normalizedFilePath)
      if (!child) {
        if (body.fallback === 'full-directory') {
          return serializeMaintenanceJob(await queueDirectoryRefresh(params.id, params.itemId))
        }
        throw DataApiErrorFactory.conflict(
          'No indexed knowledge item exists for this file. Refresh the full directory first.'
        )
      }

      const backendJobId = await application.get('KnowledgeService').reindexItems(params.id, [child.id])
      return serializeMaintenanceJob(
        createMaintenanceJob('refresh_directory_file', params.id, child.id, filePath, backendJobId ?? undefined)
      )
    },
    {
      params: KnowledgeDirectoryParamsSchema,
      body: RefreshKnowledgeDirectoryFileSchema,
      detail: {
        tags: [DOC_TAGS.cherry],
        summary: 'Refresh Knowledge Directory File'
      }
    }
  )
  .get('/:id', ({ params }) => knowledgeBaseService.getById(params.id), {
    params: KnowledgeBaseIdParamSchema,
    response: { 200: KnowledgeBaseResponseSchema },
    detail: {
      tags: [DOC_TAGS.cherry],
      summary: 'Get Knowledge Base',
      description: DOC_DESCRIPTIONS.get_knowledge_base
    }
  })
