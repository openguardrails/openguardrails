/**
 * IP-based Language Detection Utility
 * Detects user's language based on their IP address location
 */

interface IPLocationResponse {
  country_code?: string;
  country?: string;
}

/**
 * Detect language based on IP geolocation
 * Returns 'zh' for Chinese users, 'en' for others
 */
export async function detectLanguageByIP(): Promise<string> {
  try {
    // Try multiple IP geolocation services
    const services = [
      'https://ipapi.co/json/',
      'https://ip-api.com/json/',
      'https://ipwho.is/'
    ];

    for (const service of services) {
      try {
        const response = await fetch(service, {
          method: 'GET',
          signal: AbortSignal.timeout(3000) // 3 second timeout
        });

        if (response.ok) {
          const data: IPLocationResponse = await response.json();
          const countryCode = data.country_code || data.country || '';

          // Check if user is from China
          if (countryCode.toUpperCase() === 'CN' || countryCode.toUpperCase() === 'CHINA') {
            return 'zh';
          }

          // Return English for all other countries
          return 'en';
        }
      } catch (error) {
        console.warn(`Failed to detect location from ${service}:`, error);
        continue; // Try next service
      }
    }

    // Default to English if all services fail
    console.warn('All IP geolocation services failed, defaulting to English');
    return 'en';

  } catch (error) {
    console.error('Error detecting language by IP:', error);
    return 'en'; // Default to English on error
  }
}

/**
 * Initialize language based on priority:
 * 1. URL query parameter (?lng=en or ?lng=zh)
 * 2. User saved language preference (if logged in)
 * 3. LocalStorage saved preference
 * 4. IP-based detection
 * 5. Browser language
 * 6. Default to English
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

  // 4. IP-based detection
  try {
    const detectedLang = await detectLanguageByIP();
    localStorage.setItem('i18nextLng', detectedLang);
    return detectedLang;
  } catch (error) {
    console.error('IP-based language detection failed:', error);
  }

  // 5. Browser language
  const browserLang = navigator.language.toLowerCase();
  if (browserLang.startsWith('zh')) {
    localStorage.setItem('i18nextLng', 'zh');
    return 'zh';
  }

  // 6. Default to English
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
