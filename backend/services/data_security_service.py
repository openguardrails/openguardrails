"""
Data security service - sensitive data detection and de-sensitization based on regular expressions and GenAI
"""
import re
import hashlib
import random
import string
import logging
import json
import asyncio
from typing import List, Dict, Any, Optional, Tuple
from sqlalchemy.orm import Session
from sqlalchemy import and_
from datetime import datetime
from database.models import DataSecurityEntityType, TenantEntityTypeDisable
from utils.logger import setup_logger
from services.model_service import ModelService
from services.format_detection_service import format_detection_service
from services.segmentation_service import segmentation_service, ContentSegment

logger = setup_logger()

# Risk level mapping
RISK_LEVEL_MAPPING = {
    'low': 'low_risk',
    'medium': 'medium_risk',
    'high': 'high_risk'
}

def _convert_replacement_template(template: str) -> str:
    """
    Ensure replacement template uses Python's \\1, \\2 syntax.

    The preferred format is now \\1, \\2 (Python regex syntax).
    For backward compatibility, $1, $2 format is still supported and will be converted.
    """
    # Check if template already uses Python format (\1, \2)
    # If it contains \1-\9, assume it's already in Python format
    import re
    if re.search(r'\\[1-9]', template):
        return template

    # Convert legacy $1, $2, ... $9 to \1, \2, ... \9
    result = template
    for i in range(9, 0, -1):  # Start from 9 to avoid $1 matching part of $10
        result = result.replace(f'${i}', f'\\{i}')
    return result

class DataSecurityService:
    """Data security service - sensitive data detection and de-sensitization"""

    def __init__(self, db: Session):
        self.db = db
        self.model_service = ModelService()

    async def detect_sensitive_data(
        self,
        text: str,
        tenant_id: str,  # tenant_id, for backward compatibility keep parameter name tenant_id
        direction: str = "input",  # input or output
        application_id: Optional[str] = None,  # NEW: application_id for application-level entity type filtering
        enable_format_detection: bool = True,  # NEW: Enable format detection
        enable_smart_segmentation: bool = True  # NEW: Enable smart segmentation
    ) -> Dict[str, Any]:
        """
        Detect sensitive data in text with format-aware optimization

        Args:
            text: text to detect
            tenant_id: tenant ID (actually tenant_id, parameter name for backward compatibility)
            direction: detection direction, input means input detection, output means output detection
            application_id: application ID for application-level entity type filtering
            enable_format_detection: Enable automatic format detection (JSON/YAML/CSV/Markdown)
            enable_smart_segmentation: Enable intelligent segmentation based on format

        Returns:
            Detection result, including risk level, detected categories, de-sensitized text, and format info
        """
        # 1. Format detection (if enabled)
        format_type = 'plain_text'
        format_metadata = {}
        if enable_format_detection:
            try:
                format_type, format_metadata = format_detection_service.detect_format(text)
                logger.info(f"Detected format: {format_type}")
            except Exception as e:
                logger.warning(f"Format detection failed: {e}, falling back to plain_text")

        # 2. Get tenant's sensitive data definition
        entity_types = self._get_user_entity_types(tenant_id, direction, application_id)

        if not entity_types:
            return {
                'risk_level': 'no_risk',
                'categories': [],
                'detected_entities': [],
                'anonymized_text': text,
                'format_info': {
                    'format_type': format_type,
                    'metadata': format_metadata
                }
            }

        # 3. Separate regex and genai entity types
        regex_entity_types = [et for et in entity_types if et.get('recognition_method', 'regex') == 'regex']
        genai_entity_types = [et for et in entity_types if et.get('recognition_method') == 'genai']

        logger.info(f"Entity types breakdown: {len(regex_entity_types)} regex, {len(genai_entity_types)} genai")

        detected_entities = []
        highest_risk_level = 'no_risk'
        detected_categories = set()

        # 4. Regex detection (full text, no segmentation)
        for entity_type in regex_entity_types:
            pattern_preview = entity_type.get('pattern', '')[:80] if entity_type.get('pattern') else 'NO PATTERN'
            logger.info(f"Regex checking entity type: {entity_type.get('entity_type')} with pattern: {pattern_preview}")
            matches = self._match_pattern(text, entity_type)
            logger.info(f"Regex result for {entity_type.get('entity_type')}: {len(matches)} matches")
            if matches:
                detected_entities.extend(matches)
                detected_categories.add(entity_type['entity_type'])

                # Update highest risk level
                entity_risk = entity_type.get('risk_level', 'medium')
                if self._compare_risk_level(entity_risk, highest_risk_level) > 0:
                    highest_risk_level = RISK_LEVEL_MAPPING.get(entity_risk, 'medium_risk')

        # 5. GenAI detection (smart segmentation or full text)
        if genai_entity_types:
            # Decide whether to use smart segmentation
            should_segment = (
                enable_smart_segmentation and
                format_type in ['json', 'yaml', 'csv', 'markdown'] and
                len(text) > 1000  # Only segment if text is large enough
            )

            if should_segment:
                logger.info(f"Using smart segmentation for {format_type} format")
                genai_matches = await self._detect_genai_with_segmentation(
                    text, genai_entity_types, direction, format_type, format_metadata
                )
            else:
                logger.info("Using full-text GenAI detection")
                genai_matches = await self._match_pattern_genai(text, genai_entity_types, direction)

            if genai_matches:
                detected_entities.extend(genai_matches)
                for match in genai_matches:
                    detected_categories.add(match['entity_type'])

                    # Update highest risk level
                    entity_risk = match.get('risk_level', 'medium')
                    if self._compare_risk_level(entity_risk, highest_risk_level) > 0:
                        highest_risk_level = RISK_LEVEL_MAPPING.get(entity_risk, 'medium_risk')

        # 6. De-sensitization
        anonymized_text = self._anonymize_text(text, detected_entities, entity_types)

        return {
            'risk_level': highest_risk_level,
            'categories': list(detected_categories),
            'detected_entities': detected_entities,
            'anonymized_text': anonymized_text,
            'format_info': {
                'format_type': format_type,
                'metadata': format_metadata
            }
        }

    def _get_user_entity_types(self, tenant_id: str, direction: str, application_id: Optional[str] = None) -> List[Dict[str, Any]]:
        """Get tenant's sensitive data type configuration

        Note: For backward compatibility, keep function name _get_user_entity_types, parameter name tenant_id, but actually process tenant_id
        When application_id is provided, filter by application to respect application-level is_active settings.
        """
        try:
            # If application_id is provided, use application-level filtering
            if application_id:
                # Ensure application has copies of all system templates
                self.ensure_application_has_system_copies(tenant_id, application_id)

                # Get disabled entity types for this application
                disabled_entity_types = set()
                disabled_query = self.db.query(TenantEntityTypeDisable).filter(
                    and_(
                        TenantEntityTypeDisable.tenant_id == tenant_id,
                        TenantEntityTypeDisable.application_id == application_id
                    )
                )
                for disabled in disabled_query.all():
                    disabled_entity_types.add(disabled.entity_type)

                # Get only application's own entity types (both system_copy and custom)
                # Filter by application_id to respect application-level is_active settings
                query = self.db.query(DataSecurityEntityType).filter(
                    and_(
                        DataSecurityEntityType.is_active == True,
                        DataSecurityEntityType.application_id == application_id
                    )
                )
            else:
                # Fallback: use tenant-level filtering (for backward compatibility)
                # Ensure tenant has copies of all system templates
                self.ensure_tenant_has_system_copies(tenant_id)

                # Get disabled entity types for this tenant
                disabled_entity_types = set()
                disabled_query = self.db.query(TenantEntityTypeDisable).filter(
                    TenantEntityTypeDisable.tenant_id == tenant_id
                )
                for disabled in disabled_query.all():
                    disabled_entity_types.add(disabled.entity_type)

                # Get only tenant's own entity types (both system_copy and custom)
                # No longer include global templates directly
                query = self.db.query(DataSecurityEntityType).filter(
                    and_(
                        DataSecurityEntityType.is_active == True,
                        DataSecurityEntityType.tenant_id == tenant_id
                    )
                )

            entity_types_orm = query.all()
            if application_id:
                logger.info(f"Found {len(entity_types_orm)} entity types for application {application_id}")
            else:
                logger.info(f"Found {len(entity_types_orm)} entity types for tenant {tenant_id}")
            entity_types = []

            for et in entity_types_orm:
                # Skip if this entity type is disabled by the tenant
                if et.entity_type in disabled_entity_types:
                    continue

                # Check if the corresponding direction detection is enabled
                recognition_config = et.recognition_config or {}
                if direction == "input" and not recognition_config.get('check_input', True):
                    continue
                if direction == "output" and not recognition_config.get('check_output', True):
                    continue

                entity_types.append({
                    'entity_type': et.entity_type,
                    'entity_type_name': et.entity_type_name,
                    'risk_level': et.category,  # Use category field to store risk level
                    'recognition_method': et.recognition_method,
                    'pattern': recognition_config.get('pattern', ''),
                    'entity_definition': recognition_config.get('entity_definition', ''),
                    'anonymization_method': et.anonymization_method,
                    'anonymization_config': et.anonymization_config or {}
                })

            return entity_types
        except Exception as e:
            logger.error(f"Error getting entity types: {e}")
            return []

    def _match_pattern(self, text: str, entity_type: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Use regular expression to match sensitive data"""
        matches = []
        pattern = entity_type.get('pattern', '')

        if not pattern:
            return matches

        try:
            # Fix: Handle double-escaped patterns from JSON storage
            # Replace \\d with \d, \\s with \s, etc.
            if '\\\\' in pattern:
                pattern = pattern.replace('\\\\', '\\')

            regex = re.compile(pattern)
            for match in regex.finditer(text):
                matches.append({
                    'entity_type': entity_type['entity_type'],
                    'entity_type_name': entity_type['entity_type_name'],
                    'start': match.start(),
                    'end': match.end(),
                    'text': match.group(),
                    'risk_level': entity_type['risk_level'],
                    'anonymization_method': entity_type['anonymization_method'],
                    'anonymization_config': entity_type['anonymization_config']
                })
        except re.error as e:
            logger.error(f"Invalid regex pattern for {entity_type['entity_type']}: {e}")

        return matches

    async def _match_pattern_genai(
        self,
        text: str,
        entity_types: List[Dict[str, Any]],
        direction: str
    ) -> List[Dict[str, Any]]:
        """Use GenAI to identify sensitive data (extraction only, masking is done separately)

        Args:
            text: Text to analyze
            entity_types: List of GenAI entity type configs
            direction: 'input' or 'output'

        Returns:
            List of detected entities with original text and positions
        """
        if not entity_types or not text:
            return []

        matches = []

        try:
            # Process each entity type separately with simplified extraction prompts
            for et in entity_types:
                entity_name = et['entity_type_name']
                entity_definition = et.get('entity_definition', entity_name)

                # Build English extraction prompt (inspired by testdlp.py)
                system_prompt = "You are an enterprise sensitive data detection model."

                prompt = f"""Extract all instances of {entity_name} from the following text.
{entity_definition}

Requirements:
- Return JSON format
- results must be an array
- Do not modify the original text, keep it exactly as it appears
- Do not merge multiple instances

Output format:
{{
  "found": true or false,
  "results": ["instance1", "instance2"]
}}

If nothing found:
{{
  "found": false,
  "results": []
}}

Text:
{text}
"""

                # Call model API with system and user messages
                messages = [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": prompt}
                ]
                model_response = await self.model_service.check_messages(messages)

                logger.debug(f"GenAI extraction for {entity_name}: {model_response}")

                # Parse model response
                try:
                    # Extract JSON from response
                    response_text = model_response.strip()

                    # Find JSON object in response
                    start_idx = response_text.find('{')
                    end_idx = response_text.rfind('}')

                    if start_idx != -1 and end_idx != -1:
                        json_str = response_text[start_idx:end_idx+1]
                        result = json.loads(json_str)
                    else:
                        logger.warning(f"No JSON object found in GenAI response for {entity_name}: {response_text}")
                        continue

                    # Extract results
                    found = result.get('found', False)
                    results = result.get('results', [])

                    if not found or not results:
                        continue

                    # Find all occurrences of each detected instance
                    for original_text in results:
                        if not original_text:
                            continue

                        start_pos = 0
                        while True:
                            pos = text.find(original_text, start_pos)
                            if pos == -1:
                                break

                            # Add match - use entity type's configured anonymization method
                            matches.append({
                                'entity_type': et['entity_type'],
                                'entity_type_name': et['entity_type_name'],
                                'start': pos,
                                'end': pos + len(original_text),
                                'text': original_text,
                                'risk_level': et['risk_level'],
                                'anonymization_method': et.get('anonymization_method', 'genai'),
                                'anonymization_config': et.get('anonymization_config', {})
                            })

                            start_pos = pos + len(original_text)

                except json.JSONDecodeError as e:
                    logger.error(f"Failed to parse GenAI response as JSON for {entity_name}: {e}\nResponse: {model_response}")
                    continue

            logger.info(f"GenAI detected {len(matches)} sensitive entities in {direction}")

        except Exception as e:
            logger.error(f"Error in GenAI entity detection: {e}", exc_info=True)
            return []

        return matches

    async def _detect_genai_with_segmentation(
        self,
        text: str,
        entity_types: List[Dict[str, Any]],
        direction: str,
        format_type: str,
        format_metadata: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """
        Detect sensitive data using GenAI with intelligent segmentation

        Args:
            text: Full text to analyze
            entity_types: List of GenAI entity type configs
            direction: 'input' or 'output'
            format_type: Detected format type
            format_metadata: Format metadata

        Returns:
            List of detected entities with adjusted positions
        """
        try:
            # Segment content based on format
            segments = segmentation_service.segment_content(text, format_type, format_metadata)
            logger.info(f"Segmented content into {len(segments)} segments")

            # Detect each segment in parallel
            detection_tasks = [
                self._match_pattern_genai(segment.content, entity_types, direction)
                for segment in segments
            ]

            segment_results = await asyncio.gather(*detection_tasks, return_exceptions=True)

            # Merge results and adjust positions
            all_matches = []
            for segment, result in zip(segments, segment_results):
                if isinstance(result, Exception):
                    logger.error(f"Error detecting segment {segment.segment_index}: {result}")
                    continue

                if not result:
                    continue

                # Adjust match positions to original text coordinates
                for match in result:
                    adjusted_match = match.copy()
                    adjusted_match['start'] = match['start'] + segment.original_start
                    adjusted_match['end'] = match['end'] + segment.original_start
                    all_matches.append(adjusted_match)

            # Deduplicate matches (in case same entity appears in multiple segments)
            deduplicated = self._deduplicate_matches(all_matches)

            logger.info(f"Smart segmentation detected {len(deduplicated)} entities (from {len(all_matches)} total matches)")

            return deduplicated

        except Exception as e:
            logger.error(f"Error in smart segmentation detection: {e}", exc_info=True)
            # Fallback to traditional full-text detection
            logger.warning("Falling back to full-text GenAI detection")
            return await self._match_pattern_genai(text, entity_types, direction)

    def _deduplicate_matches(self, matches: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """
        Remove duplicate matches based on position and entity type

        Args:
            matches: List of detected entities

        Returns:
            Deduplicated list
        """
        if not matches:
            return []

        # Sort by start position
        sorted_matches = sorted(matches, key=lambda m: m['start'])

        # Remove exact duplicates (same start, end, entity_type)
        seen = set()
        deduplicated = []

        for match in sorted_matches:
            key = (match['start'], match['end'], match['entity_type'])
            if key not in seen:
                seen.add(key)
                deduplicated.append(match)

        return deduplicated

    def _anonymize_text(
        self,
        text: str,
        detected_entities: List[Dict[str, Any]],
        entity_types: List[Dict[str, Any]]
    ) -> str:
        """De-sensitize text"""
        if not detected_entities:
            return text

        # Remove overlapping entities where one is completely contained within another
        # Keep the longer entity (prefer mask over replace for same-length overlapping entities)
        filtered_entities = []
        for i, entity1 in enumerate(detected_entities):
            is_contained = False
            for j, entity2 in enumerate(detected_entities):
                if i != j:
                    # Check if entity1 is completely contained within entity2
                    if (entity1['start'] >= entity2['start'] and
                        entity1['end'] <= entity2['end'] and
                        len(entity1['text']) < len(entity2['text'])):
                        is_contained = True
                        break
                    # If same range, prefer mask over replace
                    elif (entity1['start'] == entity2['start'] and
                          entity1['end'] == entity2['end'] and
                          entity1.get('anonymization_method') == 'mask' and
                          entity2.get('anonymization_method') == 'replace'):
                        # entity1 (mask) should replace entity2 (replace) later
                        continue
                    elif (entity1['start'] == entity2['start'] and
                          entity1['end'] == entity2['end'] and
                          entity1.get('anonymization_method') == 'replace' and
                          entity2.get('anonymization_method') == 'mask'):
                        is_contained = True  # entity1 (replace) should be ignored in favor of entity2 (mask)
                        break
            if not is_contained:
                filtered_entities.append(entity1)

        # Sort by position in descending order, replace from back to front to avoid position offset
        # For overlapping entities with same start, longer ones first
        sorted_entities = sorted(filtered_entities, key=lambda x: (x['start'], len(x['text'])), reverse=True)

        anonymized_text = text
        for entity in sorted_entities:
            method = entity.get('anonymization_method', 'replace')
            config = entity.get('anonymization_config', {})
            original_text = entity['text']

            # Process according to de-sensitization method
            if method == 'regex_replace':
                # 正则替换脱敏 - 使用捕获组和替换模板
                pattern = config.get('regex_pattern', '')
                replacement_template = config.get('replacement_template', '***')
                try:
                    if pattern:
                        # Ensure replacement uses Python regex syntax (\1, \2)
                        python_replacement = _convert_replacement_template(replacement_template)
                        replacement = re.sub(pattern, python_replacement, original_text)
                    else:
                        replacement = '***'
                except re.error as e:
                    logger.warning(f"Regex replace error for {entity['entity_type']}: {e}")
                    replacement = f"<{entity['entity_type']}>"
            elif method == 'genai':
                # GenAI智能脱敏 - 使用AI生成替换内容
                anonymization_prompt = config.get('anonymization_prompt', '')
                if anonymization_prompt:
                    replacement = self._genai_anonymize_sync(original_text, anonymization_prompt, entity.get('entity_type_name', entity['entity_type']))
                else:
                    # 无提示词时使用默认格式
                    replacement = f"[REDACTED_{entity.get('entity_type_name', entity['entity_type']).upper().replace(' ', '_')}]"
            elif method == 'replace':
                # Replace with placeholder
                replacement = config.get('replacement', f"<{entity['entity_type']}>")
            elif method == 'mask':
                # Mask
                mask_char = config.get('mask_char', '*')
                keep_prefix = config.get('keep_prefix', 0)
                keep_suffix = config.get('keep_suffix', 0)
                replacement = self._mask_string(original_text, mask_char, keep_prefix, keep_suffix)
            elif method == 'hash':
                # Hash
                replacement = self._hash_string(original_text)
            elif method == 'encrypt':
                # Encrypt (simplified implementation, actually should use real encryption)
                replacement = f"<ENCRYPTED_{hashlib.md5(original_text.encode()).hexdigest()[:8]}>"
            elif method == 'shuffle':
                # Shuffle
                replacement = self._shuffle_string(original_text)
            elif method == 'random':
                # Random replace
                replacement = self._random_replacement(original_text)
            else:
                # Default replace
                replacement = f"<{entity['entity_type']}>"

            # Replace text
            anonymized_text = anonymized_text[:entity['start']] + replacement + anonymized_text[entity['end']:]

        return anonymized_text

    def _mask_string(self, text: str, mask_char: str = '*', keep_prefix: int = 0, keep_suffix: int = 0) -> str:
        """Mask string"""
        if len(text) <= keep_prefix + keep_suffix:
            return text

        prefix = text[:keep_prefix] if keep_prefix > 0 else ''
        suffix = text[-keep_suffix:] if keep_suffix > 0 else ''
        middle_length = len(text) - keep_prefix - keep_suffix

        return prefix + mask_char * middle_length + suffix

    def _hash_string(self, text: str) -> str:
        """Hash string"""
        return hashlib.sha256(text.encode()).hexdigest()[:16]

    def _shuffle_string(self, text: str) -> str:
        """Shuffle string"""
        chars = list(text)
        random.shuffle(chars)
        return ''.join(chars)

    def _random_replacement(self, text: str) -> str:
        """Random replace"""
        # 保持长度，随机替换字符
        replacement = ''
        for char in text:
            if char.isdigit():
                replacement += random.choice(string.digits)
            elif char.isalpha():
                if char.isupper():
                    replacement += random.choice(string.ascii_uppercase)
                else:
                    replacement += random.choice(string.ascii_lowercase)
            else:
                replacement += char
        return replacement

    def _genai_anonymize_sync(self, text: str, prompt: str, entity_type_name: str) -> str:
        """
        同步调用GenAI执行脱敏

        Args:
            text: 需要脱敏的原始文本
            prompt: 用户定义的脱敏指令
            entity_type_name: 实体类型名称

        Returns:
            脱敏后的文本
        """
        try:
            messages = [
                {
                    "role": "system",
                    "content": "You are a data anonymization assistant. Your task is to anonymize sensitive data according to the given instruction. Return ONLY the anonymized result, nothing else. Do not include any explanation or prefix."
                },
                {
                    "role": "user",
                    "content": f"Original sensitive data: {text}\nAnonymization instruction: {prompt}\n\nReturn the anonymized result only:"
                }
            ]

            # 使用事件循环运行异步方法
            try:
                loop = asyncio.get_event_loop()
                if loop.is_running():
                    # 如果已经在异步上下文中，创建一个新任务
                    import concurrent.futures
                    with concurrent.futures.ThreadPoolExecutor() as executor:
                        future = executor.submit(asyncio.run, self.model_service.check_messages(messages))
                        result = future.result(timeout=30)
                else:
                    result = loop.run_until_complete(self.model_service.check_messages(messages))
            except RuntimeError:
                # 没有事件循环，创建一个新的
                result = asyncio.run(self.model_service.check_messages(messages))

            if result:
                # 清理结果，移除可能的引号和空白
                cleaned_result = result.strip().strip('"\'')
                return cleaned_result if cleaned_result else f"[REDACTED_{entity_type_name.upper().replace(' ', '_')}]"

            return f"[REDACTED_{entity_type_name.upper().replace(' ', '_')}]"

        except Exception as e:
            logger.error(f"GenAI anonymization failed for {entity_type_name}: {e}")
            return f"[REDACTED_{entity_type_name.upper().replace(' ', '_')}]"

    async def generate_anonymization_regex(self, description: str, entity_type: str, sample_data: str = None) -> dict:
        """
        使用AI生成脱敏正则表达式

        Args:
            description: 用户对脱敏规则的自然语言描述
            entity_type: 实体类型
            sample_data: 可选的示例数据

        Returns:
            包含regex_pattern, replacement_template, explanation的字典
        """
        prompt = f"""Generate a regex pattern and replacement template for data anonymization.

Entity type: {entity_type}
Anonymization requirement: {description}
{f'Sample data: {sample_data}' if sample_data else ''}

Requirements:
1. The regex pattern should use capture groups (e.g., (\\d{{3}}) ) to preserve parts of the data
2. The replacement template MUST use Python regex syntax: \\1, \\2, etc. to reference capture groups (NOT $1, $2)
3. Use * for masked characters
4. Make sure the regex pattern matches the entire text

Examples:
- "Keep first 3 and last 4 digits of phone number" → pattern: (\\d{{3}})\\d{{4}}(\\d{{4}}), replacement: \\1****\\2
- "Mask email before @" → pattern: [^@]+(@.+), replacement: ****\\1
- "Replace each digit group in IP with ***" → pattern: \\d+, replacement: ***
- "Keep first 2 characters of name" → pattern: (.{{2}}).*, replacement: \\1***

Return JSON only, no markdown:
{{"regex_pattern": "your_pattern_here", "replacement_template": "your_replacement_here", "explanation": "brief_explanation"}}"""

        try:
            messages = [
                {"role": "system", "content": "You are a regex expert. Return valid JSON only, no markdown code blocks."},
                {"role": "user", "content": prompt}
            ]

            result = await self.model_service.check_messages(messages)

            if result:
                # 尝试解析JSON
                try:
                    # 清理可能的markdown代码块
                    cleaned = result.strip()
                    if cleaned.startswith('```'):
                        cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
                    if cleaned.endswith('```'):
                        cleaned = cleaned[:-3]
                    cleaned = cleaned.strip()

                    parsed = json.loads(cleaned)
                    return {
                        "success": True,
                        "regex_pattern": parsed.get("regex_pattern", ""),
                        "replacement_template": parsed.get("replacement_template", "***"),
                        "explanation": parsed.get("explanation", "")
                    }
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse AI response as JSON: {e}, response: {result}")
                    return {
                        "success": False,
                        "regex_pattern": "",
                        "replacement_template": "***",
                        "explanation": f"Failed to generate regex: {str(e)}"
                    }

            return {
                "success": False,
                "regex_pattern": "",
                "replacement_template": "***",
                "explanation": "No response from AI model"
            }

        except Exception as e:
            logger.error(f"Generate anonymization regex failed: {e}")
            return {
                "success": False,
                "regex_pattern": "",
                "replacement_template": "***",
                "explanation": f"Error: {str(e)}"
            }

    async def generate_recognition_regex(self, description: str, entity_type: str, sample_data: str = None) -> dict:
        """
        使用AI生成识别用的正则表达式

        Args:
            description: 用户对要识别数据的自然语言描述
            entity_type: 实体类型名称
            sample_data: 可选的示例数据

        Returns:
            包含regex_pattern和explanation的字典
        """
        prompt = f"""Generate a regex pattern to recognize/detect a specific type of sensitive data.

Entity type: {entity_type}
Description of what to detect: {description}
{f'Sample data that should match: {sample_data}' if sample_data else ''}

Requirements:
1. The regex pattern should accurately match the described data type
2. Be specific enough to avoid false positives
3. Be flexible enough to match common variations
4. Use appropriate character classes and quantifiers

Examples:
- "Chinese phone number" → pattern: 1[3-9]\\d{{9}}
- "Email address" → pattern: [a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{{2,}}
- "Chinese ID card number" → pattern: [1-9]\\d{{5}}(?:19|20)\\d{{2}}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\\d|3[01])\\d{{3}}[\\dXx]
- "IPv4 address" → pattern: (?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)\\.(?:25[0-5]|2[0-4]\\d|[01]?\\d\\d?)
- "Credit card number (16 digits)" → pattern: \\d{{4}}[- ]?\\d{{4}}[- ]?\\d{{4}}[- ]?\\d{{4}}

Return JSON only, no markdown:
{{"regex_pattern": "your_pattern_here", "explanation": "brief_explanation_of_what_this_pattern_matches"}}"""

        try:
            messages = [
                {"role": "system", "content": "You are a regex expert specializing in data recognition patterns. Return valid JSON only, no markdown code blocks."},
                {"role": "user", "content": prompt}
            ]

            result = await self.model_service.check_messages(messages)

            if result:
                try:
                    # 清理可能的markdown代码块
                    cleaned = result.strip()
                    if cleaned.startswith('```'):
                        cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
                    if cleaned.endswith('```'):
                        cleaned = cleaned[:-3]
                    cleaned = cleaned.strip()

                    parsed = json.loads(cleaned)
                    return {
                        "success": True,
                        "regex_pattern": parsed.get("regex_pattern", ""),
                        "explanation": parsed.get("explanation", "")
                    }
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse AI response as JSON: {e}, response: {result}")
                    return {
                        "success": False,
                        "regex_pattern": "",
                        "explanation": f"Failed to generate regex: {str(e)}"
                    }

            return {
                "success": False,
                "regex_pattern": "",
                "explanation": "No response from AI model"
            }

        except Exception as e:
            logger.error(f"Generate recognition regex failed: {e}")
            return {
                "success": False,
                "regex_pattern": "",
                "explanation": f"Error: {str(e)}"
            }

    async def generate_entity_type_code(self, entity_type_name: str) -> dict:
        """
        使用AI根据实体类型名称生成实体类型代码

        Args:
            entity_type_name: 实体类型名称（可以是中文或英文）

        Returns:
            包含entity_type_code的字典
        """
        prompt = f"""Generate an entity type code based on the given entity type name.

Entity type name: {entity_type_name}

Requirements:
1. The code must only contain UPPERCASE English letters and underscores
2. The code should be a meaningful English abbreviation or translation of the name
3. Use underscores to separate words
4. Keep it concise but clear (typically 2-4 words)
5. No spaces, numbers, or special characters allowed

Examples:
- "手机号码" → PHONE_NUMBER
- "身份证号" → ID_CARD_NUMBER
- "邮箱地址" → EMAIL_ADDRESS
- "银行卡号" → BANK_CARD_NUMBER
- "家庭住址" → HOME_ADDRESS
- "公司名称" → COMPANY_NAME
- "信用卡" → CREDIT_CARD
- "护照号" → PASSPORT_NUMBER
- "IP地址" → IP_ADDRESS
- "车牌号" → LICENSE_PLATE

Return JSON only, no markdown:
{{"entity_type_code": "YOUR_CODE_HERE"}}"""

        try:
            messages = [
                {"role": "system", "content": "You are an expert at generating standardized entity type codes. Return valid JSON only, no markdown code blocks."},
                {"role": "user", "content": prompt}
            ]

            result = await self.model_service.check_messages(messages)

            if result:
                try:
                    # 清理可能的markdown代码块
                    cleaned = result.strip()
                    if cleaned.startswith('```'):
                        cleaned = cleaned.split('\n', 1)[1] if '\n' in cleaned else cleaned[3:]
                    if cleaned.endswith('```'):
                        cleaned = cleaned[:-3]
                    cleaned = cleaned.strip()

                    parsed = json.loads(cleaned)
                    code = parsed.get("entity_type_code", "")

                    # 验证生成的代码格式
                    if code and re.match(r'^[A-Z][A-Z_]*[A-Z]$|^[A-Z]+$', code):
                        return {
                            "success": True,
                            "entity_type_code": code
                        }
                    else:
                        # 如果格式不对，尝试修正
                        fixed_code = re.sub(r'[^A-Z_]', '', code.upper().replace(' ', '_'))
                        fixed_code = re.sub(r'_+', '_', fixed_code).strip('_')
                        if fixed_code:
                            return {
                                "success": True,
                                "entity_type_code": fixed_code
                            }
                        return {
                            "success": False,
                            "entity_type_code": "",
                            "error": "Generated code format is invalid"
                        }
                except json.JSONDecodeError as e:
                    logger.warning(f"Failed to parse AI response as JSON: {e}, response: {result}")
                    return {
                        "success": False,
                        "entity_type_code": "",
                        "error": f"Failed to parse response: {str(e)}"
                    }

            return {
                "success": False,
                "entity_type_code": "",
                "error": "No response from AI model"
            }

        except Exception as e:
            logger.error(f"Generate entity type code failed: {e}")
            return {
                "success": False,
                "entity_type_code": "",
                "error": f"Error: {str(e)}"
            }

    async def test_entity_definition(self, entity_definition: str, entity_type_name: str, test_input: str) -> dict:
        """
        测试GenAI实体定义是否能识别输入中的敏感数据

        Args:
            entity_definition: 实体定义描述
            entity_type_name: 实体类型名称
            test_input: 测试输入

        Returns:
            包含匹配结果的字典
        """
        import time
        start_time = time.time()

        try:
            if not entity_definition:
                return {
                    "success": False,
                    "matched": False,
                    "matches": [],
                    "error": "Entity definition is empty",
                    "processing_time_ms": (time.time() - start_time) * 1000
                }

            if not test_input:
                return {
                    "success": False,
                    "matched": False,
                    "matches": [],
                    "error": "Test input is empty",
                    "processing_time_ms": (time.time() - start_time) * 1000
                }

            # Build entity type config for GenAI detection
            entity_types = [{
                'entity_type': 'TEST_ENTITY',
                'entity_type_name': entity_type_name or 'Test Entity',
                'risk_level': 'medium',
                'entity_definition': entity_definition,
                'recognition_method': 'genai',
                'anonymization_method': 'genai',
                'anonymization_config': {}
            }]

            # Call GenAI detection
            matches = await self._match_pattern_genai(test_input, entity_types, 'input')

            # Extract matched texts
            matched_texts = [m['text'] for m in matches]

            return {
                "success": True,
                "matched": len(matched_texts) > 0,
                "matches": matched_texts,
                "match_count": len(matched_texts),
                "processing_time_ms": (time.time() - start_time) * 1000
            }

        except Exception as e:
            logger.error(f"Test entity definition failed: {e}")
            return {
                "success": False,
                "matched": False,
                "matches": [],
                "error": f"Error: {str(e)}",
                "processing_time_ms": (time.time() - start_time) * 1000
            }

    def test_recognition_regex(self, pattern: str, test_input: str) -> dict:
        """
        测试识别正则表达式是否能匹配输入

        Args:
            pattern: 正则表达式
            test_input: 测试输入

        Returns:
            包含匹配结果的字典
        """
        import time
        start_time = time.time()

        try:
            if not pattern:
                return {
                    "success": False,
                    "matched": False,
                    "matches": [],
                    "error": "Pattern is empty",
                    "processing_time_ms": (time.time() - start_time) * 1000
                }

            regex = re.compile(pattern)
            matches = regex.findall(test_input)

            # 如果 findall 返回元组（有捕获组），展开它们
            if matches and isinstance(matches[0], tuple):
                # 对于有捕获组的情况，使用 finditer 获取完整匹配
                matches = [m.group(0) for m in regex.finditer(test_input)]

            return {
                "success": True,
                "matched": len(matches) > 0,
                "matches": matches,
                "match_count": len(matches),
                "processing_time_ms": (time.time() - start_time) * 1000
            }

        except re.error as e:
            return {
                "success": False,
                "matched": False,
                "matches": [],
                "error": f"Invalid regex pattern: {str(e)}",
                "processing_time_ms": (time.time() - start_time) * 1000
            }
        except Exception as e:
            return {
                "success": False,
                "matched": False,
                "matches": [],
                "error": f"Error: {str(e)}",
                "processing_time_ms": (time.time() - start_time) * 1000
            }

    def test_anonymization(self, method: str, config: dict, test_input: str) -> dict:
        """
        测试脱敏效果

        Args:
            method: 脱敏方法
            config: 脱敏配置
            test_input: 测试输入

        Returns:
            包含result和processing_time_ms的字典
        """
        import time
        start_time = time.time()

        try:
            if method == 'regex_replace':
                pattern = config.get('regex_pattern', '')
                replacement_template = config.get('replacement_template', '***')
                try:
                    if pattern:
                        # Ensure replacement uses Python regex syntax (\1, \2)
                        python_replacement = _convert_replacement_template(replacement_template)
                        result = re.sub(pattern, python_replacement, test_input)
                    else:
                        result = '***'
                except re.error as e:
                    return {
                        "success": False,
                        "result": f"Regex error: {str(e)}",
                        "processing_time_ms": (time.time() - start_time) * 1000
                    }
            elif method == 'genai':
                anonymization_prompt = config.get('anonymization_prompt', '')
                if anonymization_prompt:
                    result = self._genai_anonymize_sync(test_input, anonymization_prompt, 'TEST_ENTITY')
                else:
                    result = '[REDACTED_TEST_ENTITY]'
            elif method == 'mask':
                mask_char = config.get('mask_char', '*')
                keep_prefix = config.get('keep_prefix', 0)
                keep_suffix = config.get('keep_suffix', 0)
                result = self._mask_string(test_input, mask_char, keep_prefix, keep_suffix)
            elif method == 'replace':
                result = config.get('replacement', '<PLACEHOLDER>')
            elif method == 'hash':
                result = self._hash_string(test_input)
            elif method == 'encrypt':
                result = f"<ENCRYPTED_{hashlib.md5(test_input.encode()).hexdigest()[:8]}>"
            elif method == 'shuffle':
                result = self._shuffle_string(test_input)
            elif method == 'random':
                result = self._random_replacement(test_input)
            else:
                result = f"<{method.upper()}>"

            processing_time_ms = (time.time() - start_time) * 1000

            return {
                "success": True,
                "result": result,
                "processing_time_ms": round(processing_time_ms, 2)
            }

        except Exception as e:
            logger.error(f"Test anonymization failed: {e}")
            return {
                "success": False,
                "result": f"Error: {str(e)}",
                "processing_time_ms": (time.time() - start_time) * 1000
            }

    def _compare_risk_level(self, level1: str, level2: str) -> int:
        """Compare risk level, return 1 if level1 > level2, -1 if level1 < level2, 0 if equal"""
        risk_order = {'no_risk': 0, 'low': 1, 'low_risk': 1, 'medium': 2, 'medium_risk': 2, 'high': 3, 'high_risk': 3}
        score1 = risk_order.get(level1, 0)
        score2 = risk_order.get(level2, 0)

        if score1 > score2:
            return 1
        elif score1 < score2:
            return -1
        else:
            return 0

    def create_entity_type(
        self,
        tenant_id: str,
        application_id: Optional[str] = None,
        entity_type: str = None,
        entity_type_name: str = None,
        risk_level: str = None,
        pattern: str = None,
        entity_definition: str = None,
        recognition_method: str = 'regex',
        anonymization_method: str = 'replace',
        anonymization_config: Optional[Dict[str, Any]] = None,
        check_input: bool = True,
        check_output: bool = True,
        is_global: bool = False,
        source_type: str = 'custom',
        template_id: Optional[str] = None
    ) -> DataSecurityEntityType:
        """Create sensitive data type configuration

        Args:
            tenant_id: Tenant ID
            application_id: Application ID (optional, None for global templates)
            recognition_method: 'regex' or 'genai'
            pattern: Regex pattern (for regex method)
            entity_definition: Entity description (for genai method)
            source_type: 'system_template' (admin creates template), 'system_copy' (application's copy), 'custom' (user creates)
            template_id: UUID of the template if this is a copy
        """
        recognition_config = {
            'check_input': check_input,
            'check_output': check_output
        }

        # Add pattern or entity_definition based on recognition method
        if recognition_method == 'genai':
            recognition_config['entity_definition'] = entity_definition or entity_type_name
        else:
            recognition_config['pattern'] = pattern

        # For backward compatibility: is_global=True implies source_type='system_template'
        if is_global and source_type == 'custom':
            source_type = 'system_template'

        # GenAI recognition can now use any anonymization method
        # No longer force genai anonymization for genai recognition

        entity_type_obj = DataSecurityEntityType(
            tenant_id=tenant_id,
            application_id=application_id if not is_global else None,  # Global templates don't have application_id
            entity_type=entity_type,
            entity_type_name=entity_type_name,
            category=risk_level,  # Use category field to store risk level
            recognition_method=recognition_method,
            recognition_config=recognition_config,
            anonymization_method=anonymization_method,
            anonymization_config=anonymization_config or {},
            is_global=is_global,
            source_type=source_type,
            template_id=template_id
        )

        self.db.add(entity_type_obj)
        self.db.commit()
        self.db.refresh(entity_type_obj)

        return entity_type_obj

    def update_entity_type(
        self,
        entity_type_id: str,
        tenant_id: str,
        application_id: Optional[str] = None,
        **kwargs
    ) -> Optional[DataSecurityEntityType]:
        """Update sensitive data type configuration

        Args:
            entity_type_id: Entity type ID to update
            tenant_id: Tenant ID
            application_id: Application ID (optional)
        """
        # Build query conditions
        conditions = [DataSecurityEntityType.id == entity_type_id]

        # Allow access if global template or belongs to the application
        if application_id:
            conditions.append(
                (DataSecurityEntityType.application_id == application_id) |
                (DataSecurityEntityType.is_global == True)
            )
        else:
            conditions.append(DataSecurityEntityType.is_global == True)

        entity_type = self.db.query(DataSecurityEntityType).filter(and_(*conditions)).first()

        if not entity_type:
            return None

        # Update fields
        if 'entity_type_name' in kwargs:
            entity_type.entity_type_name = kwargs['entity_type_name']
        if 'risk_level' in kwargs:
            entity_type.category = kwargs['risk_level']
        
        # Update recognition_method if provided
        if 'recognition_method' in kwargs:
            entity_type.recognition_method = kwargs['recognition_method']

        # Update recognition_config fields
        recognition_config_updated = False
        if 'pattern' in kwargs or 'entity_definition' in kwargs or 'check_input' in kwargs or 'check_output' in kwargs:
            # Get current recognition_config
            recognition_config = dict(entity_type.recognition_config or {})

            if 'pattern' in kwargs:
                recognition_config['pattern'] = kwargs['pattern']
                recognition_config_updated = True
            if 'entity_definition' in kwargs:
                recognition_config['entity_definition'] = kwargs['entity_definition']
                recognition_config_updated = True
            if 'check_input' in kwargs:
                recognition_config['check_input'] = kwargs['check_input']
                recognition_config_updated = True
            if 'check_output' in kwargs:
                recognition_config['check_output'] = kwargs['check_output']
                recognition_config_updated = True

            # Force SQLAlchemy to detect the change by reassigning the entire dict
            if recognition_config_updated:
                entity_type.recognition_config = recognition_config

        # GenAI recognition can now use any anonymization method
        if 'anonymization_method' in kwargs:
            entity_type.anonymization_method = kwargs['anonymization_method']
            if 'anonymization_config' in kwargs:
                entity_type.anonymization_config = kwargs['anonymization_config']
        if 'is_active' in kwargs:
            entity_type.is_active = kwargs['is_active']

        entity_type.updated_at = datetime.utcnow()
        self.db.commit()
        self.db.refresh(entity_type)

        return entity_type

    def delete_entity_type(self, entity_type_id: str, tenant_id: str, application_id: Optional[str] = None) -> bool:
        """Delete sensitive data type configuration

        Args:
            entity_type_id: Entity type ID to delete
            tenant_id: Tenant ID
            application_id: Application ID (optional)
        """
        conditions = [DataSecurityEntityType.id == entity_type_id]

        # Only allow deletion if it belongs to the application
        if application_id:
            conditions.append(DataSecurityEntityType.application_id == application_id)
        else:
            conditions.append(DataSecurityEntityType.tenant_id == tenant_id)

        entity_type = self.db.query(DataSecurityEntityType).filter(and_(*conditions)).first()

        if not entity_type:
            return False

        self.db.delete(entity_type)
        self.db.commit()

        return True

    def get_entity_types(
        self,
        tenant_id: str,
        application_id: Optional[str] = None,
        risk_level: Optional[str] = None,
        is_active: Optional[bool] = None
    ) -> List[DataSecurityEntityType]:
        """Get sensitive data type configuration list

        This method now automatically ensures application has copies of all system templates.

        Args:
            tenant_id: Tenant ID
            application_id: Application ID (optional)
            risk_level: Filter by risk level (optional)
            is_active: Filter by active status (optional)
        """
        # Ensure application has copies of all system templates
        if application_id:
            self.ensure_application_has_system_copies(tenant_id, application_id)

            # Get application's own entity types (both system_copy and custom)
            query = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.application_id == application_id
            )
        else:
            # Fallback: get tenant's entity types (for backward compatibility)
            query = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.tenant_id == tenant_id
            )

        if risk_level:
            query = query.filter(DataSecurityEntityType.category == risk_level)
        if is_active is not None:
            query = query.filter(DataSecurityEntityType.is_active == is_active)

        return query.order_by(DataSecurityEntityType.created_at.desc()).all()

    def disable_entity_type_for_application(self, tenant_id: str, application_id: str, entity_type: str) -> bool:
        """Disable an entity type for a specific application"""
        try:
            # Check if already disabled
            existing = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if existing:
                return True  # Already disabled

            # Create disable record
            disable_record = TenantEntityTypeDisable(
                tenant_id=tenant_id,
                application_id=application_id,
                entity_type=entity_type
            )
            self.db.add(disable_record)
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error disabling entity type {entity_type} for application {application_id}: {e}")
            self.db.rollback()
            return False

    def enable_entity_type_for_application(self, tenant_id: str, application_id: str, entity_type: str) -> bool:
        """Enable an entity type for a specific application (remove disable record)"""
        try:
            disable_record = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if disable_record:
                self.db.delete(disable_record)
                self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error enabling entity type {entity_type} for application {application_id}: {e}")
            self.db.rollback()
            return False

    def get_application_disabled_entity_types(self, tenant_id: str, application_id: str) -> List[str]:
        """Get list of disabled entity types for an application"""
        try:
            disabled_records = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.application_id == application_id
                )
            ).all()
            return [record.entity_type for record in disabled_records]
        except Exception as e:
            logger.error(f"Error getting disabled entity types for application {application_id}: {e}")
            return []

    # Keep old tenant methods for backward compatibility
    def disable_entity_type_for_tenant(self, tenant_id: str, entity_type: str) -> bool:
        """Disable an entity type for a specific tenant (deprecated, use disable_entity_type_for_application)"""
        try:
            # Check if already disabled
            existing = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if existing:
                return True  # Already disabled

            # Create disable record
            disable_record = TenantEntityTypeDisable(
                tenant_id=tenant_id,
                entity_type=entity_type
            )
            self.db.add(disable_record)
            self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error disabling entity type {entity_type} for tenant {tenant_id}: {e}")
            self.db.rollback()
            return False

    def enable_entity_type_for_tenant(self, tenant_id: str, entity_type: str) -> bool:
        """Enable an entity type for a specific tenant (deprecated, use enable_entity_type_for_application)"""
        try:
            disable_record = self.db.query(TenantEntityTypeDisable).filter(
                and_(
                    TenantEntityTypeDisable.tenant_id == tenant_id,
                    TenantEntityTypeDisable.entity_type == entity_type
                )
            ).first()

            if disable_record:
                self.db.delete(disable_record)
                self.db.commit()
            return True
        except Exception as e:
            logger.error(f"Error enabling entity type {entity_type} for tenant {tenant_id}: {e}")
            self.db.rollback()
            return False

    def get_tenant_disabled_entity_types(self, tenant_id: str) -> List[str]:
        """Get list of disabled entity types for a tenant (deprecated, use get_application_disabled_entity_types)"""
        try:
            disabled_records = self.db.query(TenantEntityTypeDisable).filter(
                TenantEntityTypeDisable.tenant_id == tenant_id
            ).all()
            return [record.entity_type for record in disabled_records]
        except Exception as e:
            logger.error(f"Error getting disabled entity types for tenant {tenant_id}: {e}")
            return []
    
    def ensure_application_has_system_copies(self, tenant_id: str, application_id: str) -> int:
        """Ensure application has copies of all system templates

        This method:
        1. Finds all system templates (source_type='system_template')
        2. For each template, checks if application has a copy
        3. Creates missing copies with source_type='system_copy' and template_id set

        Returns:
            Number of copies created
        """
        try:
            # Get all system templates
            system_templates = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.source_type == 'system_template'
            ).all()

            if not system_templates:
                return 0

            # Get application's existing entity types
            application_entity_types = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.application_id == application_id
            ).all()

            # Create a set of template IDs that application already has copies of
            application_template_ids = set()
            for et in application_entity_types:
                if et.template_id:
                    application_template_ids.add(str(et.template_id))

            # Create copies for missing templates
            copies_created = 0
            for template in system_templates:
                template_id_str = str(template.id)

                # Skip if application already has a copy of this template
                if template_id_str in application_template_ids:
                    continue

                # Create a copy for this application
                recognition_config = template.recognition_config or {}
                copy = DataSecurityEntityType(
                    tenant_id=tenant_id,
                    application_id=application_id,
                    entity_type=template.entity_type,
                    entity_type_name=template.entity_type_name,
                    category=template.category,
                    recognition_method=template.recognition_method,
                    recognition_config=recognition_config.copy(),
                    anonymization_method=template.anonymization_method,
                    anonymization_config=(template.anonymization_config or {}).copy(),
                    is_active=template.is_active,
                    is_global=False,  # Copies are not global
                    source_type='system_copy',
                    template_id=template.id
                )

                self.db.add(copy)
                copies_created += 1
                logger.info(f"Created system copy of '{template.entity_type}' for application {application_id}")

            if copies_created > 0:
                self.db.commit()
                logger.info(f"Created {copies_created} system entity type copies for application {application_id}")

            return copies_created

        except Exception as e:
            logger.error(f"Error ensuring application {application_id} has system copies: {e}")
            self.db.rollback()
            return 0

    def ensure_tenant_has_system_copies(self, tenant_id: str) -> int:
        """Ensure tenant has copies of all system templates (deprecated, use ensure_application_has_system_copies)

        This method:
        1. Finds all system templates (source_type='system_template')
        2. For each template, checks if tenant has a copy
        3. Creates missing copies with source_type='system_copy' and template_id set

        Returns:
            Number of copies created
        """
        try:
            # Get all system templates
            system_templates = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.source_type == 'system_template'
            ).all()

            if not system_templates:
                return 0

            # Get tenant's existing entity types
            tenant_entity_types = self.db.query(DataSecurityEntityType).filter(
                DataSecurityEntityType.tenant_id == tenant_id
            ).all()

            # Create a set of template IDs that tenant already has copies of
            tenant_template_ids = set()
            for et in tenant_entity_types:
                if et.template_id:
                    tenant_template_ids.add(str(et.template_id))

            # Create copies for missing templates
            copies_created = 0
            for template in system_templates:
                template_id_str = str(template.id)

                # Skip if tenant already has a copy of this template
                if template_id_str in tenant_template_ids:
                    continue

                # Create a copy for this tenant
                recognition_config = template.recognition_config or {}
                copy = DataSecurityEntityType(
                    tenant_id=tenant_id,
                    entity_type=template.entity_type,
                    entity_type_name=template.entity_type_name,
                    category=template.category,
                    recognition_method=template.recognition_method,
                    recognition_config=recognition_config.copy(),
                    anonymization_method=template.anonymization_method,
                    anonymization_config=(template.anonymization_config or {}).copy(),
                    is_active=template.is_active,
                    is_global=False,  # Copies are not global
                    source_type='system_copy',
                    template_id=template.id
                )

                self.db.add(copy)
                copies_created += 1
                logger.info(f"Created system copy of '{template.entity_type}' for tenant {tenant_id}")

            if copies_created > 0:
                self.db.commit()
                logger.info(f"Created {copies_created} system entity type copies for tenant {tenant_id}")

            return copies_created

        except Exception as e:
            logger.error(f"Error ensuring tenant {tenant_id} has system copies: {e}")
            self.db.rollback()
            return 0


def get_default_entity_types_config() -> List[Dict[str, Any]]:
    """Get default entity types configuration (used for global initialization)"""
    return [
        {
            'entity_type': 'ID_CARD_NUMBER_SYS',
            'entity_type_name': 'ID Card Number',
            'risk_level': 'high',
            'pattern': r'[1-8]\d{5}(19|20)\d{2}((0[1-9])|(1[0-2]))((0[1-9])|([12]\d)|(3[01]))\d{3}[\dxX]',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 3, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'PHONE_NUMBER_SYS',
            'entity_type_name': 'Phone Number',
            'risk_level': 'medium',
            'pattern': r'1[3-9]\d{9}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 3, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'EMAIL_SYS',
            'entity_type_name': 'Email',
            'risk_level': 'low',
            'pattern': r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 2, 'keep_suffix': 0},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'BANK_CARD_NUMBER_SYS',
            'entity_type_name': 'Bank Card Number',
            'risk_level': 'high',
            'pattern': r'\d{16,19}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 4, 'keep_suffix': 4},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'PASSPORT_NUMBER_SYS',
            'entity_type_name': 'Passport Number',
            'risk_level': 'high',
            'pattern': r'[EGP]\d{8}',
            'anonymization_method': 'mask',
            'anonymization_config': {'mask_char': '*', 'keep_prefix': 1, 'keep_suffix': 2},
            'check_input': True,
            'check_output': True
        },
        {
            'entity_type': 'IP_ADDRESS_SYS',
            'entity_type_name': 'IP Address',
            'risk_level': 'low',
            'pattern': r'(?:\d{1,3}\.){3}\d{1,3}',
            'anonymization_method': 'replace',
            'anonymization_config': {'replacement': '<IP_ADDRESS>'},
            'check_input': True,
            'check_output': True
        }
    ]


def create_global_entity_types(db: Session, admin_tenant_id: str) -> int:
    """Create system template entity type configurations (called during system initialization)

    Args:
        db: Database session
        admin_tenant_id: Super admin tenant ID (used as creator of templates)

    Returns:
        Number of entity types created
    """
    service = DataSecurityService(db)
    default_entity_types = get_default_entity_types_config()

    created_count = 0
    for entity_data in default_entity_types:
        try:
            # Check if system template already exists
            existing = db.query(DataSecurityEntityType).filter(
                and_(
                    DataSecurityEntityType.entity_type == entity_data['entity_type'],
                    DataSecurityEntityType.source_type == 'system_template'
                )
            ).first()

            if not existing:
                service.create_entity_type(
                    tenant_id=admin_tenant_id,
                    entity_type=entity_data['entity_type'],
                    entity_type_name=entity_data['entity_type_name'],
                    risk_level=entity_data['risk_level'],
                    pattern=entity_data['pattern'],
                    anonymization_method=entity_data['anonymization_method'],
                    anonymization_config=entity_data['anonymization_config'],
                    check_input=entity_data['check_input'],
                    check_output=entity_data['check_output'],
                    is_global=True,  # Keep for backward compatibility
                    source_type='system_template'
                )
                created_count += 1
                logger.info(f"Created system template entity type: {entity_data['entity_type']}")
        except Exception as e:
            logger.error(f"Failed to create system template entity type {entity_data['entity_type']}: {e}")

    return created_count


def create_user_default_entity_types(db: Session, tenant_id: str) -> int:
    """Create default entity type configuration for new tenant (DEPRECATED)

    This function is now deprecated and does nothing. Global entity types are created
    during system initialization via migration. This function is kept for backward
    compatibility but no longer creates any entity types.

    Note: For backward compatibility, keep function name create_user_default_entity_types, parameter name tenant_id, but actually process tenant_id
    """
    # No longer create entity types for individual users
    # Global entity types should already exist from system initialization
    logger.info(f"Skipping entity type creation for tenant {tenant_id} - using global defaults")
    return 0

