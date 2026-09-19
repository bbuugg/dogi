import type { Api } from './tauri/api'

declare global {
  interface Window {
    api: Api
  }
}

export {}
