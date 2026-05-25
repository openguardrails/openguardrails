/**
 * Billing and subscription related types
 */

export interface UsageBreakdown {
  guardrails_proxy: number;
  direct_model_access: number;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  subscription_type: 'free' | 'subscribed';
  subscription_tier: number;
  monthly_quota: number;
  current_month_usage: number;
  usage_reset_at: string;
  usage_percentage: number;
  plan_name: string;
  usage_breakdown?: UsageBreakdown;
  billing_period_start?: string;
  billing_period_end?: string;
  purchased_quota: number;
  purchased_quota_expires_at: string | null;
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
