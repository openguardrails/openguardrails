/**
 * @deprecated This file is deprecated and kept only for backward compatibility.
 *
 * IP-based language detection has been removed to support offline/air-gapped deployments.
 * Language is now determined by:
 * 1. User preference (localStorage)
 * 2. Server configuration (DEFAULT_LANGUAGE in .env)
 * 3. Browser language
 *
 * See languageDetector.ts for the current implementation.
 */

/**
 * @deprecated Use getDefaultLanguageFromConfig() from languageDetector.ts instead
 */
export async function isFromChinaMainland(): Promise<boolean> {
  console.warn('isFromChinaMainland() is deprecated. Language is now determined by server config and user preference.');
  return false; // Default to English
}

/**
 * @deprecated Use getDefaultLanguageFromConfig() from languageDetector.ts instead
 */
export async function getLanguageFromIp(): Promise<'zh' | 'en'> {
  console.warn('getLanguageFromIp() is deprecated. Language is now determined by server config and user preference.');
  return 'en'; // Default to English
}
