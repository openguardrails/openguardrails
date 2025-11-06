/**
 * Language Detection Utility (Offline-friendly)
 * Detects user's language without requiring external internet access
 */

/**
 * Get default language from server configuration
 * Returns server-configured default language ('en' or 'zh')
 */
export async function getDefaultLanguageFromConfig(): Promise<string> {
  try {
    const response = await fetch('/api/v1/auth/default-language');
    if (response.ok) {
      const data = await response.json();
      return data.default_language || 'en';
    }
    return 'en';
  } catch (error) {
    console.warn('Failed to fetch default language from config:', error);
    return 'en'; // Fallback to English
  }
}

/**
 * Initialize language based on priority (NO IP detection - offline-friendly):
 * 1. URL query parameter (?lng=en or ?lng=zh)
 * 2. User saved language preference (if logged in)
 * 3. LocalStorage saved preference
 * 4. Server default language configuration
 * 5. Browser language
 * 6. Fallback to English
 */
export async function initializeLanguage(userLanguage?: string): Promise<string> {
  // 1. Check URL query parameter
  const urlParams = new URLSearchParams(window.location.search);
  const urlLang = urlParams.get('lng');
  if (urlLang === 'en' || urlLang === 'zh') {
    localStorage.setItem('i18nextLng', urlLang);
    return urlLang;
  }

  // 2. Check user saved language preference (highest priority for logged in users)
  if (userLanguage && (userLanguage === 'en' || userLanguage === 'zh')) {
    localStorage.setItem('i18nextLng', userLanguage);
    return userLanguage;
  }

  // 3. Check localStorage
  const savedLang = localStorage.getItem('i18nextLng');
  if (savedLang === 'en' || savedLang === 'zh') {
    return savedLang;
  }

  // 4. Server default language configuration
  try {
    const configLang = await getDefaultLanguageFromConfig();
    if (configLang === 'en' || configLang === 'zh') {
      localStorage.setItem('i18nextLng', configLang);
      return configLang;
    }
  } catch (error) {
    console.warn('Failed to get server default language:', error);
  }

  // 5. Browser language
  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith('zh')) {
    localStorage.setItem('i18nextLng', 'zh');
    return 'zh';
  }

  // 6. Fallback to English
  localStorage.setItem('i18nextLng', 'en');
  return 'en';
}

/**
 * Change language and persist to localStorage
 */
export function changeLanguage(lang: string): void {
  if (lang === 'en' || lang === 'zh') {
    localStorage.setItem('i18nextLng', lang);
    window.location.reload(); // Reload to apply language change
  }
}
