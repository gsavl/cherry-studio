import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

const DEFAULT_CONFIG = 'kb-dirs.yaml'
const DEFAULT_SOURCE = 'Z:\\007 Podcasts\\_cherry_knowledge_inputs\\preferred\\general'
const PODCAST_KNOWLEDGE_BASE = '播客'

interface CliOptions {
  config: string
  source: string
  dryRun: boolean
}

interface SyncResult {
  added: string[]
  discovered: number
}

function usage(): string {
  return [
    'Usage:',
    '  pnpm tsx scripts/sync-podcast-directories.ts [--config kb-dirs.yaml] [--source <directory>] [--dry-run]'
  ].join('\n')
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    config: DEFAULT_CONFIG,
    source: DEFAULT_SOURCE,
    dryRun: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const readValue = (): string => {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}`)
      }

      index += 1
      return value
    }

    switch (argument) {
      case '--config':
        options.config = readValue()
        break
      case '--source':
        options.source = readValue()
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
      default:
        throw new Error(`Unknown option: ${argument}`)
    }
  }

  return options
}

function normalizePath(value: string): string {
  return path.win32
    .normalize(value)
    .replace(/[\\/]+$/, '')
    .toLowerCase()
}

function quoteYamlScalar(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function getNewPodcastDirectories(existingPaths: string[], discoveredPaths: string[]): string[] {
  const knownPaths = new Set(existingPaths.map(normalizePath))

  return discoveredPaths.filter((directoryPath) => {
    const normalizedPath = normalizePath(directoryPath)
    if (knownPaths.has(normalizedPath)) {
      return false
    }

    knownPaths.add(normalizedPath)
    return true
  })
}

export function appendPodcastDirectories(configText: string, directoryPaths: string[]): string {
  if (directoryPaths.length === 0) {
    return configText
  }

  const lineEnding = configText.includes('\r\n') ? '\r\n' : '\n'
  const hasTrailingLineEnding = configText.endsWith('\n')
  const lines = configText.split(/\r?\n/)
  const podcastHeaderIndex = lines.findIndex((line) => /^播客:\s*(?:#.*)?$/.test(line))

  if (podcastHeaderIndex === -1) {
    throw new Error(`Knowledge base "${PODCAST_KNOWLEDGE_BASE}" was not found in the config`)
  }

  let insertIndex = podcastHeaderIndex + 1
  while (insertIndex < lines.length) {
    const line = lines[insertIndex]
    if (/^\s*-\s+/.test(line) || /^\s*(?:#.*)?$/.test(line)) {
      insertIndex += 1
      continue
    }

    break
  }

  lines.splice(insertIndex, 0, ...directoryPaths.map((directoryPath) => `  - ${quoteYamlScalar(directoryPath)}`))
  const result = lines.join(lineEnding)
  return hasTrailingLineEnding && !result.endsWith(lineEnding) ? `${result}${lineEnding}` : result
}

function getPodcastPaths(config: unknown, configPath: string): string[] {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid YAML config: ${configPath}`)
  }

  const entries = (config as Record<string, unknown>)[PODCAST_KNOWLEDGE_BASE]
  if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error(`Knowledge base "${PODCAST_KNOWLEDGE_BASE}" must be a list of directories: ${configPath}`)
  }

  return entries
}

async function discoverPodcastDirectories(sourcePath: string): Promise<string[]> {
  let entries: fs.Dirent[]
  try {
    entries = await fs.promises.readdir(sourcePath, { withFileTypes: true })
  } catch (error) {
    throw new Error(`Unable to read podcast source directory: ${sourcePath}. ${(error as Error).message}`)
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(sourcePath, entry.name))
    .sort((left, right) => left.localeCompare(right, 'zh-Hans-CN'))
}

export async function syncPodcastDirectories(options: CliOptions): Promise<SyncResult> {
  const configPath = path.resolve(options.config)
  const sourcePath = path.resolve(options.source)
  const configText = await fs.promises.readFile(configPath, 'utf8')
  const existingPaths = getPodcastPaths(parse(configText), configPath)
  const discoveredPaths = await discoverPodcastDirectories(sourcePath)
  const added = getNewPodcastDirectories(existingPaths, discoveredPaths)

  if (added.length > 0 && !options.dryRun) {
    await fs.promises.writeFile(configPath, appendPodcastDirectories(configText, added), 'utf8')
  }

  return { added, discovered: discoveredPaths.length }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const result = await syncPodcastDirectories(options)

  if (result.added.length === 0) {
    console.log(`Podcast directory list is current (${result.discovered} directories found).`)
    return
  }

  console.log(
    `${options.dryRun ? 'Would add' : 'Added'} ${result.added.length} podcast director${result.added.length === 1 ? 'y' : 'ies'}:`
  )
  for (const directoryPath of result.added) {
    console.log(`  ${directoryPath}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error((error as Error).message)
    process.exitCode = 1
  })
}
