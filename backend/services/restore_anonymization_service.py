"""
Restore Anonymization Service

This service handles the "Anonymize + Restore" (脱敏+还原) functionality,
which allows sensitive data to be replaced with numbered placeholders
and later restored from the LLM response.

Key features:
1. AI-generated anonymization code based on natural language descriptions
2. Secure sandboxed code execution
3. Placeholder mapping management
4. Streaming restore with sliding window buffer
"""

import re
import hashlib
import logging
import asyncio
from typing import Dict, List, Tuple, Optional, Any
from concurrent.futures import ThreadPoolExecutor
import signal

from config import settings
from services.model_service import ModelService

logger = logging.getLogger(__name__)

# Thread pool for running sandboxed code execution
_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="restore_anon_")


class CodeGenerationError(Exception):
    """Raised when AI fails to generate valid code."""
    pass


class CodeExecutionError(Exception):
    """Raised when sandboxed code execution fails."""
    pass


class RestoreAnonymizationService:
    """
    Service for restore-enabled anonymization operations.

    This service handles:
    1. Generating anonymization code from natural language descriptions
    2. Executing anonymization code safely in a sandbox
    3. Managing placeholder mappings
    4. Restoring placeholders in output text
    """

    def __init__(self):
        self.model_service = ModelService()

    async def generate_restore_code(
        self,
        entity_type_code: str,
        entity_type_name: str,
        natural_description: str,
        sample_data: str = None
    ) -> Dict[str, Any]:
        """
        Generate Python anonymization code using AI based on natural language description.

        Args:
            entity_type_code: Entity type code (e.g., "EMAIL", "PHONE_NUMBER")
            entity_type_name: Display name (e.g., "Email Address", "Phone Number")
            natural_description: Natural language description of what to anonymize
            sample_data: Optional sample data for context

        Returns:
            Dict containing:
                - code: The generated Python code
                - code_hash: SHA-256 hash for integrity verification
                - placeholder_format: Example placeholder format
        """
        prompt = self._build_code_generation_prompt(
            entity_type_code, entity_type_name, natural_description, sample_data
        )

        try:
            messages = [
                {"role": "system", "content": "You are a Python code generator specialized in data anonymization. Generate only valid Python code, no explanations."},
                {"role": "user", "content": prompt}
            ]

            response = await self.model_service.check_messages(messages)
            code = self._parse_code_response(response)

            # Validate the code is safe
            if not self._validate_code_safety(code):
                raise CodeGenerationError("Generated code contains unsafe operations")

            code_hash = hashlib.sha256(code.encode()).hexdigest()

            return {
                "code": code,
                "code_hash": code_hash,
                "placeholder_format": f"[{entity_type_code.lower()}_N]"
            }

        except Exception as e:
            logger.error(f"Failed to generate restore code: {e}")
            raise CodeGenerationError(f"Code generation failed: {str(e)}")

    def execute_restore_anonymization(
        self,
        text: str,
        entity_type_code: str,
        restore_code: str,
        restore_code_hash: str,
        existing_mapping: Dict[str, str] = None,
        existing_counters: Dict[str, int] = None
    ) -> Tuple[str, Dict[str, str], Dict[str, int]]:
        """
        Execute the stored anonymization code to replace sensitive data with placeholders.

        Args:
            text: Input text to anonymize
            entity_type_code: Entity type code for placeholder naming
            restore_code: AI-generated Python code
            restore_code_hash: Expected hash for code integrity verification
            existing_mapping: Existing placeholder mapping to continue from
            existing_counters: Existing entity counters

        Returns:
            Tuple of (anonymized_text, new_mapping, updated_counters)
        """
        # Verify code integrity
        actual_hash = hashlib.sha256(restore_code.encode()).hexdigest()
        if actual_hash != restore_code_hash:
            raise CodeExecutionError("Code integrity check failed - hash mismatch")

        # Validate code safety before execution
        if not self._validate_code_safety(restore_code):
            raise CodeExecutionError("Code contains unsafe operations")

        # Execute in sandbox
        result = self._safe_execute(
            restore_code,
            text,
            entity_type_code,
            existing_mapping or {},
            existing_counters or {}
        )

        return (
            result['anonymized_text'],
            result['mapping'],
            result['counters']
        )

    def test_restore_anonymization(
        self,
        text: str,
        entity_type_code: str,
        restore_code: str
    ) -> Dict[str, Any]:
        """
        Test anonymization code with sample input.

        Args:
            text: Test input text
            entity_type_code: Entity type code
            restore_code: Code to test

        Returns:
            Dict containing test results
        """
        if not self._validate_code_safety(restore_code):
            return {
                "success": False,
                "error": "Code contains unsafe operations"
            }

        try:
            result = self._safe_execute(
                restore_code,
                text,
                entity_type_code,
                {},
                {}
            )

            return {
                "success": True,
                "anonymized_text": result['anonymized_text'],
                "mapping": result['mapping'],
                "placeholder_count": len(result['mapping'])
            }

        except Exception as e:
            return {
                "success": False,
                "error": str(e)
            }

    @staticmethod
    def restore_text(
        anonymized_text: str,
        mapping: Dict[str, str]
    ) -> str:
        """
        Restore placeholders in text to original values.

        Args:
            anonymized_text: Text containing placeholders like [email_1]
            mapping: Dict mapping placeholders to original values

        Returns:
            Text with placeholders restored to original values
        """
        if not mapping:
            return anonymized_text

        result = anonymized_text
        for placeholder, original in mapping.items():
            result = result.replace(placeholder, original)

        return result

    def _build_code_generation_prompt(
        self,
        entity_type_code: str,
        entity_type_name: str,
        natural_description: str,
        sample_data: str = None
    ) -> str:
        """Build the prompt for AI code generation."""
        entity_code_lower = entity_type_code.lower()

        prompt = f"""Generate Python code to anonymize {entity_type_name} in text based on the following requirement.

User Requirement: {natural_description}
{f'Sample Data: {sample_data}' if sample_data else ''}

The code will receive these variables:
- input_text: str - The text to process
- entity_type_code: str - The entity type code ('{entity_type_code}')
- existing_mapping: dict - Existing placeholder->original mappings
- existing_counters: dict - Existing entity type counters

The code must set:
- result['anonymized_text']: str - The anonymized text
- result['mapping']: dict - New placeholder->original mappings
- result['counters']: dict - Updated entity type counters

IMPORTANT RULES:
1. Use re module for pattern matching (already imported)
2. Placeholder format MUST be: [{entity_code_lower}_N] where N is a number
3. Start counter from (existing_counters.get('{entity_code_lower}', 0) + 1)
4. Update counters after each replacement
5. Add all new mappings to result['mapping']
6. DO NOT use any imports, file operations, or network calls
7. ONLY use: re, len, str, int, dict, list, range, enumerate
8. DO NOT use 'global' keyword - use mutable containers like lists or dicts instead

Example for email (anonymize username, keep domain):
```python
pattern = r'([a-zA-Z0-9._%+-]+)(@[a-zA-Z0-9.-]+\\.[a-zA-Z]{{2,}})'
# Use a list for mutable counter (DO NOT use global keyword!)
state = {{'counter': existing_counters.get('email', 0), 'mapping': {{}}}}

def replace_fn(match):
    state['counter'] += 1
    placeholder = f'[email_{{state["counter"]}}]'
    state['mapping'][placeholder] = match.group(1)
    return placeholder + match.group(2)

anonymized = re.sub(pattern, replace_fn, input_text)

result['anonymized_text'] = anonymized
result['mapping'] = state['mapping']
result['counters'] = existing_counters.copy()
result['counters']['email'] = state['counter']
```

Now generate code for: {natural_description}
Return ONLY the Python code, no markdown, no explanation."""

        return prompt

    def _parse_code_response(self, response: str) -> str:
        """Parse and clean the AI response to extract code."""
        code = response.strip()

        # Remove markdown code blocks if present
        if code.startswith("```python"):
            code = code[9:]
        if code.startswith("```"):
            code = code[3:]
        if code.endswith("```"):
            code = code[:-3]

        return code.strip()

    def _validate_code_safety(self, code: str) -> bool:
        """
        Validate that the generated code is safe to execute.

        Args:
            code: Python code to validate

        Returns:
            True if code is safe, False otherwise
        """
        # Dangerous patterns to reject
        dangerous_patterns = [
            r'\bimport\s+',           # import statements
            r'\bfrom\s+\w+\s+import', # from X import Y
            r'__\w+__',               # dunder attributes (__builtins__, __class__, etc.)
            r'\beval\s*\(',           # eval function
            r'\bexec\s*\(',           # exec function
            r'\bcompile\s*\(',        # compile function
            r'\bopen\s*\(',           # file operations
            r'\bos\.',                # os module
            r'\bsys\.',               # sys module
            r'\bsubprocess',          # subprocess module
            r'\bsocket\.',            # socket operations
            r'\brequests\.',          # HTTP requests
            r'\bhttpx\.',             # HTTP requests
            r'\bgetattr\s*\(',        # getattr
            r'\bsetattr\s*\(',        # setattr
            r'\bdelattr\s*\(',        # delattr
            r'\bglobals\s*\(',        # globals access
            r'\blocals\s*\(',         # locals access (but we allow it in context)
            r'\bbreakpoint\s*\(',     # debugger
            r'\.read\s*\(',           # file read
            r'\.write\s*\(',          # file write
            r'\bglobal\s+',           # global keyword (doesn't work in exec sandbox)
        ]

        code_lower = code.lower()
        for pattern in dangerous_patterns:
            if re.search(pattern, code, re.IGNORECASE):
                logger.warning(f"Unsafe pattern detected in code: {pattern}")
                return False

        return True

    def _safe_execute(
        self,
        code: str,
        input_text: str,
        entity_type_code: str,
        existing_mapping: Dict[str, str],
        existing_counters: Dict[str, int],
        timeout: float = 5.0
    ) -> Dict[str, Any]:
        """
        Safely execute code in a restricted environment with timeout.

        Args:
            code: Python code to execute
            input_text: Input text to process
            entity_type_code: Entity type code
            existing_mapping: Existing mappings
            existing_counters: Existing counters
            timeout: Execution timeout in seconds

        Returns:
            Dict with anonymized_text, mapping, and counters
        """
        # Pre-define state dict for closures to work in exec() environment
        # Must be in globals for nested functions to access it
        state = {'counter': 0, 'mapping': {}}
        result = {
            'anonymized_text': input_text,
            'mapping': {},
            'counters': existing_counters.copy()
        }

        # Prepare the execution environment
        # Note: For nested functions (closures) to work in exec(), variables must be in globals
        safe_globals = {
            '__builtins__': {
                'len': len,
                'str': str,
                'int': int,
                'dict': dict,
                'list': list,
                'range': range,
                'enumerate': enumerate,
                'min': min,
                'max': max,
                'sorted': sorted,
                'reversed': reversed,
                'zip': zip,
                'map': map,
                'filter': filter,
                'any': any,
                'all': all,
                'True': True,
                'False': False,
                'None': None,
            },
            # These must be in globals for nested functions (replace_fn) to access them
            're': re,
            'input_text': input_text,
            'entity_type_code': entity_type_code,
            'existing_mapping': existing_mapping.copy(),
            'existing_counters': existing_counters.copy(),
            'state': state,
            'result': result,
        }

        safe_locals = {}

        def execute_code():
            try:
                exec(code, safe_globals, safe_locals)
                # Result is in safe_globals since we put it there for closure access
                result = safe_globals['result']

                # WORKAROUND: Due to exec() scoping issues, nested functions (like replace_fn)
                # update safe_globals['state'] but the code's local 'state' variable shadows it.
                # So result['mapping'] = state['mapping'] uses the local (empty) state.
                # We need to copy the mapping from safe_globals['state'] if result['mapping'] is empty.
                if not result.get('mapping') and safe_globals.get('state', {}).get('mapping'):
                    result['mapping'] = safe_globals['state']['mapping']
                    logger.debug(f"Recovered mapping from safe_globals['state']: {result['mapping']}")

                return result
            except Exception as e:
                raise CodeExecutionError(f"Code execution failed: {str(e)}")

        # Execute with timeout
        try:
            future = _executor.submit(execute_code)
            result = future.result(timeout=timeout)
            return result
        except TimeoutError:
            raise CodeExecutionError(f"Code execution timed out after {timeout} seconds")
        except Exception as e:
            if isinstance(e, CodeExecutionError):
                raise
            raise CodeExecutionError(f"Code execution error: {str(e)}")


class StreamingRestoreBuffer:
    """
    Sliding window buffer for detecting and restoring placeholders in streaming output.

    Handles cases where placeholders span across multiple chunks:
    - Chunk 1: "Hello [em"
    - Chunk 2: "ail_1] world"

    The buffer holds content until placeholders are complete, then outputs restored text.
    """

    def __init__(self, mapping: Dict[str, str], max_placeholder_length: int = 50):
        """
        Initialize the streaming restore buffer.

        Args:
            mapping: Dict mapping placeholders to original values
            max_placeholder_length: Maximum expected placeholder length
        """
        self.mapping = mapping
        self.buffer = ""
        self.max_placeholder_length = max_placeholder_length
        self.placeholder_pattern = re.compile(r'\[[a-zA-Z_]+_\d+\]')

    def process_chunk(self, chunk: str) -> str:
        """
        Process incoming chunk and return content safe to output.

        The method:
        1. Appends chunk to buffer
        2. Restores complete placeholders
        3. Checks for potential partial placeholder at end
        4. Returns safe content, keeps potential partial in buffer

        Args:
            chunk: Incoming text chunk

        Returns:
            Text that is safe to output (all placeholders restored)
        """
        self.buffer += chunk

        # First, restore all complete placeholders
        restored = self.buffer
        for placeholder, original in self.mapping.items():
            restored = restored.replace(placeholder, original)

        # Check for potential partial placeholder at end
        # Look for '[' without matching ']' in the tail
        last_bracket = restored.rfind('[')

        if last_bracket != -1:
            # Check if there's a ']' after the last '['
            tail = restored[last_bracket:]
            if ']' not in tail:
                # Potential partial placeholder, keep in buffer
                # But limit buffer size to prevent memory issues
                if len(tail) <= self.max_placeholder_length:
                    output = restored[:last_bracket]
                    self.buffer = tail
                    return output
                else:
                    # Tail too long, not a placeholder, output everything
                    self.buffer = ""
                    return restored

        # No partial placeholder
        self.buffer = ""
        return restored

    def flush(self) -> str:
        """
        Flush remaining buffer content at stream end.

        Returns:
            Remaining buffer content with placeholders restored
        """
        result = self.buffer
        for placeholder, original in self.mapping.items():
            result = result.replace(placeholder, original)
        self.buffer = ""
        return result

    def has_pending_content(self) -> bool:
        """Check if there's content waiting in the buffer."""
        return len(self.buffer) > 0


# Singleton instance
_service_instance: Optional[RestoreAnonymizationService] = None


def get_restore_anonymization_service() -> RestoreAnonymizationService:
    """Get or create the RestoreAnonymizationService singleton."""
    global _service_instance
    if _service_instance is None:
        _service_instance = RestoreAnonymizationService()
    return _service_instance
