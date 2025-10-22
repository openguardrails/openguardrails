/**
 * I18n Mapper Utility
 * Maps backend English field values to i18n translation keys
 */

import { TFunction } from 'i18next';

/**
 * Map risk level value from backend to translated text
 */
export function translateRiskLevel(value: string, t: TFunction): string {
  const keyMap: Record<string, string> = {
    'no_risk': 'risk.level.no_risk',
    'low_risk': 'risk.level.low_risk',
    'medium_risk': 'risk.level.medium_risk',
    'high_risk': 'risk.level.high_risk'
  };

  const key = keyMap[value];
  return key ? t(key) : value;
}

/**
 * Map suggested action value from backend to translated text
 */
export function translateAction(value: string, t: TFunction): string {
  const keyMap: Record<string, string> = {
    'pass': 'action.pass',
    'reject': 'action.reject',
    'replace': 'action.replace',
    'block': 'action.block',
    'allow': 'action.allow'
  };

  const key = keyMap[value];
  return key ? t(key) : value;
}

/**
 * Map sensitivity level value from backend to translated text
 */
export function translateSensitivity(value: string, t: TFunction): string {
  const keyMap: Record<string, string> = {
    'high': 'sensitivity.high',
    'medium': 'sensitivity.medium',
    'low': 'sensitivity.low'
  };

  const key = keyMap[value];
  return key ? t(key) : value;
}

/**
 * Map category code to translated text
 */
export function translateCategory(value: string, t: TFunction): string {
  const key = `category.${value}`;
  const translated = t(key);

  // If translation not found, return original value
  return translated !== key ? translated : value;
}

/**
 * Get risk level badge color
 */
export function getRiskLevelColor(riskLevel: string): string {
  const colorMap: Record<string, string> = {
    'no_risk': 'success',
    'low_risk': 'warning',
    'medium_risk': 'orange',
    'high_risk': 'error'
  };

  return colorMap[riskLevel] || 'default';
}

/**
 * Get action badge color
 */
export function getActionColor(action: string): string {
  const colorMap: Record<string, string> = {
    'pass': 'success',
    'reject': 'error',
    'replace': 'warning',
    'block': 'error',
    'allow': 'success'
  };

  return colorMap[action] || 'default';
}
