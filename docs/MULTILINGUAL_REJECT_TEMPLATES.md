# Multilingual Reject Answer Templates

## Overview

The OpenGuardrails platform now supports multilingual reject answer templates. This feature allows administrators to configure different rejection messages for each risk category in multiple languages (English and Chinese). The system automatically returns the appropriate language version based on the user's language preference.

## Features

- **Automatic Language Selection**: The system automatically returns reject answers in the user's preferred language
- **Backward Compatibility**: Existing single-language templates are automatically migrated to the new format
- **Frontend UI**: Easy-to-use interface for managing multilingual content
- **Fallback Mechanism**: If a language is not available, the system falls back to English or the first available language

## Database Schema Changes

### Before (Single Language)
```sql
template_content TEXT NOT NULL
```

Example:
```
"I'm sorry, but I cannot discuss political topics."
```

### After (Multilingual JSON)
```sql
template_content JSONB NOT NULL
```

Example:
```json
{
  "en": "I'm sorry, but I cannot discuss political topics.",
  "zh": "抱歉,我无法讨论政治话题。"
}
```

## How It Works

### 1. User Language Detection

When a user makes a request, the system:
1. Retrieves the user's language preference from the `tenants.language` field
2. Passes this language to the template service
3. Returns the appropriate language version of the reject message

### 2. Language Fallback Logic

The system uses the following fallback logic:

```
1. Try user's preferred language (e.g., 'zh')
2. If not found, try English ('en')
3. If English not found, use first available language
4. If no languages available, use hardcoded default message
```

### 3. Template Storage Format

Templates are stored as JSON objects in the database:

```json
{
  "en": "English version of the reject message",
  "zh": "中文版本的拒答消息"
}
```

## Migration

### Running the Migration

The migration script `migrations/010_multilingual_response_templates.py` handles the conversion of existing templates:

```bash
cd /path/to/openguardrails
python migrations/010_multilingual_response_templates.py
```

### What the Migration Does

1. **Creates temporary column**: Adds `template_content_json` JSONB column
2. **Migrates data**: Converts existing text templates to JSON format
   - Detects if content is Chinese or English based on character analysis
   - Fills in missing language with default content
3. **Replaces column**: Drops old TEXT column and renames JSON column
4. **Preserves data**: All existing templates are preserved and enhanced

### Migration Safety

- **Non-destructive**: Original data is preserved during migration
- **Rollback support**: Downgrade script available (though it loses multilingual support)
- **Transaction-based**: Uses database transactions for atomicity

## Frontend Usage

### Editing Templates

1. Navigate to **Configuration** → **Reject Answer Library**
2. Click **Edit** on any risk category
3. Enter content in both languages:
   - **English**: Enter English version in "Reject Content (English)" field
   - **Chinese**: Enter Chinese version in "Reject Content (Chinese)" field
4. Click **Confirm** to save

### Viewing Templates

The table displays both language versions in the format:
```
EN: English content | ZH: Chinese content
```

### Validation

- At least one language must be provided
- Both languages are optional, but recommended for better user experience

## API Integration

### Request Format (No Changes)

The API request format remains the same:

```json
POST /v1/guardrails
{
  "model": "OpenGuardrails-Text",
  "messages": [
    {"role": "user", "content": "Your content to check"}
  ]
}
```

### Response Format (No Changes)

The response automatically includes the correct language version:

```json
{
  "id": "guardrails-xxxxx",
  "suggest_action": "reject",
  "suggest_answer": "抱歉,我无法讨论政治话题。"  // Chinese user
}
```

or

```json
{
  "id": "guardrails-xxxxx",
  "suggest_action": "reject",
  "suggest_answer": "I'm sorry, but I cannot discuss political topics."  // English user
}
```

## Backend Implementation

### Key Files Modified

1. **Database Model**: `backend/database/models.py`
   - Changed `template_content` from TEXT to JSON

2. **Enhanced Template Service**: `backend/services/enhanced_template_service.py`
   - Added `user_language` parameter
   - Added `_get_localized_content()` method
   - Updated `_get_template_answer()` and `_get_default_answer()`

3. **Detection Services**:
   - `backend/services/detection_guardrail_service.py`
   - `backend/services/guardrail_service.py`
   - Both now fetch user language from tenant and pass to template service

4. **Frontend Component**: `frontend/src/pages/Config/ResponseTemplateManagement.tsx`
   - Updated to support dual-language input fields
   - Added rendering for multilingual content display

5. **Internationalization**:
   - `frontend/src/locales/en.json`
   - `frontend/src/locales/zh.json`

## Default Templates

The migration includes default templates for all 19 risk categories plus a default fallback. Each template has both English and Chinese versions.

### Example Default Templates

**S1 - General Political Topics**
- English: "I'm sorry, but I cannot discuss general political topics. Please ask about something else."
- Chinese: "抱歉，我无法讨论一般政治话题。请询问其他内容。"

**S9 - Prompt Attacks**
- English: "I'm sorry, but I detected a prompt attack attempt. Please rephrase your question appropriately."
- Chinese: "抱歉，我检测到了提示词攻击尝试。请适当地重新表述您的问题。"

## Testing

### Manual Testing Steps

1. **Change User Language**:
   - Update user's language preference in account settings
   - Or directly in database: `UPDATE tenants SET language = 'zh' WHERE id = 'xxx'`

2. **Configure Templates**:
   - Edit a template in the Reject Answer Library
   - Add both English and Chinese versions

3. **Test Detection**:
   - Send a request that triggers the configured risk category
   - Verify the response contains the correct language version

4. **Test Fallback**:
   - Remove one language from a template
   - Verify the system falls back to the available language

### Automated Testing

```python
# Example test case
def test_multilingual_template():
    # Set user language to Chinese
    user.language = 'zh'

    # Trigger S1 (General Political Topics)
    response = detect_content("政治相关内容")

    # Verify Chinese response
    assert "抱歉" in response.suggest_answer
    assert "政治话题" in response.suggest_answer
```

## Best Practices

1. **Always Provide Both Languages**: For best user experience, configure both English and Chinese versions

2. **Consistent Tone**: Maintain consistent tone and messaging across languages

3. **Cultural Sensitivity**: Consider cultural differences when translating reject messages

4. **Regular Updates**: Review and update templates periodically to ensure clarity

5. **Test After Changes**: Always test templates in both languages after updates

## Troubleshooting

### Issue: Templates Not Appearing in Correct Language

**Solution**:
1. Check user's language setting in `tenants.language`
2. Verify template has content for that language
3. Check logs for any errors in template retrieval

### Issue: Migration Failed

**Solution**:
1. Check database connection
2. Ensure PostgreSQL version supports JSONB (9.4+)
3. Review migration logs for specific error
4. Can rollback with `python migrations/010_multilingual_response_templates.py downgrade`

### Issue: Frontend Not Showing Multilingual Fields

**Solution**:
1. Clear browser cache
2. Verify frontend build includes latest changes
3. Check browser console for JavaScript errors

## Future Enhancements

Possible future improvements:

1. **Additional Languages**: Support for more languages beyond English and Chinese
2. **Bulk Import**: CSV/Excel import for bulk template management
3. **Template Versioning**: Track changes to templates over time
4. **A/B Testing**: Test different template variations
5. **Analytics**: Track which templates are most effective

## Related Documentation

- [API Reference](./API_REFERENCE.md)
- [Configuration Guide](./DEPLOYMENT.md)
- [Database Migration Guide](./MIGRATION_GUIDE.md)

## Support

For questions or issues related to multilingual templates:
- Email: thomas@openguardrails.com
- GitHub Issues: https://github.com/openguardrails/openguardrails/issues
