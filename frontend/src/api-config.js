const PRODUCTION_API_URL = 'https://meet-up-realtime-communication.onrender.com'
const DEVELOPMENT_API_URL = 'http://localhost:5000'

export function resolveApiUrl({
  configuredApiUrl,
  isProduction,
  frontendOrigin,
}) {
  const fallback = isProduction ? PRODUCTION_API_URL : DEVELOPMENT_API_URL
  const configured = configuredApiUrl?.trim()
  if (!configured) return fallback

  try {
    const configuredOrigin = new URL(configured, frontendOrigin).origin
    const isFrontendOrigin = configuredOrigin === frontendOrigin
    const isLocalhost =
      configuredOrigin.startsWith('http://localhost:') ||
      configuredOrigin.startsWith('http://127.0.0.1:')
    if (isProduction && (isFrontendOrigin || isLocalhost)) return fallback
  } catch {
    return fallback
  }

  return configured.replace(/\/+$/, '')
}
