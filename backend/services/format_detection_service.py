"""
Format Detection Service

Detects content format (JSON, YAML, CSV, Markdown, Plain Text) and extracts
structural metadata to optimize data leakage detection.
"""

import json
import re
import csv
from typing import Dict, Any, Tuple, List, Set
from io import StringIO


class FormatDetectionService:
    """Service for detecting content format and extracting structural metadata"""

    # Sensitive key patterns (common field names that often contain sensitive data)
    SENSITIVE_KEY_PATTERNS = {
        # Personal Information
        'ssn', 'social_security', 'social_security_number',
        'id_card', 'idcard', 'identity', 'passport',
        'phone', 'telephone', 'mobile', 'cell',
        'email', 'e-mail', 'mail',
        'address', 'home_address', 'residence',
        'birth', 'birthday', 'birthdate', 'dob', 'date_of_birth',

        # Financial Information
        'credit_card', 'creditcard', 'card_number', 'card_num',
        'bank_account', 'account_number', 'routing_number',
        'cvv', 'cvc', 'security_code',
        'salary', 'income', 'balance', 'payment',

        # Authentication & Security
        'password', 'passwd', 'pwd', 'pass',
        'secret', 'token', 'api_key', 'apikey', 'access_key',
        'private_key', 'privatekey', 'credential', 'auth',

        # Health Information
        'medical', 'health', 'diagnosis', 'prescription',
        'blood_type', 'insurance', 'patient',

        # Other Sensitive
        'tax', 'license', 'driver_license', 'national_id',
    }

    def detect_format(self, text: str) -> Tuple[str, Dict[str, Any]]:
        """
        Detect content format and extract metadata

        Args:
            text: Content to analyze

        Returns:
            Tuple of (format_type, metadata)
            - format_type: 'json' | 'yaml' | 'csv' | 'markdown' | 'plain_text'
            - metadata: Format-specific structural information
        """
        if not text or not text.strip():
            return 'plain_text', {}

        text = text.strip()

        # Try JSON first (most structured)
        json_result = self._try_parse_json(text)
        if json_result:
            return 'json', json_result

        # Try YAML
        yaml_result = self._try_parse_yaml(text)
        if yaml_result:
            return 'yaml', yaml_result

        # Try CSV
        csv_result = self._try_parse_csv(text)
        if csv_result:
            return 'csv', csv_result

        # Try Markdown
        markdown_result = self._try_parse_markdown(text)
        if markdown_result:
            return 'markdown', markdown_result

        # Default to plain text
        return 'plain_text', {'line_count': len(text.split('\n'))}

    def _try_parse_json(self, text: str) -> Dict[str, Any]:
        """Try to parse as JSON and extract schema"""
        try:
            data = json.loads(text)
            return self._analyze_json_schema(data)
        except (json.JSONDecodeError, ValueError):
            return None

    def _try_parse_yaml(self, text: str) -> Dict[str, Any]:
        """Try to parse as YAML and extract schema"""
        try:
            import yaml
            data = yaml.safe_load(text)
            if data is None:
                return None
            # YAML structure is similar to JSON after parsing
            return self._analyze_json_schema(data, format_type='yaml')
        except:
            return None

    def _try_parse_csv(self, text: str) -> Dict[str, Any]:
        """Try to parse as CSV and extract column information"""
        try:
            lines = text.strip().split('\n')
            if len(lines) < 2:  # Need at least header + 1 data row
                return None

            # Try to parse with csv module
            reader = csv.reader(StringIO(text))
            rows = list(reader)

            if len(rows) < 2:
                return None

            headers = rows[0]

            # Check if it looks like CSV (consistent column count)
            column_counts = [len(row) for row in rows]
            if len(set(column_counts)) > 2:  # Too much variation
                return None

            # Analyze headers for sensitive fields
            sensitive_columns = []
            for i, header in enumerate(headers):
                if self._is_potentially_sensitive_key(header):
                    sensitive_columns.append({
                        'index': i,
                        'name': header
                    })

            return {
                'type': 'csv',
                'row_count': len(rows) - 1,  # Exclude header
                'column_count': len(headers),
                'headers': headers,
                'sensitive_columns': sensitive_columns,
                'has_sensitive_fields': len(sensitive_columns) > 0
            }
        except:
            return None

    def _try_parse_markdown(self, text: str) -> Dict[str, Any]:
        """Try to parse as Markdown and extract structure"""
        lines = text.split('\n')

        # Look for markdown headers
        header_pattern = re.compile(r'^(#{1,6})\s+(.+)$')
        headers = []

        for i, line in enumerate(lines):
            match = header_pattern.match(line.strip())
            if match:
                level = len(match.group(1))
                title = match.group(2).strip()
                headers.append({
                    'level': level,
                    'title': title,
                    'line': i
                })

        # Only consider it markdown if we have headers or other markdown syntax
        has_markdown_syntax = (
            len(headers) > 0 or
            '```' in text or  # Code blocks
            re.search(r'\[.+\]\(.+\)', text) or  # Links
            re.search(r'^\s*[-*+]\s', text, re.MULTILINE) or  # Lists
            re.search(r'^\s*\d+\.\s', text, re.MULTILINE)  # Numbered lists
        )

        if not has_markdown_syntax:
            return None

        return {
            'type': 'markdown',
            'header_count': len(headers),
            'headers': headers,
            'max_header_level': max([h['level'] for h in headers]) if headers else 0,
            'has_code_blocks': '```' in text
        }

    def _analyze_json_schema(self, data: Any, format_type: str = 'json', path: str = '') -> Dict[str, Any]:
        """
        Recursively analyze JSON/YAML structure and identify sensitive fields

        Args:
            data: Parsed JSON/YAML data
            format_type: 'json' or 'yaml'
            path: Current path in the structure (for nested objects)
        """
        if isinstance(data, dict):
            keys_info = {}
            sensitive_paths = []

            for key, value in data.items():
                current_path = f"{path}.{key}" if path else key
                is_sensitive = self._is_potentially_sensitive_key(key)

                if is_sensitive:
                    sensitive_paths.append(current_path)

                # Recursively analyze nested structures
                if isinstance(value, (dict, list)):
                    nested_analysis = self._analyze_json_schema(value, format_type, current_path)
                    keys_info[key] = {
                        'is_sensitive': is_sensitive,
                        'type': 'object' if isinstance(value, dict) else 'array',
                        'nested': nested_analysis
                    }
                    # Collect nested sensitive paths
                    if 'sensitive_paths' in nested_analysis:
                        sensitive_paths.extend(nested_analysis['sensitive_paths'])
                else:
                    keys_info[key] = {
                        'is_sensitive': is_sensitive,
                        'type': type(value).__name__,
                        'value_length': len(str(value)) if value is not None else 0
                    }

            return {
                'type': format_type,
                'structure': 'object',
                'key_count': len(keys_info),
                'keys': keys_info,
                'sensitive_paths': sensitive_paths,
                'has_sensitive_fields': len(sensitive_paths) > 0
            }

        elif isinstance(data, list):
            if not data:
                return {
                    'type': format_type,
                    'structure': 'array',
                    'element_count': 0,
                    'sensitive_paths': []
                }

            # Analyze first element to understand array structure
            first_element = data[0]
            element_analysis = self._analyze_json_schema(first_element, format_type, path)

            return {
                'type': format_type,
                'structure': 'array',
                'element_count': len(data),
                'element_type': type(first_element).__name__,
                'element_structure': element_analysis if isinstance(first_element, (dict, list)) else None,
                'sensitive_paths': element_analysis.get('sensitive_paths', []) if isinstance(first_element, dict) else []
            }

        else:
            return {
                'type': format_type,
                'structure': 'primitive',
                'value_type': type(data).__name__
            }

    def _is_potentially_sensitive_key(self, key: str) -> bool:
        """
        Check if a key name suggests it contains sensitive data

        Args:
            key: Field/column name

        Returns:
            True if key matches sensitive patterns
        """
        if not key:
            return False

        # Normalize: lowercase, remove underscores/dashes
        normalized = key.lower().replace('_', '').replace('-', '').replace(' ', '')

        # Check against sensitive patterns
        for pattern in self.SENSITIVE_KEY_PATTERNS:
            pattern_normalized = pattern.replace('_', '')
            if pattern_normalized in normalized:
                return True

        return False

    def get_sensitive_field_paths(self, metadata: Dict[str, Any]) -> List[str]:
        """
        Extract all sensitive field paths from metadata

        Args:
            metadata: Format metadata from detect_format()

        Returns:
            List of sensitive field paths (e.g., ['user.ssn', 'contact.phone'])
        """
        return metadata.get('sensitive_paths', [])

    def should_focus_on_fields(self, metadata: Dict[str, Any]) -> bool:
        """
        Determine if we should focus detection on specific fields rather than full text

        Args:
            metadata: Format metadata

        Returns:
            True if format has identifiable sensitive fields
        """
        return metadata.get('has_sensitive_fields', False)


# Singleton instance
format_detection_service = FormatDetectionService()
