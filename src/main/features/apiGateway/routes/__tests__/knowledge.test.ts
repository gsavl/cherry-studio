import { Elysia } from 'elysia'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DataApiError, DataApiErrorFactory } from '@shared/data/api/errors'

/**
 * Exercises the knowledge routes through a wrapper app that includes the real
 * Cherry REST `restErrorHandler` (the dialect these endpoints use), so the full
 * chain runs: v2 data services → route logic → response schemas → REST error
 * shaping (DataApiError → `{ error: { code, message } }` with its HTTP status).
 */

const {
  mockList,
  mockGetById,
  mockListRootItems,
  mockSearch,
  mockReadConcept,
  mockReindexItems,
  mockRefreshDirectoryItem,
  mockJobGet,
  mockItemGetById
} = vi.hoisted(() => ({
  mockList: vi.fn<(query: unknown) => unknown>(),
  mockGetById: vi.fn<(id: string) => unknown>(),
  mockListRootItems: vi.fn<(baseId: string) => unknown[]>(),
  mockSearch: vi.fn<(baseId: string, query: string) => Promise<unknown[]>>(),
  mockReadConcept:
    vi.fn<(baseId: string, conceptId: string, range: { charStart?: number; charEnd?: number }) => Promise<unknown>>(),
  mockReindexItems: vi.fn<(baseId: string, itemIds: string[]) => Promise<string | null>>(),
  mockRefreshDirectoryItem: vi.fn<(baseId: string, itemId: string) => Promise<string>>(),
  mockJobGet: vi.fn<(jobId: string) => Promise<unknown>>(),
  mockItemGetById: vi.fn<(itemId: string) => unknown>()
}))

vi.mock('@data/services/KnowledgeBaseService', () => ({
  knowledgeBaseService: { list: mockList, getById: mockGetById }
}))
vi.mock('@data/services/KnowledgeItemService', () => ({
  knowledgeItemService: { getById: mockItemGetById }
}))
vi.mock('@application', () => ({
  application: {
    get: vi.fn((name: string) => {
      if (name === 'KnowledgeService') {
        return {
          listRootItems: mockListRootItems,
          search: mockSearch,
          readConcept: mockReadConcept,
          reindexItems: mockReindexItems,
          refreshDirectoryItem: mockRefreshDirectoryItem
        }
      }
      if (name === 'JobManager') {
        return { get: mockJobGet }
      }
      throw new Error(`Unexpected application.get(${name})`)
    })
  }
}))
vi.mock('@logger', () => ({
  loggerService: { withContext: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })) }
}))

import { restErrorHandler } from '../../errors'
import { knowledgeRoutes } from '../knowledge'

const app = new Elysia().error({ DATA_API: DataApiError }).onError(restErrorHandler).use(knowledgeRoutes)

const kb = (id: string, name: string) => ({
  id,
  name,
  embeddingModelId: 'openai:text-embedding-3-small',
  dimensions: 1536
})
const result = (chunkId: string, score: number) => ({
  pageContent: `chunk ${chunkId}`,
  score,
  scoreKind: 'similarity',
  rank: 1,
  metadata: {},
  chunkId
})

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
  )
  return { status: res.status, body: await res.json() }
}

describe('knowledge routes (v2)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListRootItems.mockReturnValue([])
    mockReindexItems.mockResolvedValue('backend-job-1')
    mockRefreshDirectoryItem.mockResolvedValue('incremental-job-1')
    mockJobGet.mockResolvedValue({ id: 'backend-job-1', status: 'pending', error: null })
    mockItemGetById.mockReturnValue({
      id: 'directory-1',
      baseId: 'kb-1',
      type: 'directory',
      status: 'completed',
      error: null,
      data: { source: 'Z:\\knowledge' }
    })
  })

  it('GET /knowledge-bases applies a true offset/limit window', async () => {
    // The service is page-based; the route fetches [0, offset+limit) from page 1
    // and slices the exact window, so page-aligned offsets still work end-to-end.
    const items = Array.from({ length: 40 }, (_, i) => kb(`kb-${i}`, `KB ${i}`))
    mockList.mockReturnValue({ items, total: 100, page: 1 })
    const { status, body } = await call('GET', '/knowledge-bases?limit=20&offset=20')
    expect(status).toBe(200)

    expect(body.knowledge_bases).toHaveLength(20)
    expect(body.knowledge_bases[0].id).toBe('kb-20')
    expect(body.knowledge_bases[19].id).toBe('kb-39')
    expect(body.total).toBe(100)
  })

  it('GET /knowledge-bases honors a non-page-aligned offset (v1 regression guard)', async () => {
    // offset=5, limit=20 → must return items 5..24 (the v1 server sliced; the first
    // port floored to a page and returned 0..19, dropping the offset%limit remainder).
    const items = Array.from({ length: 25 }, (_, i) => kb(`kb-${i}`, `KB ${i}`))
    mockList.mockReturnValue({ items, total: 25, page: 1 })
    const { status, body } = await call('GET', '/knowledge-bases?limit=20&offset=5')
    expect(status).toBe(200)

    expect(body.knowledge_bases).toHaveLength(20)
    expect(body.knowledge_bases[0].id).toBe('kb-5')
    expect(body.knowledge_bases[19].id).toBe('kb-24')
  })

  it('GET /knowledge-bases includes v2 root items used to detect bound directories', async () => {
    mockList.mockReturnValue({ items: [kb('kb-1', 'KB 1')], total: 1, page: 1 })
    mockListRootItems.mockReturnValue([
      {
        id: 'directory-1',
        baseId: 'kb-1',
        type: 'directory',
        status: 'completed',
        data: { source: 'Z:\\knowledge' }
      }
    ])

    const { status, body } = await call('GET', '/knowledge-bases')

    expect(status).toBe(200)
    expect(mockListRootItems).toHaveBeenCalledWith('kb-1')
    expect(body.knowledge_bases[0].items).toEqual([
      expect.objectContaining({ id: 'directory-1', type: 'directory', data: { source: 'Z:\\knowledge' } })
    ])
  })

  it('GET /knowledge-bases/:id returns a base', async () => {
    mockGetById.mockReturnValue(kb('kb-1', 'KB 1'))
    const { status, body } = await call('GET', '/knowledge-bases/kb-1')
    expect(status).toBe(200)
    expect(body.id).toBe('kb-1')
  })

  it('POST /knowledge-bases/:id/read returns indexed document content', async () => {
    mockReadConcept.mockResolvedValue({
      conceptId: 'articles/example.md',
      title: 'example.md',
      itemType: 'file',
      totalChars: 12,
      charStart: 2,
      charEnd: 8,
      content: '正文内容',
      truncated: true
    })

    const { status, body } = await call('POST', '/knowledge-bases/kb-1/read', {
      concept_id: 'articles/example.md',
      char_start: 2,
      char_end: 8
    })

    expect(status).toBe(200)
    expect(body.content).toBe('正文内容')
    expect(mockReadConcept).toHaveBeenCalledWith('kb-1', 'articles/example.md', { charStart: 2, charEnd: 8 })
  })

  it('waits for the backend refresh job before reporting a completed directory', async () => {
    const started = await call('POST', '/knowledge-bases/kb-1/directories/directory-1/refresh', {})

    expect(started.status).toBe(200)
    expect(started.body.status).toBe('running')
    expect(started.body.backend_job_id).toBe('backend-job-1')

    mockJobGet.mockResolvedValue({ id: 'backend-job-1', status: 'completed', error: null })
    mockItemGetById.mockReturnValue({
      id: 'directory-1',
      baseId: 'kb-1',
      type: 'directory',
      status: 'processing',
      error: null,
      data: { source: 'Z:\\knowledge' }
    })
    const processing = await call('GET', `/knowledge-bases/jobs/${started.body.id}`)
    expect(processing.body.status).toBe('running')

    mockItemGetById.mockReturnValue({
      id: 'directory-1',
      baseId: 'kb-1',
      type: 'directory',
      status: 'completed',
      error: null,
      data: { source: 'Z:\\knowledge' }
    })
    const completed = await call('GET', `/knowledge-bases/jobs/${started.body.id}`)
    expect(completed.body.status).toBe('completed')
  })

  it('routes incremental directory refreshes to the v2 incremental job', async () => {
    mockJobGet.mockResolvedValue({ id: 'incremental-job-1', status: 'pending', error: null })

    const response = await call('POST', '/knowledge-bases/kb-1/directories/directory-1/refresh', {
      mode: 'incremental'
    })

    expect(response.status).toBe(200)
    expect(response.body.backend_job_id).toBe('incremental-job-1')
    expect(mockRefreshDirectoryItem).toHaveBeenCalledWith('kb-1', 'directory-1')
    expect(mockReindexItems).not.toHaveBeenCalled()
  })

  it('GET /knowledge-bases/:id maps a DataApiError NOT_FOUND → 404 REST envelope', async () => {
    mockGetById.mockImplementation(() => {
      throw DataApiErrorFactory.notFound('KnowledgeBase', 'nope')
    })
    const { status, body } = await call('GET', '/knowledge-bases/nope')
    expect(status).toBe(404)
    expect(body.type).toBeUndefined() // Cherry REST dialect: { error: { code, message } }
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST /search aggregates + sorts orchestrator results across bases', async () => {
    mockList.mockReturnValue({ items: [kb('kb-1', 'KB 1'), kb('kb-2', 'KB 2')], total: 2, page: 1 })
    mockSearch.mockImplementation(async (baseId: string) =>
      baseId === 'kb-1' ? [result('a', 0.4)] : [result('b', 0.9)]
    )
    const { status, body } = await call('POST', '/knowledge-bases/search', { query: 'hi' })
    expect(status).toBe(200)
    expect(body.results.map((r: any) => r.chunkId)).toEqual(['b', 'a'])
    expect(body.results[0].knowledge_base_id).toBe('kb-2')
  })

  it('POST /search warns when no knowledge bases are configured', async () => {
    mockList.mockReturnValue({ items: [], total: 0, page: 1 })
    const { status, body } = await call('POST', '/knowledge-bases/search', { query: 'hi' })
    expect(status).toBe(200)
    expect(body.results).toEqual([])
    expect(body.warnings).toHaveLength(1)
  })

  it('POST /search → 503 when every targeted base search fails', async () => {
    mockList.mockReturnValue({ items: [kb('kb-1', 'KB 1'), kb('kb-2', 'KB 2')], total: 2, page: 1 })
    mockSearch.mockRejectedValue(new Error('vector store unavailable'))
    const { status, body } = await call('POST', '/knowledge-bases/search', { query: 'hi' })
    expect(status).toBe(503)
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE')
  })

  it('POST /search → 404 when none of the specified bases exist', async () => {
    mockGetById.mockImplementation(() => {
      throw DataApiErrorFactory.notFound('KnowledgeBase', 'nope')
    })
    const { status, body } = await call('POST', '/knowledge-bases/search', {
      query: 'hi',
      knowledge_base_ids: ['nope']
    })
    expect(status).toBe(404)
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('POST /search propagates a non-NOT_FOUND getById failure instead of masking it as 404', async () => {
    mockGetById.mockImplementation(() => {
      throw new Error('database unavailable')
    })
    const { status, body } = await call('POST', '/knowledge-bases/search', {
      query: 'hi',
      knowledge_base_ids: ['kb-1']
    })
    expect(status).toBe(500)
    expect(body.error.code).toBe('INTERNAL_SERVER_ERROR')
  })
})
