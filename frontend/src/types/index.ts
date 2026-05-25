// API response type
export interface ApiResponse<T = any> {
  success: boolean;
  message: string;
  data?: T;
}

// Guardrail detection related types
export interface GuardrailRequest {
  model: string;
  messages: Message[];
  max_tokens?: number;
  temperature?: number;
}

export interface Message {
  role: 'user' | 'system' | 'assistant';
  content: string;
}

export interface GuardrailResponse {
  id: string;
  result: {
    compliance: {
      risk_level: string;
      categories: string[];
    };
    security: {
      risk_level: string;
      categories: string[];
    };
    data: {
      risk_level: string;
      categories: string[];
    };
  };
  overall_risk_level: string;
  suggest_action: string;
  suggest_answer?: string;
  score?: number;  // Detection probability score (0.0-1.0)
}

// Detection result type
export interface DetectionResult {
  id: number;
  request_id: string;
  content: string;
  original_content?: string;  // Original unmasked content (only when data masking applied)
  has_data_masking?: boolean;  // Whether data masking was applied
  suggest_action?: string;
  suggest_answer?: string;
  hit_keywords?: string;
  model_response?: string;  // e.g. blacklist_hit, whitelist_hit
  created_at: string;
  ip_address?: string;
  // Separated security and compliance detection results
  security_risk_level: string;
  security_categories: string[];
  compliance_risk_level: string;
  compliance_categories: string[];
  // Data security detection results
  data_risk_level: string;
  data_categories: string[];
  // Detection result related fields
  score?: number;  // Detection probability score (0.0-1.0)
  // 多模态相关字段
  has_image?: boolean;
  image_count?: number;
  image_paths?: string[];
  image_urls?: string[];  // Signed image access URLs
  // Direct Model Access flag
  is_direct_model_access?: boolean;  // Whether this is a direct model access call
  // Detection source: guardrail_api, proxy, gateway, direct_model, content_scan
  source?: string;
  // Unsafe content segments identified by second-pass detection
  unsafe_segments?: Array<{
    text: string;
    start: number;
    end: number;
    categories: string[];
  }>;
  // Doublecheck fields
  doublecheck_result?: string;  // confirmed_unsafe, overturned_safe, or null
  doublecheck_categories?: string[];  // Original categories before doublecheck
  doublecheck_reasoning?: string;  // AI reasoning from doublecheck
  // Application and workspace info (for global results view)
  application_id?: string;
  application_name?: string;
  workspace_id?: string;
  workspace_name?: string;
  // Detection scope fields (content field stores actual detected content)
  detection_scope?: string;  // What was detected: 'all', 'last_message', 'user_only'
  sliding_window_count?: number;  // Number of sliding windows used
  matched_window_indices?: number[];  // Which windows matched
  // Audit: complete original messages array (system + user/assistant + tool_calls + tool results).
  // Only populated by the detail endpoint; undefined in list responses.
  full_messages?: Array<{
    role: string;
    content?: string | Array<{ type: string; text?: string; image_url?: { url: string } | string }> | null;
    name?: string;
    tool_call_id?: string;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
    }>;
    [key: string]: any;
  }>;
}

// Paginated response type.
// `total` / `pages` may be null when computing the exact count is too
// expensive (e.g., substring search over a very large table). In that case
// callers should fall back to `has_more` for next-page navigation.
export interface PaginatedResponse<T> {
  items: T[];
  total: number | null;
  page: number;
  per_page: number;
  pages: number | null;
  has_more?: boolean;
}

// Configuration related types
export interface Blacklist {
  id: number;
  name: string;
  keywords: string[];
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Whitelist {
  id: number;
  name: string;
  keywords: string[];
  description?: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ResponseTemplate {
  id: number;
  category: string;
  scanner_type?: string | null;  // Scanner type: blacklist, whitelist, official_scanner, custom_scanner, etc.
  scanner_identifier?: string | null;  // Scanner identifier: blacklist name, scanner tag, etc.
  guardrail_name?: string | null;  // Guardrail name from Scanner table (for custom/marketplace scanners)
  risk_level: string;
  template_content: { [key: string]: string };  // Multilingual content: { en: "...", zh: "...", ... }
  is_default: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Dashboard statistics type
export interface DashboardStats {
  total_requests: number;
  security_risks: number;
  compliance_risks: number;
  data_leaks: number;
  high_risk_count: number;
  medium_risk_count: number;
  low_risk_count: number;
  safe_count: number;
  risk_distribution: {
    'high_risk': number;
    'medium_risk': number;
    'low_risk': number;
    'no_risk': number;
  };
  daily_trends: DailyTrend[];
}

export interface DailyTrend {
  date: string;
  total: number;
  high_risk: number;
  medium_risk: number;
  low_risk: number;
  safe: number;
}

// Knowledge base related types
export interface KnowledgeBase {
  id: number;
  category?: string | null;  // Legacy field (S1-S21) - nullable for new scanner types
  scanner_type?: string | null;  // Scanner type: blacklist, whitelist, official_scanner, etc.
  scanner_identifier?: string | null;  // Scanner identifier: blacklist name, scanner tag, etc.
  guardrail_name?: string | null;  // Guardrail human-readable name for display
  name: string;
  description?: string;
  file_path: string;
  vector_file_path?: string;
  total_qa_pairs: number;
  similarity_threshold: number;
  is_active: boolean;
  is_global: boolean;
  is_disabled_by_me?: boolean;  // Whether current user has disabled this global KB
  created_at: string;
  updated_at: string;
}

export interface KnowledgeBaseFileInfo {
  original_file_exists: boolean;
  vector_file_exists: boolean;
  original_file_size: number;
  vector_file_size: number;
  total_qa_pairs: number;
}

export interface SimilarQuestionResult {
  questionid: string;
  question: string;
  answer: string;
  similarity_score: number;
  rank: number;
}

// Data security related types
export interface DataSecurityEntityType {
  id: string;
  entity_type: string;
  entity_type_name: string;
  risk_level: string;  // Low, medium, high
  pattern: string;
  anonymization_method: string;
  anonymization_config: Record<string, any>;
  check_input: boolean;
  check_output: boolean;
  is_active: boolean;
  is_global: boolean;
  created_at: string;
  updated_at: string;
}