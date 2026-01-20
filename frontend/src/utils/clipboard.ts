/**
 * Copy text to clipboard with fallback for non-HTTPS environments
 * navigator.clipboard API is only available in secure contexts (HTTPS)
 * This utility provides a fallback using execCommand for HTTP environments
 */
export async function copyToClipboard(text: string): Promise<void> {
  // Try modern clipboard API first (only works in HTTPS)
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  // Fallback for HTTP environments using execCommand
  const textArea = document.createElement('textarea')
  textArea.value = text

  // Avoid scrolling to bottom
  textArea.style.top = '0'
  textArea.style.left = '0'
  textArea.style.position = 'fixed'
  textArea.style.opacity = '0'

  document.body.appendChild(textArea)
  textArea.focus()
  textArea.select()

  try {
    const successful = document.execCommand('copy')
    if (!successful) {
      throw new Error('execCommand copy failed')
    }
  } finally {
    document.body.removeChild(textArea)
  }
}
