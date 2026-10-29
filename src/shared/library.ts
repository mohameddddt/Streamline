import type { LibraryBackup, LibraryItem, ProgressEntry, RatingEntry, Stream } from './types'

/**
 * The library as it is stored, plus every change that can be made to it. Pure
 * functions over a plain object, so the desktop build can keep it in a JSON file
 * and the web build in localStorage, and both behave identically.
 */
export interface LibraryFile {
  items: Record<string, LibraryItem>
  progress: Record<string, ProgressEntry>
  ratings: Record<string, RatingEntry>
  /** progress-style key -> the source the user last played for it. */
  lastStreams: Record<string, { stream: Stream; playedAt: number }>
}

export function emptyLibrary(): LibraryFile {
  return { items: {}, progress: {}, ratings: {}, lastStreams: {} }
}

export function listLibrary(lib: LibraryFile): {
  items: LibraryItem[]
  progress: ProgressEntry[]
  ratings: RatingEntry[]
} {
  return {
    items: Object.values(lib.items).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)),
    progress: Object.values(lib.progress).sort((a, b) => b.updatedAt - a.updatedAt),
    ratings: Object.values(lib.ratings).sort((a, b) => b.ratedAt - a.ratedAt)
  }
}

/**
 * Merges imported history. Anything the user already has wins over the import:
 * an existing finished entry is left alone, and an unfinished one keeps its
 * resume position while being marked watched.
 */
export function mergeImport(
  lib: LibraryFile,
  batch: { items: LibraryItem[]; progress: ProgressEntry[]; ratings: RatingEntry[] }
): void {
  for (const item of batch.items) {
    if (!lib.items[item.key]) lib.items[item.key] = item
  }
  for (const entry of batch.progress) {
    const existing = lib.progress[entry.key]
    if (!existing) lib.progress[entry.key] = entry
    else if (!existing.finished) existing.finished = true
  }
  for (const rating of batch.ratings) lib.ratings[rating.key] = rating
}

/** Restoring a backup: whichever side touched an entry last keeps it. */
export function mergeBackup(lib: LibraryFile, backup: LibraryBackup): number {
  if (backup?.app !== 'streamline') throw new Error('That file is not a Streamline backup.')
  let changed = 0
  for (const item of backup.items ?? []) {
    if (!lib.items[item.key]) {
      lib.items[item.key] = item
      changed++
    }
  }
  for (const entry of backup.progress ?? []) {
    const existing = lib.progress[entry.key]
    if (!existing || existing.updatedAt < entry.updatedAt) {
      lib.progress[entry.key] = entry
      changed++
    }
  }
  for (const rating of backup.ratings ?? []) {
    const existing = lib.ratings[rating.key]
    if (!existing || existing.ratedAt < rating.ratedAt) {
      lib.ratings[rating.key] = rating
      changed++
    }
  }
  return changed
}

export function makeBackup(lib: LibraryFile): LibraryBackup {
  return { app: 'streamline', version: 1, exportedAt: Date.now(), ...listLibrary(lib) }
}

export function toggleFavorite(lib: LibraryFile, item: LibraryItem): boolean {
  const key = `${item.type}:${item.id}`
  if (lib.items[key]) {
    delete lib.items[key]
    return false
  }
  lib.items[key] = { ...item, key, favorite: true, addedAt: Date.now() }
  return true
}

export function setProgress(lib: LibraryFile, entry: ProgressEntry): void {
  // Past 95% counts as watched. The entry stays so it can show up as history.
  const finished = entry.duration > 0 && entry.time / entry.duration > 0.95
  lib.progress[entry.key] = { ...entry, finished, updatedAt: Date.now() }
}

/**
 * Flips an entry's watched flag. With no entry yet (an episode never opened),
 * `seed` describes the title so a finished one can be created.
 */
export interface WatchChange {
  key: string
  watched: boolean
  seed?: Omit<ProgressEntry, 'time' | 'duration' | 'updatedAt'>
}

/** A whole season or show at once, in one write. */
export function markManyWatched(lib: LibraryFile, changes: WatchChange[]): void {
  for (const c of changes) markWatched(lib, c.key, c.watched, c.seed)
}

export function markWatched(
  lib: LibraryFile,
  key: string,
  watched: boolean,
  seed?: Omit<ProgressEntry, 'time' | 'duration' | 'updatedAt'>
): void {
  const entry = lib.progress[key]
  if (entry) {
    entry.finished = watched
    entry.updatedAt = Date.now()
    return
  }
  if (watched && seed) {
    lib.progress[key] = { ...seed, key, time: 0, duration: 0, updatedAt: Date.now(), finished: true }
  }
}

export function clearProgress(lib: LibraryFile, key: string): void {
  delete lib.progress[key]
}

/** `rating` null clears it. */
export function setRating(
  lib: LibraryFile,
  entry: Omit<RatingEntry, 'rating' | 'ratedAt' | 'source'>,
  rating: number | null
): void {
  if (rating === null) {
    delete lib.ratings[entry.key]
    return
  }
  lib.ratings[entry.key] = {
    ...entry,
    rating: Math.max(1, Math.min(10, Math.round(rating))),
    ratedAt: Date.now(),
    source: 'streamline'
  }
}

export function getLastStream(lib: LibraryFile, key: string): Stream | null {
  return lib.lastStreams[key]?.stream ?? null
}

export function setLastStream(lib: LibraryFile, key: string, stream: Stream): void {
  lib.lastStreams[key] = { stream, playedAt: Date.now() }
}
