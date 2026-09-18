import type { StreamlineApi } from '../../preload/index'

declare global {
  interface Window {
    api: StreamlineApi
  }
}

export {}
