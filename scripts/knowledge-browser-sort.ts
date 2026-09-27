export interface PublishedFileLike {
  name: string
  mtimeMs: number
  publishedAt?: string
}

const publishedDatePattern = /(?:^|_)(\d{4}-\d{2}-\d{2})(?=_|\.|$)/

export function extractPublishedAt(fileName: string): string | undefined {
  return fileName.match(publishedDatePattern)?.[1]
}

export function compareFilesByPublishedAt(left: PublishedFileLike, right: PublishedFileLike): number {
  const leftPublishedAt = left.publishedAt || extractPublishedAt(left.name)
  const rightPublishedAt = right.publishedAt || extractPublishedAt(right.name)

  if (leftPublishedAt && rightPublishedAt) {
    const dateComparison = rightPublishedAt.localeCompare(leftPublishedAt)
    if (dateComparison !== 0) {
      return dateComparison
    }
  } else if (leftPublishedAt) {
    return -1
  } else if (rightPublishedAt) {
    return 1
  }

  return right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name, 'zh-CN')
}
