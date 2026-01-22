# API Reference

> Complete API reference for OpenGuardrails platform

## Table of Contents

- [Overview](#overview)
- [Service Ports](#service-ports)
- [Authentication](#authentication)
- [API Endpoints](#api-endpoints)
  - [Guardrails Detection API](#guardrails-detection-api)
  - [Authentication API](#authentication-api)
  - [User Management API](#user-management-api)
  - [Dashboard API](#dashboard-api)
  - [Configuration API](#configuration-api)
  - [Proxy Management API](#proxy-management-api)
  - [Ban Policy API](#ban-policy-api)
  - [Risk Configuration API](#risk-configuration-api)
  - [Detection Results API](#detection-results-api)
  - [Data Security API](#data-security-api)
  - [Data Leakage Policy API](#data-leakage-policy-api)
  - [Media API](#media-api)
- [Request/Response Models](#requestresponse-models)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)

---

## Overview

OpenGuardrails provides RESTful APIs built with FastAPI. The platform consists of three independent services:

- **Admin Service** (Port 5000): User management and configuration
- **Detection Service** (Port 5001): Core safety detection APIs
- **Proxy Service** (Port 5002): Transparent security gateway

All APIs follow OpenAPI 3.0 specification and return JSON responses.

### Base URLs

```
Admin Service:     http://localhost:5000
Detection Service: http://localhost:5001
Proxy Service:     http://localhost:5002
```

### API Documentation

When running in debug mode, interactive API documentation is available:

- **Swagger UI**: `http://localhost:{port}/docs`
- **ReDoc**: `http://localhost:{port}/redoc`
- **OpenAPI JSON**: `http://localhost:{port}/openapi.json`

---

## Service Ports

| Service | Port | Purpose | Main Routes |
|---------|------|---------|-------------|
| **Admin Service** | 5000 | User & configuration management | `/api/v1/auth`, `/api/v1/users`, `/api/v1/config` |
| **Detection Service** | 5001 | Safety detection & analysis | `/v1/guardrails`, `/api/v1/dashboard` |
| **Proxy Service** | 5002 | Transparent security gateway | `/v1/chat/completions` (OpenAI compatible) |

---

## Authentication

OpenGuardrails supports two authentication methods:

### 1. API Key Authentication

Include your API key in the request header:

```http
Authorization: Bearer sk-xxai-your-api-key-here
```

### 2. JWT Token Authentication

For admin and user management APIs, use JWT tokens obtained from the login endpoint:

```http
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Multi-Tenant Support

The platform supports tenant isolation. API requests are automatically scoped to the authenticated user's tenant.

**Super Admin User Switching**: Super admins can switch user context by including:

```http
X-Switch-User: {user_id}
```

---

## API Endpoints

### Guardrails Detection API

Core safety detection endpoints for prompt attack, content compliance, and data leak detection.

#### POST `/v1/guardrails`

Detect safety risks in AI conversations with full context awareness.

**Service**: Detection Service (Port 5001)

**Request Body**:

```json
{
  "model": "string (optional)",
  "messages": [
    {
      "role": "user|assistant",
      "content": "string or array"
    }
  ]
}
```

**Multimodal Message Format** (supports text + images):

```json
{
  "model": "gpt-4-vision",
  "messages": [
    {
      "role": "user",
      "content": [
        {"type": "text", "text": "Is this image safe?"},
        {
          "type": "image_url",
          "image_url": {
            "url": "data:image/jpeg;base64,{base64_image}"
          }
        }
      ]
    }
  ]
}
```

**Response**:

```json
{
  "id": "det_xxxxxxxx",
  "result": {
    "compliance": {
      "risk_level": "no_risk|low_risk|medium_risk|high_risk",
      "categories": ["Violent Crime", "Illegal Activities"],
      "score": 0.85
    },
    "security": {
      "risk_level": "no_risk|low_risk|medium_risk|high_risk",
      "categories": ["Prompt Injection", "Jailbreak"],
      "score": 0.72
    },
    "data": {
      "risk_level": "no_risk|low_risk|medium_risk|high_risk",
      "categories": ["ID Card", "Phone Number"],
      "entities": [
        {
          "type": "phone",
          "value": "138****5678",
          "original": "13812345678",
          "masked": true
        }
      ],
      "score": 0.65
    }
  },
  "overall_risk_level": "high_risk",
  "suggest_action": "Pass|Decline|Delegate",
  "suggest_answer": "Sorry, I cannot provide information related to violent crimes.",
  "score": 0.82,
  "matched_knowledge_base": {
    "questionid": "q123",
    "question": "...",
    "answer": "...",
    "similarity": 0.95
  }
}
```

**Risk Levels**:
- `no_risk`: Safe to proceed
- `low_risk`: Minor concerns, usually safe
- `medium_risk`: Moderate risk, may require review
- `high_risk`: Significant risk, should be blocked

**Suggest Actions**:
- `Pass`: Content is safe
- `Decline`: Content should be blocked
- `Delegate`: Delegate to knowledge base answer (if matched)

---

#### POST `/v1/guardrails/input`

Detect safety risks in user input only (without full conversation context).

**Service**: Detection Service (Port 5001)

**Request Body**:

```json
{
  "input": "string",
  "model": "string (optional)"
}
```

**Response**: Same format as `/v1/guardrails`

---

#### POST `/v1/guardrails/output`

Detect safety risks in AI model output only.

**Service**: Detection Service (Port 5001)

**Request Body**:

```json
{
  "output": "string",
  "model": "string (optional)"
}
```

**Response**: Same format as `/v1/guardrails`

---

### Authentication API

User authentication and session management.

#### POST `/api/v1/auth/login`

Authenticate user and obtain JWT token.

**Service**: Admin Service (Port 5000)

**Request Body**:

```json
{
  "username": "string",
  "password": "string"
}
```

**Response**:

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "token_type": "bearer",
  "user": {
    "id": "user_xxx",
    "username": "john_doe",
    "email": "john@example.com",
    "role": "admin|user",
    "tenant_id": "tenant_xxx",
    "api_key": "sk-xxai-xxx",
    "created_at": "2025-01-15T10:30:00Z"
  }
}
```

---

#### GET `/api/v1/auth/me`

Get current authenticated user information.

**Service**: Admin Service (Port 5000)

**Authentication**: Required (JWT or API Key)

**Response**:

```json
{
  "id": "user_xxx",
  "username": "john_doe",
  "email": "john@example.com",
  "role": "admin|user",
  "tenant_id": "tenant_xxx",
  "api_key": "sk-xxai-xxx",
  "created_at": "2025-01-15T10:30:00Z"
}
```

---

#### POST `/api/v1/auth/logout`

Logout and invalidate current session.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "message": "Logout successful"
}
```

---

### User Management API

Manage users and tenants.

#### GET `/api/v1/users`

List all users (admin only).

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Query Parameters**:
- `skip` (integer, default: 0): Pagination offset
- `limit` (integer, default: 100): Number of users to return
- `role` (string, optional): Filter by role
- `tenant_id` (string, optional): Filter by tenant

**Response**:

```json
{
  "users": [
    {
      "id": "user_xxx",
      "username": "john_doe",
      "email": "john@example.com",
      "role": "admin|user",
      "tenant_id": "tenant_xxx",
      "created_at": "2025-01-15T10:30:00Z",
      "is_active": true
    }
  ],
  "total": 42
}
```

---

#### POST `/api/v1/users`

Create a new user (admin only).

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "username": "string",
  "email": "string",
  "password": "string",
  "role": "admin|user",
  "tenant_id": "string (optional)"
}
```

**Response**:

```json
{
  "id": "user_xxx",
  "username": "john_doe",
  "email": "john@example.com",
  "role": "user",
  "tenant_id": "tenant_xxx",
  "api_key": "sk-xxai-xxx",
  "created_at": "2025-01-15T10:30:00Z"
}
```

---

#### PUT `/api/v1/users/{user_id}`

Update user information (admin only).

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "email": "string (optional)",
  "password": "string (optional)",
  "role": "admin|user (optional)",
  "is_active": true|false (optional)
}
```

**Response**: Updated user object

---

#### DELETE `/api/v1/users/{user_id}`

Delete a user (admin only).

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Response**:

```json
{
  "message": "User deleted successfully"
}
```

---

### Dashboard API

Analytics and statistics endpoints.

#### GET `/api/v1/dashboard/stats`

Get dashboard statistics and metrics.

**Service**: Detection Service (Port 5001)

**Authentication**: Required

**Query Parameters**:
- `start_date` (string, ISO 8601): Start date for statistics
- `end_date` (string, ISO 8601): End date for statistics

**Response**:

```json
{
  "total_detections": 12450,
  "total_blocked": 342,
  "total_passed": 12108,
  "risk_distribution": {
    "no_risk": 11850,
    "low_risk": 258,
    "medium_risk": 180,
    "high_risk": 162
  },
  "category_distribution": {
    "Violent Crime": 45,
    "Illegal Activities": 38,
    "Prompt Injection": 67,
    "Data Leak": 23
  },
  "hourly_trend": [
    {"hour": "2025-01-15T00:00:00Z", "count": 512},
    {"hour": "2025-01-15T01:00:00Z", "count": 387}
  ],
  "ban_statistics": {
    "total_banned_users": 15,
    "total_ban_events": 23,
    "active_bans": 8
  }
}
```

---

#### GET `/api/v1/dashboard/category-distribution`

Get detailed category distribution statistics.

**Service**: Detection Service (Port 5001)

**Authentication**: Required

**Response**:

```json
{
  "compliance": {
    "Violent Crime": 45,
    "Illegal Activities": 38,
    "Sexual Content": 12,
    "Discrimination": 8
  },
  "security": {
    "Prompt Injection": 67,
    "Jailbreak": 34,
    "Code Injection": 12
  },
  "data_security": {
    "ID Card": 15,
    "Phone Number": 23,
    "Email": 18,
    "Bank Card": 5
  }
}
```

---

### Configuration API

Manage platform configurations including blacklist, whitelist, and response templates.

#### GET `/api/v1/config/blacklist`

Get current blacklist keywords.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "keywords": ["bomb", "weapon", "hack"]
}
```

---

#### PUT `/api/v1/config/blacklist`

Update blacklist keywords.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "keywords": ["bomb", "weapon", "hack", "exploit"]
}
```

**Response**:

```json
{
  "message": "Blacklist updated successfully",
  "keywords": ["bomb", "weapon", "hack", "exploit"]
}
```

---

#### GET `/api/v1/config/whitelist`

Get current whitelist keywords.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "keywords": ["education", "research", "authorized"]
}
```

---

#### PUT `/api/v1/config/whitelist`

Update whitelist keywords.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "keywords": ["education", "research", "authorized", "legitimate"]
}
```

---

#### GET `/api/v1/config/response-templates`

Get configured response templates for different risk categories.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "templates": [
    {
      "category": "Violent Crime",
      "template": "Sorry, I cannot provide information related to violent crimes."
    },
    {
      "category": "Illegal Activities",
      "template": "I cannot assist with illegal activities."
    }
  ]
}
```

---

#### PUT `/api/v1/config/response-templates`

Update response templates.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "templates": [
    {
      "category": "Violent Crime",
      "template": "Custom response for violent crime category"
    }
  ]
}
```

---

### Proxy Management API

Manage proxy models and configurations for the security gateway.

#### GET `/api/v1/proxy/models`

List all configured proxy models.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "models": [
    {
      "id": "model_xxx",
      "name": "gpt-4-proxy",
      "upstream_url": "https://api.openai.com/v1",
      "upstream_model": "gpt-4",
      "upstream_api_key": "sk-xxx",
      "enabled": true,
      "created_at": "2025-01-15T10:30:00Z"
    }
  ]
}
```

---

#### POST `/api/v1/proxy/models`

Create a new proxy model configuration.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "name": "gpt-4-proxy",
  "upstream_url": "https://api.openai.com/v1",
  "upstream_model": "gpt-4",
  "upstream_api_key": "sk-xxx",
  "enabled": true
}
```

**Response**: Created proxy model object

---

#### PUT `/api/v1/proxy/models/{model_id}`

Update proxy model configuration.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**: Same as POST

**Response**: Updated proxy model object

---

#### DELETE `/api/v1/proxy/models/{model_id}`

Delete a proxy model configuration.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Response**:

```json
{
  "message": "Proxy model deleted successfully"
}
```

---

### Ban Policy API

Manage ban policies and banned users.

#### GET `/api/v1/ban-policy`

Get current ban policy configuration.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "enabled": true,
  "risk_levels": ["high_risk", "medium_risk"],
  "trigger_count": 3,
  "time_window_minutes": 60,
  "ban_duration_minutes": 1440
}
```

**Configuration Parameters**:
- `enabled`: Whether ban policy is active
- `risk_levels`: Which risk levels trigger ban counting
- `trigger_count`: Number of violations before ban
- `time_window_minutes`: Time window for counting violations
- `ban_duration_minutes`: How long the ban lasts

---

#### PUT `/api/v1/ban-policy`

Update ban policy configuration.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "enabled": true,
  "risk_levels": ["high_risk"],
  "trigger_count": 5,
  "time_window_minutes": 30,
  "ban_duration_minutes": 720
}
```

---

#### GET `/api/v1/banned-users`

List all currently banned users.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "banned_users": [
    {
      "user_id": "user_xxx",
      "username": "malicious_user",
      "banned_at": "2025-01-15T10:30:00Z",
      "ban_expires_at": "2025-01-16T10:30:00Z",
      "violation_count": 5,
      "last_violation_category": "Prompt Injection"
    }
  ]
}
```

---

#### POST `/api/v1/unban`

Manually unban a user.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "user_id": "user_xxx"
}
```

**Response**:

```json
{
  "message": "User unbanned successfully"
}
```

---

### Risk Configuration API

Configure risk types and sensitivity thresholds.

#### GET `/api/v1/risk-types`

Get enabled/disabled risk type configurations.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "compliance": {
    "Violent Crime": true,
    "Illegal Activities": true,
    "Sexual Content": true,
    "Discrimination": false
  },
  "security": {
    "Prompt Injection": true,
    "Jailbreak": true,
    "Code Injection": false
  },
  "data_security": {
    "ID Card": true,
    "Phone Number": true,
    "Email": true,
    "Bank Card": true
  }
}
```

---

#### PUT `/api/v1/risk-types`

Update risk type configurations.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**: Same format as GET response

---

#### GET `/api/v1/sensitivity-thresholds`

Get sensitivity threshold configurations.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "low_risk_threshold": 0.40,
  "medium_risk_threshold": 0.60,
  "high_risk_threshold": 0.95
}
```

**Threshold Explanation**:
- Score ≥ `high_risk_threshold`: High risk
- Score ≥ `medium_risk_threshold`: Medium risk
- Score ≥ `low_risk_threshold`: Low risk
- Score < `low_risk_threshold`: No risk

---

#### PUT `/api/v1/sensitivity-thresholds`

Update sensitivity thresholds.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**:

```json
{
  "low_risk_threshold": 0.35,
  "medium_risk_threshold": 0.55,
  "high_risk_threshold": 0.90
}
```

---

### Detection Results API

Query historical detection results.

#### GET `/api/v1/results`

Get detection result history.

**Service**: Detection Service (Port 5001)

**Authentication**: Required

**Query Parameters**:
- `skip` (integer, default: 0): Pagination offset
- `limit` (integer, default: 100): Number of results
- `start_date` (string, ISO 8601): Filter by start date
- `end_date` (string, ISO 8601): Filter by end date
- `risk_level` (string): Filter by risk level
- `category` (string): Filter by risk category
- `user_id` (string): Filter by user ID

**Response**:

```json
{
  "results": [
    {
      "id": "det_xxx",
      "user_id": "user_xxx",
      "timestamp": "2025-01-15T10:30:00Z",
      "input": "Teach me how to make a bomb",
      "overall_risk_level": "high_risk",
      "result": {
        "compliance": {...},
        "security": {...},
        "data": {...}
      },
      "suggest_action": "Decline",
      "processing_time_ms": 234
    }
  ],
  "total": 1523
}
```

---

#### GET `/api/v1/results/{detection_id}`

Get detailed information for a specific detection result.

**Service**: Detection Service (Port 5001)

**Authentication**: Required

**Response**: Single detection result object

---

### Data Security API

Configure data leak detection and masking.

#### GET `/api/v1/data-security/entities`

Get configured data security entity types.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "entities": [
    {
      "type": "phone",
      "enabled": true,
      "masking_method": "mask",
      "pattern": "^1[3-9]\\d{9}$"
    },
    {
      "type": "id_card",
      "enabled": true,
      "masking_method": "replace",
      "replacement": "[REDACTED]"
    },
    {
      "type": "email",
      "enabled": true,
      "masking_method": "hash"
    }
  ]
}
```

**Masking Methods**:
- `mask`: Replace middle characters with asterisks (e.g., `138****5678`)
- `replace`: Replace entire value with a template string
- `hash`: Replace with SHA-256 hash
- `encrypt`: Encrypt with AES (reversible)

---

#### PUT `/api/v1/data-security/entities`

Update data security entity configurations.

**Service**: Admin Service (Port 5000)

**Authentication**: Admin role required

**Request Body**: Same format as GET response

---

### Data Leakage Policy API

Configure data leakage prevention disposal policies and private model selection.

#### GET `/api/v1/config/data-leakage-policy`

Get data leakage disposal policy for the current application.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Headers**:
```http
X-Application-ID: {application_id}
```

**Response**:

```json
{
  "id": "policy_xxx",
  "application_id": "app_xxx",
  "high_risk_action": "block",
  "medium_risk_action": "switch_private_model",
  "low_risk_action": "anonymize",
  "private_model": {
    "id": "model_xxx",
    "config_name": "Enterprise Private Model",
    "provider": "openai",
    "model": "gpt-4",
    "is_data_safe": true,
    "is_default_private_model": true,
    "private_model_priority": 10
  },
  "available_private_models": [
    {
      "id": "model_xxx",
      "config_name": "Enterprise Private Model",
      "provider": "openai",
      "model": "gpt-4",
      "is_data_safe": true,
      "is_default_private_model": true,
      "private_model_priority": 10
    }
  ],
  "enable_format_detection": true,
  "enable_smart_segmentation": true,
  "created_at": "2025-01-05T10:00:00Z",
  "updated_at": "2025-01-05T12:30:00Z"
}
```

**Disposal Actions**:
- `block`: Block the request completely
- `switch_private_model`: Switch to a data-private model (e.g., on-premise/private)
- `anonymize`: Anonymize sensitive data before sending
- `pass`: Allow the request (record only)

**Default Strategy**:
- High Risk → `block`
- Medium Risk → `switch_private_model`
- Low Risk → `anonymize`

---

#### PUT `/api/v1/config/data-leakage-policy`

Update data leakage disposal policy for an application.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Headers**:
```http
X-Application-ID: {application_id}
```

**Request Body**:

```json
{
  "high_risk_action": "block",
  "medium_risk_action": "switch_private_model",
  "low_risk_action": "anonymize",
  "private_model_id": "model_xxx",
  "enable_format_detection": true,
  "enable_smart_segmentation": true
}
```

**Response**: Same as GET response

**Field Descriptions**:
- `high_risk_action`, `medium_risk_action`, `low_risk_action`: Disposal action for each risk level
- `private_model_id`: Specific private model to use (null = use tenant's default)
- `enable_format_detection`: Auto-detect content format (JSON/YAML/CSV/Markdown) for optimization
- `enable_smart_segmentation`: Intelligently segment content by format for better GenAI detection

---

#### GET `/api/v1/config/private-models`

List all available data-private models for the tenant.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
[
  {
    "id": "model_xxx",
    "config_name": "Enterprise Private GPT-4",
    "provider": "openai",
    "model": "gpt-4",
    "is_data_safe": true,
    "is_default_private_model": true,
    "private_model_priority": 10
  },
  {
    "id": "model_yyy",
    "config_name": "Local Llama Model",
    "provider": "ollama",
    "model": "llama2",
    "is_data_safe": true,
    "is_default_private_model": false,
    "private_model_priority": 5
  }
]
```

**Private Model Selection Priority**:
1. Application-configured private model (`private_model_id` in policy)
2. Tenant's default private model (`is_default_private_model = true`)
3. Highest priority private model (`private_model_priority` DESC)

---

### Media API

Upload and manage media files (images for multimodal detection).

#### POST `/api/v1/media/upload/image`

Upload an image for detection.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Request**: Multipart form data

**Form Fields**:
- `file`: Image file (PNG, JPG, JPEG, GIF)
- `purpose` (optional): Purpose of upload (e.g., "detection")

**Response**:

```json
{
  "file_id": "file_xxx",
  "url": "/media/images/file_xxx.jpg",
  "filename": "uploaded_image.jpg",
  "size_bytes": 245678,
  "mime_type": "image/jpeg",
  "created_at": "2025-01-15T10:30:00Z"
}
```

---

#### GET `/api/v1/media/images/{file_id}`

Retrieve an uploaded image.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**: Image file (binary)

---

#### DELETE `/api/v1/media/images/{file_id}`

Delete an uploaded image.

**Service**: Admin Service (Port 5000)

**Authentication**: Required

**Response**:

```json
{
  "message": "Image deleted successfully"
}
```

---

## Request/Response Models

### GuardrailRequest

Main detection request model.

```typescript
{
  model?: string;                // Optional model identifier
  messages: Message[];           // Conversation messages


  // For direct HTTP/curl requests, use top-level parameters:
  xxai_app_user_id?: string;
}
```

### Message

Message in conversation (supports multimodal).

```typescript
{
  role: "user" | "assistant" | "system";
  content: string | ContentPart[];  // Text or multimodal content
}
```

### ContentPart

Content part for multimodal messages.

```typescript
{
  type: "text" | "image_url";
  text?: string;                    // For text type
  image_url?: {                     // For image_url type
    url: string;                    // data:image/jpeg;base64,... or http(s) URL
  }
}
```

### GuardrailResponse

Detection result response.

```typescript
{
  id: string;                       // Detection ID
  result: {
    compliance: ComplianceResult;
    security: SecurityResult;
    data: DataSecurityResult;
  };
  overall_risk_level: "no_risk" | "low_risk" | "medium_risk" | "high_risk";
  suggest_action: "Pass" | "Decline" | "Delegate";
  suggest_answer?: string;          // Suggested response template
  score: number;                    // Overall risk score (0.0-1.0)
  matched_knowledge_base?: {        // If matched to knowledge base
    questionid: string;
    question: string;
    answer: string;
    similarity: number;
  };
}
```

### ComplianceResult

Content compliance detection result.

```typescript
{
  risk_level: "no_risk" | "low_risk" | "medium_risk" | "high_risk";
  categories: string[];             // Detected risk categories
  score: number;                    // Compliance score (0.0-1.0)
  details?: {                       // Optional detailed information
    [category: string]: number;     // Category-specific scores
  }
}
```

### SecurityResult

Security attack detection result.

```typescript
{
  risk_level: "no_risk" | "low_risk" | "medium_risk" | "high_risk";
  categories: string[];             // Detected attack types
  score: number;                    // Security score (0.0-1.0)
  details?: {
    [category: string]: number;
  }
}
```

### DataSecurityResult

Data leak detection result.

```typescript
{
  risk_level: "no_risk" | "low_risk" | "medium_risk" | "high_risk";
  categories: string[];             // Detected data types
  entities: DataEntity[];           // Detected entities with masking
  score: number;                    // Data security score (0.0-1.0)
}
```

### DataEntity

Detected sensitive data entity.

```typescript
{
  type: string;                     // Entity type (phone, id_card, email, etc.)
  value: string;                    // Masked value
  original?: string;                // Original value (only if masking disabled)
  masked: boolean;                  // Whether value was masked
  position?: {                      // Position in text
    start: number;
    end: number;
  }
}
```

---

## Error Handling

All API errors follow a consistent format:

### Error Response Format

```json
{
  "detail": "Error message description",
  "error_code": "ERROR_CODE",
  "status_code": 400
}
```

### Common HTTP Status Codes

| Status Code | Meaning | Common Causes |
|-------------|---------|---------------|
| 200 | Success | Request completed successfully |
| 400 | Bad Request | Invalid request parameters or body |
| 401 | Unauthorized | Missing or invalid authentication |
| 403 | Forbidden | Insufficient permissions |
| 404 | Not Found | Resource does not exist |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Server-side error |
| 503 | Service Unavailable | Service temporarily unavailable |

### Common Error Codes

| Error Code | Description | Solution |
|------------|-------------|----------|
| `INVALID_API_KEY` | API key is invalid or expired | Check your API key in account settings |
| `INSUFFICIENT_PERMISSIONS` | User lacks required permissions | Contact admin for access |
| `RATE_LIMIT_EXCEEDED` | Too many requests | Implement backoff and retry logic |
| `INVALID_REQUEST` | Request format is invalid | Check request body against API spec |
| `USER_BANNED` | User is currently banned | Wait for ban to expire or contact admin |
| `RESOURCE_NOT_FOUND` | Requested resource doesn't exist | Verify resource ID |
| `TENANT_LIMIT_EXCEEDED` | Tenant usage limit exceeded | Upgrade plan or contact support |
| `MODEL_NOT_FOUND` | Proxy model not configured | Configure model in proxy management |

### Error Handling Best Practices

1. **Always check HTTP status codes** before processing response
2. **Implement exponential backoff** for rate limit errors (429)
3. **Log error details** including `error_code` for debugging
4. **Handle authentication errors** by refreshing tokens or API keys
5. **Validate requests** before sending to reduce 400 errors

---

## Rate Limiting

OpenGuardrails implements rate limiting to ensure fair usage and system stability.

### Rate Limit Headers

All API responses include rate limit information:

```http
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1610000000
```

**Headers**:
- `X-RateLimit-Limit`: Maximum requests allowed in window
- `X-RateLimit-Remaining`: Requests remaining in current window
- `X-RateLimit-Reset`: Unix timestamp when limit resets

### Default Rate Limits

| Endpoint Type | Requests per Minute | Burst Limit |
|---------------|---------------------|-------------|
| Detection APIs | 60 | 100 |
| Admin APIs | 120 | 200 |
| Authentication | 30 | 50 |
| Public APIs | 20 | 30 |

### Rate Limit Response

When rate limit is exceeded, API returns:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 60
```

```json
{
  "detail": "Rate limit exceeded. Please try again in 60 seconds.",
  "error_code": "RATE_LIMIT_EXCEEDED",
  "status_code": 429,
  "retry_after": 60
}
```

### Best Practices

1. **Monitor rate limit headers** and implement adaptive throttling
2. **Implement retry logic** with exponential backoff
3. **Batch requests** when possible to reduce API calls
4. **Cache responses** for frequently accessed data
5. **Use webhooks** instead of polling where available

---

## Additional Resources

- **Main Documentation**: [README.md](../README.md)
- **Deployment Guide**: [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Migration Guide**: [MIGRATION_GUIDE.md](./MIGRATION_GUIDE.md)
- **Python Client Library**: [PyPI - openguardrails](https://pypi.org/project/openguardrails/)
- **Node.js Client Library**: [NPM - openguardrails](https://www.npmjs.com/package/openguardrails)
- **Hugging Face Models**: [openguardrails/OpenGuardrails-Text](https://huggingface.co/openguardrails/OpenGuardrails-Text)
- **Official Website**: [https://www.openguardrails.com](https://www.openguardrails.com)

---

## Support

For questions, issues, or feature requests:

- **Email**: thomas@openguardrails.com
- **GitHub Issues**: [https://github.com/openguardrails/openguardrails/issues](https://github.com/openguardrails/openguardrails/issues)
- **Documentation**: [https://docs.openguardrails.com](https://docs.openguardrails.com)

---

**Last Updated**: 2025-01-21
**API Version**: 2.3
**Document Version**: 1.0
