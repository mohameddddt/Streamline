import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { createAddonClient, createMetaStore } from '../shared/addons'
import type { MetaDetail } from '../shared/types'
import { getSettings } from './settings'
import { isOffline } from './network'
import { archiveAddon } from '../shared/archive'
import { openMoviesAddon } from '../shared/openMovies'
import { localAddon } from './local'

export type { CatalogRef } from '../shared/addons'

const metaFile = (): string => path.join(app.getPath('userData'), 'meta-cache.json')

function readMetaCache(): Record<string, MetaDetail> {
  try {
    return JSON.parse(fs.readFileSync(metaFile(), 'utf8'))
  } catch {
    return {}
  }
}

const client = createAddonClient({
  offline: isOffline,
  metaStore: createMetaStore(readMetaCache(), (all) => {
    fs.promises.writeFile(metaFile(), JSON.stringify(all), 'utf8').catch(() => undefined)
  }),
  addonUrls: () => getSettings().addons,
  headers: { 'user-agent': 'Streamline/0.4' },
  builtins: [archiveAddon, openMoviesAddon, localAddon]
})

export const {
  getManifest,
  getManifests,
  forgetManifests,
  unreachable,
  wakeUp,
  listCatalogs,
  getCatalog,
  search,
  getMeta,
  getStreams,
  getSubtitles,
  fetchSubtitleAsVtt
} = client
