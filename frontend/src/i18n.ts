import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enTranslations from './locales/en.json';
import zhTranslations from './locales/zh.json';

// Language detection order (NO IP detection - offline-friendly):
// 1. Query parameter (?lng=en or ?lng=zh)
// 2. LocalStorage (user preference)
// 3. Navigator language (browser setting)
// 4. Default language from server config
// 5. Fallback to 'en'

// Custom server config language detector
const configLanguageDetector = {
  name: 'configDetector',

  async lookup() {
    try {
      // Only fetch default language if no localStorage preference exists
      const savedLang = localStorage.getItem('i18nextLng');
      if (savedLang) {
        return undefined; // Let other detectors handle it
      }

      // Fetch default language from server config
      const response = await fetch('/api/v1/auth/default-language');
      if (response.ok) {
        const data = await response.json();
        return data.default_language || 'en';
      }
      return 'en';
    } catch (error) {
      console.warn('Failed to fetch default language from config, using fallback:', error);
      return 'en'; // Fallback to English if API fails
    }
  },

  cacheUserLanguage() {
    // No caching needed for config detection
  }
};

// Add custom detector to LanguageDetector
const languageDetector = new LanguageDetector();
languageDetector.addDetector(configLanguageDetector as any);

i18n
  .use(languageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        translation: enTranslations
      },
      zh: {
        translation: zhTranslations
      }
    },
    fallbackLng: 'en',
    debug: false,
    interpolation: {
      escapeValue: false // React already escapes values
    },
    detection: {
      order: ['querystring', 'localStorage', 'navigator', 'configDetector'],
      caches: ['localStorage'],
      lookupQuerystring: 'lng'
    }
  });

export default i18n;
