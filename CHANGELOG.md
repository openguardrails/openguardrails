# Changelog

This file documents all notable changes to the **OpenGuardrails Platform**.

All notable changes to OpenGuardrails platform are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

---

## [4.0.0] - 2025-11-04

### 🚀 Major Architecture Update - Multi-Application Management

**Breaking Changes**: This release introduces a major architectural change to support multi-application management within a single tenant account. While existing API keys continue to work (automatically migrated to a default application), the data model has been restructured for better scalability.

#### 🎯 What's New

OpenGuardrails v4.0.0 introduces **Application Management** - a powerful new architecture that allows developers to manage multiple applications within one tenant account, each with completely isolated configurations.

**Use Cases:**
- 🏢 **Enterprise Teams**: Manage different products/services with separate guardrail policies
- 🧪 **Development Workflows**: Maintain separate configs for dev, staging, and production environments
- 👥 **Multi-Tenant SaaS**: Provide isolated guardrail configurations for each customer
- 🔄 **A/B Testing**: Test different safety policies side-by-side

### Added

#### 📱 **Application Management System**
- **New Application Entity**: Introduced `applications` table as the primary isolation boundary
- **Application CRUD**: Full create, read, update, delete operations for applications
- **Application Context Header**: New `X-Application-ID` header for API requests to specify which application to use
- **Default Application**: Automatic creation of "Default Application" for all tenants during migration
- **Application-Scoped API Keys**: Each API key now belongs to a specific application
- **Application Summary**: Real-time protection configuration summary for each application:
  - Risk types enabled count (e.g., 21/21)
  - Ban policy status (enabled/disabled)
  - Sensitivity level (low/medium/high)
  - Data security entities count
  - Blacklist/whitelist counts
  - Knowledge base entries count

#### 🔧 **Configuration Isolation**
All protection configurations are now scoped to the application level:
- ✅ **Risk Type Configuration**: Each application has independent risk category settings
- ✅ **Ban Policy**: Application-specific user banning rules
- ✅ **Data Security Entity Types**: Isolated data leak detection patterns
- ✅ **Blacklists/Whitelists**: Application-scoped keyword filtering
- ✅ **Response Templates**: Custom response templates per application
- ✅ **Knowledge Bases**: Application-specific Q&A knowledge bases
- ✅ **Proxy Configurations**: Proxy settings remain tenant-level (shared across apps)

#### 🗄️ **Database Changes**
- **New Table**: `applications` - Store application metadata
  - `id` (UUID, PK), `tenant_id`, `name`, `description`
  - `is_active`, `created_at`, `updated_at`

- **Schema Updates**: Added `application_id` column to:
  - `api_keys` - Link API keys to applications
  - `risk_type_configs` - Application-scoped risk settings
  - `ban_policies` - Application-scoped ban rules
  - `data_security_entity_types` - Application-scoped DLP patterns
  - `blacklists` - Application-scoped blacklists
  - `whitelists` - Application-scoped whitelists
  - `response_templates` - Application-scoped response templates
  - `knowledge_bases` - Application-scoped knowledge bases
  - `detection_results` - Track which application handled each request

- **Migration Scripts**:
  - `011_add_application_management.sql` - Add applications table and columns
  - `012_remove_old_tenant_id_unique_constraints.sql` - Update constraints to use (tenant_id, application_id) instead of just tenant_id

#### 🌐 **API Updates**

**New Application Management Endpoints** (Admin Service - Port 5000):
```
GET    /api/v1/applications                    # List all applications
POST   /api/v1/applications                    # Create new application
PUT    /api/v1/applications/{app_id}           # Update application
DELETE /api/v1/applications/{app_id}           # Delete application
GET    /api/v1/applications/{app_id}/keys      # List API keys for app
POST   /api/v1/applications/{app_id}/keys      # Create API key for app
DELETE /api/v1/applications/{app_id}/keys/{key_id}  # Delete API key
PUT    /api/v1/applications/{app_id}/keys/{key_id}/toggle  # Toggle key status
```

**Application Context Header**:
```http
# Specify which application to use for the request
X-Application-ID: 3b9d3c1d-4ecb-4013-9508-a7067c4abf8b
```

**Backward Compatibility**:
- ✅ Existing API keys continue to work (automatically linked to default application)
- ✅ Requests without `X-Application-ID` header use the application linked to the API key
- ✅ All existing APIs support application context

#### 🎨 **Frontend Updates**

**New Application Management Page** (`/platform/config/applications`):
- Create and manage multiple applications
- View protection configuration summary for each app
- Manage application-specific API keys
- Toggle application active status
- View API key usage statistics
- Copy/show/hide API keys with one click

**Updated Configuration Pages**:
All configuration pages now respect the selected application context:
- Risk Type Management
- Ban Policy
- Data Security (DLP)
- Blacklist/Whitelist Management
- Response Templates
- Knowledge Base Management

**New Application Selector Component**:
- Global application context switcher in the header
- Shows current application name
- Quick switch between applications
- Remembers last selected application in localStorage

#### 🔄 **Automatic Migration & Initialization**

**Zero-Downtime Migration**:
- ✅ Automatic creation of "Default Application" for all existing tenants
- ✅ All existing API keys automatically linked to default application
- ✅ All existing configurations copied to default application
- ✅ Unique constraints updated to support multi-application architecture
- ✅ No data loss - all existing data preserved

**New Application Auto-Setup**:
When creating a new application, the system automatically initializes:
1. **Risk Type Config**: All 21 risk types enabled by default
2. **Ban Policy**: Disabled by default (ready to configure)
3. **Data Security Entity Types**: System templates copied and activated
4. **No other configs**: Blacklists, whitelists, templates, knowledge bases start empty

#### 📊 **Application Metrics**

Each application tracks:
- Total API keys (active + inactive)
- Last detection request timestamp
- Total detection requests count
- Risk distribution statistics
- Configuration completeness

### Changed

#### 🔄 **Data Model Restructure**

**Before (v3.x):**
```
Tenant → API Keys
Tenant → Configurations (Risk, Ban, DLP, etc.)
Tenant → Detection Results
```

**After (v4.0):**
```
Tenant → Applications → API Keys
       → Applications → Configurations (Risk, Ban, DLP, etc.)
       → Applications → Detection Results
```

**Benefits:**
- 🎯 Better configuration isolation
- 📈 Easier scaling for enterprise customers
- 🔒 Improved security with application-level access control
- 🧪 Simplified testing and deployment workflows

#### 🔧 **Service Updates**

**Admin Service** (`backend/admin_service.py`):
- Added application management routes
- Updated all config APIs to support application context
- Added application context middleware

**Detection Service** (`backend/detection_service.py`):
- Reads application context from `X-Application-ID` header or API key
- Loads application-specific configurations
- Records application_id in detection results

**Proxy Service** (`backend/proxy_service.py`):
- Supports application context for detection
- Proxy configs remain tenant-level (shared)

#### 📁 **New Files**

**Backend**:
- `backend/routers/applications.py` - Application management routes
- `backend/contexts/ApplicationContext.tsx` - React context for app selection
- `backend/migrations/versions/011_add_application_management.sql` - Migration script
- `backend/migrations/versions/012_remove_old_tenant_id_unique_constraints.sql` - Constraint updates
- `backend/fix_existing_apps.py` - Migration helper script
- `backend/diagnose_app_config.py` - Diagnostic tool

**Frontend**:
- `frontend/src/pages/Config/ApplicationManagement.tsx` - App management UI
- `frontend/src/components/ApplicationSelector/` - App selector component
- `frontend/src/contexts/ApplicationContext.tsx` - Application context provider

### Migration Guide

#### For Existing Deployments

**Automatic Migration** (recommended):
```bash
# Simply restart services - migrations run automatically!
docker compose restart

# Or rebuild and restart
docker compose down
docker compose up -d
```

The migration will:
1. ✅ Create `applications` table
2. ✅ Add `application_id` columns to all config tables
3. ✅ Create "Default Application" for each tenant
4. ✅ Link all existing API keys to default application
5. ✅ Copy all existing configs to default application
6. ✅ Update unique constraints

**Verify Migration Success**:
```bash
# Check applications table
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT id, tenant_id, name FROM applications;"

# Check API keys are linked
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT id, application_id, key FROM api_keys LIMIT 5;"
```

#### For Developers

**Using Application Context in API Calls**:

```python
# Python SDK (will be updated in next SDK release)
from openguardrails import OpenGuardrails

client = OpenGuardrails(
    api_key="sk-xxai-your-key",
    application_id="3b9d3c1d-4ecb-4013-9508-a7067c4abf8b"  # Optional
)

# HTTP API
curl -X POST "http://localhost:5001/v1/guardrails" \
  -H "Authorization: Bearer sk-xxai-your-key" \
  -H "X-Application-ID: 3b9d3c1d-4ecb-4013-9508-a7067c4abf8b" \
  -H "Content-Type: application/json" \
  -d '{"model": "OpenGuardrails-Text", "messages": [...]}'
```

**Managing Applications via API**:

```python
import requests

# List applications
response = requests.get(
    "http://localhost:5000/api/v1/applications",
    headers={"Authorization": "Bearer your-jwt-token"}
)

# Create new application
response = requests.post(
    "http://localhost:5000/api/v1/applications",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={
        "name": "Production App",
        "description": "Production environment guardrails"
    }
)

# Create API key for application
app_id = response.json()["id"]
response = requests.post(
    f"http://localhost:5000/api/v1/applications/{app_id}/keys",
    headers={"Authorization": "Bearer your-jwt-token"},
    json={"name": "Production API Key"}
)
```

### Backward Compatibility

✅ **Fully Backward Compatible**:
- All existing API keys continue to work
- No changes required to existing client code
- `X-Application-ID` header is optional (defaults to API key's application)
- All existing endpoints support application context

⚠️ **Recommended Updates**:
- Update SDKs to latest versions (when released)
- Use `X-Application-ID` header for explicit application selection
- Migrate to application management UI for better organization

### Fixed

- 🐛 Configuration isolation issues when managing multiple environments
- 🐛 API key management limitations for large teams
- 🐛 Difficulty testing different guardrail policies simultaneously
- 🔧 Improved unique constraint handling for multi-application scenarios

### Breaking Changes

**Database Schema**:
- ⚠️ All configuration tables now require `application_id`
- ⚠️ Unique constraints changed from `(tenant_id, name)` to `(tenant_id, application_id, name)`
- ✅ Migration handles these changes automatically

**API Keys**:
- ⚠️ API keys are now application-scoped (one key per application)
- ✅ Existing keys automatically linked to default application
- ✅ Old API keys continue to work without changes

### Technical Details

**Application Initialization**:
```python
# When creating a new application, automatically initialize:
def initialize_application_configs(application_id, tenant_id):
    # 1. Risk Type Config (all 21 types enabled)
    # 2. Ban Policy (disabled, ready to configure)
    # 3. Data Security Entity Types (system templates copied)
```

**Application Context Resolution**:
```
1. Check X-Application-ID header
2. If not present, get application_id from API key
3. Load application-specific configurations
4. Apply application context to all operations
```

**Protection Summary Calculation**:
```python
protection_summary = {
    "risk_types_enabled": 21,      # Count of enabled risk types
    "total_risk_types": 21,        # Total available risk types
    "ban_policy_enabled": False,   # Ban policy status
    "sensitivity_level": "medium", # Sensitivity threshold
    "data_security_entities": 6,   # Active DLP entities
    "blacklist_count": 2,          # Active blacklists
    "whitelist_count": 1,          # Active whitelists
    "knowledge_base_count": 5      # Active KB entries
}
```

### Documentation Updates

- Updated [README.md](README.md) with application management feature
- Updated [CLAUDE.md](CLAUDE.md) with new architecture details
- Updated [API_REFERENCE.md](docs/API_REFERENCE.md) with new endpoints
- Added application management examples

---

## [3.0.0] - 2025-01-20

### 🚀 Deployment & Developer Experience

#### Added
- ✨ **Automatic Database Migrations** - Database migrations now run automatically on first deployment
  - No manual migration commands needed - just run `docker compose up -d`
  - Entrypoint script ([backend/entrypoint.sh](backend/entrypoint.sh)) handles automatic migration execution
  - PostgreSQL advisory locks prevent concurrent migration conflicts
  - Admin service runs migrations before starting (detection and proxy services skip)
  - Migration tracking table (`schema_migrations`) records all executed migrations
  - Clear migration logs visible in admin service output
  - Safe failure mode - service won't start if migration fails
  - Improved first-time deployment experience for new developers

#### Changed
- 🐳 **Docker Configuration Updates**
  - Updated [backend/Dockerfile](backend/Dockerfile) to include `postgresql-client` for health checks
  - Added `ENTRYPOINT` script to handle pre-startup initialization
  - Added `SERVICE_NAME` environment variable to all services in [docker-compose.yml](docker-compose.yml)
  - Changed `RESET_DATABASE_ON_STARTUP` default to `false` (migrations handle schema)

#### Documentation
- 📚 **Migration Documentation**
  - Updated [backend/migrations/README.md](backend/migrations/README.md) with automatic migration details
  - Added [docs/AUTO_MIGRATION_TEST.md](docs/AUTO_MIGRATION_TEST.md) with comprehensive testing guide
  - Updated main [README.md](README.md) to explain automatic migration on deployment

## [2.6.1] - 2025-10-08

### 🌍 Internationalization (i18n)

#### Added
- 🌐 **Multi-language Support**
  - Complete internationalization framework implementation
  - Support for English (en) and Chinese (zh) languages
  - Dynamic language switching in the frontend interface
  - Persistent language preference storage in localStorage
  - Comprehensive translation coverage for all UI components

- 📝 **Translation Management**
  - Structured translation files: `frontend/src/locales/en.json` and `frontend/src/locales/zh.json`
  - Translation keys organized by feature modules (dashboard, detection, config, etc.)
  - Consistent naming convention for translation keys
  - Support for pluralization and parameter interpolation

- 🔧 **Technical Implementation**
  - React i18next integration for frontend internationalization
  - Language detection based on browser preferences
  - Fallback language mechanism (defaults to English)
  - Type-safe translation key validation
  - Hot-reload support for translation updates during development

#### Changed
- 🎨 **User Interface Updates**
  - All static text replaced with translatable keys
  - Language selector added to the main navigation
  - Consistent UI layout across different languages
  - Responsive design maintained for both language versions
  - Date and number formatting localized appropriately

- 📊 **Dashboard Localization**
  - Risk level indicators translated (Safe, Low, Medium, High)
  - Chart labels and tooltips localized
  - Statistical data descriptions in multiple languages
  - Time-based filters and date ranges localized

- ⚙️ **Configuration Pages**
  - All configuration forms and labels translated
  - Help text and tooltips localized
  - Error messages and validation feedback in user's language
  - Success notifications and status messages translated

#### Technical Features
- **Framework**: React i18next with namespace support
- **Storage**: Browser localStorage for language persistence
- **Detection**: Automatic browser language detection
- **Fallback**: Graceful fallback to English for missing translations
- **Performance**: Lazy loading of translation resources

#### Files Added
- `frontend/src/locales/en.json` - English translations
- `frontend/src/locales/zh.json` - Chinese translations
- `frontend/src/i18n/index.ts` - i18n configuration and setup
- `frontend/src/hooks/useTranslation.ts` - Custom translation hook

#### Files Modified
- Updated all React components to use translation keys
- Modified navigation components for language switching
- Enhanced configuration pages with localized content
- Updated dashboard components with translated labels

### Usage Examples

#### Language Switching
```typescript
import { useTranslation } from 'react-i18next';

function MyComponent() {
  const { t, i18n } = useTranslation();
  
  const switchLanguage = (lang: string) => {
    i18n.changeLanguage(lang);
  };
  
  return (
    <div>
      <h1>{t('dashboard.title')}</h1>
      <button onClick={() => switchLanguage('en')}>English</button>
      <button onClick={() => switchLanguage('zh')}>中文</button>
    </div>
  );
}
```

#### Translation Key Usage
```typescript
// Simple translation
{t('common.save')}

// Translation with parameters
{t('detection.results_count', { count: 42 })}

// Pluralization support
{t('user.ban_duration', { count: days, duration: days })}
```

### Documentation Updates
- Updated README.md with internationalization feature description
- Added i18n setup instructions for developers
- Updated contribution guidelines for translation contributions
- Added language support information to API documentation

---

## [2.5.0] - 2025-10-06

### 🚀 Major Updates
- 🚫 **Ban Policy**
  - Introduced an intelligent user behavior-based ban system
  - Automatically detects and defends against persistent prompt injection attempts
  - Especially effective against repeated prompt modification attacks
  - Supports flexible ban condition configuration and auto-unban mechanism

### Added
- 🚫 **Ban Policy Management**
  - New configuration management page for ban policies
  - Customizable ban conditions: risk level, trigger count, time window
  - Configurable ban duration (minutes, hours, days, permanent)
  - Enable/disable individual ban policies
  - View banned user list and manually unban users

- 🔍 **Intelligent Attack Detection**
  - Real-time monitoring of high-risk user behaviors
  - Sliding time window-based attack pattern recognition
  - Automatically logs reasons and timestamps for bans
  - Different ban strategies for different risk levels (high/medium)

- 🗄️ **Database Changes**
  - Added `ban_policies` table to store ban policy configurations
  - Added `banned_users` table to store banned user information
  - Added database migration script: `backend/database/migrations/add_ban_policy_tables.sql`

- 🔧 **New Files**
  - `backend/routers/ban_policy_api.py` - Ban policy routes
  - `backend/services/ban_policy_service.py` - Ban policy service
  - `frontend/src/pages/Config/BanPolicy.tsx` - Ban policy configuration page

- 🆔 **User ID Tracking**
  - Detection API now supports `extra_body.xxai_app_user_id` parameter for tenant app user ID
  - Enables ban policy and behavior analysis based on user ID
  - All SDKs (Python, Java, Node.js, Go) now support an optional `user_id` parameter
  - Useful for implementing user-level risk control and audit tracking

### Changed
- 🔄 **Enhanced Detection Workflow**
  - Automatically checks if a user is banned before detection
  - Banned users’ requests return a ban message immediately
  - Updates user’s high-risk behavior count after each detection
  - Automatically triggers ban once conditions are met

- 📱 **Frontend Updates**
  - Added Ban Policy submenu in Protection Configurations
  - Added Ban Policy configuration interface
  - Added banned user list and management features
  - Supports manual unban and viewing ban details

### Fixed
- 🐛 **Ban Policy Edge Cases**
  - Fixed time window boundary calculation issues
  - Improved performance for ban status checks
  - Fixed accuracy issues in concurrent counting scenarios

### Usage Examples

#### Configure a Ban Policy
```python
# Configure ban policy via API
import requests

response = requests.post(
    "http://localhost:5000/api/v1/ban-policies",
    headers={"Authorization": "Bearer your-api-key"},
    json={
        "name": "High Risk Behavior Ban",
        "risk_level": "High",
        "trigger_count": 3,
        "time_window_minutes": 60,
        "ban_duration_minutes": 1440,  # 24 hours
        "enabled": True
    }
)
````

#### Pass User ID in API Call

```python
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")

# Pass user ID during detection
response = client.check_prompt(
    "How to make a bomb",
    user_id="user123"
)

if response.is_blocked:
    print("User is banned or content blocked")
```

#### HTTP API Example

```bash
curl -X POST "http://localhost:5001/v1/guardrails" \
    -H "Authorization: Bearer your-api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "OpenGuardrails-Text",
      "messages": [
        {"role": "user", "content": "How to make a bomb"}
      ],
      "extra_body": {
        "xxai_app_user_id": "user123"
      }
    }'
```

### Technical Features

* **Intelligent Detection**: Sliding window-based attack pattern recognition
* **Flexible Configuration**: Multiple ban conditions and duration settings
* **Auto Unban**: Supports automatic unban after configured duration
* **Performance Optimized**: Efficient ban state checks and counter updates

### Documentation Updates

* Updated `README.md` with ban policy feature description
* Updated `README_ZH.md` with Chinese documentation for ban policy
* Updated API documentation to include user ID parameter

---

## [2.4.0] - 2025-10-04

### 🚀 Major Updates

* 🔐 **Data Leak Detection**

  * Added regex-based sensitive data detection and masking
  * Detects ID numbers, phone numbers, emails, bank cards, passports, IPs, etc.
  * Supports multiple masking methods: replace, mask, hash, encrypt, shuffle, randomize
  * Allows custom sensitive data patterns and regex rules
  * Separates input/output detection with flexible configuration
  * Supports both system-level and user-level configurations

### Added

* 🔐 **Data Security Management**

  * Added Data Leak Protection configuration page
  * Custom sensitive data definitions (name, regex, risk level)
  * Three risk levels: low, medium, high
  * Six masking methods: replace, mask, hash, encrypt, shuffle, random
  * Configurable input/output direction detection
  * Built-in types: ID_CARD_NUMBER_SYS, PHONE_NUMBER_SYS, EMAIL_SYS, BANK_CARD_NUMBER_SYS, PASSPORT_NUMBER_SYS, IP_ADDRESS_SYS

* 📊 **Enhanced Detection Results**

  * Added `data` field in detection results for data security findings
  * New response structure: `result.data.risk_level` and `result.data.categories`
  * Dashboard now includes “Data Leak Detected” stats
  * Online test page includes data leak examples
  * Detection results table includes “Data Leak” column
  * Risk reports include data leak metrics

* 🗄️ **Database Changes**

  * Added `data_security_patterns` table for sensitive data definitions
  * Added `data_security_config` table for DLP configurations
  * Added `data_risk_level` and `data_categories` fields to `detection_results`
  * Added migration scripts:

    * `backend/database/migrations/add_data_security_tables.sql`
    * `backend/database/migrations/add_data_security_fields.sql`

* 🔧 **New Files**

  * `backend/routers/data_security.py` - Data Security routes
  * `backend/services/data_security_service.py` - Data Security service
  * `frontend/src/pages/DataSecurity/` - Data Leak Protection UI
  * `DATA_SECURITY_README.md` - Documentation for DLP features

### Changed

* 🔄 **API Response Format**

  * Unified structure with three dimensions: `compliance`, `security`, `data`
  * Enhanced response example:

    ```json
    {
      "result": {
        "compliance": {"risk_level": "Safe", "categories": []},
        "security": {"risk_level": "Safe", "categories": []},
        "data": {"risk_level": "High", "categories": ["PHONE_NUMBER_SYS", "ID_CARD_NUMBER_SYS"]}
      },
      "suggest_answer": "My phone is <PHONE_NUMBER_SYS>, ID is <ID_CARD_NUMBER_SYS>"
    }
    ```

* 📱 **Frontend Updates**

  * Dashboard redesigned with data leak risk cards
  * Added data leak testing in online test page
  * Detection results support data leak filtering
  * Risk report includes DLP charts
  * Protection Configurations now include DLP submenu

* 🔧 **Backend Enhancements**

  * Integrated data security into detection workflow
  * Supports input/output direction detection
  * Combined risk decision based on highest risk level
  * Masked results returned via `suggest_answer`

### Fixed

* 🐛 **Database Pool Optimization**

  * Fixed connection pool leaks under high concurrency
  * Tuned pool configuration parameters

* 🔧 **Regex Boundary Issue**

  * Fixed boundary matching for Chinese text
  * Improved character boundary logic for non-Latin text

### SDK Updates

* 📦 **Updated All SDKs for New Response Format**

  * Python SDK (openguardrails)
  * Go SDK (openguardrails-go)
  * Node.js SDK (openguardrails)
  * Java SDK (openguardrails)

### Technical Features

* **Direction Control**: Input-only, output-only, or bidirectional detection
* **Custom Rules**: Full user-defined sensitive data patterns
* **Performance**: Optimized regex matching for high concurrency
* **Isolation**: User-level configuration isolation

### Documentation Updates

* Updated `README.md` with DLP feature description
* Updated `README_ZH.md` with Chinese DLP documentation
* Added detailed `DATA_SECURITY_README.md`
* Updated API documentation for new response schema

---

## [2.3.0] - 2025-09-30

### 🚀 Major Updates

* 🖼️ **Multimodal Detection**

  * Added image modality safety detection capability
  * Supports compliance and safety checks for image content
  * Consistent risk categories and detection standards with text detection
  * Fully supports both API and Gateway modes

### Added

* 🖼️ **Image Detection**

  * Supports two input types: base64-encoded images and image URLs
  * Utilizes the multimodal detection model `OpenGuardrails-VL`
  * Image files stored under user-specific directories (`/mnt/data/openguardrails-data/media/{user_uuid}/`)
  * Web UI now supports image upload for testing
  * Added new image upload and preview components

* 🔌 **Enhanced API**

  * Detection API now supports hybrid messages (text + image)
  * `messages.content` supports array format: `[{"type": "text"}, {"type": "image_url"}]`
  * Image URLs support both `data:image/jpeg;base64,...` and `file://...` formats
  * Security Gateway proxy fully supports multimodal request passthrough

* 📁 **New Files**

  * `backend/routers/media.py` – Media file management routes
  * `backend/utils/image_utils.py` – Image processing utilities
  * `backend/utils/url_signature.py` – URL signature verification utilities
  * `backend/scripts/migrate_add_image_fields.py` – Database migration script
  * `frontend/src/components/ImageUpload/` – Image upload component

### Changed

* 🔄 **Enhanced Detection Service**

  * Detection model logic now supports multimodal content
  * Database schema updated to include image-related fields
  * Online testing page supports image upload and preview

* 🌐 **API Response Format**

  * Unified response format consistent with text detection
  * Supports multiple risk tags (e.g., `unsafe\nS1,S2`)
  * Sensitivity scores and levels now apply to image detection

### Technical Features

* **Image Detection Model**: Vision-Language-based multimodal safety detection
* **Storage Management**: Isolated, user-level media file storage
* **URL Security**: Signed URLs prevent unauthorized access
* **Format Compatibility**: Compatible with OpenAI Vision API message format

### Usage Examples

#### Python API Example

```python
import base64
from openguardrails import OpenGuardrails

client = OpenGuardrails("your-api-key")

# Encode image to base64
with open("image.jpg", "rb") as f:
    image_base64 = base64.b64encode(f.read()).decode("utf-8")

# Send detection request
response = client.check_messages([
    {
        "role": "user",
        "content": [
            {"type": "text", "text": "Is this image safe?"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}}
        ]
    }
])

print(f"Overall Risk Level: {response.overall_risk_level}")
print(f"Risk Categories: {response.all_categories}")
```

#### cURL Example

```bash
curl -X POST "http://localhost:5001/v1/guardrails" \
    -H "Authorization: Bearer your-api-key" \
    -H "Content-Type: application/json" \
    -d '{
      "model": "OpenGuardrails-VL",
      "messages": [{
        "role": "user",
        "content": [
          {"type": "text", "text": "Is this image safe?"},
          {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,..."}}
        ]
      }],
      "logprobs": true
    }'
```

---

## [2.2.0] - 2025-01-15

### 🚀 Major Updates

* 🧠 **Knowledge-Based Auto-Response**

  * Brand-new intelligent answering system based on vector similarity search
  * Supports uploading Q&A files to automatically build knowledge base vector indexes
  * During risk detection, similar questions are matched first and the corresponding safe answers are returned
  * Supports both global and user-level knowledge bases; administrators can configure globally active ones

### Added

* 📚 **Knowledge Base Management**

  * Web UI for creating, editing, and deleting knowledge bases
  * Supports JSONL-format Q&A pair uploads with validation
  * Automatic generation and management of vector indexes
  * Built-in knowledge search testing interface
  * Supports file replacement and reindexing

* 🎯 **Smart Answer Strategy**

  * When risk detection is triggered, the system searches for similar Q&A pairs in the knowledge base
  * Uses cosine similarity for question matching
  * Configurable similarity threshold and result count
  * Falls back to default rejection templates if no match is found

### New Configuration

* `EMBEDDING_API_BASE_URL` – Embedding API base URL
* `EMBEDDING_API_KEY` – Embedding API key
* `EMBEDDING_MODEL_NAME` – Embedding model name
* `EMBEDDING_MODEL_DIMENSION` – Vector dimension
* `EMBEDDING_SIMILARITY_THRESHOLD` – Similarity threshold
* `EMBEDDING_MAX_RESULTS` – Max number of returned results

#### Knowledge Base File Format

```jsonl
{"questionid": "q1", "question": "What is Artificial Intelligence?", "answer": "AI is the technology that simulates human intelligence."}
{"questionid": "q2", "question": "How to use Machine Learning?", "answer": "Machine learning is an important branch of AI..."}
```

---

## [2.1.0] - 2025-09-29

Added **sensitivity threshold configuration** – allows customizing detection sensitivity, useful for special cases or fully automated pipelines.

---

## [2.0.0] - 2025-01-01

### 🚀 Major Updates

* 🛡️ **All-New Security Gateway Mode**

  * Added reverse proxy service (`proxy-service`) supporting OpenAI-compatible transparent proxy
  * Implements WAF-style AI protection for automatic input/output inspection
  * Supports upstream model management for one-click protection configuration
  * Zero-code integration—just update `base_url` and `api_key`

* 🏗️ **Three-Service Architecture**

  * **Management Service** (port 5000): Admin APIs (low concurrency)
  * **Detection Service** (port 5001): High-concurrency guardrails detection API
  * **Proxy Service** (port 5002): High-concurrency reverse proxy for security gateway
  * Architecture optimization reduced DB connections from 4,800 to 176 (↓96%)

### Added

* 🔌 **Dual Mode Support**

  * **API Mode**: Developers actively call detection APIs
  * **Gateway Mode**: Transparent reverse proxy with automatic request inspection

* 🎯 **Upstream Model Management**

  * Web UI for configuring upstream models (OpenAI, Claude, local models, etc.)
  * Secure API key management and storage
  * Request forwarding and response proxying
  * User-level model access control

* 🚦 **Smart Proxy Strategy**

  * Input detection: preprocess and filter user requests
  * Output detection: review AI-generated responses
  * Auto-blocking of high-risk content
  * Auto-response templates for safe replacement

* 🐳 **Optimized Docker Architecture**

  * Docker Compose now supports all three services
  * Independent containers for detection, management, and proxy
  * Unified data directory mount and log management
  * Automatic health checks and service discovery

* 📁 **New Files**

  * `backend/proxy_service.py` – Proxy service entry
  * `backend/start_proxy_service.py` – Proxy service startup script
  * `backend/start_all_services.sh` – Startup script for all three services
  * `backend/stop_all_services.sh` – Shutdown script for all three services
  * `backend/services/proxy_service.py` – Proxy core logic
  * `backend/routers/proxy_api.py` – Proxy API routes
  * `backend/routers/proxy_management.py` – Proxy management routes
  * `frontend/src/pages/Config/ProxyModelManagement.tsx` – Upstream model UI
  * `examples/proxy_usage_demo.py` – Proxy usage example

* 🔌 **Private Deployment Integration** 🆕

  * Supports deep integration with customer systems
  * New config `STORE_DETECTION_RESULTS` to control detection result storage
  * Customers can manage user-level allowlists, blocklists, and templates via API
  * JWT authentication ensures complete data isolation

### Changed

* 🔄 **Architecture Refactoring**

  * Split into three microservices for scalability
  * Detection Service: 32 processes for API detection
  * Management Service: 2 lightweight admin processes
  * Proxy Service: 24 processes for secure gateway
  * Unified log directory under `DATA_DIR`

* 🌐 **API Route Updates**

  * Detection API: `/v1/guardrails` (port 5001)
  * Management API: `/api/v1/*` (port 5000)
  * Proxy API: OpenAI-compatible format (port 5002)
  * New Proxy Management API: `/api/v1/proxy/*`
  * Separate health check endpoints for each service

* 📦 **Deployment Updates**

  * Docker Compose supports independent service containers
  * Added proxy-related environment variables
  * Unified data directory mounts
  * Automated start/stop scripts

* 🔧 **Configuration Enhancements**

  * New proxy configs: `PROXY_PORT`, `PROXY_UVICORN_WORKERS`
  * Improved DB connection pool separation
  * Added upstream model configuration management
  * Supports multiple AI provider integrations

* 📊 **Data Flow Redesign**

  ```
  # API Mode
  Client → Detection Service (5001) → Guardrails Detection → Response

  # Gateway Mode
  Client → Proxy Service (5002) → Input Check → Upstream Model → Output Check → Response

  # Management Mode
  Web Admin → Management Service (5000) → Config Management → Database
  ```

### Fixed

* 🐛 **Database Connection Pool**

  * Resolved DB connection exhaustion under high concurrency
  * Optimized connection pool allocation for three-service setup
  * Reduced redundant DB operations, improving response times

### Technical Debt

* Removed deprecated single-service mode
* Optimized Docker image build
* Unified configuration file management

---

## [1.0.0] - 2024-08-09

### Added

* 🛡️ **Core Safety Detection**

  * 12-dimension risk classification
  * Prompt injection detection (S9)
  * Content compliance detection (S1–S8, S10–S12)
  * Four risk levels: none, low, medium, high

* 🧠 **Context-Aware Detection**

  * Supports multi-turn dialogue understanding
  * Risk evaluation across full conversation context
  * Context-sensitive risk identification

* 🏗️ **Complete System Architecture**

  * FastAPI backend
  * React admin frontend
  * PostgreSQL database
  * Dockerized deployment

* 👥 **Tenant Management**

  * User registration, login, authentication
  * API key management
  * JWT-based identity verification
  * Role-based admin control

* ⚙️ **Flexible Configuration**

  * Blacklist/whitelist management
  * Safe response template management
  * User-level rate limit configuration

* 📊 **Visual Dashboard**

  * Real-time detection metrics
  * Historical detection queries
  * Risk distribution visualization
  * Config management interface

* 🚦 **Rate Limiting & Monitoring**

  * User-level request rate limits
  * Real-time performance monitoring
  * Detection result analytics
  * Abnormal access alerts

* 🔌 **API Interface**

  * OpenAI-compatible format
  * RESTful API design
  * Full documentation
  * Multi-language SDKs

* 🐳 **Deployment**

  * One-click Docker Compose deployment
  * PostgreSQL initialization scripts
  * Health checks
  * Production-ready configs

### Technical Features

* **High Performance**: Async processing, high concurrency
* **High Availability**: Containerized, scalable
* **High Security**: Encrypted, offline-ready
* **High Accuracy**: >97% accuracy, <0.5% false positives

### Documentation

* 📖 Full API docs
* 🚀 Quick start guide
* 🏗️ Product overview
* 🤝 Contribution guide
* 🔒 Security notes

### Open Source Model

* 🤗 HuggingFace model: `openguardrails/OpenGuardrails-Text`
* Apache 2.0 License
* Supports Chinese & English detection
* Includes full inference example

### Client Libraries

* 🐍 Python SDK: `openguardrails`
* 📱 JavaScript SDK: `openguardrails-js`
* 🌐 HTTP API: OpenAI-compatible

---

## Version Notes

### Semantic Versioning

* **MAJOR**: Incompatible API changes
* **MINOR**: Backward-compatible feature additions
* **PATCH**: Backward-compatible fixes

### Change Types

* **Added**: New features
* **Changed**: Modified existing features
* **Deprecated**: Soon-to-be removed
* **Removed**: Fully removed
* **Fixed**: Bug fixes
* **Security**: Security-related changes

---

## Upgrade Guide

### Upgrading from 0.x to 1.0.0

First official release, with major changes:

#### Database Changes

* Migration from SQLite → PostgreSQL
* New schema and table structure
* User data and config must be reimported

#### API Changes

* Unified OpenAI-compatible API format
* New authentication (Bearer Token)
* Standardized response format

#### Configuration Changes

* Updated environment variables
* Revised Docker Compose setup
* Removed deprecated configs

#### Migration Steps

1. Back up your data
2. Update to the new version
3. Run migration scripts
4. Update API call logic
5. Test and verify

---

## Contributors

Thanks to all contributors:

* **Core Team**

  * [@thomas](mailto:thomas@openguardrails.com) – Project Lead
  * OpenGuardrails Team

* **Community Contributors**

  * Be the first to contribute!

---

## Support & Contact

* 📧 **Technical Support**: [thomas@openguardrails.com](mailto:thomas@openguardrails.com)
* 🌐 **Website**: [https://openguardrails.com](https://openguardrails.com)
* 📱 **GitHub Issues**: [https://github.com/openguardrails/openguardrails/issues](https://github.com/openguardrails/openguardrails/issues)
* 💬 **Discussions**: [https://github.com/openguardrails/openguardrails/discussions](https://github.com/openguardrails/openguardrails/discussions)
