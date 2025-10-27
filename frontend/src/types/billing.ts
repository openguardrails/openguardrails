/**
 * Billing and subscription related types
 */

export interface Subscription {
  id: string;
  tenant_id: string;
  subscription_type: 'free' | 'subscribed';
  monthly_quota: number;
  current_month_usage: number;
  usage_reset_at: string;
  usage_percentage: number;
  plan_name: string;
}

export interface UsageInfo {
  current_month_usage: number;
  monthly_quota: number;
  usage_percentage: number;
  remaining: number;
  usage_reset_at: string;
  subscription_type: string;
  plan_name: string;
}

export interface SubscriptionListItem {
  id: string;
  tenant_id: string;
  email: string;
  subscription_type: 'free' | 'subscribed';
  monthly_quota: number;
  current_month_usage: number;
  usage_reset_at: string;
  usage_percentage: number;
  plan_name: string;
}

export interface UpdateSubscriptionRequest {
  subscription_type: 'free' | 'subscribed';
}
