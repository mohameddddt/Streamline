import { createAddonClient } from '../shared/addons'
import { getSettings } from './settings'

export type { CatalogRef } from '../shared/addons'

const client = createAddonClient({
  addonUrls: () => getSettings().addons,
  headers: { 'user-agent': 'Streamline/0.3' }
})

export const {
  getManifest,
  getManifests,
  forgetManifests,
  listCatalogs,
  getCatalog,
  search,
  getMeta,
  getStreams,
  getSubtitles,
  fetchSubtitleAsVtt
} = client
