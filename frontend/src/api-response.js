export function parseApiResponseText(text, status) {
  try {
    return JSON.parse(text)
  } catch {
    return {
      error: `The server returned an unexpected response (HTTP ${status}).`,
    }
  }
}

export async function readApiResponse(response) {
  return parseApiResponseText(await response.text(), response.status)
}
