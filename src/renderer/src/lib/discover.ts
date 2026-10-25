import type { MetaPreview } from '../../../shared/types'
import type { CatalogRef } from '../../../shared/addons'

let catalogsPromise: Promise<CatalogRef[]> | null = null

/** The installed catalogs that can be browsed without a search term. */
export function browsableCatalogs(fresh = false): Promise<CatalogRef[]> {
  if (fresh || !catalogsPromise) {
    catalogsPromise = window.api.addons
      .catalogs()
      .then((list) => list.filter((c) => !c.requiresSearch && !c.requiresOther))
      .catch((err) => {
        catalogsPromise = null
        throw err
      })
  }
  return catalogsPromise
}

/** A random, well-rated title from a random catalog. */
export async function surprisePick(type?: string): Promise<MetaPreview | null> {
  const catalogs = (await browsableCatalogs()).filter(
    (c) => (type ? c.type === type : c.type === 'movie' || c.type === 'series')
  )
  if (!catalogs.length) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    const cat = catalogs[Math.floor(Math.random() * catalogs.length)]
    const skip = cat.pageable ? Math.floor(Math.random() * 4) * 100 : undefined
    const metas = await catalogItems(cat, skip ? { skip: String(skip) } : undefined).catch(
      () => [] as MetaPreview[]
    )
    const good = metas.filter((m) => m.poster && (!m.imdbRating || Number(m.imdbRating) >= 6.5))
    const pool = good.length ? good : metas
    if (pool.length) return pool[Math.floor(Math.random() * pool.length)]
  }
  return null
}

const CATALOG_TTL = 1000 * 60 * 10
const catalogCache = new Map<string, { at: number; items: Promise<MetaPreview[]> }>()

/** Catalog pages, remembered for a few minutes so going back is instant. */
export function catalogItems(
  cat: Pick<CatalogRef, 'addonUrl' | 'type' | 'id'>,
  extra?: Record<string, string>
): Promise<MetaPreview[]> {
  const key = `${cat.addonUrl}|${cat.type}|${cat.id}|${JSON.stringify(extra ?? {})}`
  const hit = catalogCache.get(key)
  if (hit && Date.now() - hit.at < CATALOG_TTL) return hit.items
  const items = window.api.addons.catalog(cat.addonUrl, cat.type, cat.id, extra)
  items.catch(() => catalogCache.delete(key))
  catalogCache.set(key, { at: Date.now(), items })
  return items
}

/** Cinemeta-style artwork for IMDb ids, when an addon left a field out. */
export function backdropFor(meta: { id: string; background?: string; poster?: string }): string | undefined {
  if (meta.background) return meta.background
  if (meta.id.startsWith('tt')) return `https://images.metahub.space/background/medium/${meta.id}/img`
  return meta.poster
}

export function logoFor(meta: { id: string; logo?: string }): string | undefined {
  if (meta.logo) return meta.logo
  if (meta.id.startsWith('tt')) return `https://images.metahub.space/logo/medium/${meta.id}/img`
  return undefined
}

export const typeLabel = (type: string): string =>
  type === 'movie' ? 'Films' : type === 'series' ? 'Series' : type.charAt(0).toUpperCase() + type.slice(1)
