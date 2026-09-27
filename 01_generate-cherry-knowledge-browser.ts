import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'

import { parse as parseYaml } from 'yaml'

import { compareFilesByPublishedAt, extractPublishedAt } from './scripts/knowledge-browser-sort'
import { knowledgeSupportedFileExts } from './src/shared/utils/file/fileExtensions'

type DirectorySyncConfig = Record<string, string[]>

interface CliOptions {
  config: string
  output: string
  indexFile?: string
  open?: boolean
}

interface KnowledgeDirectoryFileRecord {
  uniqueId: string
  size: number
  mtimeMs: number
  ext: string
  contentHash?: string
  lastIndexedAt: number
}

interface KnowledgeItemRow {
  id: string
  base_id: string
  group_id: string | null
  data: string
  updated_at: number
}

interface KnowledgeItemData {
  source?: string
  sourceFingerprint?: {
    size?: number
    modifiedAt?: number
  }
}

interface RootScanResult {
  id: number
  knowledgeBaseName: string
  rootPath: string
  name: string
  exists: boolean
  error?: string
  fileCount: number
  folderCount: number
  latestFileId?: number
  latestMtimeMs?: number
}

interface BrowserFile {
  id: number
  knowledgeBaseName: string
  rootId: number
  rootName: string
  rootPath: string
  folderPath: string
  relativePath: string
  name: string
  path: string
  url: string
  ext: string
  size: number
  mtimeMs: number
  birthtimeMs: number
  indexed: boolean
  publishedAt?: string
  lastIndexedAt?: number
  uniqueId?: string
}

interface BrowserFolder {
  id: number
  knowledgeBaseName: string
  rootId: number
  rootName: string
  rootPath: string
  path: string
  url: string
  name: string
  relativePath: string
  levelLabel: string
  subgroupLabel?: string
  depth: number
  isRoot: boolean
  fileCount: number
  totalSize: number
  indexedCount: number
  latestFileId: number
  latestMtimeMs: number
  fileIds: number[]
  subgroups: BrowserSubgroup[]
}

interface BrowserSubgroup {
  id: number
  name: string
  path: string
  url: string
  relativePath: string
  fileCount: number
  totalSize: number
  indexedCount: number
  latestFileId: number
  latestMtimeMs: number
  fileIds: number[]
}

interface BrowserReportData {
  generatedAt: string
  configPath: string
  outputPath: string
  supportedExtensions: string[]
  index: {
    available: boolean
    path?: string
    recordCount: number
  }
  stats: {
    roots: number
    missingRoots: number
    files: number
    folders: number
    indexedFiles: number
    totalSize: number
  }
  roots: RootScanResult[]
  folders: BrowserFolder[]
  files: BrowserFile[]
}

interface FolderDraft {
  id: number
  knowledgeBaseName: string
  rootId: number
  rootName: string
  rootPath: string
  path: string
  name: string
  relativePath: string
  levelLabel: string
  subgroupLabel?: string
  depth: number
  isRoot: boolean
  fileCount: number
  totalSize: number
  indexedCount: number
  latestFileId: number
  latestMtimeMs: number
  fileIds: number[]
  subgroups: Map<string, SubgroupDraft>
}

interface SubgroupDraft {
  id: number
  name: string
  path: string
  relativePath: string
  fileCount: number
  totalSize: number
  indexedCount: number
  latestFileId: number
  latestMtimeMs: number
  fileIds: number[]
}

interface DisplayGrouping {
  folderPath: string
  folderName: string
  folderRelativePath: string
  levelLabel: string
  subgroupLabel?: string
  subgroup?: {
    path: string
    name: string
    relativePath: string
  }
}

const DEFAULT_CONFIG = 'kb-dirs.yaml'
const DEFAULT_OUTPUT = path.join('reports', 'knowledge-browser.html')
const supportedExtensions = new Set(knowledgeSupportedFileExts.map((ext) => ext.toLowerCase()))

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    config: DEFAULT_CONFIG,
    output: DEFAULT_OUTPUT
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const readValue = (): string => {
      const value = argv[i + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`)
      }

      i += 1
      return value
    }

    switch (arg) {
      case '--config':
        options.config = readValue()
        break
      case '--output':
        options.output = readValue()
        break
      case '--index-file':
        options.indexFile = readValue()
        break
      case '--open':
        options.open = true
        break
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  return options
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm tsx 01_generate-cherry-knowledge-browser.ts [--config kb-dirs.yaml] [--output reports/knowledge-browser.html] [--open]',
    '',
    'Options:',
    '  --config <path>      YAML/JSON map: knowledge base name -> directory list',
    '  --output <path>      HTML report path',
    '  --index-file <path>  Optional Cherry knowledge_directory_index.json path',
    '  --open              Open the generated HTML after writing it'
  ].join('\n')
}

function readDirectorySyncConfig(configFile: string): DirectorySyncConfig {
  const resolvedPath = path.resolve(configFile)
  const raw = fs
    .readFileSync(resolvedPath, 'utf-8')
    .replace(/^\uFEFF/, '')
    .trim()
  if (!raw) {
    throw new Error(`Sync config file is empty: ${resolvedPath}`)
  }

  const parsed =
    path.extname(resolvedPath).toLowerCase() === '.json' || raw.startsWith('{') ? JSON.parse(raw) : parseYaml(raw)
  return validateDirectorySyncConfig(parsed, resolvedPath)
}

function validateDirectorySyncConfig(value: unknown, configFile: string): DirectorySyncConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Sync config must be an object/map: ${configFile}`)
  }

  const config: DirectorySyncConfig = {}
  for (const [baseName, paths] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(paths)) {
      throw new Error(`Sync config entry must be a list of folders: ${baseName}`)
    }

    const normalizedPaths = paths
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((entry) => entry.length > 0)
    if (normalizedPaths.length > 0) {
      config[baseName] = normalizedPaths
    }
  }

  if (Object.keys(config).length === 0) {
    throw new Error(`Sync config has no knowledge base entries: ${configFile}`)
  }

  return config
}

function getDefaultIndexFile(): string | undefined {
  const candidates = [
    process.env.CHERRY_KB_DIRECTORY_INDEX_FILE,
    process.env.CHERRY_KB_INDEX_FILE,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'CherryStudio', 'Data', 'KnowledgeBase', 'knowledge_directory_index.json')
      : undefined,
    process.env.APPDATA
      ? path.join(process.env.APPDATA, 'CherryStudioDev', 'Data', 'KnowledgeBase', 'knowledge_directory_index.json')
      : undefined
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function getDefaultDatabaseFile(): string | undefined {
  const candidates = [
    process.env.CHERRY_KB_DATABASE_FILE,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CherryStudio', 'Data', 'cherrystudio.sqlite') : undefined,
    process.env.APPDATA ? path.join(process.env.APPDATA, 'CherryStudioDev', 'Data', 'cherrystudio.sqlite') : undefined
  ].filter((candidate): candidate is string => Boolean(candidate))

  return candidates.find((candidate) => fs.existsSync(candidate))
}

function loadV2DirectoryIndex(
  databaseFile: string,
  config: DirectorySyncConfig
): { path: string; records: Map<string, KnowledgeDirectoryFileRecord> } {
  const records = new Map<string, KnowledgeDirectoryFileRecord>()
  const database = new DatabaseSync(databaseFile, { readOnly: true })

  try {
    const configuredRoots = new Map<string, Set<string>>()
    for (const [baseName, rootPaths] of Object.entries(config)) {
      configuredRoots.set(baseName, new Set(rootPaths.map(normalizeComparablePath)))
    }

    const bases = database.prepare('SELECT id, name FROM knowledge_base').all() as Array<{ id: string; name: string }>
    const baseNames = new Map(bases.map((base) => [base.id, base.name]))
    const directories = database
      .prepare(
        "SELECT id, base_id, group_id, data, updated_at FROM knowledge_item WHERE type = 'directory' AND status = 'completed'"
      )
      .all() as KnowledgeItemRow[]
    const configuredDirectoryIds = new Set<string>()

    for (const directory of directories) {
      const roots = configuredRoots.get(baseNames.get(directory.base_id) || '')
      if (!roots) continue

      const data = JSON.parse(directory.data) as KnowledgeItemData
      if (data.source && roots.has(normalizeComparablePath(data.source))) {
        configuredDirectoryIds.add(directory.id)
      }
    }

    let addedDescendant = true
    while (addedDescendant) {
      addedDescendant = false
      for (const directory of directories) {
        if (
          directory.group_id &&
          configuredDirectoryIds.has(directory.group_id) &&
          !configuredDirectoryIds.has(directory.id)
        ) {
          configuredDirectoryIds.add(directory.id)
          addedDescendant = true
        }
      }
    }

    const files = database
      .prepare(
        "SELECT id, base_id, group_id, data, updated_at FROM knowledge_item WHERE type = 'file' AND status = 'completed'"
      )
      .all() as KnowledgeItemRow[]
    const filesByBase = new Map<string, KnowledgeItemRow[]>()
    for (const file of files) {
      if (!file.group_id || !configuredDirectoryIds.has(file.group_id)) continue
      const baseFiles = filesByBase.get(file.base_id) || []
      baseFiles.push(file)
      filesByBase.set(file.base_id, baseFiles)
    }

    const knowledgeBaseDirectory = path.dirname(databaseFile)
    for (const [baseId, baseFiles] of filesByBase) {
      const indexFile = path.join(knowledgeBaseDirectory, 'KnowledgeBase', baseId, '.cherry', 'index.sqlite')
      if (!fs.existsSync(indexFile)) continue

      const indexDatabase = new DatabaseSync(indexFile, { readOnly: true })
      try {
        const materials = indexDatabase
          .prepare('SELECT material_id, updated_at FROM material WHERE current_content_hash IS NOT NULL')
          .all() as Array<{ material_id: string; updated_at: number }>
        const materialUpdatedAt = new Map(materials.map((material) => [material.material_id, material.updated_at]))

        for (const file of baseFiles) {
          const lastIndexedAt = materialUpdatedAt.get(file.id)
          if (lastIndexedAt === undefined) continue

          const data = JSON.parse(file.data) as KnowledgeItemData
          if (!data.source) continue

          records.set(normalizeComparablePath(data.source), {
            uniqueId: file.id,
            size: data.sourceFingerprint?.size || 0,
            mtimeMs: data.sourceFingerprint?.modifiedAt || file.updated_at,
            ext: path.extname(data.source),
            lastIndexedAt
          })
        }
      } finally {
        indexDatabase.close()
      }
    }
  } finally {
    database.close()
  }

  return { path: databaseFile, records }
}

function loadDirectoryIndex(
  config: DirectorySyncConfig,
  indexFile?: string
): {
  path?: string
  records: Map<string, KnowledgeDirectoryFileRecord>
} {
  if (!indexFile) {
    const databaseFile = getDefaultDatabaseFile()
    if (databaseFile) {
      return loadV2DirectoryIndex(databaseFile, config)
    }
  }

  const resolvedIndexFile = indexFile ? path.resolve(indexFile) : getDefaultIndexFile()
  const records = new Map<string, KnowledgeDirectoryFileRecord>()
  if (!resolvedIndexFile || !fs.existsSync(resolvedIndexFile)) {
    return { path: resolvedIndexFile, records }
  }

  const raw = fs.readFileSync(resolvedIndexFile, 'utf-8').trim()
  if (!raw) {
    return { path: resolvedIndexFile, records }
  }

  const data = JSON.parse(raw) as Record<
    string,
    Record<string, { root: string; files: Record<string, KnowledgeDirectoryFileRecord> }>
  >
  for (const base of Object.values(data)) {
    for (const directory of Object.values(base)) {
      for (const [filePath, record] of Object.entries(directory.files || {})) {
        records.set(normalizeComparablePath(filePath), record)
      }
    }
  }

  return { path: resolvedIndexFile, records }
}

function normalizeComparablePath(targetPath: string): string {
  const normalized = path.normalize(path.resolve(targetPath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isSupportedKnowledgeFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase()
  return supportedExtensions.has(ext)
}

async function scanRootFiles(rootPath: string): Promise<Array<{ path: string; stats: fs.Stats }>> {
  const found: Array<{ path: string; stats: fs.Stats }> = []

  async function visit(directory: string): Promise<void> {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }

      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }

      if (!entry.isFile() || !isSupportedKnowledgeFile(entry.name)) {
        continue
      }

      found.push({ path: entryPath, stats: await fs.promises.stat(entryPath) })
    }
  }

  await visit(rootPath)
  return found
}

function formatRelativePath(rootPath: string, targetPath: string): string {
  const relativePath = path.relative(rootPath, targetPath)
  return relativePath ? relativePath.replace(/\\/g, '/') : '.'
}

function getFolderDepth(relativePath: string): number {
  if (relativePath === '.') {
    return 0
  }

  return relativePath.split('/').filter(Boolean).length
}

function getRelativeSegments(rootPath: string, filePath: string): string[] {
  const relativePath = formatRelativePath(rootPath, filePath)
  return relativePath === '.' ? [] : relativePath.split('/').filter(Boolean)
}

function getDisplayGrouping(
  knowledgeBaseName: string,
  rootPath: string,
  rootName: string,
  filePath: string
): DisplayGrouping {
  const segments = getRelativeSegments(rootPath, filePath)

  if (knowledgeBaseName === '微信公众号' && segments.length > 1) {
    const accountName = segments[0]
    const folderPath = path.join(rootPath, accountName)
    const monthName = segments.length > 2 ? segments[1] : undefined

    return {
      folderPath,
      folderName: accountName,
      folderRelativePath: accountName,
      levelLabel: '公众号',
      subgroupLabel: '月份',
      subgroup: monthName
        ? {
            path: path.join(folderPath, monthName),
            name: monthName,
            relativePath: `${accountName}/${monthName}`
          }
        : undefined
    }
  }

  if (knowledgeBaseName === '得到课程') {
    const lessonName = segments.length > 1 ? segments[0] : undefined

    return {
      folderPath: rootPath,
      folderName: rootName,
      folderRelativePath: '.',
      levelLabel: '课程',
      subgroupLabel: '课时',
      subgroup: lessonName
        ? {
            path: path.join(rootPath, lessonName),
            name: lessonName,
            relativePath: lessonName
          }
        : undefined
    }
  }

  const childFolderName = segments.length > 1 ? segments[0] : undefined

  return {
    folderPath: rootPath,
    folderName: rootName,
    folderRelativePath: '.',
    levelLabel: '目录',
    subgroupLabel: childFolderName ? '子目录' : undefined,
    subgroup: childFolderName
      ? {
          path: path.join(rootPath, childFolderName),
          name: childFolderName,
          relativePath: childFolderName
        }
      : undefined
  }
}

function addFileStats(target: FolderDraft | SubgroupDraft, file: BrowserFile): void {
  target.fileCount += 1
  target.totalSize += file.size
  target.fileIds.push(file.id)
  if (file.indexed) {
    target.indexedCount += 1
  }
  if (file.mtimeMs > target.latestMtimeMs) {
    target.latestMtimeMs = file.mtimeMs
    target.latestFileId = file.id
  }
}

async function buildReportData(options: CliOptions): Promise<BrowserReportData> {
  const configPath = path.resolve(options.config)
  const outputPath = path.resolve(options.output)
  const config = readDirectorySyncConfig(configPath)
  const index = loadDirectoryIndex(config, options.indexFile)
  const roots: RootScanResult[] = []
  const files: BrowserFile[] = []
  const folderDrafts = new Map<string, FolderDraft>()
  let rootId = 0

  for (const [knowledgeBaseName, rootPaths] of Object.entries(config)) {
    for (const configuredRootPath of rootPaths) {
      const rootPath = path.resolve(configuredRootPath)
      const root: RootScanResult = {
        id: rootId,
        knowledgeBaseName,
        rootPath,
        name: path.basename(rootPath),
        exists: false,
        fileCount: 0,
        folderCount: 0
      }
      roots.push(root)
      rootId += 1

      console.error(`[${root.id + 1}] Scanning ${knowledgeBaseName}: ${rootPath}`)

      try {
        const rootStats = await fs.promises.stat(rootPath)
        if (!rootStats.isDirectory()) {
          root.error = 'Path exists but is not a directory'
          continue
        }

        root.exists = true
        const scannedFiles = await scanRootFiles(rootPath)
        root.fileCount = scannedFiles.length

        for (const scannedFile of scannedFiles) {
          const normalizedPath = normalizeComparablePath(scannedFile.path)
          const indexedRecord = index.records.get(normalizedPath)
          const file: BrowserFile = {
            id: files.length,
            knowledgeBaseName,
            rootId: root.id,
            rootName: root.name,
            rootPath,
            folderPath: path.dirname(scannedFile.path),
            relativePath: formatRelativePath(rootPath, scannedFile.path),
            name: path.basename(scannedFile.path),
            path: scannedFile.path,
            url: pathToFileURL(scannedFile.path).href,
            ext: path.extname(scannedFile.path),
            size: scannedFile.stats.size,
            mtimeMs: scannedFile.stats.mtimeMs,
            birthtimeMs: scannedFile.stats.birthtimeMs,
            indexed: Boolean(indexedRecord),
            publishedAt: extractPublishedAt(path.basename(scannedFile.path)),
            lastIndexedAt: indexedRecord?.lastIndexedAt,
            uniqueId: indexedRecord?.uniqueId
          }
          files.push(file)

          if (!root.latestMtimeMs || file.mtimeMs > root.latestMtimeMs) {
            root.latestMtimeMs = file.mtimeMs
            root.latestFileId = file.id
          }

          const grouping = getDisplayGrouping(knowledgeBaseName, rootPath, root.name, scannedFile.path)
          const folderKey = `${root.id}:${normalizeComparablePath(grouping.folderPath)}`
          let folder = folderDrafts.get(folderKey)
          if (!folder) {
            folder = {
              id: folderDrafts.size,
              knowledgeBaseName,
              rootId: root.id,
              rootName: root.name,
              rootPath,
              path: grouping.folderPath,
              name: grouping.folderName,
              relativePath: grouping.folderRelativePath,
              levelLabel: grouping.levelLabel,
              subgroupLabel: grouping.subgroupLabel,
              depth: getFolderDepth(grouping.folderRelativePath),
              isRoot: grouping.folderRelativePath === '.',
              fileCount: 0,
              totalSize: 0,
              indexedCount: 0,
              latestFileId: file.id,
              latestMtimeMs: file.mtimeMs,
              fileIds: [],
              subgroups: new Map()
            }
            folderDrafts.set(folderKey, folder)
          }

          addFileStats(folder, file)

          if (grouping.subgroup) {
            const subgroupKey = normalizeComparablePath(grouping.subgroup.path)
            let subgroup = folder.subgroups.get(subgroupKey)
            if (!subgroup) {
              subgroup = {
                id: folder.subgroups.size,
                name: grouping.subgroup.name,
                path: grouping.subgroup.path,
                relativePath: grouping.subgroup.relativePath,
                fileCount: 0,
                totalSize: 0,
                indexedCount: 0,
                latestFileId: file.id,
                latestMtimeMs: file.mtimeMs,
                fileIds: []
              }
              folder.subgroups.set(subgroupKey, subgroup)
            }

            addFileStats(subgroup, file)
          }
        }
      } catch (error) {
        root.error = (error as Error).message
      }
    }
  }

  const folders = Array.from(folderDrafts.values()).map((folder): BrowserFolder => {
    folder.fileIds.sort((left, right) => compareFilesByPublishedAt(files[left], files[right]))
    const subgroups = Array.from(folder.subgroups.values()).map((subgroup): BrowserSubgroup => {
      subgroup.fileIds.sort((left, right) => compareFilesByPublishedAt(files[left], files[right]))
      return {
        ...subgroup,
        url: pathToFileURL(subgroup.path).href
      }
    })
    subgroups.sort(
      (left, right) => right.latestMtimeMs - left.latestMtimeMs || left.name.localeCompare(right.name, 'zh-CN')
    )

    return {
      ...folder,
      url: pathToFileURL(folder.path).href,
      subgroups
    }
  })
  folders.sort((left, right) => right.latestMtimeMs - left.latestMtimeMs || left.path.localeCompare(right.path))

  for (const root of roots) {
    root.folderCount = folders.filter((folder) => folder.rootId === root.id).length
  }

  const indexedFiles = files.filter((file) => file.indexed).length

  return {
    generatedAt: new Date().toISOString(),
    configPath,
    outputPath,
    supportedExtensions: Array.from(supportedExtensions).sort(),
    index: {
      available: Boolean(index.path && fs.existsSync(index.path)),
      path: index.path,
      recordCount: index.records.size
    },
    stats: {
      roots: roots.length,
      missingRoots: roots.filter((root) => !root.exists).length,
      files: files.length,
      folders: folders.length,
      indexedFiles,
      totalSize: files.reduce((total, file) => total + file.size, 0)
    },
    roots,
    folders,
    files
  }
}

function buildHtml(data: BrowserReportData): string {
  const safeJson = JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cherry 知识库 Browser</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7fb;
      --card: #ffffff;
      --text: #1f2430;
      --muted: #687083;
      --border: #e2e6ef;
      --accent: #d83b70;
      --accent-soft: #ffe9f0;
      --ok: #17803d;
      --warn: #a65f00;
      --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #11131a;
        --card: #191c25;
        --text: #eff2f7;
        --muted: #a1a8b8;
        --border: #2b3040;
        --accent: #ff78a2;
        --accent-soft: #351926;
        --ok: #68d391;
        --warn: #f6ad55;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      line-height: 1.5;
    }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--bg) 88%, transparent);
      backdrop-filter: blur(14px);
    }
    .wrap { max-width: 1280px; margin: 0 auto; padding: 20px; }
    h1 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.03em; }
    .subtitle { margin: 0; color: var(--muted); }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(240px, 1fr) auto auto;
      gap: 10px;
      align-items: center;
      margin-top: 16px;
    }
    input, select, button {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--card);
      color: var(--text);
      font: inherit;
    }
    input, select { padding: 10px 12px; }
    button {
      padding: 8px 10px;
      cursor: pointer;
    }
    button:hover { border-color: var(--accent); color: var(--accent); }
    label.toggle {
      display: flex;
      gap: 7px;
      align-items: center;
      color: var(--muted);
      white-space: nowrap;
      user-select: none;
    }
    label.toggle input { margin: 0; }
    .stats {
      display: grid;
      grid-template-columns: repeat(6, minmax(0, 1fr));
      gap: 10px;
      margin-top: 18px;
    }
    .stat, .folder {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: var(--card);
      box-shadow: 0 8px 30px color-mix(in srgb, #000 7%, transparent);
    }
    .stat { padding: 14px; }
    .stat .value { font-size: 24px; font-weight: 750; letter-spacing: -0.03em; }
    .stat .label { color: var(--muted); font-size: 13px; }
    .folder { margin: 12px 0; overflow: hidden; }
    details.folder summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 15px 16px;
      cursor: pointer;
      list-style: none;
    }
    details.folder summary::-webkit-details-marker { display: none; }
    .folder-title {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }
    .folder-title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 17px;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
    .badge {
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      padding: 3px 8px;
      font-size: 12px;
      white-space: nowrap;
    }
    .badge.muted { background: transparent; color: var(--muted); border: 1px solid var(--border); }
    .badge.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
    .badge.warn { background: color-mix(in srgb, var(--warn) 18%, transparent); color: var(--warn); }
    .folder-meta {
      padding: 0 16px 14px;
      color: var(--muted);
      font-size: 13px;
    }
    .pathline {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
      margin: 8px 0;
      font-family: var(--mono);
      font-size: 12px;
    }
    .pathline code {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
      color: var(--muted);
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .subgroups {
      display: grid;
      gap: 10px;
      padding: 0 16px 16px;
    }
    details.subgroup {
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      background: color-mix(in srgb, var(--card) 88%, var(--bg));
    }
    details.subgroup summary {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      padding: 10px 12px;
      cursor: pointer;
      list-style: none;
    }
    details.subgroup summary::-webkit-details-marker { display: none; }
    .subgroup-title {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 650;
    }
    .subgroup-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      justify-content: flex-end;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    th, td {
      padding: 8px 10px;
      border-top: 1px solid var(--border);
      vertical-align: top;
      text-align: left;
    }
    th { color: var(--muted); font-weight: 650; }
    td.time, td.size, td.index { white-space: nowrap; color: var(--muted); }
    td.file a {
      display: inline-block;
      max-width: 760px;
      overflow: hidden;
      text-overflow: ellipsis;
      vertical-align: bottom;
      white-space: nowrap;
    }
    .empty, .note {
      border: 1px dashed var(--border);
      border-radius: 16px;
      padding: 22px;
      color: var(--muted);
      background: var(--card);
    }
    .warning-list {
      margin: 18px 0 0;
      padding: 12px 16px;
      border: 1px solid color-mix(in srgb, var(--warn) 35%, var(--border));
      border-radius: 14px;
      background: color-mix(in srgb, var(--warn) 9%, transparent);
      color: var(--warn);
      font-size: 13px;
    }
    .load-more { width: 100%; margin: 16px 0 0; padding: 12px; }
    .small { font-size: 12px; color: var(--muted); }
    @media (max-width: 900px) {
      .toolbar { grid-template-columns: 1fr; }
      .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      details.folder summary { grid-template-columns: 1fr; }
      .badges { justify-content: flex-start; }
      td.file a { max-width: 52vw; }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <h1>Cherry 知识库 Browser</h1>
      <p class="subtitle" id="subtitle"></p>
      <div class="toolbar">
        <input id="search" type="search" placeholder="搜索知识库名、文件夹、文件名、路径…" autofocus />
        <select id="sort">
          <option value="latest">最新 Item 优先</option>
          <option value="name">名称 A-Z</option>
          <option value="count">文件数多优先</option>
          <option value="coverage">索引缺口多优先</option>
        </select>
        <label class="toggle"><input id="missingOnly" type="checkbox" /> 只看疑似未入库</label>
      </div>
      <div class="stats" id="stats"></div>
      <div id="warnings"></div>
    </div>
  </header>
  <main class="wrap">
    <div id="resultInfo" class="small"></div>
    <div id="folders"></div>
    <button id="loadMore" class="load-more" type="button">显示更多</button>
  </main>
  <script>window.KNOWLEDGE_BROWSER_DATA = ${safeJson};</script>
  <script>
    (() => {
      const data = window.KNOWLEDGE_BROWSER_DATA
      const fileSearchCache = new Map()
      let renderLimit = 80

      const $ = (id) => document.getElementById(id)
      const formatNumber = (value) => new Intl.NumberFormat('zh-CN').format(value)
      const formatTime = (value) => value ? new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(value)) : '—'
      const formatBytes = (bytes) => {
        if (!bytes) return '0 B'
        const units = ['B', 'KB', 'MB', 'GB', 'TB']
        let value = bytes
        let unit = 0
        while (value >= 1024 && unit < units.length - 1) {
          value /= 1024
          unit += 1
        }
        return (unit === 0 ? value.toFixed(0) : value.toFixed(1)) + ' ' + units[unit]
      }
      const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char])

      function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).catch(() => fallbackCopy(text))
          return
        }
        fallbackCopy(text)
      }

      function fallbackCopy(text) {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }

      function fileSearchText(id) {
        if (fileSearchCache.has(id)) return fileSearchCache.get(id)
        const file = data.files[id]
        const value = [
          file.knowledgeBaseName,
          file.rootName,
          file.name,
          file.relativePath,
          file.path,
          file.ext
        ].join('\\n').toLowerCase()
        fileSearchCache.set(id, value)
        return value
      }

      function folderMatches(folder, terms) {
        if (terms.length === 0) return true
        const folderText = [
          folder.knowledgeBaseName,
          folder.rootName,
          folder.name,
          folder.levelLabel,
          folder.relativePath,
          folder.path,
          ...folder.subgroups.flatMap((subgroup) => [subgroup.name, subgroup.relativePath, subgroup.path])
        ].join('\\n').toLowerCase()

        return terms.every((term) => {
          if (folderText.includes(term)) return true
          return folder.fileIds.some((id) => fileSearchText(id).includes(term))
        })
      }

      function getVisibleFolders() {
        const query = $('search').value.trim().toLowerCase()
        const terms = query ? query.split(/\\s+/).filter(Boolean) : []
        const missingOnly = $('missingOnly').checked
        const sortMode = $('sort').value
        const folders = data.folders.filter((folder) => {
          if (missingOnly && data.index.available && folder.indexedCount >= folder.fileCount) return false
          return folderMatches(folder, terms)
        })

        folders.sort((left, right) => {
          if (sortMode === 'name') return left.name.localeCompare(right.name, 'zh-CN')
          if (sortMode === 'count') return right.fileCount - left.fileCount || right.latestMtimeMs - left.latestMtimeMs
          if (sortMode === 'coverage') {
            const leftMissing = left.fileCount - left.indexedCount
            const rightMissing = right.fileCount - right.indexedCount
            return rightMissing - leftMissing || right.latestMtimeMs - left.latestMtimeMs
          }
          return right.latestMtimeMs - left.latestMtimeMs || left.path.localeCompare(right.path)
        })

        return folders
      }

      function renderStats() {
        $('subtitle').textContent = '生成于 ' + formatTime(data.generatedAt) + ' · 配置：' + data.configPath
        const stats = [
          ['配置目录', data.stats.roots],
          ['展示项', data.stats.folders],
          ['文件', data.stats.files],
          ['疑似已入库', data.stats.indexedFiles],
          ['总大小', formatBytes(data.stats.totalSize)],
          ['索引记录', data.index.available ? data.index.recordCount : '未读取']
        ]
        $('stats').innerHTML = stats.map(([label, value]) =>
          '<div class="stat"><div class="value">' + escapeHtml(typeof value === 'number' ? formatNumber(value) : value) +
          '</div><div class="label">' + escapeHtml(label) + '</div></div>'
        ).join('')

        const warnings = []
        if (!data.index.available) {
          warnings.push('没有读取到 Cherry v2 SQLite 索引；页面仍可按原始目录浏览，但“是否入库”只能显示为未知/未入库。')
        }
        for (const root of data.roots) {
          if (!root.exists || root.error) {
            warnings.push(root.knowledgeBaseName + ' · ' + root.rootPath + '：' + (root.error || '目录不存在'))
          }
        }
        $('warnings').innerHTML = warnings.length
          ? '<div class="warning-list">' + warnings.map((warning) => '<div>⚠ ' + escapeHtml(warning) + '</div>').join('') + '</div>'
          : ''
        $('missingOnly').disabled = !data.index.available
      }

      function renderFolder(folder) {
        const latest = data.files[folder.latestFileId]
        const missing = folder.fileCount - folder.indexedCount
        const indexBadge = data.index.available
          ? '<span class="badge ' + (missing ? 'warn' : 'ok') + '">索引 ' + formatNumber(folder.indexedCount) + '/' + formatNumber(folder.fileCount) + '</span>'
          : '<span class="badge muted">索引未知</span>'
        const body = folder.subgroups.length > 0
          ? '<div class="subgroups">' + folder.subgroups.map((subgroup) => renderSubgroup(folder, subgroup)).join('') + '</div>'
          : '<table><thead><tr><th>修改时间</th><th>文件</th><th>大小</th><th>索引</th><th>操作</th></tr></thead><tbody>' +
            folder.fileIds.slice(0, 80).map((id) => renderFileRow(data.files[id])).join('') +
            '</tbody></table>'
        const overflow = folder.subgroups.length === 0 && folder.fileIds.length > 80
          ? '<div class="folder-meta">仅显示最新 80 个文件；此项还有 ' + formatNumber(folder.fileIds.length - 80) + ' 个更早文件，可用搜索框继续缩小范围。</div>'
          : ''

        return '<details class="folder">' +
          '<summary>' +
            '<div class="folder-title">' +
              '<strong title="' + escapeHtml(folder.path) + '">' + escapeHtml(folder.name) + '</strong>' +
              '<span class="badge muted">' + escapeHtml(folder.knowledgeBaseName) + '</span>' +
              '<span class="badge muted">' + escapeHtml(folder.levelLabel) + '</span>' +
              (folder.subgroups.length > 0 ? '<span class="badge muted">' + escapeHtml(folder.subgroupLabel || '子分组') + ' ' + formatNumber(folder.subgroups.length) + '</span>' : '') +
            '</div>' +
            '<div class="badges">' +
              '<span class="badge">最新 ' + escapeHtml(formatTime(folder.latestMtimeMs)) + '</span>' +
              '<span class="badge muted">' + formatNumber(folder.fileCount) + ' 文件</span>' +
              '<span class="badge muted">' + escapeHtml(formatBytes(folder.totalSize)) + '</span>' +
              indexBadge +
            '</div>' +
          '</summary>' +
          '<div class="folder-meta">' +
            '<div class="pathline"><code title="' + escapeHtml(folder.path) + '">' + escapeHtml(folder.path) + '</code>' +
              '<a href="' + escapeHtml(folder.url) + '">打开文件夹</a>' +
              '<button type="button" data-copy="' + escapeHtml(folder.path) + '">复制路径</button>' +
            '</div>' +
            '<div>最新 Item：<a href="' + escapeHtml(latest.url) + '">' + escapeHtml(latest.relativePath) + '</a> · ' +
              escapeHtml(formatBytes(latest.size)) + ' · ' + escapeHtml(formatTime(latest.mtimeMs)) + '</div>' +
          '</div>' +
          body +
          overflow +
        '</details>'
      }

      function renderSubgroup(folder, subgroup) {
        const missing = subgroup.fileCount - subgroup.indexedCount
        const indexBadge = data.index.available
          ? '<span class="badge ' + (missing ? 'warn' : 'ok') + '">索引 ' + formatNumber(subgroup.indexedCount) + '/' + formatNumber(subgroup.fileCount) + '</span>'
          : '<span class="badge muted">索引未知</span>'
        const rows = subgroup.fileIds.slice(0, 60).map((id) => renderFileRow(data.files[id])).join('')
        const overflow = subgroup.fileIds.length > 60
          ? '<div class="folder-meta">仅显示最新 60 个文件；此' + escapeHtml(folder.subgroupLabel || '分组') + '还有 ' + formatNumber(subgroup.fileIds.length - 60) + ' 个更早文件。</div>'
          : ''

        return '<details class="subgroup">' +
          '<summary>' +
            '<span class="subgroup-title" title="' + escapeHtml(subgroup.path) + '">' + escapeHtml(subgroup.name) + '</span>' +
            '<span class="subgroup-meta">' +
              '<span class="badge">最新 ' + escapeHtml(formatTime(subgroup.latestMtimeMs)) + '</span>' +
              '<span class="badge muted">' + formatNumber(subgroup.fileCount) + ' 文件</span>' +
              '<span class="badge muted">' + escapeHtml(formatBytes(subgroup.totalSize)) + '</span>' +
              indexBadge +
              '<a class="badge muted" href="' + escapeHtml(subgroup.url) + '">打开</a>' +
            '</span>' +
          '</summary>' +
          '<table><thead><tr><th>修改时间</th><th>文件</th><th>大小</th><th>索引</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
          overflow +
        '</details>'
      }

      function renderFileRow(file) {
        const indexText = data.index.available
          ? (file.indexed ? '✓ ' + formatTime(file.lastIndexedAt) : '—')
          : '未知'
        return '<tr>' +
          '<td class="time">' + escapeHtml(formatTime(file.mtimeMs)) + '</td>' +
          '<td class="file"><a href="' + escapeHtml(file.url) + '" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.relativePath) + '</a></td>' +
          '<td class="size">' + escapeHtml(formatBytes(file.size)) + '</td>' +
          '<td class="index">' + escapeHtml(indexText) + '</td>' +
          '<td><button type="button" data-copy="' + escapeHtml(file.path) + '">复制路径</button></td>' +
        '</tr>'
      }

      function renderFolders() {
        const visible = getVisibleFolders()
        const shown = visible.slice(0, renderLimit)
        $('resultInfo').textContent = '显示 ' + formatNumber(shown.length) + ' / ' + formatNumber(visible.length) + ' 个展示项'
        $('folders').innerHTML = shown.length
          ? shown.map(renderFolder).join('')
          : '<div class="empty">没有匹配的文件夹。换个关键词试试，或者取消筛选。</div>'
        $('loadMore').style.display = visible.length > shown.length ? 'block' : 'none'
      }

      function resetAndRender() {
        renderLimit = 80
        renderFolders()
      }

      $('search').addEventListener('input', resetAndRender)
      $('sort').addEventListener('change', resetAndRender)
      $('missingOnly').addEventListener('change', resetAndRender)
      $('loadMore').addEventListener('click', () => {
        renderLimit += 80
        renderFolders()
      })
      document.addEventListener('click', (event) => {
        const target = event.target
        if (target instanceof HTMLElement && target.dataset.copy) {
          copyText(target.dataset.copy)
          target.textContent = '已复制'
          setTimeout(() => {
            target.textContent = '复制路径'
          }, 900)
        }
      })

      renderStats()
      renderFolders()
    })()
  </script>
</body>
</html>
`
}

async function writeReport(data: BrowserReportData): Promise<void> {
  await fs.promises.mkdir(path.dirname(data.outputPath), { recursive: true })
  await fs.promises.writeFile(data.outputPath, buildHtml(data), 'utf-8')
}

function openFile(filePath: string): void {
  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', filePath] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [filePath] }
        : { file: 'xdg-open', args: [filePath] }
  const child = spawn(command.file, command.args, {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const data = await buildReportData(options)
  await writeReport(data)

  console.log(
    JSON.stringify(
      {
        output: data.outputPath,
        roots: data.stats.roots,
        folders: data.stats.folders,
        files: data.stats.files,
        indexed_files: data.stats.indexedFiles,
        index_file: data.index.path || null,
        index_available: data.index.available
      },
      null,
      2
    )
  )

  if (options.open) {
    openFile(data.outputPath)
  }
}

main().catch((error) => {
  console.error((error as Error).message)
  process.exitCode = 1
})
