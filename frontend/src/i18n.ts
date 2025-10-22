import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import enTranslations from './locales/en.json';
import zhTranslations from './locales/zh.json';
import { getLanguageFromIp } from './utils/ipLocation';

// Language detection order:
// 1. Query parameter (?lng=en or ?lng=zh)
// 2. LocalStorage
// 3. IP-based geolocation (China mainland = zh, others = en)
// 4. Navigator language (browser setting)
// 5. Default to 'en'

// Custom IP-based language detector
const ipLanguageDetector = {
  name: 'ipDetector',

  async lookup() {
    try {
      const lang = await getLanguageFromIp();
      return lang;
    } catch (error) {
      console.error('IP language detection failed:', error);
      return undefined;
    }
  },

  cacheUserLanguage() {
    // No caching needed for IP detection
  }
};

// Add custom detector to LanguageDetector
const languageDetector = new LanguageDetector();
languageDetector.addDetector(ipLanguageDetector as any);

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
      order: ['querystring', 'localStorage', 'ipDetector', 'navigator'],
      caches: ['localStorage'],
      lookupQuerystring: 'lng'
    }
  });

export default i18n;
