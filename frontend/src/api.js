import { parseApiResponseText, readApiResponse } from './api-response'
import { resolveApiUrl } from './api-config'

const frontendOrigin = typeof window === 'undefined' ? '' : window.location.origin
export const API_URL = resolveApiUrl({
  configuredApiUrl: import.meta.env.VITE_API_URL,
  isProduction: import.meta.env.PROD,
  frontendOrigin,
})

export function apiFetch(path, options = {}) {
  return fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
  })
}

export { parseApiResponseText, readApiResponse }
