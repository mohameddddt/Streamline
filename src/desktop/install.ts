import { desktopApi } from './api'

// Must run before the app's first render reads `window.api`.
window.api = desktopApi
