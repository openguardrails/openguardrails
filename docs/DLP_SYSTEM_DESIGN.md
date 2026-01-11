# Data Leakage Prevention (DLP) System Design

> Comprehensive Technical Documentation for OpenGuardrails DLP System

**Version**: 5.1.0
**Last Updated**: 2026-01-09
**Author**: OpenGuardrails Team

---

## Table of Contents

1. [Overview](#1-overview)
2. [System Architecture](#2-system-architecture)
3. [Core Components](#3-core-components)
4. [Detection Pipeline](#4-detection-pipeline)
5. [Anonymization Strategies](#5-anonymization-strategies)
6. [Restore Anonymization (De-anonymization)](#6-restore-anonymization-de-anonymization)
7. [Private Model Switching](#7-private-model-switching)
8. [Disposal Actions](#8-disposal-actions)
9. [Policy Management](#9-policy-management)
10. [API Reference](#10-api-reference)
11. [Database Schema](#11-database-schema)
12. [Examples](#12-examples)
13. [Performance Considerations](#13-performance-considerations)

---

## 1. Overview

### 1.1 What is DLP?

The Data Leakage Prevention (DLP) system in OpenGuardrails is a **multi-layered protection framework** designed to prevent sensitive data from being exposed to external AI models. It provides:

- **Automatic Detection**: Identifies sensitive data using regex patterns and GenAI-powered recognition
- **Smart Anonymization**: Masks or transforms sensitive data with multiple strategies
- **Restore Capability**: Restores anonymized data in responses back to original values
- **Private Model Switching**: Routes requests with sensitive data to on-premise/private models
- **Flexible Policies**: Configurable disposal actions per risk level and application

### 1.2 Key Features (v5.1.0)

| Feature | Description |
|---------|-------------|
| **Dual Recognition** | Regex patterns + GenAI-powered entity extraction |
| **Format-Aware Detection** | Auto-detects JSON, YAML, CSV, Markdown, Plain Text |
| **Smart Segmentation** | Intelligent content splitting for large documents |
| **7 Anonymization Methods** | mask, replace, hash, encrypt, shuffle, random, genai |
| **Streaming Restore** | Real-time placeholder restoration in streaming responses |
| **Private Model Switching** | Automatic routing to data-safe models |
| **Hierarchical Policies** | Tenant defaults + Application overrides |

### 1.3 Design Principles

1. **Defense in Depth**: Multiple detection layers (regex + GenAI)
2. **Fail-Safe**: Default to blocking on high-risk detection
3. **Transparency**: Users see original data after restoration
4. **Performance**: Parallel processing for large content
5. **Flexibility**: Customizable entity types and policies per application

---

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           OpenGuardrails Platform                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   Format    │───▶│ Segmentation│───▶│   Entity    │───▶│   Disposal  │  │
│  │  Detection  │    │   Service   │    │  Detection  │    │   Service   │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│         │                  │                  │                  │          │
│         ▼                  ▼                  ▼                  ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                     Data Security Service                            │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌────────────┐  │   │
│  │  │   Regex     │  │   GenAI     │  │ Anonymization│  │  Restore   │  │   │
│  │  │  Matching   │  │  Detection  │  │   Engine    │  │  Service   │  │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘  └────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                      │
│                                      ▼                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                    Policy Resolution Layer                           │   │
│  │  ┌──────────────────┐           ┌──────────────────┐                │   │
│  │  │  Tenant Policy   │◀─────────▶│ Application Policy│                │   │
│  │  │   (Defaults)     │           │   (Overrides)    │                │   │
│  │  └──────────────────┘           └──────────────────┘                │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                      │                                      │
│                                      ▼                                      │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                       Action Execution                               │   │
│  │  ┌───────┐  ┌────────────────────┐  ┌───────────┐  ┌──────────┐    │   │
│  │  │ Block │  │ Switch Private Model│  │ Anonymize │  │   Pass   │    │   │
│  │  └───────┘  └────────────────────┘  └───────────┘  └──────────┘    │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Interaction Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              Request Flow                                     │
└──────────────────────────────────────────────────────────────────────────────┘

    User Request                                              LLM Response
         │                                                         ▲
         ▼                                                         │
┌─────────────────┐                                    ┌─────────────────┐
│  Input Content  │                                    │ Output Content  │
└────────┬────────┘                                    └────────┬────────┘
         │                                                      │
         ▼                                                      ▼
┌─────────────────┐                                    ┌─────────────────┐
│ Format Detection│                                    │ Restore Service │
│  (JSON/YAML/    │                                    │ (Placeholder →  │
│   CSV/MD/Text)  │                                    │  Original Data) │
└────────┬────────┘                                    └────────┬────────┘
         │                                                      ▲
         ▼                                                      │
┌─────────────────┐                                    ┌─────────────────┐
│ Smart Segment-  │                                    │   Streaming     │
│     ation       │                                    │ Restore Buffer  │
└────────┬────────┘                                    └────────┬────────┘
         │                                                      ▲
         ▼                                                      │
┌─────────────────┐         ┌─────────────────┐       ┌─────────────────┐
│ Entity Detection│────────▶│ Risk Level      │──────▶│   LLM Model     │
│ (Regex + GenAI) │         │ Aggregation     │       │ (Public/Private)│
└────────┬────────┘         └────────┬────────┘       └─────────────────┘
         │                           │                         ▲
         ▼                           ▼                         │
┌─────────────────┐         ┌─────────────────┐                │
│  Anonymization  │         │ Disposal Action │────────────────┘
│    Engine       │         │   Resolution    │
└────────┬────────┘         └─────────────────┘
         │
         ▼
┌─────────────────┐
│ restore_mapping │
│ {placeholder:   │
│  original_value}│
└─────────────────┘
```

### 2.3 File Structure

```
backend/
├── services/
│   ├── data_security_service.py        # Core DLP detection & anonymization
│   ├── data_leakage_disposal_service.py # Disposal action resolution
│   ├── format_detection_service.py      # Content format detection
│   ├── segmentation_service.py          # Smart content segmentation
│   └── restore_anonymization_service.py # AI code generation & restoration
├── routers/
│   ├── data_security.py                 # Entity type management API
│   └── data_leakage_policy_api.py       # Policy configuration API
└── database/
    └── models.py                        # DLP-related database models
```

---

## 3. Core Components

### 3.1 Data Security Service

**File**: `backend/services/data_security_service.py`

The central orchestrator for all DLP operations.

```python
class DataSecurityService:
    async def detect_sensitive_data(
        text: str,
        tenant_id: str,
        direction: str = "input",      # "input" or "output"
        application_id: str = None,
        enable_format_detection: bool = True,
        enable_smart_segmentation: bool = True
    ) -> Dict[str, Any]:
        """
        Main entry point for sensitive data detection.

        Returns:
            {
                'risk_level': 'no_risk' | 'low_risk' | 'medium_risk' | 'high_risk',
                'categories': [list of entity types found],
                'detected_entities': [
                    {
                        'start': int,
                        'end': int,
                        'text': str,
                        'entity_type': str,
                        'anonymized_value': str,
                        ...
                    }
                ],
                'anonymized_text': str,
                'restore_mapping': {placeholder: original_value},
                'format_info': {
                    'format_type': 'json'|'yaml'|'csv'|'markdown'|'plain_text',
                    'metadata': {...}
                }
            }
        """
```

### 3.2 Format Detection Service

**File**: `backend/services/format_detection_service.py`

Automatically detects content format for optimized processing.

| Format | Detection Method | Sensitive Field Detection |
|--------|------------------|---------------------------|
| JSON | `json.loads()` | Schema analysis, key patterns |
| YAML | `yaml.safe_load()` | Same as JSON |
| CSV | Header row detection | Column name patterns |
| Markdown | `#` header detection | Section structure |
| Plain Text | Default fallback | Line count only |

**Sensitive Key Patterns**:
- Personal: `ssn`, `id_card`, `passport`, `phone`, `email`, `address`, `birthday`
- Financial: `credit_card`, `bank_account`, `cvv`, `salary`, `balance`
- Security: `password`, `token`, `api_key`, `secret`
- Health: `medical`, `diagnosis`, `prescription`, `insurance`

### 3.3 Segmentation Service

**File**: `backend/services/segmentation_service.py`

Splits large content into manageable segments for parallel processing.

| Format | Segmentation Strategy | Max Segments |
|--------|----------------------|--------------|
| JSON Array | Group elements by size | 50 |
| JSON Object | Group key-value pairs | 50 |
| CSV | Row batches with headers | 100 |
| Markdown | Section grouping by headers | 30 |
| Plain Text | Paragraph-based splitting | 20 |

### 3.4 Restore Anonymization Service

**File**: `backend/services/restore_anonymization_service.py`

Generates safe Python code for entity-specific anonymization and restoration.

```python
async def generate_restore_code(
    entity_type_code: str,
    entity_type_name: str,
    natural_description: str,
    sample_data: str = None
) -> Dict[str, Any]:
    """
    Uses LLM to generate Python code for anonymization.

    Returns:
        {
            'code': str,           # Python anonymization code
            'code_hash': str,      # SHA-256 hash for integrity
            'placeholder_format': str  # Example: '[email_N]'
        }
    """
```

---

## 4. Detection Pipeline

### 4.1 Complete Detection Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Detection Pipeline                                  │
└─────────────────────────────────────────────────────────────────────────────┘

Step 1: Format Detection
├── Input: Raw text content
├── Process: detect_format(text)
└── Output: (format_type, metadata)

Step 2: Entity Type Retrieval
├── Input: tenant_id, application_id, direction
├── Process:
│   ├── ensure_application_has_system_copies()
│   ├── Filter by is_active status
│   └── Respect TenantEntityTypeDisable records
└── Output: List of applicable entity types

Step 3: Entity Classification
├── Regex Entity Types: recognition_method == 'regex'
│   └── Uses: recognition_config.pattern
└── GenAI Entity Types: recognition_method == 'genai'
    └── Uses: recognition_config.entity_definition

Step 4: Regex Detection (Fast Path)
├── Input: Full text, regex entity types
├── Process: _match_pattern(text, pattern)
└── Output: List of matches with positions

Step 5: GenAI Detection (Smart Path)
├── Condition: Content > 1000 chars AND format supports segmentation
├── If True:
│   ├── segment_content(text, format_type)
│   ├── Parallel: _match_pattern_genai(segment) for each segment
│   └── Adjust positions to original text coordinates
└── If False:
    └── _match_pattern_genai(full_text)

Step 6: Risk Aggregation
├── Input: All detected entities
├── Process:
│   ├── Map entity_type.category → risk_level
│   └── highest_risk = max(all_risk_levels)
└── Output: Aggregated risk_level

Step 7: Unified Anonymization
├── Input: Original text, all detected entities
├── Process: _anonymize_text_unified()
│   ├── Sort entities by position (back-to-front)
│   ├── Handle overlapping entities
│   ├── Apply anonymization method per entity
│   └── Build restore_mapping for restore-enabled entities
└── Output: (anonymized_text, restore_mapping)

Step 8: Result Assembly
└── Return: {risk_level, categories, detected_entities,
             anonymized_text, restore_mapping, format_info}
```

### 4.2 Regex Detection

```python
def _match_pattern(text: str, pattern: str) -> List[Dict]:
    """
    Regex-based entity matching.

    Supports:
    - Standard regex syntax
    - Double-escaped patterns (\\d, \\s)
    - Capture groups for anonymization

    Returns:
        [{'start': int, 'end': int, 'text': str, 'groups': tuple}]
    """
```

**Example Patterns**:
```python
# Chinese ID Card (18 digits)
pattern = r'\b[1-9]\d{5}(18|19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b'

# Phone Number
pattern = r'\b1[3-9]\d{9}\b'

# Email Address
pattern = r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'

# Credit Card
pattern = r'\b(?:\d{4}[-\s]?){3}\d{4}\b'
```

### 4.3 GenAI Detection

```python
async def _match_pattern_genai(text: str, entity_definition: str) -> List[Dict]:
    """
    GenAI-powered entity extraction.

    Uses LLM with entity_definition as natural language instruction.

    Example entity_definition:
        "Extract all company confidential project names that follow
         the pattern 'Project-XXX' or contain words like 'confidential',
         'internal', 'secret'"

    Returns:
        [{'start': int, 'end': int, 'text': str, 'confidence': float}]
    """
```

### 4.4 Direction-Specific Detection

Entity types can be configured to detect on input, output, or both:

```json
{
    "recognition_config": {
        "pattern": "\\b1[3-9]\\d{9}\\b",
        "check_input": true,   // Detect in user requests
        "check_output": false  // Skip detection in LLM responses
    }
}
```

---

## 5. Anonymization Strategies

### 5.1 Available Methods

| Method | Description | Reversible | Use Case |
|--------|-------------|------------|----------|
| `mask` | Character masking with prefix/suffix preservation | No | Display masking |
| `replace` | Static placeholder replacement | Yes (with mapping) | Standard anonymization |
| `hash` | SHA-256 hashing | No | Audit logging |
| `encrypt` | MD5-based placeholder | No | Reference tracking |
| `shuffle` | Character shuffling | No | Pattern preservation |
| `random` | Random replacement (digit→digit, letter→letter) | No | Format preservation |
| `regex_replace` | Regex capture group replacement | No | Partial masking |
| `genai` | AI-powered transformation | Configurable | Complex transformations |

### 5.2 Method Details

#### 5.2.1 Mask Method

```python
anonymization_config = {
    "method": "mask",
    "mask_char": "*",      # Character to use for masking
    "keep_prefix": 3,      # Characters to keep at start
    "keep_suffix": 4       # Characters to keep at end
}

# Example:
# Input:  "13812345678"
# Output: "138****5678"
```

#### 5.2.2 Replace Method

```python
anonymization_config = {
    "method": "replace",
    "replacement": "<PHONE_NUMBER>"  # Static replacement text
}

# Example:
# Input:  "Call me at 13812345678"
# Output: "Call me at <PHONE_NUMBER>"
```

#### 5.2.3 Regex Replace Method

```python
anonymization_config = {
    "method": "regex_replace",
    "pattern": "(\\d{3})\\d{4}(\\d{4})",
    "replacement": "\\1****\\2"
}

# Example:
# Input:  "13812345678"
# Output: "138****5678"
```

#### 5.2.4 Hash Method

```python
anonymization_config = {
    "method": "hash"
}

# Example:
# Input:  "13812345678"
# Output: "a1b2c3d4e5f6..."  # SHA-256 hash
```

### 5.3 Restore-Enabled Anonymization

For entities that need to be restored in responses:

```python
entity_type_config = {
    "entity_type": "PHONE_NUMBER",
    "anonymization_method": "replace",
    "restore_enabled": True,
    "restore_natural_desc": "Chinese mobile phone numbers starting with 1"
}

# Detection Result:
{
    "anonymized_text": "My number is [phone_1]",
    "restore_mapping": {
        "[phone_1]": "13812345678"
    }
}

# After LLM Response:
# LLM says: "I'll call you at [phone_1]"
# After restore: "I'll call you at 13812345678"
```

### 5.4 Overlapping Entity Handling

When entities overlap, the system:
1. Removes entities completely contained within other entities
2. Prefers longer entities over shorter ones
3. For same-position entities: prefers `mask` over `replace`

```
Text: "Contact: user@company.com"

Entity 1: "user@company.com" (email, pos 9-24)
Entity 2: "company.com" (domain, pos 14-24)

Result: Only email entity is processed (contains domain)
```

---

## 6. Restore Anonymization (De-anonymization)

### 6.1 Overview

The Restore Anonymization feature allows sensitive data to be:
1. **Anonymized** before sending to external LLMs
2. **Restored** in the LLM's response back to original values

This ensures users see natural responses while data never leaves the secure environment.

### 6.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Restore Anonymization Flow                            │
└─────────────────────────────────────────────────────────────────────────────┘

                    REQUEST PATH                 RESPONSE PATH
                         │                            │
                         ▼                            ▼
┌─────────────────────────────┐      ┌─────────────────────────────┐
│      Original Input         │      │      LLM Response           │
│ "My phone is 13812345678"   │      │ "I'll call [phone_1] later" │
└─────────────────────────────┘      └─────────────────────────────┘
                         │                            │
                         ▼                            ▼
┌─────────────────────────────┐      ┌─────────────────────────────┐
│    Entity Detection         │      │   Streaming Restore Buffer  │
│ Found: 13812345678 (phone)  │      │   mapping: {[phone_1]:      │
└─────────────────────────────┘      │            "13812345678"}   │
                         │           └─────────────────────────────┘
                         ▼                            │
┌─────────────────────────────┐                       ▼
│   Anonymization Engine      │      ┌─────────────────────────────┐
│ Generate: [phone_1]         │      │     Restored Response       │
│ Store mapping               │      │ "I'll call 13812345678      │
└─────────────────────────────┘      │  later"                     │
                         │           └─────────────────────────────┘
                         ▼
┌─────────────────────────────┐
│    Anonymized Input         │
│ "My phone is [phone_1]"     │
│ + restore_mapping stored    │
└─────────────────────────────┘
                         │
                         ▼
                   ┌───────────┐
                   │  LLM API  │
                   └───────────┘
```

### 6.3 AI-Generated Restore Code

The system uses LLM to generate safe Python code for anonymization:

```python
# Generated code example for phone numbers
def anonymize_phone(text, mapping):
    import re
    counter = [0]

    def replace_func(match):
        counter[0] += 1
        placeholder = f"[phone_{counter[0]}]"
        mapping[placeholder] = match.group(0)
        return placeholder

    pattern = r'\b1[3-9]\d{9}\b'
    result = re.sub(pattern, replace_func, text)
    return result, mapping
```

### 6.4 Streaming Restore Buffer

Handles placeholder restoration in streaming responses:

```python
class StreamingRestoreBuffer:
    def __init__(self, mapping: Dict[str, str], max_placeholder_length: int = 50):
        self.mapping = mapping
        self.buffer = ""
        self.max_length = max_placeholder_length

    def process_chunk(self, chunk: str) -> str:
        """
        Process a streaming chunk and return restorable content.

        Handles cases where placeholders are split across chunks:
        - Chunk 1: "Hello [pho"
        - Chunk 2: "ne_1] world"

        Returns only content that's safe to output.
        """
        self.buffer += chunk

        # Find last potential placeholder start
        last_bracket = self.buffer.rfind('[')

        if last_bracket == -1:
            # No potential placeholder, output all
            output = self._restore(self.buffer)
            self.buffer = ""
            return output

        # Check if we have complete placeholder
        if ']' in self.buffer[last_bracket:]:
            output = self._restore(self.buffer)
            self.buffer = ""
            return output

        # Incomplete placeholder, hold in buffer
        output = self._restore(self.buffer[:last_bracket])
        self.buffer = self.buffer[last_bracket:]
        return output

    def flush(self) -> str:
        """Flush remaining buffer content."""
        output = self._restore(self.buffer)
        self.buffer = ""
        return output
```

### 6.5 Safety Sandbox

Generated code runs in a restricted environment:

**Blocked Patterns**:
```python
DANGEROUS_PATTERNS = [
    r'\bimport\s+',           # import statements
    r'\bfrom\s+\w+\s+import', # from X import Y
    r'__\w+__',               # dunder attributes
    r'\beval\s*\(',           # eval()
    r'\bexec\s*\(',           # exec()
    r'\bcompile\s*\(',        # compile()
    r'\bopen\s*\(',           # open()
    r'\bos\.',                # os module
    r'\bsys\.',               # sys module
    r'\bsubprocess\.',        # subprocess module
    r'\bsocket\.',            # socket module
    r'\bglobal\s+',           # global keyword
]
```

**Allowed Builtins**:
```python
ALLOWED_BUILTINS = {
    'len', 'str', 'int', 'float', 'bool',
    'dict', 'list', 'tuple', 'set',
    'range', 'enumerate', 'zip',
    'min', 'max', 'sorted', 'reversed',
    'any', 'all', 'map', 'filter',
    'True', 'False', 'None',
    're',  # regex module
}
```

---

## 7. Private Model Switching

### 7.1 Overview

**Private Model Switching** is a key feature (v5.1.0) that automatically routes requests containing sensitive data to on-premise or private models, ensuring data never leaves your infrastructure.

### 7.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                      Private Model Switching Flow                            │
└─────────────────────────────────────────────────────────────────────────────┘

User Request
     │
     ▼
┌─────────────────┐
│  DLP Detection  │
└────────┬────────┘
         │
         ▼
    ┌─────────┐
    │ Sensitive│────No────▶ Continue to Public Model
    │  Data?  │
    └────┬────┘
         │Yes
         ▼
┌─────────────────┐
│ Risk Level      │
│ Determination   │
└────────┬────────┘
         │
         ├─── High Risk ───▶ Get Disposal Action ───▶ block (default)
         │                                            │
         ├─── Medium Risk ─▶ Get Disposal Action ───▶ switch_private_model (default)
         │                                            │
         └─── Low Risk ────▶ Get Disposal Action ───▶ anonymize (default)
                                                      │
                                                      ▼
                              ┌─────────────────────────────────────────┐
                              │ If action == 'switch_private_model':    │
                              │                                         │
                              │  1. Check app policy private_model_id   │
                              │  2. Check tenant default private model  │
                              │  3. Check highest priority private model│
                              │  4. Route request to selected model     │
                              └─────────────────────────────────────────┘
                                                      │
                                                      ▼
                              ┌─────────────────────────────────────────┐
                              │        Private/On-Premise Model         │
                              │  (Data stays within infrastructure)     │
                              └─────────────────────────────────────────┘
```

### 7.3 Model Safety Attributes

Models can be marked as "data-safe" in the `upstream_api_config` table:

```python
class UpstreamApiConfig:
    # ... other fields ...

    # DLP-related fields
    is_private_model: bool          # Mark as safe for sensitive data
    is_default_private_model: bool  # Tenant-wide default
    private_model_names: JSON       # Available model names
    default_private_model_name: str # Specific model to use
```

### 7.4 Private Model Selection Priority

```python
async def get_private_model(
    tenant_id: str,
    application_id: str = None
) -> Optional[UpstreamApiConfig]:
    """
    Get private model with priority:

    1. Application-configured private model (highest priority)
       - app_policy.private_model_id

    2. Tenant's default private model
       - upstream_api_config.is_default_private_model = True

    3. First available private model (fallback)
       - upstream_api_config.is_private_model = True
       - Ordered by private_model_priority DESC
    """
```

### 7.5 Configuration Example

**Step 1: Mark model as private in Admin UI**

Navigate to: Proxy Model Management → Select Model → Safety Settings

```json
{
    "model_name": "Internal-LLaMA-70B",
    "api_base_url": "http://internal-llm.company.local:8080/v1",
    "is_private_model": true,
    "is_default_private_model": true,
    "private_model_priority": 100
}
```

**Step 2: Configure application policy**

```json
{
    "application_id": "app-123",
    "input_medium_risk_action": "switch_private_model",
    "output_medium_risk_action": "switch_private_model",
    "private_model_id": "model-uuid-456"  // Optional override
}
```

### 7.6 Enterprise Value

| Scenario | Without Private Switching | With Private Switching |
|----------|---------------------------|------------------------|
| User sends SSN | Request blocked, user frustrated | Routed to private model, seamless |
| Medical records | Data exposed or blocked | Stays on-premise, processed normally |
| Financial data | Risk of compliance violation | Full compliance, uninterrupted workflow |
| User experience | Interrupted, error messages | Transparent, natural responses |

---

## 8. Disposal Actions

### 8.1 Available Actions

| Action | Description | When to Use |
|--------|-------------|-------------|
| `block` | Reject request completely | High-risk data, zero tolerance |
| `switch_private_model` | Route to data-safe model | Sensitive data, privacy required |
| `anonymize` | Replace with placeholders | Low-risk, restore needed |
| `anonymize_restore` | Anonymize + restore in response | Seamless user experience |
| `pass` | Allow, log only | Audit mode, monitoring |

### 8.2 Default Strategy

```
┌─────────────────┬─────────────────────────────────┐
│   Risk Level    │         Default Action          │
├─────────────────┼─────────────────────────────────┤
│   High Risk     │   block                         │
├─────────────────┼─────────────────────────────────┤
│   Medium Risk   │   switch_private_model          │
├─────────────────┼─────────────────────────────────┤
│   Low Risk      │   anonymize                     │
├─────────────────┼─────────────────────────────────┤
│   No Risk       │   pass                          │
└─────────────────┴─────────────────────────────────┘
```

### 8.3 Disposal Service

```python
class DataLeakageDisposalService:

    VALID_ACTIONS = ['block', 'switch_private_model', 'anonymize',
                     'anonymize_restore', 'pass']

    async def get_disposal_action(
        self,
        application_id: str,
        risk_level: str,
        direction: str = "input"  # "input" or "output"
    ) -> str:
        """
        Resolve disposal action for given context.

        Priority:
        1. Application-level policy (if not NULL)
        2. Tenant-level default policy
        3. System default
        """

    async def validate_action(
        self,
        action: str,
        tenant_id: str
    ) -> Tuple[bool, Optional[str]]:
        """
        Validate action is executable.

        For 'switch_private_model': checks private model exists.
        """
```

---

## 9. Policy Management

### 9.1 Hierarchical Policy Structure

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Policy Hierarchy                                     │
└─────────────────────────────────────────────────────────────────────────────┘

                    ┌─────────────────────────────┐
                    │     System Defaults         │
                    │  (Hardcoded fallbacks)      │
                    └─────────────┬───────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │   Tenant Policy             │
                    │   (tenant_data_leakage_     │
                    │    policy table)            │
                    │                             │
                    │   - default_input_high_     │
                    │     risk_action             │
                    │   - default_input_medium_   │
                    │     risk_action             │
                    │   - default_input_low_      │
                    │     risk_action             │
                    │   - default_output_*        │
                    │   - default_enable_format_  │
                    │     detection               │
                    └─────────────┬───────────────┘
                                  │
                                  ▼
                    ┌─────────────────────────────┐
                    │   Application Policy        │
                    │   (application_data_        │
                    │    leakage_policy table)    │
                    │                             │
                    │   - input_high_risk_action  │
                    │     (NULL = use tenant)     │
                    │   - input_medium_risk_action│
                    │   - input_low_risk_action   │
                    │   - output_*                │
                    │   - private_model_id        │
                    │   - enable_format_detection │
                    └─────────────────────────────┘
```

### 9.2 Policy Resolution Logic

```python
def resolve_policy(
    application_id: str,
    field_name: str,
    tenant_id: str
) -> Any:
    """
    Resolve policy value with fallback chain.
    """
    # 1. Check application policy
    app_policy = get_application_policy(application_id)
    if app_policy and getattr(app_policy, field_name) is not None:
        return getattr(app_policy, field_name)

    # 2. Check tenant policy
    tenant_policy = get_tenant_policy(tenant_id)
    tenant_field = f"default_{field_name}"
    if tenant_policy and getattr(tenant_policy, tenant_field) is not None:
        return getattr(tenant_policy, tenant_field)

    # 3. Return system default
    return SYSTEM_DEFAULTS.get(field_name)
```

### 9.3 Entity Type Management

Entity types follow a similar hierarchy:

```
System Templates (source_type='system_template')
        │
        │  Auto-copy on first access
        ▼
Application Copies (source_type='system_copy')
        │
        │  Can be customized
        ▼
Custom Entity Types (source_type='custom', S100+)
```

**Disabling Entity Types**:
```python
# TenantEntityTypeDisable table
{
    "tenant_id": "uuid",
    "application_id": "uuid",  # NULL for tenant-wide
    "entity_type": "ID_CARD_NUMBER_SYS"
}
```

---

## 10. API Reference

### 10.1 Entity Type APIs

```
# List entity types
GET /api/v1/config/data-security/entity-types
Query: risk_level, is_active
Response: {items: [...], total: int}

# Get single entity type
GET /api/v1/config/data-security/entity-types/{entity_type_id}
Response: EntityTypeDetail

# Create custom entity type
POST /api/v1/config/data-security/entity-types
Body: {
    entity_type: "CUSTOM_ENTITY_S100",
    entity_type_name: "Custom Entity",
    category: "low",
    recognition_method: "regex",
    recognition_config: {...},
    anonymization_method: "mask",
    anonymization_config: {...}
}

# Update entity type
PUT /api/v1/config/data-security/entity-types/{entity_type_id}
Body: {partial updates}

# Delete entity type
DELETE /api/v1/config/data-security/entity-types/{entity_type_id}
```

### 10.2 Policy APIs

```
# Get tenant defaults
GET /api/v1/config/data-leakage-policy/tenant-defaults
Response: {
    default_input_high_risk_action: "block",
    default_input_medium_risk_action: "switch_private_model",
    ...
    available_private_models: [...]
}

# Update tenant defaults
PUT /api/v1/config/data-leakage-policy/tenant-defaults
Body: {all fields required}

# Get application policy (resolved)
GET /api/v1/config/data-leakage-policy
Header: X-Application-ID: {app_id}
Response: {
    overrides: {input_high_risk_action: null, ...},
    resolved: {input_high_risk_action: "block", ...}
}

# Update application policy
PUT /api/v1/config/data-leakage-policy
Header: X-Application-ID: {app_id}
Body: {all fields nullable}

# List private models
GET /api/v1/config/private-models
Response: [{id, model_name, is_default_private_model, ...}]
```

### 10.3 Detection API

```
# Main guardrails detection (includes DLP)
POST /v1/guardrails
Body: {
    messages: [...],
    extra_body: {
        enable_data_security: true,
        enable_format_detection: true,
        enable_smart_segmentation: true
    }
}
Response: {
    action: "pass" | "reject",
    risk_level: "no_risk" | "low_risk" | "medium_risk" | "high_risk",
    data_security: {
        detected_entities: [...],
        anonymized_text: "...",
        restore_mapping: {...}
    }
}
```

---

## 11. Database Schema

### 11.1 Entity Type Table

```sql
CREATE TABLE data_security_entity_types (
    id UUID PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    application_id UUID REFERENCES applications(id),

    -- Entity definition
    entity_type VARCHAR(100) NOT NULL,
    entity_type_name VARCHAR(255) NOT NULL,
    category VARCHAR(20) NOT NULL,  -- low, medium, high

    -- Recognition
    recognition_method VARCHAR(20) NOT NULL,  -- regex, genai
    recognition_config JSONB NOT NULL,

    -- Anonymization
    anonymization_method VARCHAR(20) NOT NULL,
    anonymization_config JSONB NOT NULL,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    source_type VARCHAR(20) NOT NULL,  -- system_template, system_copy, custom
    template_id UUID,

    -- Restore
    restore_enabled BOOLEAN DEFAULT FALSE,
    restore_code TEXT,
    restore_code_hash VARCHAR(64),
    restore_natural_desc TEXT,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### 11.2 Policy Tables

```sql
-- Tenant-level defaults
CREATE TABLE tenant_data_leakage_policy (
    id UUID PRIMARY KEY,
    tenant_id UUID UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,

    -- Input actions
    default_input_high_risk_action VARCHAR(30) DEFAULT 'block',
    default_input_medium_risk_action VARCHAR(30) DEFAULT 'switch_private_model',
    default_input_low_risk_action VARCHAR(30) DEFAULT 'anonymize',

    -- Output actions
    default_output_high_risk_action VARCHAR(30) DEFAULT 'block',
    default_output_medium_risk_action VARCHAR(30) DEFAULT 'switch_private_model',
    default_output_low_risk_action VARCHAR(30) DEFAULT 'anonymize',

    -- Features
    default_enable_format_detection BOOLEAN DEFAULT TRUE,
    default_enable_smart_segmentation BOOLEAN DEFAULT TRUE,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Application-level overrides
CREATE TABLE application_data_leakage_policy (
    id UUID PRIMARY KEY,
    tenant_id UUID REFERENCES tenants(id),
    application_id UUID UNIQUE REFERENCES applications(id) ON DELETE CASCADE,

    -- All fields nullable (NULL = use tenant default)
    input_high_risk_action VARCHAR(30),
    input_medium_risk_action VARCHAR(30),
    input_low_risk_action VARCHAR(30),

    output_high_risk_action VARCHAR(30),
    output_medium_risk_action VARCHAR(30),
    output_low_risk_action VARCHAR(30),

    private_model_id UUID REFERENCES upstream_api_config(id),

    enable_format_detection BOOLEAN,
    enable_smart_segmentation BOOLEAN,

    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);
```

### 11.3 Model Safety Attributes

```sql
ALTER TABLE upstream_api_config ADD COLUMN
    is_private_model BOOLEAN DEFAULT FALSE,
    is_default_private_model BOOLEAN DEFAULT FALSE,
    private_model_names JSONB,
    default_private_model_name VARCHAR(255);
```

---

## 12. Examples

### 12.1 Basic Detection Example

**Request**:
```python
import requests

response = requests.post(
    "http://localhost:5001/v1/guardrails",
    headers={"Authorization": "Bearer sk-xxai-your-key"},
    json={
        "messages": [
            {"role": "user", "content": "My ID is 310101199001011234 and phone is 13812345678"}
        ]
    }
)

print(response.json())
```

**Response**:
```json
{
    "action": "reject",
    "risk_level": "high_risk",
    "categories": ["ID_CARD_NUMBER_SYS", "PHONE_NUMBER_SYS"],
    "data_security": {
        "detected_entities": [
            {
                "entity_type": "ID_CARD_NUMBER_SYS",
                "text": "310101199001011234",
                "start": 9,
                "end": 27,
                "risk_level": "high"
            },
            {
                "entity_type": "PHONE_NUMBER_SYS",
                "text": "13812345678",
                "start": 42,
                "end": 53,
                "risk_level": "medium"
            }
        ],
        "anonymized_text": "My ID is [id_card_1] and phone is [phone_1]",
        "restore_mapping": {
            "[id_card_1]": "310101199001011234",
            "[phone_1]": "13812345678"
        }
    }
}
```

### 12.2 Private Model Switching Example

**Scenario**: User sends sensitive medical data

**Configuration**:
```python
# Tenant policy
{
    "default_input_medium_risk_action": "switch_private_model"
}

# Private model
{
    "model_name": "Internal-Medical-LLM",
    "is_private_model": True,
    "is_default_private_model": True
}
```

**Request**:
```python
response = requests.post(
    "http://localhost:5002/v1/chat/completions",
    headers={"Authorization": "Bearer sk-xxai-your-key"},
    json={
        "model": "gpt-4",
        "messages": [
            {"role": "user", "content": "Patient SSN: 123-45-6789, diagnosis: diabetes"}
        ]
    }
)
```

**Internal Flow**:
```
1. DLP detects: SSN (medium risk), medical data (medium risk)
2. Policy check: medium_risk_action = "switch_private_model"
3. Get private model: Internal-Medical-LLM
4. Route request to internal model
5. Return response to user (transparent switch)
```

### 12.3 Anonymization + Restore Example

**Scenario**: Anonymize phone numbers, restore in response

**Entity Type Configuration**:
```json
{
    "entity_type": "PHONE_NUMBER_SYS",
    "anonymization_method": "replace",
    "restore_enabled": true,
    "restore_natural_desc": "Chinese mobile phone numbers"
}
```

**Request**:
```
User: "Call me at 13812345678"
```

**After Anonymization** (sent to LLM):
```
User: "Call me at [phone_1]"
restore_mapping: {"[phone_1]": "13812345678"}
```

**LLM Response**:
```
"Sure, I'll call you at [phone_1] tomorrow at 3pm."
```

**After Restore** (returned to user):
```
"Sure, I'll call you at 13812345678 tomorrow at 3pm."
```

### 12.4 Custom Entity Type Example

**Create custom entity for internal project codes**:

```python
requests.post(
    "http://localhost:5000/api/v1/config/data-security/entity-types",
    headers={"Authorization": "Bearer jwt-token"},
    json={
        "entity_type": "PROJECT_CODE_S100",
        "entity_type_name": "Internal Project Code",
        "category": "medium",
        "recognition_method": "genai",
        "recognition_config": {
            "entity_definition": "Extract internal project codes that follow the pattern 'PRJ-XXXX' or 'PROJECT-XXXX' where X is alphanumeric",
            "check_input": True,
            "check_output": True
        },
        "anonymization_method": "replace",
        "anonymization_config": {
            "replacement": "[PROJECT_CODE]"
        },
        "restore_enabled": False
    }
)
```

### 12.5 Policy Configuration Example

**Set up tenant defaults**:
```python
requests.put(
    "http://localhost:5000/api/v1/config/data-leakage-policy/tenant-defaults",
    headers={"Authorization": "Bearer jwt-token"},
    json={
        "default_input_high_risk_action": "block",
        "default_input_medium_risk_action": "switch_private_model",
        "default_input_low_risk_action": "anonymize",
        "default_output_high_risk_action": "block",
        "default_output_medium_risk_action": "anonymize",
        "default_output_low_risk_action": "pass",
        "default_enable_format_detection": True,
        "default_enable_smart_segmentation": True
    }
)
```

**Override for specific application**:
```python
requests.put(
    "http://localhost:5000/api/v1/config/data-leakage-policy",
    headers={
        "Authorization": "Bearer jwt-token",
        "X-Application-ID": "app-uuid-123"
    },
    json={
        # Only override what's different from tenant defaults
        "input_medium_risk_action": "anonymize",  # Don't switch model for this app
        "private_model_id": None  # Use tenant default private model
    }
)
```

---

## 13. Performance Considerations

### 13.1 Processing Times

| Operation | Typical Time | Notes |
|-----------|--------------|-------|
| Format Detection | 5-10ms | JSON/YAML parsing overhead |
| Smart Segmentation | 10-20ms | Per segment creation |
| Regex Detection | 1-5ms | Per pattern per entity |
| GenAI Detection | 100-500ms | Depends on model latency |
| Anonymization | 5-15ms | Per document |
| Restore Code Execution | 10-50ms | Sandbox overhead |

### 13.2 Optimization Strategies

1. **Parallel GenAI Processing**: Multiple segments processed concurrently
2. **Regex First**: Fast regex detection before slower GenAI
3. **Caching**: Entity types, policies cached (5-minute TTL)
4. **Streaming Restore**: Chunk-by-chunk restoration for low latency

### 13.3 Segmentation Benefits

| Content Size | Without Segmentation | With Segmentation | Improvement |
|--------------|---------------------|-------------------|-------------|
| < 1KB | N/A | N/A | - |
| 1-10KB | 500ms | 350ms | 30% faster |
| 10-50KB | 2000ms | 800ms | 60% faster |
| > 50KB | Timeout risk | 1500ms | Reliable |

### 13.4 Recommended Limits

```yaml
# Recommended configuration
max_content_size: 100KB
max_segments: 50
genai_timeout: 30s
restore_code_timeout: 5s
max_placeholder_length: 50
```

---

## Appendix A: Default Entity Types

| Code | Name | Category | Method |
|------|------|----------|--------|
| ID_CARD_NUMBER_SYS | Chinese ID Card | high | regex |
| PHONE_NUMBER_SYS | Phone Number | medium | regex |
| EMAIL_ADDRESS_SYS | Email Address | low | regex |
| BANK_CARD_NUMBER_SYS | Bank Card | high | regex |
| PASSPORT_NUMBER_SYS | Passport | high | regex |
| IP_ADDRESS_SYS | IP Address | low | regex |

---

## Appendix B: Troubleshooting

### B.1 Detection Not Working

```bash
# Check entity type is active
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/v1/config/data-security/entity-types?is_active=true"

# Check if entity type is disabled
SELECT * FROM tenant_entity_type_disable
WHERE tenant_id = 'your-tenant-id';
```

### B.2 Private Model Not Switching

```bash
# Verify private model exists
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:5000/api/v1/config/private-models"

# Check policy configuration
curl -H "Authorization: Bearer $TOKEN" \
  -H "X-Application-ID: your-app-id" \
  "http://localhost:5000/api/v1/config/data-leakage-policy"
```

### B.3 Restore Not Working

```bash
# Check restore_enabled flag
SELECT entity_type, restore_enabled, restore_code
FROM data_security_entity_types
WHERE tenant_id = 'your-tenant-id';

# Regenerate restore code
PUT /api/v1/config/data-security/entity-types/{id}
{"restore_natural_desc": "Updated description to regenerate code"}
```

---

**Document Version**: 1.0
**Compatibility**: OpenGuardrails v5.1.0+
**Contact**: thomas@openguardrails.com
