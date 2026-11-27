import type { StreamlineApi } from '../../shared/api'

declare global {
  interface Window {
    api: StreamlineApi
  }
}

export {}
