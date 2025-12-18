import axios from 'axios';

export interface LoginRequest {
  email: string;
  password: string;
  language?: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface VerifyEmailRequest {
  email: string;
  verification_code: string;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  api_key?: string;
  tenant_id?: string;
  is_super_admin?: boolean;
  requires_password_change?: boolean;
  password_message?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  api_key: string;
  model_api_key?: string;  // Direct Model Access API Key (for private deployment)
  is_active: boolean;
  is_verified: boolean;
  is_super_admin: boolean;
  rate_limit: number;  // Tenant speed limit (requests per second, 0 means unlimited, default is 1)
  language: string;  // User language preference
}

// Get base URL auxiliary function, consistent with api.ts
const getBaseURL = () => {
  // Use API URL from environment variables first
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  // Production and Docker environments use relative path, through nginx proxy
  return '';
};

class AuthService {
  private baseURL: string;

  constructor() {
    this.baseURL = getBaseURL();
  }

  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const response = await axios.post<LoginResponse>(`${this.baseURL}/api/v1/users/login`, credentials);
    return response.data;
  }

  async register(data: RegisterRequest): Promise<{ message: string }> {
    const response = await axios.post<{ message: string }>(`${this.baseURL}/api/v1/users/register`, data);
    return response.data;
  }

  async verifyEmail(data: VerifyEmailRequest): Promise<{ message: string }> {
    const response = await axios.post<{ message: string }>(`${this.baseURL}/api/v1/users/verify-email`, data);
    return response.data;
  }

  async getCurrentUser(): Promise<UserInfo> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token found');
    }

    const response = await axios.get<UserInfo>(`${this.baseURL}/api/v1/users/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
    return response.data;
  }

  async regenerateModelApiKey(): Promise<{ model_api_key: string }> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token found');
    }

    const response = await axios.post<{ model_api_key: string }>(
      `${this.baseURL}/api/v1/users/regenerate-model-api-key`,
      {},
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );
    return response.data;
  }

  async regenerateApiKey(): Promise<{ api_key: string }> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token found');
    }
    const response = await axios.post<{ api_key: string }>(`${this.baseURL}/api/v1/users/regenerate-api-key`, {}, {
      headers: { Authorization: `Bearer ${token}` },
    });
    return response.data;
  }

  async updateLanguage(language: string): Promise<{ status: string; message: string; language: string }> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token found');
    }
    const response = await axios.put<{ status: string; message: string; language: string }>(`${this.baseURL}/api/v1/users/language`,
      { language },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  }

  async changePassword(currentPassword: string, newPassword: string): Promise<{ status: string; message: string }> {
    const token = this.getToken();
    if (!token) {
      throw new Error('No authentication token found');
    }
    const response = await axios.post<{ status: string; message: string }>(`${this.baseURL}/api/v1/users/change-password`,
      { current_password: currentPassword, new_password: newPassword },
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return response.data;
  }

  async logout(): Promise<void> {
    const token = this.getToken();
    if (token) {
      try {
        await axios.post(`${this.baseURL}/api/v1/auth/logout`, {}, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (error) {
        console.error('Logout API call failed:', error);
      }
    }
    this.clearToken();
  }

  setToken(token: string): void {
    localStorage.setItem('auth_token', token);
  }

  getToken(): string | null {
    return localStorage.getItem('auth_token');
  }

  clearToken(): void {
    localStorage.removeItem('auth_token');
  }

  isAuthenticated(): boolean {
    const token = this.getToken();
    if (!token) {
      return false;
    }

    try {
      // Simple check if token has expired (can parse JWT payload to check exp field)
      const payload = JSON.parse(atob(token.split('.')[1]));
      const currentTime = Date.now() / 1000;
      return payload.exp > currentTime;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  }
}

export const authService = new AuthService();