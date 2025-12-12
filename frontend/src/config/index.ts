/**
 * Frontend Configuration
 * Manages deployment mode and feature flags
 */

export interface SystemConfig {
  deploymentMode: 'enterprise' | 'saas';
  isSaasMode: boolean;
  isEnterpriseMode: boolean;
  version: string;
}

// Default configuration (will be overridden by backend API)
let systemConfig: SystemConfig = {
  deploymentMode: 'enterprise',
  isSaasMode: false,
  isEnterpriseMode: true,
  version: '1.0.0'
};

/**
 * Initialize system configuration from backend
 */
export const initSystemConfig = async (): Promise<void> => {
  try {
    const response = await fetch('/api/v1/config/system-info');
    if (response.ok) {
      const data = await response.json();
      systemConfig = {
        deploymentMode: data.deployment_mode || 'enterprise',
        isSaasMode: data.is_saas_mode || false,
        isEnterpriseMode: data.is_enterprise_mode !== false, // Default to true
        version: data.version || '1.0.0'
      };
      console.log('System config initialized:', systemConfig);
    } else {
      console.warn('Failed to fetch system config, using defaults');
    }
  } catch (error) {
    console.warn('Failed to initialize system config, using defaults:', error);
  }
};

/**
 * Get current system configuration
 */
export const getSystemConfig = (): SystemConfig => {
  return systemConfig;
};

/**
 * Check if running in SaaS mode
 */
export const isSaasMode = (): boolean => {
  return systemConfig.isSaasMode;
};

/**
 * Check if running in enterprise mode
 */
export const isEnterpriseMode = (): boolean => {
  return systemConfig.isEnterpriseMode;
};

/**
 * Feature flags based on deployment mode
 */
export const features = {
  /**
   * Show subscription/billing features
   */
  showSubscription: (): boolean => {
    return isSaasMode();
  },

  /**
   * Show premium package marketplace
   */
  showMarketplace: (): boolean => {
    return isSaasMode();
  },

  /**
   * Show payment features
   */
  showPayment: (): boolean => {
    return isSaasMode();
  },

  /**
   * Show premium scanner packages
   */
  showThirdPartyPackages: (): boolean => {
    return isSaasMode();
  }
};

export default {
  getSystemConfig,
  initSystemConfig,
  isSaasMode,
  isEnterpriseMode,
  features
};
