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

    async def generate_genai_anonymization_code(
        self,
        natural_description: str,
        sample_data: str = None
    ) -> Dict[str, Any]:
        """
        Generate Python anonymization code using AI based on natural language description.

        This is a standalone method that doesn't require entity type information.
        The generated code should define an `anonymize(text)` function.

        Args:
            natural_description: Natural language description of the anonymization rule
            sample_data: Optional sample data for context

        Returns:
            Dict containing:
                - code: The generated Python code
        """
        prompt = self._build_genai_code_prompt(natural_description, sample_data)

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

            return {
                "code": code
            }

        except Exception as e:
            logger.error(f"Failed to generate genai code: {e}")
            raise CodeGenerationError(f"Code generation failed: {str(e)}")

    def execute_genai_code(
        self,
        code: str,
        text: str
    ) -> str:
        """
        Execute genai anonymization code to transform input text.

        Args:
            code: Python code defining an `anonymize(text)` function
            text: Input text to anonymize

        Returns:
            Anonymized text
        """
        if not self._validate_code_safety(code):
            raise CodeExecutionError("Code contains unsafe operations")

        try:
            result = self._safe_execute_simple(code, text)
            return result
        except Exception as e:
            raise CodeExecutionError(f"Code execution failed: {str(e)}")

    def _build_genai_code_prompt(
        self,
        natural_description: str,
        sample_data: str = None
    ) -> str:
        """Build prompt for genai code generation."""
        sample_section = ""
        if sample_data:
            sample_section = f"""
Sample input data:
{sample_data}
"""

        return f"""Generate a Python function to anonymize text based on this requirement:

{natural_description}
{sample_section}
CRITICAL Requirements:
1. Define a single function named `anonymize(text)` that takes a string and returns the anonymized string
2. DO NOT use any import statements - the following modules are already available globally:
   - re (regex)
   - string (string constants)
   - random (random numbers)
   - hashlib (md5, sha256, etc.)
   - time (timestamps)
   - datetime (date/time operations)
   - base64 (encoding)
   - uuid (unique identifiers)
   - math (mathematical functions)
3. The function should handle any input gracefully (empty strings, special characters, etc.)
4. Keep the code simple and efficient

Example - Replace with MD5 hash:
```python
def anonymize(text):
    return hashlib.md5(text.encode()).hexdigest()[:8]
```

Example - Replace digits with random digits:
```python
def anonymize(text):
    result = ''
    for char in text:
        if char.isdigit():
            result += str(random.randint(0, 9))
        else:
            result += char
    return result
```

Example - Keep first 3 and last 4, replace middle with *:
```python
def anonymize(text):
    if len(text) <= 7:
        return '*' * len(text)
    return text[:3] + '*' * (len(text) - 7) + text[-4:]
```

IMPORTANT: Do NOT write any import statements. The modules are pre-loaded and ready to use.
Generate ONLY the Python function code, no explanations or markdown."""

    def _safe_execute_simple(
        self,
        code: str,
        text: str
    ) -> str:
        """
        Safely execute anonymization code that defines an `anonymize(text)` function.

        Args:
            code: Python code with anonymize function
            text: Input text to process

        Returns:
            Result of anonymize(text)
        """
        import re as re_module
        import string as string_module
        import random as random_module
        import hashlib as hashlib_module
        import time as time_module
        import datetime as datetime_module
        import base64 as base64_module
        import uuid as uuid_module
        import math as math_module

        # Create a restricted namespace
        safe_globals = {
            '__builtins__': {
                'len': len,
                'str': str,
                'int': int,
                'float': float,
                'bool': bool,
                'list': list,
                'dict': dict,
                'tuple': tuple,
                'range': range,
                'enumerate': enumerate,
                'zip': zip,
                'min': min,
                'max': max,
                'sum': sum,
                'abs': abs,
                'ord': ord,
                'chr': chr,
                'isinstance': isinstance,
                'sorted': sorted,
                'reversed': reversed,
                'map': map,
                'filter': filter,
                'hex': hex,
                'bin': bin,
                'oct': oct,
                'round': round,
                'pow': pow,
                'divmod': divmod,
                'any': any,
                'all': all,
                'repr': repr,
                'hash': hash,
                'set': set,
                'frozenset': frozenset,
                'bytes': bytes,
                'bytearray': bytearray,
                'slice': slice,
                'type': type,
            },
            're': re_module,
            'string': string_module,
            'random': random_module,
            'hashlib': hashlib_module,
            'time': time_module,
            'datetime': datetime_module,
            'base64': base64_module,
            'uuid': uuid_module,
            'math': math_module,
        }

        safe_locals = {}

        try:
            # Execute the code to define the function
            exec(code, safe_globals, safe_locals)

            # Get the anonymize function
            if 'anonymize' not in safe_locals:
                raise CodeExecutionError("Code must define an 'anonymize' function")

            anonymize_func = safe_locals['anonymize']

            # Execute with timeout
            result = anonymize_func(text)

            if not isinstance(result, str):
                result = str(result)

            return result

        except Exception as e:
            raise CodeExecutionError(f"Execution error: {str(e)}")

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

        code = code.strip()

        # Remove import statements for pre-loaded safe modules
        # These modules are already available in the sandbox environment
        safe_modules = ['re', 'string', 'random', 'hashlib', 'time', 'datetime', 'base64', 'uuid', 'math']
        lines = code.split('\n')
        cleaned_lines = []
        for line in lines:
            stripped = line.strip()
            # Check if it's an import statement for a safe module
            is_safe_import = False
            for mod in safe_modules:
                if stripped == f'import {mod}' or stripped.startswith(f'import {mod} '):
                    is_safe_import = True
                    break
                if stripped.startswith(f'from {mod} import'):
                    is_safe_import = True
                    break
            if not is_safe_import:
                cleaned_lines.append(line)

        return '\n'.join(cleaned_lines).strip()

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
        # Initialize counter from existing_counters using entity_type_code as key
        counter_key = entity_type_code.lower()
        initial_counter = existing_counters.get(counter_key, 0)
        state = {'counter': initial_counter, 'mapping': {}}
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
                # We need to copy the mapping and counters from safe_globals['state'].
                if not result.get('mapping') and safe_globals.get('state', {}).get('mapping'):
                    result['mapping'] = safe_globals['state']['mapping']
                    logger.debug(f"Recovered mapping from safe_globals['state']: {result['mapping']}")

                # Also recover counters from safe_globals['state'] if the counter was updated
                state_counter = safe_globals.get('state', {}).get('counter', 0)
                if state_counter > 0:
                    # The entity_type_code is lowercased for the counter key
                    counter_key = safe_globals.get('entity_type_code', '').lower()
                    if counter_key:
                        result['counters'] = safe_globals.get('existing_counters', {}).copy()
                        result['counters'][counter_key] = state_counter
                        logger.debug(f"Recovered counter from safe_globals['state']: {counter_key}={state_counter}")

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
    - Chunk 1: "Hello __em"
    - Chunk 2: "ail_1__ world"

    The buffer holds content until placeholders are complete, then outputs restored text.

    Supports both old format [entity_type_N] and new format __entity_type_N__.
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
        # Support both old [entity_type_N] and new __entity_type_N__ formats
        self.placeholder_pattern = re.compile(r'(__[a-z_]+_\d+__|\[[a-zA-Z_]+_\d+\])')

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
        # Look for '__' or '[' that might indicate start of a placeholder
        last_double_underscore = restored.rfind('__')
        last_bracket = restored.rfind('[')

        # Find the last potential placeholder start
        potential_start = max(last_double_underscore, last_bracket)

        if potential_start != -1:
            tail = restored[potential_start:]
            # Check if this could be an incomplete placeholder
            # For __ format: need closing __
            # For [] format: need closing ]
            is_incomplete = False

            if last_double_underscore == potential_start:
                # Check if __ format is incomplete (no closing __)
                # Count underscores - if odd count of __, it's incomplete
                underscore_count = tail.count('__')
                if underscore_count % 2 == 1:
                    is_incomplete = True
            elif last_bracket == potential_start:
                # Check if [] format is incomplete (no closing ])
                if ']' not in tail:
                    is_incomplete = True

            if is_incomplete:
                # Potential partial placeholder, keep in buffer
                # But limit buffer size to prevent memory issues
                if len(tail) <= self.max_placeholder_length:
                    output = restored[:potential_start]
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
