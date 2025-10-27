/**
 * Billing and subscription API service
 */

import api from './api';
import type { Subscription, UsageInfo, SubscriptionListItem, UpdateSubscriptionRequest } from '../types/billing';

export const billingService = {
  /**
   * Get current user's subscription information
   */
  async getCurrentSubscription(): Promise<Subscription> {
    const response = await api.get('/api/v1/billing/subscription');
    return response.data;
  },

  /**
   * Get current user's usage statistics
   */
  async getCurrentUsage(): Promise<UsageInfo> {
    const response = await api.get('/api/v1/billing/usage');
    return response.data.data;
  },

  /**
   * List all subscriptions (admin only)
   */
  async listAllSubscriptions(params?: {
    skip?: number;
    limit?: number;
    search?: string;
    subscription_type?: 'free' | 'subscribed';
  }): Promise<{ data: SubscriptionListItem[]; total: number }> {
    const response = await api.get('/api/v1/admin/billing/subscriptions', { params });
    return {
      data: response.data.data,
      total: response.data.total
    };
  },

  /**
   * Update tenant subscription type (admin only)
   */
  async updateSubscription(tenantId: string, data: UpdateSubscriptionRequest): Promise<void> {
    await api.put(`/api/v1/admin/billing/subscriptions/${tenantId}`, data);
  },

  /**
   * Reset tenant's monthly quota (admin only)
   */
  async resetTenantQuota(tenantId: string): Promise<void> {
    await api.post(`/api/v1/admin/billing/subscriptions/${tenantId}/reset-quota`);
  },

  /**
   * Reset all tenants' monthly quotas (admin only)
   */
  async resetAllQuotas(): Promise<{ reset_count: number }> {
    const response = await api.post('/api/v1/admin/billing/reset-all-quotas');
    return response.data.data;
  }
};
