# Changelog

All notable changes to the OpenGuardrails Higress Plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] - 2025-12-06

### Fixed
- **Critical**: Fixed `checkResponse: true` not working - response content was not being sent to OpenGuardrails for detection
  - Added context storage in `onHttpRequestBody` to save request prompt and user_id for response checking
  - Response checking now correctly receives the full conversation context (prompt + response)

### Added
- **Multimodal content support** - Plugin now works seamlessly with multimodal models (Gemini, GPT-4V, Claude 3, etc.)
  - Automatically detects and extracts text from multimodal requests (text + images/PDFs)
  - Handles multimodal responses (text + generated images) by checking only text parts
  - Skips detection gracefully when no text content is present (e.g., pure image requests)
  - Non-text content (images, PDFs, audio) passes through transparently without interference
  - Added comprehensive tests for multimodal scenarios (5 test cases)

### Changed
- **Breaking**: Added configuration validation - `checkResponse: true` now requires `checkRequest: true`
  - Response detection is context-aware and needs the user prompt for accurate detection
  - Invalid configurations (`checkRequest: false, checkResponse: true`) will be rejected at startup
  - Supported configurations:
    - `checkRequest: true, checkResponse: false` - Only check user input
    - `checkRequest: true, checkResponse: true` - Check both input and AI response (with context)

### Technical Details
The original bug occurred because:
1. Request prompt was never saved to context in `onHttpRequestBody` (main.go:199-293)
2. `onHttpResponseBody` tried to read `request_prompt` from context but always found it empty (main.go:317-324)
3. OpenGuardrails received empty prompt + response content, causing incomplete detection

The fix ensures:
- ✅ Request prompt is always saved to context when `checkResponse: true` (main.go:222-228)
- ✅ Full context (user prompt + AI response) is sent to OpenGuardrails for accurate detection
- ✅ Configuration validation prevents invalid setups (main.go:145-148)
- ✅ Each request/response pair is guaranteed to be matched (Higress HttpContext lifecycle guarantee)

## [0.1.0] - 2025-12-05

### Added
- Initial release of OpenGuardrails Higress Plugin
- Support for request checking (`checkRequest`)
- Support for response checking (`checkResponse`)
- Direct mode: Use full URLs without DNS service configuration
- Service discovery mode: Traditional Higress DNS service integration
- Configurable JSON paths for custom API formats
- Custom deny messages and status codes
- Support for both OpenAI and custom protocol formats
- Comprehensive configuration examples for various deployment scenarios
