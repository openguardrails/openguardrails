import api from './api';

const API_BASE = '/api/v1/payment';

export interface PaymentConfig {
  provider: 'alipay' | 'stripe';
  currency: string;
  subscription_price: number;
  stripe_publishable_key?: string;
}

export interface PaymentResponse {
  success: boolean;
  payment_id?: string;
  order_id?: string;
  provider?: string;
  payment_url?: string;
  checkout_url?: string;
  session_id?: string;
  amount?: number;
  currency?: string;
  error?: string;
  package_name?: string;
}

export interface PaymentOrder {
  id: string;
  order_type: 'subscription' | 'package';
  amount: number;
  currency: string;
  payment_provider: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  package_id: string | null;
}

export interface SubscriptionStatus {
  subscription_type: 'free' | 'subscribed';
  is_active: boolean;
  started_at: string | null;
  expires_at: string | null;
  cancel_at_period_end: boolean;
  next_payment_date: string | null;
}

export interface PaymentVerificationResult {
  status: 'pending' | 'completed' | 'failed' | 'not_found';
  order_type?: 'subscription' | 'package';
  order_id?: string;
  payment_status?: string;
  details?: {
    package_id?: string;
    purchase_status?: string;
  };
  paid_at?: string | null;
  message?: string;
}

export const paymentService = {
  /**
   * Get payment configuration for frontend
   */
  async getConfig(): Promise<PaymentConfig> {
    const response = await api.get(`${API_BASE}/config`);
    return response.data;
  },

  /**
   * Create a subscription payment
   */
  async createSubscriptionPayment(): Promise<PaymentResponse> {
    const response = await api.post(`${API_BASE}/subscription/create`, {});
    return response.data;
  },

  /**
   * Create a package purchase payment
   */
  async createPackagePayment(packageId: string): Promise<PaymentResponse> {
    const response = await api.post(`${API_BASE}/package/create`, {
      package_id: packageId
    });
    return response.data;
  },

  /**
   * Cancel the current subscription
   */
  async cancelSubscription(): Promise<{ success: boolean; cancel_at?: string }> {
    const response = await api.post(`${API_BASE}/subscription/cancel`);
    return response.data;
  },

  /**
   * Get payment order history
   */
  async getOrders(params?: {
    order_type?: string;
    status?: string;
    limit?: number;
  }): Promise<{ orders: PaymentOrder[] }> {
    const response = await api.get(`${API_BASE}/orders`, { params });
    return response.data;
  },

  /**
   * Get current subscription status
   */
  async getSubscriptionStatus(): Promise<SubscriptionStatus> {
    const response = await api.get(`${API_BASE}/subscription/status`);
    return response.data;
  },

  /**
   * Verify payment session status
   * Used to poll payment completion after redirect from payment provider
   */
  async verifyPaymentSession(sessionId: string): Promise<PaymentVerificationResult> {
    const response = await api.get(`${API_BASE}/verify-session/${sessionId}`);
    return response.data;
  },

  /**
   * Format price for display
   */
  formatPrice(amount: number, currency: string): string {
    if (currency === 'CNY') {
      return `¥${amount}`;
    }
    return `$${amount}`;
  },

  /**
   * Handle payment redirect
   */
  redirectToPayment(response: PaymentResponse): void {
    if (response.payment_url) {
      // Alipay redirect
      window.location.href = response.payment_url;
    } else if (response.checkout_url) {
      // Stripe checkout redirect
      window.location.href = response.checkout_url;
    }
  }
};

export default paymentService;
