import axios from 'axios';
import { toast } from 'sonner';
import type {
  ApiResponse,
  GuardrailRequest,
  GuardrailResponse,
  DetectionResult,
  PaginatedResponse,
  DashboardStats,
  Blacklist,
  Whitelist,
  ResponseTemplate,
  KnowledgeBase,
  KnowledgeBaseFileInfo,
  SimilarQuestionResult
} from '../types';

// Create axios instance - Use API URL from environment variables
const getBaseURL = () => {
  // Use API URL from environment variables
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL;
  }
  // Production and Docker environments use relative path, through nginx proxy
  return '';
};

const api = axios.create({
  baseURL: getBaseURL(),
  timeout: 300000, // Increase to 5 minutes timeout
});

// Request interceptor
api.interceptors.request.use(
  (config) => {
    // Skip authentication routes, do not add Authorization header
    if (config.url && config.url.includes('/auth/')) {
      return config;
    }

    // Add authentication header - Use JWT token first, then use API key
    const authToken = localStorage.getItem('auth_token');
    const apiToken = localStorage.getItem('api_token');

    const token = authToken || apiToken;
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // Add tenant switch session token
    const switchToken = localStorage.getItem('switch_session_token');
    if (switchToken) {
      config.headers['X-Switch-Session'] = switchToken;
    }

    // Add current application ID
    // Note: Proxy management APIs are tenant-level (global), not application-specific
    const isProxyManagementRequest = config.url && config.url.includes('/proxy/upstream-apis');
    const applicationId = localStorage.getItem('current_application_id');
    if (applicationId && !isProxyManagementRequest) {
      config.headers['X-Application-ID'] = applicationId;
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    const status = error.response?.status;
    const url: string | undefined = error.config?.url;
    
    // Silent handling of certain non-critical 401 (e.g. when checking switch status is not ready)
    if (status === 401 && url && url.includes('/admin/current-switch')) {
      return Promise.reject(error);
    }
    
    // For 429 rate limit errors, let business logic handle it, do not show a popup globally
    if (status === 429) {
      return Promise.reject(error);
    }
    
    // For 403 errors on custom scanners, let the component handle it (show upgrade prompt)
    if (status === 403 && url && url.includes('/custom-scanners')) {
      return Promise.reject(error);
    }
    
    // Handle error message - ensure it's a string for toast
    let errorMessage = 'Request failed';
    const detail = error.response?.data?.detail;
    if (typeof detail === 'string') {
      errorMessage = detail;
    } else if (Array.isArray(detail) && detail.length > 0) {
      // Pydantic validation error format: [{type, loc, msg, ...}]
      errorMessage = detail.map((e: any) => e.msg || JSON.stringify(e)).join('; ');
    } else if (error.message) {
      errorMessage = error.message;
    }
    toast.error(errorMessage);
    return Promise.reject(error);
  }
);

// Guardrails API
export const guardrailsApi = {
  // Check content
  check: (data: GuardrailRequest): Promise<GuardrailResponse> =>
    api.post('/v1/guardrails', data).then(res => res.data),
  
  // Health check
  health: () => api.get('/v1/guardrails/health').then(res => res.data),
  
  // Get model list
  models: () => api.get('/v1/guardrails/models').then(res => res.data),
};

// Dashboard API
export const dashboardApi = {
  // Get stats data
  getStats: (): Promise<DashboardStats> =>
    api.get('/api/v1/dashboard/stats').then(res => res.data),
  
  // Get risk category distribution
  getCategoryDistribution: (params?: {
    start_date?: string;
    end_date?: string;
  }): Promise<{ categories: { name: string; value: number }[] }> =>
    api.get('/api/v1/dashboard/category-distribution', { params }).then(res => res.data),
};

// Detection results API
export const resultsApi = {
  // Get detection results list
  getResults: (params?: {
    page?: number;
    per_page?: number;
    risk_level?: string;
    security_risk_level?: string;
    compliance_risk_level?: string;
    category?: string;
    data_entity_type?: string;
    start_date?: string;
    end_date?: string;
    content_search?: string;
    request_id_search?: string;
  }): Promise<PaginatedResponse<DetectionResult>> =>
    api.get('/api/v1/results', { params }).then(res => res.data),

  // Get single detection result
  getResult: (id: number): Promise<DetectionResult> =>
    api.get(`/api/v1/results/${id}`).then(res => res.data),

  // Export detection results to Excel
  exportResults: (params?: {
    risk_level?: string;
    security_risk_level?: string;
    compliance_risk_level?: string;
    category?: string;
    data_entity_type?: string;
    start_date?: string;
    end_date?: string;
    content_search?: string;
    request_id_search?: string;
  }): Promise<Blob> =>
    api.get('/api/v1/results/export', {
      params,
      responseType: 'blob'
    }).then(res => res.data),
};

// Config API
export const configApi = {
  // Blacklist management
  blacklist: {
    list: (): Promise<Blacklist[]> => api.get('/api/v1/config/blacklist').then(res => res.data),
    create: (data: Omit<Blacklist, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.post('/api/v1/config/blacklist', data).then(res => res.data),
    update: (id: number, data: Omit<Blacklist, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.put(`/api/v1/config/blacklist/${id}`, data).then(res => res.data),
    delete: (id: number): Promise<ApiResponse> =>
      api.delete(`/api/v1/config/blacklist/${id}`).then(res => res.data),
  },
  
  // Whitelist management
  whitelist: {
    list: (): Promise<Whitelist[]> => api.get('/api/v1/config/whitelist').then(res => res.data),
    create: (data: Omit<Whitelist, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.post('/api/v1/config/whitelist', data).then(res => res.data),
    update: (id: number, data: Omit<Whitelist, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.put(`/api/v1/config/whitelist/${id}`, data).then(res => res.data),
    delete: (id: number): Promise<ApiResponse> =>
      api.delete(`/api/v1/config/whitelist/${id}`).then(res => res.data),
  },
  
  // Response template management
  responses: {
    list: (): Promise<ResponseTemplate[]> => api.get('/api/v1/config/responses').then(res => res.data),
    create: (data: Omit<ResponseTemplate, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.post('/api/v1/config/responses', data).then(res => res.data),
    update: (id: number, data: Omit<ResponseTemplate, 'id' | 'created_at' | 'updated_at'>): Promise<ApiResponse> =>
      api.put(`/api/v1/config/responses/${id}`, data).then(res => res.data),
    delete: (id: number): Promise<ApiResponse> =>
      api.delete(`/api/v1/config/responses/${id}`).then(res => res.data),
  },
  
  // Get system info
  getSystemInfo: (): Promise<{ support_email: string | null; app_name: string; app_version: string }> =>
    api.get('/api/v1/config/system-info').then(res => res.data),

  // Ban policy management
  banPolicy: {
    // Get ban policy
    get: (): Promise<any> => api.get('/api/v1/ban-policy').then(res => res.data),

    // Update ban policy
    update: (data: {
      enabled: boolean;
      risk_level: string;
      trigger_count: number;
      time_window_minutes: number;
      ban_duration_minutes: number;
    }): Promise<any> => api.put('/api/v1/ban-policy', data).then(res => res.data),

    // Get banned users list
    getBannedUsers: (skip?: number, limit?: number): Promise<{ users: any[] }> =>
      api.get('/api/v1/ban-policy/banned-users', { params: { skip, limit } }).then(res => res.data),

    // Unban user
    unbanUser: (userId: string): Promise<any> =>
      api.post('/api/v1/ban-policy/unban', { user_id: userId }).then(res => res.data),

    // Get user risk history
    getUserHistory: (userId: string, days?: number): Promise<{ history: any[] }> =>
      api.get(`/api/v1/ban-policy/user-history/${userId}`, { params: { days } }).then(res => res.data),

    // Check user ban status
    checkUserStatus: (userId: string): Promise<any> =>
      api.get(`/api/v1/ban-policy/check-status/${userId}`).then(res => res.data),
  },

  // Appeal configuration management
  appealConfig: {
    // Get appeal configuration
    get: (): Promise<{
      id?: string;
      enabled: boolean;
      message_template: string;
      appeal_base_url: string;
      final_reviewer_email?: string;
      created_at?: string;
      updated_at?: string;
    }> => api.get('/api/v1/config/appeal').then(res => res.data),

    // Update appeal configuration
    update: (data: {
      enabled: boolean;
      message_template: string;
      appeal_base_url: string;
      final_reviewer_email?: string;
    }): Promise<any> => api.put('/api/v1/config/appeal', data).then(res => res.data),

    // Get appeal records
    getRecords: (params?: {
      status?: string;
      page?: number;
      page_size?: number;
    }): Promise<{
      items: Array<{
        id: string;
        request_id: string;
        user_id?: string;
        application_id?: string;
        application_name?: string;
        original_content: string;
        original_risk_level: string;
        original_categories: string[];
        status: string;
        ai_approved?: boolean;
        ai_review_result?: string;
        processor_type?: string;
        processor_id?: string;
        processor_reason?: string;
        created_at?: string;
        ai_reviewed_at?: string;
        processed_at?: string;
      }>;
      total: number;
      page: number;
      page_size: number;
      pages: number;
    }> => api.get('/api/v1/config/appeal/records', { params }).then(res => res.data),

    // Manual review appeal
    reviewAppeal: (appealId: string, data: {
      action: 'approve' | 'reject';
      reason?: string;
    }): Promise<{
      success: boolean;
      status: string;
      message: string;
    }> => api.post(`/api/v1/config/appeal/records/${appealId}/review`, data).then(res => res.data),

    // Export appeal records to Excel
    exportRecords: (params?: {
      status?: string;
    }): Promise<Blob> =>
      api.get('/api/v1/config/appeal/records/export', {
        params,
        responseType: 'blob'
      }).then(res => res.data),
  },
};

// Admin API
export const adminApi = {
  // Get admin stats info
  getAdminStats: (): Promise<{
    status: string;
    data: {
      total_users: number;
      total_detections: number;
      user_detection_counts: Array<{
        tenant_id: string;
        email: string;
        detection_count: number;
      }>
    }
  }> =>
    api.get('/api/v1/admin/stats').then(res => res.data),

  // Get all tenants list
  getUsers: (params?: { sort_by?: string; sort_order?: string; skip?: number; limit?: number; search?: string }): Promise<{ status: string; users: any[]; total: number }> =>
    api.get('/api/v1/admin/users', { params }).then(res => res.data),

  // Switch to specified tenant perspective
  switchToUser: (tenantId: string): Promise<{
    status: string;
    message: string;
    switch_session_token: string;
    target_user: { id: string; email: string; api_key: string }
  }> =>
    api.post(`/api/v1/admin/switch-user/${tenantId}`).then(res => res.data),

  // Exit tenant switch
  exitSwitch: (): Promise<{ status: string; message: string }> =>
    api.post('/api/v1/admin/exit-switch').then(res => res.data),

  // Get current switch status
  getCurrentSwitch: (): Promise<{
    is_switched: boolean;
    admin_user?: { id: string; email: string };
    target_user?: { id: string; email: string; api_key: string };
  }> =>
    api.get('/api/v1/admin/current-switch').then(res => res.data),

  // Tenant management
  createUser: (data: {
    email: string;
    password: string;
    is_active?: boolean;
    is_verified?: boolean;
    is_super_admin?: boolean;
  }): Promise<ApiResponse> =>
    api.post('/api/v1/admin/create-user', data).then(res => res.data),

  updateUser: (tenantId: string, data: {
    email?: string;
    is_active?: boolean;
    is_verified?: boolean;
    is_super_admin?: boolean;
  }): Promise<ApiResponse> =>
    api.put(`/api/v1/admin/users/${tenantId}`, data).then(res => res.data),

  deleteUser: (tenantId: string): Promise<ApiResponse> =>
    api.delete(`/api/v1/admin/users/${tenantId}`).then(res => res.data),

  resetUserApiKey: (tenantId: string): Promise<ApiResponse> =>
    api.post(`/api/v1/admin/users/${tenantId}/reset-api-key`).then(res => res.data),

  // Tenant rate limit management
  getRateLimits: (params?: { skip?: number; limit?: number; search?: string; sort_by?: string; sort_order?: string }): Promise<{ status: string; data: any[]; total: number }> =>
    api.get('/api/v1/admin/rate-limits', { params }).then(res => res.data),

  setUserRateLimit: (data: {
    tenant_id: string;
    requests_per_second: number;
  }): Promise<{ status: string; message: string; data: any }> =>
    api.post('/api/v1/admin/rate-limits', data).then(res => res.data),

  removeUserRateLimit: (tenantId: string): Promise<{ status: string; message: string }> =>
    api.delete(`/api/v1/admin/rate-limits/${tenantId}`).then(res => res.data),

  // Get tenant analytics
  getTenantAnalytics: (days?: number): Promise<{
    status: string;
    data: {
      latest_created_tenants: Array<{
        id: string;
        email: string;
        created_at: string | null;
        is_active: boolean;
        is_verified: boolean;
      }>;
      recently_active_tenants: Array<{
        id: string;
        email: string;
        last_activity: string | null;
        is_active: boolean;
        is_verified: boolean;
      }>;
      creation_trend: Array<{
        date: string;
        count: number;
      }>;
      usage_trend: Array<{
        date: string;
        count: number;
      }>;
    };
  }> =>
    api.get('/api/v1/admin/tenant-analytics', { params: { days } }).then(res => res.data),
};

// Online test model API - Use proxy model configuration
export const testModelsApi = {
  // Get online test available proxy model list
  getModels: () => api.get('/api/v1/test/models').then(res => res.data),
  
  // Update online test model selection
  updateSelection: (model_selections: Array<{ id: string; selected: boolean }>) => 
    api.post('/api/v1/test/models/selection', { model_selections }).then(res => res.data),
};


// Sensitivity threshold configuration API
export const sensitivityThresholdApi = {
  // Get sensitivity threshold configuration
  get: () => api.get('/api/v1/config/sensitivity-thresholds').then(res => res.data),

  // Update sensitivity threshold configuration
  update: (config: {
    high_sensitivity_threshold: number;
    medium_sensitivity_threshold: number;
    low_sensitivity_threshold: number;
    sensitivity_trigger_level: string;
  }) => api.put('/api/v1/config/sensitivity-thresholds', config).then(res => res.data),

  // Reset to default configuration
  reset: () => api.post('/api/v1/config/sensitivity-thresholds/reset').then(res => res.data),
};

// Proxy upstream API configuration API
export const proxyModelsApi = {
  // Get upstream API configurations list
  list: (): Promise<{ success: boolean; data: any[] }> =>
    api.get('/api/v1/proxy/upstream-apis').then(res => res.data),

  // Get upstream API configuration detail
  get: (id: string): Promise<{ success: boolean; data: any }> =>
    api.get(`/api/v1/proxy/upstream-apis/${id}`).then(res => res.data),

  // Create upstream API configuration
  create: (data: {
    config_name: string;
    api_base_url: string;
    api_key: string;
    is_active?: boolean;
    enable_reasoning_detection?: boolean;
    stream_chunk_size?: number;
  }): Promise<{ success: boolean; message: string; data?: any }> =>
    api.post('/api/v1/proxy/upstream-apis', data).then(res => res.data),

  // Update upstream API configuration
  update: (id: string, data: {
    config_name?: string;
    api_base_url?: string;
    api_key?: string;
    is_active?: boolean;
    enable_reasoning_detection?: boolean;
    stream_chunk_size?: number;
  }): Promise<{ success: boolean; message: string }> =>
    api.put(`/api/v1/proxy/upstream-apis/${id}`, data).then(res => res.data),

  // Delete upstream API configuration
  delete: (id: string): Promise<{ success: boolean; message: string }> =>
    api.delete(`/api/v1/proxy/upstream-apis/${id}`).then(res => res.data),

  // Test upstream API configuration
  test: (id: string): Promise<{ success: boolean; message: string; data?: any }> =>
    api.post(`/api/v1/proxy/upstream-apis/${id}/test`).then(res => res.data),
};

// Knowledge base management API
export const knowledgeBaseApi = {
  // Get knowledge base list
  list: (category?: string): Promise<KnowledgeBase[]> => {
    const url = category ? `/api/v1/config/knowledge-bases?category=${category}` : '/api/v1/config/knowledge-bases';
    return api.get(url).then(res => res.data);
  },

  // Create knowledge base
  create: (data: FormData): Promise<{ success: boolean; message: string }> =>
    api.post('/api/v1/config/knowledge-bases', data, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    }).then(res => res.data),

  // Update knowledge base
  update: (id: number, data: {
    category: string;
    name: string;
    description?: string;
    is_active: boolean;
  }): Promise<{ success: boolean; message: string }> =>
    api.put(`/api/v1/config/knowledge-bases/${id}`, data).then(res => res.data),

  // Delete knowledge base
  delete: (id: number): Promise<{ success: boolean; message: string }> =>
    api.delete(`/api/v1/config/knowledge-bases/${id}`).then(res => res.data),

  // Replace knowledge base file
  replaceFile: (id: number, file: File): Promise<{ success: boolean; message: string }> => {
    const formData = new FormData();
    formData.append('file', file);
    return api.post(`/api/v1/config/knowledge-bases/${id}/replace-file`, formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    }).then(res => res.data);
  },

  // Get knowledge base file info
  getInfo: (id: number): Promise<KnowledgeBaseFileInfo> =>
    api.get(`/api/v1/config/knowledge-bases/${id}/info`).then(res => res.data),

  // Search similar questions
  search: (id: number, query: string, topK?: number): Promise<SimilarQuestionResult[]> => {
    const params = new URLSearchParams({ query });
    if (topK) params.append('top_k', topK.toString());
    return api.post(`/api/v1/config/knowledge-bases/${id}/search?${params.toString()}`).then(res => res.data);
  },

  // Get knowledge base by category
  getByCategory: (category: string): Promise<KnowledgeBase[]> =>
    api.get(`/api/v1/config/categories/${category}/knowledge-bases`).then(res => res.data),

  // Toggle global knowledge base disable status
  toggleDisable: (id: number): Promise<{ success: boolean; message: string }> =>
    api.post(`/api/v1/config/knowledge-bases/${id}/toggle-disable`).then(res => res.data),

  // Check if global knowledge base is disabled
  checkDisabled: (id: number): Promise<{ kb_id: number; is_global: boolean; is_disabled: boolean }> =>
    api.get(`/api/v1/config/knowledge-bases/${id}/is-disabled`).then(res => res.data),

  // Get available scanners for knowledge base creation
  getAvailableScanners: (): Promise<{
    blacklists: Array<{ value: string; label: string }>;
    whitelists: Array<{ value: string; label: string }>;
    official_scanners: Array<{ value: string; label: string }>;
    marketplace_scanners: Array<{ value: string; label: string }>;
    custom_scanners: Array<{ value: string; label: string }>;
  }> =>
    api.get('/api/v1/config/knowledge-bases/available-scanners').then(res => res.data),
};

// Data security API
export const dataSecurityApi = {
  // Get all sensitive data types
  getEntityTypes: (): Promise<{ items: any[] }> =>
    api.get('/api/v1/config/data-security/entity-types').then(res => res.data),

  // Alias for getEntityTypes (for consistency with Results page)
  list: (): Promise<{ items: any[] }> =>
    api.get('/api/v1/config/data-security/entity-types').then(res => res.data),

  // Get single sensitive data type
  getEntityType: (id: string): Promise<any> =>
    api.get(`/api/v1/config/data-security/entity-types/${id}`).then(res => res.data),

  // Create sensitive data type
  createEntityType: (data: any): Promise<any> =>
    api.post('/api/v1/config/data-security/entity-types', data).then(res => res.data),

  // Update sensitive data type
  updateEntityType: (id: string, data: any): Promise<any> =>
    api.put(`/api/v1/config/data-security/entity-types/${id}`, data).then(res => res.data),

  // Delete sensitive data type
  deleteEntityType: (id: string): Promise<any> =>
    api.delete(`/api/v1/config/data-security/entity-types/${id}`).then(res => res.data),

  // Create global sensitive data type (only admin)
  createGlobalEntityType: (data: any): Promise<any> =>
    api.post('/api/v1/config/data-security/global-entity-types', data).then(res => res.data),

  // Generate anonymization regex using AI
  generateAnonymizationRegex: (data: {
    description: string
    entity_type: string
    sample_data?: string
  }): Promise<{
    success: boolean
    regex_pattern: string
    replacement_template: string
    explanation: string
  }> =>
    api.post('/api/v1/config/data-security/generate-anonymization-regex', data).then(res => res.data),

  // Test anonymization effect
  testAnonymization: (data: {
    method: string
    config: Record<string, any>
    test_input: string
  }): Promise<{
    success: boolean
    result: string
    processing_time_ms: number
  }> =>
    api.post('/api/v1/config/data-security/test-anonymization', data).then(res => res.data),

  // Generate recognition regex using AI
  generateRecognitionRegex: (data: {
    description: string
    entity_type: string
    sample_data?: string
  }): Promise<{
    success: boolean
    regex_pattern: string
    explanation: string
  }> =>
    api.post('/api/v1/config/data-security/generate-recognition-regex', data).then(res => res.data),

  // Generate entity type code using AI
  generateEntityTypeCode: (data: {
    entity_type_name: string
  }): Promise<{
    success: boolean
    entity_type_code: string
    error?: string
  }> =>
    api.post('/api/v1/config/data-security/generate-entity-type-code', data).then(res => res.data),

  // Test recognition regex
  testRecognitionRegex: (data: {
    pattern: string
    test_input: string
  }): Promise<{
    success: boolean
    matched: boolean
    matches: string[]
    match_count: number
    error?: string
    processing_time_ms: number
  }> =>
    api.post('/api/v1/config/data-security/test-recognition-regex', data).then(res => res.data),

  // Test GenAI entity definition
  testEntityDefinition: (data: {
    entity_definition: string
    entity_type_name: string
    test_input: string
  }): Promise<{
    success: boolean
    matched: boolean
    matches: string[]
    match_count: number
    error?: string
    processing_time_ms: number
  }> =>
    api.post('/api/v1/config/data-security/test-entity-definition', data).then(res => res.data),

  // Generate genai_code anonymization code using AI
  generateGenaiCode: (data: {
    natural_description: string
    sample_data?: string
  }): Promise<{
    success: boolean
    code_generated: boolean
    genai_code?: string
    message: string
    error?: string
  }> =>
    api.post('/api/v1/config/data-security/generate-genai-code', data).then(res => res.data),

  // Test genai_code anonymization
  testGenaiCode: (data: {
    code: string
    test_input: string
  }): Promise<{
    success: boolean
    anonymized_text: string
    error?: string
    processing_time_ms: number
  }> =>
    api.post('/api/v1/config/data-security/test-genai-code', data).then(res => res.data),

  // Save restore anonymization config
  saveRestoreConfig: (entityTypeId: string, data: {
    restore_enabled: boolean
    restore_natural_desc: string
  }): Promise<{
    success: boolean
    message: string
    error?: string
  }> =>
    api.put(`/api/v1/config/data-security/entity-types/${entityTypeId}/restore-config`, data).then(res => res.data),

  // Get detection results list
  getDetectionResults: (limit: number, offset: number): Promise<{ items: any[]; total: number }> =>
    api.get(`/api/v1/results?per_page=${limit}&page=${Math.floor(offset / limit) + 1}`).then(res => res.data),

  // Get single detection result detail
  getDetectionResult: (requestId: string): Promise<any> =>
    api.get(`/api/v1/results/${requestId}`).then(res => res.data),

  // Get premium feature availability status
  // Returns which premium features the user can access (based on subscription or enterprise mode)
  getFeatureAvailability: (): Promise<{
    is_enterprise: boolean
    is_subscribed: boolean
    features: {
      genai_recognition: boolean
      genai_code_anonymization: boolean
      natural_language_desc: boolean
      format_detection: boolean
      smart_segmentation: boolean
      custom_scanners: boolean
    }
  }> =>
    api.get('/api/v1/config/data-security/feature-availability').then(res => res.data),
};

// Scanner Package System API
export const scannerPackagesApi = {
  // Get all packages visible to current user
  getAll: (packageType?: 'basic' | 'purchasable'): Promise<any[]> =>
    api.get('/api/v1/scanner-packages/', { params: { package_type: packageType } }).then(res => res.data),

  // Get package details including scanner definitions
  getDetail: (packageId: string): Promise<any> =>
    api.get(`/api/v1/scanner-packages/${packageId}`).then(res => res.data),

  // Get marketplace packages (purchasable packages)
  getMarketplace: (): Promise<any[]> =>
    api.get('/api/v1/scanner-packages/marketplace/list').then(res => res.data),

  // Get marketplace package preview (no purchase required, hides definitions for unpurchased packages)
  getMarketplaceDetail: (packageId: string): Promise<any> =>
    api.get(`/api/v1/scanner-packages/marketplace/${packageId}`).then(res => res.data),

  // Admin: Get all packages (no purchase filtering)
  getAllAdmin: (packageType?: 'basic' | 'purchasable', includeArchived?: boolean): Promise<any[]> =>
    api.get('/api/v1/scanner-packages/admin/packages', { params: { package_type: packageType, include_archived: includeArchived } }).then(res => res.data),

  // Admin: Upload purchasable package
  uploadPackage: (packageData: any): Promise<any> =>
    api.post('/api/v1/scanner-packages/admin/upload', packageData).then(res => res.data),

  // Admin: Update package metadata
  updatePackage: (packageId: string, updates: any): Promise<any> =>
    api.put(`/api/v1/scanner-packages/admin/${packageId}`, updates).then(res => res.data),

  // Admin: Archive package
  archivePackage: (packageId: string, reason?: string): Promise<{ success: boolean; message: string }> =>
    api.post(`/api/v1/scanner-packages/admin/${packageId}/archive`, reason ? { reason } : {}).then(res => res.data),

  // Admin: Unarchive package
  unarchivePackage: (packageId: string): Promise<{ success: boolean; message: string }> =>
    api.post(`/api/v1/scanner-packages/admin/${packageId}/unarchive`).then(res => res.data),

  // Admin: Delete package (legacy - now archives)
  deletePackage: (packageId: string): Promise<{ success: boolean; message: string }> =>
    api.delete(`/api/v1/scanner-packages/admin/${packageId}`).then(res => res.data),

  // Admin: Get package statistics
  getStatistics: (packageId: string): Promise<any> =>
    api.get(`/api/v1/scanner-packages/admin/${packageId}/statistics`).then(res => res.data),
};

export const scannerConfigsApi = {
  // Get all scanner configurations for application
  getAll: (includeDisabled: boolean = true): Promise<any[]> =>
    api.get('/api/v1/scanner-configs', { params: { include_disabled: includeDisabled } }).then(res => res.data),

  // Get only enabled scanner configurations
  getEnabled: (scanType?: 'prompt' | 'response'): Promise<any[]> =>
    api.get('/api/v1/scanner-configs/enabled', { params: { scan_type: scanType } }).then(res => res.data),

  // Update scanner configuration
  update: (scannerId: string, updates: any): Promise<{ success: boolean; message: string; data: any }> =>
    api.put(`/api/v1/scanner-configs/${scannerId}`, updates).then(res => res.data),

  // Bulk update scanner configurations
  bulkUpdate: (updates: Array<{ scanner_id: string; [key: string]: any }>): Promise<{ success: boolean; message: string; data: any }> =>
    api.post('/api/v1/scanner-configs/bulk-update', { updates }).then(res => res.data),

  // Reset scanner configuration to defaults
  reset: (scannerId: string): Promise<{ success: boolean; message: string }> =>
    api.post(`/api/v1/scanner-configs/${scannerId}/reset`).then(res => res.data),

  // Reset all configurations to defaults
  resetAll: (): Promise<{ success: boolean; message: string; data: any }> =>
    api.post('/api/v1/scanner-configs/reset-all').then(res => res.data),

  // Initialize default configs for all available scanners
  initialize: (): Promise<{ success: boolean; message: string; data: any }> =>
    api.post('/api/v1/scanner-configs/initialize').then(res => res.data),
};

export const customScannersApi = {
  // Get all custom scanners for application
  getAll: (): Promise<any[]> =>
    api.get('/api/v1/custom-scanners').then(res => res.data),

  // Get custom scanner by ID
  get: (scannerId: string): Promise<any> =>
    api.get(`/api/v1/custom-scanners/${scannerId}`).then(res => res.data),

  // Create custom scanner
  create: (scannerData: {
    scanner_type: 'genai' | 'regex' | 'keyword';
    name: string;
    definition: string;
    risk_level: 'high_risk' | 'medium_risk' | 'low_risk';
    scan_prompt?: boolean;
    scan_response?: boolean;
    notes?: string;
  }): Promise<any> =>
    api.post('/api/v1/custom-scanners', scannerData).then(res => res.data),

  // Update custom scanner
  update: (scannerId: string, updates: any): Promise<any> =>
    api.put(`/api/v1/custom-scanners/${scannerId}`, updates).then(res => res.data),

  // Delete custom scanner
  delete: (scannerId: string): Promise<{ success: boolean; message: string }> =>
    api.delete(`/api/v1/custom-scanners/${scannerId}`).then(res => res.data),
};

export const purchasesApi = {
  // Direct purchase for free packages (auto-approved, no admin review)
  directPurchase: (packageId: string, email: string): Promise<any> =>
    api.post('/api/v1/purchases/direct', { package_id: packageId, email }).then(res => res.data),

  // Request to purchase a package (DEPRECATED - use payment API or directPurchase instead)
  request: (packageId: string, email: string, message?: string): Promise<any> =>
    api.post('/api/v1/purchases/request', { package_id: packageId, email, message }).then(res => res.data),

  // Get current user's purchase requests
  getMyPurchases: (status?: 'pending' | 'approved' | 'rejected'): Promise<any[]> =>
    api.get('/api/v1/purchases/my-purchases', { params: { status_filter: status } }).then(res => res.data),

  // Cancel own purchase request
  cancel: (purchaseId: string): Promise<{ success: boolean; message: string }> =>
    api.delete(`/api/v1/purchases/${purchaseId}`).then(res => res.data),

  // Admin: Get all pending purchase requests
  getPending: (): Promise<any[]> =>
    api.get('/api/v1/purchases/admin/pending').then(res => res.data),

  // Admin: Approve purchase request
  approve: (purchaseId: string): Promise<any> =>
    api.post(`/api/v1/purchases/admin/${purchaseId}/approve`).then(res => res.data),

  // Admin: Reject purchase request
  reject: (purchaseId: string, rejectionReason: string): Promise<any> =>
    api.post(`/api/v1/purchases/admin/${purchaseId}/reject`, { rejection_reason: rejectionReason }).then(res => res.data),

  // Admin: Get purchase statistics
  getStatistics: (packageId?: string): Promise<{ success: boolean; message: string; data: any }> =>
    api.get('/api/v1/purchases/admin/statistics', { params: { package_id: packageId } }).then(res => res.data),
};

export const dataLeakagePolicyApi = {
  // Get tenant-level default policy
  getTenantDefaults: (): Promise<any> =>
    api.get('/api/v1/config/data-leakage-policy/tenant-defaults').then(res => res.data),

  // Update tenant-level default policy
  updateTenantDefaults: (policyData: {
    default_input_high_risk_action: string;
    default_input_medium_risk_action: string;
    default_input_low_risk_action: string;
    default_output_high_risk_anonymize: boolean;
    default_output_medium_risk_anonymize: boolean;
    default_output_low_risk_anonymize: boolean;
    default_private_model_id?: string | null;
    default_enable_format_detection: boolean;
    default_enable_smart_segmentation: boolean;
  }): Promise<any> =>
    api.put('/api/v1/config/data-leakage-policy/tenant-defaults', policyData).then(res => res.data),

  // Get data leakage policy for current application
  getPolicy: (applicationId: string): Promise<any> =>
    api.get('/api/v1/config/data-leakage-policy', {
      headers: { 'X-Application-ID': applicationId }
    }).then(res => res.data),

  // Update data leakage policy
  updatePolicy: (applicationId: string, policyData: {
    input_high_risk_action?: string | null;
    input_medium_risk_action?: string | null;
    input_low_risk_action?: string | null;
    output_high_risk_anonymize?: boolean | null;
    output_medium_risk_anonymize?: boolean | null;
    output_low_risk_anonymize?: boolean | null;
    private_model_id?: string | null;
    enable_format_detection?: boolean | null;
    enable_smart_segmentation?: boolean | null;
  }): Promise<any> =>
    api.put('/api/v1/config/data-leakage-policy', policyData, {
      headers: { 'X-Application-ID': applicationId }
    }).then(res => res.data),

  // Get available private models
  getPrivateModels: (): Promise<any[]> =>
    api.get('/api/v1/config/private-models').then(res => res.data),
};

// Gateway Policy API (unified security policy for Security Gateway)
export const gatewayPolicyApi = {
  // Get tenant-level default gateway policy
  getTenantDefaults: (): Promise<any> =>
    api.get('/api/v1/config/gateway-policy/tenant-defaults').then(res => res.data),

  // Update tenant-level default gateway policy
  updateTenantDefaults: (policyData: {
    default_general_high_risk_action: string;
    default_general_medium_risk_action: string;
    default_general_low_risk_action: string;
    default_input_high_risk_action: string;
    default_input_medium_risk_action: string;
    default_input_low_risk_action: string;
    default_output_high_risk_action: string;
    default_output_medium_risk_action: string;
    default_output_low_risk_action: string;
  }): Promise<any> =>
    api.put('/api/v1/config/gateway-policy/tenant-defaults', policyData).then(res => res.data),

  // Get gateway policy for current application
  getPolicy: (applicationId: string): Promise<any> =>
    api.get('/api/v1/config/gateway-policy', {
      headers: { 'X-Application-ID': applicationId }
    }).then(res => res.data),

  // Update gateway policy
  updatePolicy: (applicationId: string, policyData: {
    general_high_risk_action?: string | null;
    general_medium_risk_action?: string | null;
    general_low_risk_action?: string | null;
    input_high_risk_action?: string | null;
    input_medium_risk_action?: string | null;
    input_low_risk_action?: string | null;
    output_high_risk_action?: string | null;
    output_medium_risk_action?: string | null;
    output_low_risk_action?: string | null;
    private_model_id?: string | null;
  }): Promise<any> =>
    api.put('/api/v1/config/gateway-policy', policyData, {
      headers: { 'X-Application-ID': applicationId }
    }).then(res => res.data),
};

// Fixed Answer Templates API
export const fixedAnswerTemplatesApi = {
  // Get fixed answer templates for current application
  get: (): Promise<{
    security_risk_template: { en: string; zh: string };
    data_leakage_template: { en: string; zh: string };
  }> =>
    api.get('/api/v1/config/fixed-answer-templates').then(res => res.data),

  // Update fixed answer templates
  update: (templates: {
    security_risk_template?: { en?: string; zh?: string };
    data_leakage_template?: { en?: string; zh?: string };
  }): Promise<{ success: boolean; message: string }> =>
    api.put('/api/v1/config/fixed-answer-templates', templates).then(res => res.data),
};

export default api;