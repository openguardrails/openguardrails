/**
 * IP Geolocation Detection Utility
 * Detects user's location based on IP address to determine default language
 */

interface IpLocationResponse {
  country_code?: string;
  country?: string;
}

/**
 * Detect if user is from mainland China based on IP address
 * Returns true for China mainland IPs, false for others
 */
export async function isFromChinaMainland(): Promise<boolean> {
  try {
    // Try multiple IP geolocation services for reliability
    const services = [
      // ipapi.co - free tier allows 1000 requests/day
      async () => {
        const response = await fetch('https://ipapi.co/json/', {
          headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error('ipapi.co failed');
        const data: IpLocationResponse = await response.json();
        return data.country_code === 'CN';
      },
      // ip-api.com - free for non-commercial use
      async () => {
        const response = await fetch('http://ip-api.com/json/', {
          headers: { 'Accept': 'application/json' }
        });
        if (!response.ok) throw new Error('ip-api.com failed');
        const data: IpLocationResponse = await response.json();
        return data.country_code === 'CN';
      }
    ];

    // Try services in order until one succeeds
    for (const service of services) {
      try {
        const result = await service();
        return result;
      } catch (error) {
        console.warn('IP detection service failed, trying next...', error);
        continue;
      }
    }

    // Default to English (false) if all services fail
    console.warn('All IP detection services failed, defaulting to English');
    return false;
  } catch (error) {
    console.error('Error detecting IP location:', error);
    return false; // Default to English on error
  }
}

/**
 * Get language code based on IP location
 * Returns 'zh' for China mainland, 'en' for others
 */
export async function getLanguageFromIp(): Promise<'zh' | 'en'> {
  const isChina = await isFromChinaMainland();
  return isChina ? 'zh' : 'en';
}
