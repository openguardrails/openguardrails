import asyncio
import httpx
import json
import math
import re
from typing import List, Tuple, Optional, Dict, Any
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

class ModelService:
    """Model service class"""

    def __init__(self):
        # Create reusable HTTP client to improve performance
        timeout = httpx.Timeout(30.0, connect=5.0)  # Connection timeout 5 seconds, total timeout 30 seconds
        limits = httpx.Limits(max_keepalive_connections=100, max_connections=200)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            # Close HTTP/2 to avoid import error due to missing h2 dependency
            http2=False
        )
        self._headers = {
            "Authorization": f"Bearer {settings.guardrails_model_api_key}",
            "Content-Type": "application/json"
        }
        self._api_url = f"{settings.guardrails_model_api_url}/chat/completions"

        # 多模态模型配置
        self._vl_headers = {
            "Authorization": f"Bearer {settings.guardrails_vl_model_api_key}",
            "Content-Type": "application/json"
        }
        self._vl_api_url = f"{settings.guardrails_vl_model_api_url}/chat/completions"
    
    async def check_messages(self, messages: List[dict]) -> str:
        """Check content security"""

        try:
            return await self._call_model_api(messages)

        except Exception as e:
            logger.error(f"Model service error: {e}")
            # Return safe default result
            return "无风险"

    async def check_messages_with_confidence(self, messages: List[dict]) -> Tuple[str, Optional[float]]:
        """Check content security and return confidence score"""

        try:
            return await self._call_model_api_with_logprobs(messages)

        except Exception as e:
            logger.error(f"Model service error: {e}")
            # Return safe default result
            return "无风险", None

    async def check_messages_with_sensitivity(self, messages: List[dict], use_vl_model: bool = False) -> Tuple[str, Optional[float]]:
        """Check content security and return sensitivity score"""

        try:
            if use_vl_model:
                return await self._call_vl_model_api_with_logprobs(messages)
            else:
                return await self._call_model_api_with_logprobs(messages)

        except Exception as e:
            logger.error(f"Model service error: {e}")
            # Return safe default result
            return "无风险", None
    
    async def _call_model_api(self, messages: List[dict]) -> str:
        """Call model API (using reusable client)"""
        try:
            logger.debug("Calling model API...")  # Reduce log level, reduce I/O
            
            payload = {
                "model": settings.guardrails_model_name,
                "messages": messages,
                "temperature": 0.0
            }
            
            # Use reusable client to avoid duplicate connection creation
            response = await self._client.post(
                self._api_url,
                json=payload,
                headers=self._headers
            )
            
            if response.status_code == 200:
                result_data = response.json()
                result = result_data["choices"][0]["message"]["content"].strip()
                logger.debug(f"Model response: {result}")
                return result
            else:
                logger.error(f"Model API error: {response.status_code} - {response.text}")
                raise Exception(f"API call failed with status {response.status_code}")
        
        except Exception as e:
            logger.error(f"Model API error: {e}")
            raise

    async def _call_model_api_with_logprobs(self, messages: List[dict]) -> Tuple[str, Optional[float]]:
        """Call model API and get logprobs to calculate sensitivity"""
        try:
            logger.debug("Calling model API with logprobs...")

            payload = {
                "model": settings.guardrails_model_name,
                "messages": messages,
                "temperature": 0.0,
                "logprobs": True
            }

            # Use reusable client to avoid duplicate connection creation
            response = await self._client.post(
                self._api_url,
                json=payload,
                headers=self._headers
            )

            if response.status_code == 200:
                result_data = response.json()
                result = result_data["choices"][0]["message"]["content"].strip()

                # Extract sensitivity score
                confidence_score = None
                if "logprobs" in result_data["choices"][0] and result_data["choices"][0]["logprobs"]:
                    logprobs_data = result_data["choices"][0]["logprobs"]
                    if "content" in logprobs_data and logprobs_data["content"]:
                        # Get logprob of the first token
                        first_token_logprob = logprobs_data["content"][0]["logprob"]
                        # Convert to probability
                        confidence_score = math.exp(first_token_logprob)

                logger.debug(f"Model response: {result}, confidence: {confidence_score}")
                return result, confidence_score
            else:
                logger.error(f"Model API error: {response.status_code} - {response.text}")
                raise Exception(f"API call failed with status {response.status_code}")

        except Exception as e:
            logger.error(f"Model API error: {e}")
            raise

    async def _call_vl_model_api_with_logprobs(self, messages: List[dict]) -> Tuple[str, Optional[float]]:
        """Call multi-modal model API and get logprobs to calculate sensitivity"""
        try:
            logger.debug("Calling VL model API with logprobs...")

            payload = {
                "model": settings.guardrails_vl_model_name,
                "messages": messages,
                "temperature": 0.0,
                "logprobs": True
            }

            # Use reusable client to avoid duplicate connection creation
            response = await self._client.post(
                self._vl_api_url,
                json=payload,
                headers=self._vl_headers
            )

            if response.status_code == 200:
                result_data = response.json()
                result = result_data["choices"][0]["message"]["content"].strip()

                # Extract sensitivity score
                confidence_score = None
                if "logprobs" in result_data["choices"][0] and result_data["choices"][0]["logprobs"]:
                    logprobs_data = result_data["choices"][0]["logprobs"]
                    if "content" in logprobs_data and logprobs_data["content"]:
                        # Get logprob of the first token
                        first_token_logprob = logprobs_data["content"][0]["logprob"]
                        # Convert to probability
                        confidence_score = math.exp(first_token_logprob)

                logger.debug(f"VL Model response: {result}, confidence: {confidence_score}")
                return result, confidence_score
            else:
                logger.error(f"VL Model API error: {response.status_code} - {response.text}")
                raise Exception(f"API call failed with status {response.status_code}")

        except Exception as e:
            logger.error(f"VL Model API error: {e}")
            raise

    async def check_messages_with_scanner_definitions(
        self,
        messages: List[dict],
        scanner_definitions: List[str],
        use_vl_model: bool = False
    ) -> Tuple[str, Optional[float]]:
        """
        Check content security with custom scanner definitions and return sensitivity score

        Args:
            messages: List of message dictionaries
            scanner_definitions: List of scanner definition strings
                Format: ["S2: Sensitive Political Topics. [definition]", ...]
            use_vl_model: Whether to use vision-language model

        Returns:
            Tuple of (model_response, sensitivity_score)
            Model response format: "safe" or "unsafe\nS2,S5,S7"
        """
        try:
            # Combine scanner definitions into unsafe_categories string
            # Format expected by OpenGuardrails-Text model
            # Each definition ends with " \n" (including the last one)
            if scanner_definitions:
                unsafe_categories = " \n".join(scanner_definitions) + " \n"
            else:
                unsafe_categories = ""

            # Get role of last message
            role = self._get_last_message_role(messages)

            # Convert messages to conversation string
            conversation = self._messages_to_conversation_string(messages)

            # Build instruction using the template
            instruction = f"[INST] Task: Check if there is unsafe content in '{role}' messages in conversations according to our safety policy with the below categories.\n\n<BEGIN UNSAFE CONTENT CATEGORIES>\n{unsafe_categories}\n<END UNSAFE CONTENT CATEGORIES>\n\n<BEGIN CONVERSATION>\n\n{conversation}\n\n<END CONVERSATION>\n\nProvide your safety assessment for ONLY THE LAST {role} message in the above conversation:\n- First line must read 'safe' or 'unsafe'.\n- If unsafe, a second line must include a comma-separated list of violated categories. [/INST]"

            logger.info(f"Model detection - role={role}, conversation={conversation[:500]}...")

            # Prepare new messages with instruction
            prepared_messages = [
                {"role": "user", "content": instruction}
            ]

            payload = {
                "model": settings.guardrails_vl_model_name if use_vl_model else settings.guardrails_model_name,
                "messages": prepared_messages,
                "temperature": 0.0,
                "logprobs": True
            }

            # Use appropriate API URL and headers
            api_url = self._vl_api_url if use_vl_model else self._api_url
            headers = self._vl_headers if use_vl_model else self._headers

            response = await self._client.post(
                api_url,
                json=payload,
                headers=headers
            )

            if response.status_code == 200:
                result_data = response.json()
                result = result_data["choices"][0]["message"]["content"].strip()

                # Extract sensitivity score
                sensitivity_score = None
                if "logprobs" in result_data["choices"][0] and result_data["choices"][0]["logprobs"]:
                    logprobs_data = result_data["choices"][0]["logprobs"]
                    if "content" in logprobs_data and logprobs_data["content"]:
                        # Get logprob of the first token
                        first_token_logprob = logprobs_data["content"][0]["logprob"]
                        # Convert to probability
                        sensitivity_score = math.exp(first_token_logprob)

                logger.debug(f"Model response: {result}, sensitivity: {sensitivity_score}")
                return result, sensitivity_score
            else:
                logger.error(f"Model API error: {response.status_code} - {response.text}")
                raise Exception(f"API call failed with status {response.status_code}")

        except Exception as e:
            logger.error(f"Model API error with scanner definitions: {e}")
            # Return safe default result
            return "safe", None

    async def extract_unsafe_segments(
        self,
        content: str,
        matched_categories: List[str],
        scanner_definitions: Optional[List[str]] = None
    ) -> List[Dict[str, Any]]:
        """
        Second-pass detection: extract the specific unsafe text segments from content.

        Called only when first-pass detection finds unsafe content.
        Asks the model to identify which sentences/phrases triggered the violation,
        then matches them back to the original content to get positions.

        Args:
            content: Original text content
            matched_categories: List of matched category tags (e.g., ["S2", "S5"])
            scanner_definitions: Optional scanner definitions for context

        Returns:
            List of dicts: [{"text": "...", "start": 0, "end": 10, "categories": ["S2"]}]
            Returns empty list on any error (non-blocking).
        """
        if not content or not matched_categories:
            return []

        try:
            # Build category description for the prompt
            if scanner_definitions:
                categories_desc = "\n".join(
                    d for d in scanner_definitions
                    if any(d.startswith(tag + ":") or d.startswith(tag + " ") for tag in matched_categories)
                )
            else:
                categories_desc = ", ".join(matched_categories)

            # Truncate content if too long (model has limited context)
            max_content_len = 4000
            truncated_content = content[:max_content_len] if len(content) > max_content_len else content

            # Build the extraction prompt - use simple JSON format for the 3.3B model
            instruction = f"""[INST] The following text was detected as unsafe, violating categories: {', '.join(matched_categories)}.

<BEGIN TEXT>
{truncated_content}
<END TEXT>

Identify the specific unsafe sentences or phrases in the text above.
Return ONLY a JSON array of strings, where each string is an exact quote from the text.
Example format: ["unsafe sentence one", "unsafe phrase two"]

Return ONLY the JSON array, no other text. [/INST]"""

            prepared_messages = [{"role": "user", "content": instruction}]

            payload = {
                "model": settings.guardrails_model_name,
                "messages": prepared_messages,
                "temperature": 0.0,
                "max_tokens": 1024,
            }

            response = await self._client.post(
                self._api_url,
                json=payload,
                headers=self._headers
            )

            if response.status_code != 200:
                logger.warning(f"Unsafe segment extraction API error: {response.status_code}")
                return []

            result_data = response.json()
            raw_response = result_data["choices"][0]["message"]["content"].strip()
            logger.info(f"Unsafe segment extraction raw response: {raw_response[:500]}")

            # Parse the model response - robust JSON extraction
            segments = self._parse_unsafe_segments_response(raw_response)

            if not segments:
                return []

            # Match segments back to original content to get positions
            return self._match_segments_to_content(content, segments, matched_categories)

        except Exception as e:
            logger.warning(f"Unsafe segment extraction failed (non-blocking): {e}")
            return []

    def _parse_unsafe_segments_response(self, raw_response: str) -> List[str]:
        """
        Parse model response to extract unsafe segment strings.
        Handles various imperfect formats the small model might produce.
        """
        # Try 1: Direct JSON parse
        try:
            parsed = json.loads(raw_response)
            if isinstance(parsed, list):
                return [str(s).strip() for s in parsed if s and str(s).strip()]
        except json.JSONDecodeError:
            pass

        # Try 2: Extract JSON array from response (model may add extra text)
        json_match = re.search(r'\[[\s\S]*?\]', raw_response)
        if json_match:
            try:
                parsed = json.loads(json_match.group())
                if isinstance(parsed, list):
                    return [str(s).strip() for s in parsed if s and str(s).strip()]
            except json.JSONDecodeError:
                pass

        # Try 3: Extract quoted strings
        quoted = re.findall(r'"([^"]+)"', raw_response)
        if quoted:
            return [s.strip() for s in quoted if s.strip()]

        logger.warning(f"Could not parse unsafe segments from model response")
        return []

    def _match_segments_to_content(
        self,
        content: str,
        segments: List[str],
        categories: List[str]
    ) -> List[Dict[str, Any]]:
        """
        Match extracted segment strings back to original content to find positions.
        Finds ALL occurrences of each segment (not just the first).
        Uses exact substring match first, then fuzzy fallback.
        """
        results = []
        used_ranges = []  # Avoid overlapping matches

        def _is_overlapping(start: int, end: int) -> bool:
            return any(s <= start < e or s < end <= e for s, e in used_ranges)

        def _add_result(text: str, start: int, end: int):
            if not _is_overlapping(start, end):
                results.append({
                    "text": text,
                    "start": start,
                    "end": end,
                    "categories": categories
                })
                used_ranges.append((start, end))

        for segment_text in segments:
            if not segment_text or len(segment_text) < 4:
                continue  # Skip very short segments (likely noise)

            # Find ALL exact substring matches
            found_any = False
            search_start = 0
            while True:
                start = content.find(segment_text, search_start)
                if start == -1:
                    break
                found_any = True
                end = start + len(segment_text)
                _add_result(segment_text, start, end)
                search_start = end  # Continue searching after this match

            if found_any:
                continue

            # Fuzzy fallback: normalize whitespace and find all matches
            normalized_segment = ' '.join(segment_text.split())
            normalized_content = ' '.join(content.split())

            norm_search_start = 0
            found_norm = False
            while True:
                norm_start = normalized_content.find(normalized_segment, norm_search_start)
                if norm_start == -1:
                    break
                original_pos = self._map_normalized_pos_to_original(content, norm_start, normalized_segment)
                if original_pos is not None:
                    found_norm = True
                    start, end = original_pos
                    _add_result(content[start:end], start, end)
                norm_search_start = norm_start + len(normalized_segment)

            if found_norm:
                continue

            # Last resort: try shorter prefix (first 30 chars), find all
            if len(segment_text) > 30:
                short = segment_text[:30]
                search_start = 0
                while True:
                    start = content.find(short, search_start)
                    if start == -1:
                        break
                    end = min(start + len(segment_text), len(content))
                    _add_result(content[start:end], start, end)
                    search_start = start + len(short)

        return results

    def _map_normalized_pos_to_original(
        self, original: str, norm_start: int, norm_segment: str
    ) -> Optional[Tuple[int, int]]:
        """Map a position in normalized (whitespace-collapsed) text back to original text."""
        norm_idx = 0
        orig_start = None

        for orig_idx, ch in enumerate(original):
            if norm_idx == norm_start and orig_start is None:
                orig_start = orig_idx
            if norm_idx == norm_start + len(norm_segment):
                return (orig_start, orig_idx)

            if ch in (' ', '\t', '\n', '\r'):
                # In normalized text, consecutive whitespace is collapsed to single space
                if orig_idx == 0 or original[orig_idx - 1] not in (' ', '\t', '\n', '\r'):
                    norm_idx += 1
            else:
                norm_idx += 1

        if orig_start is not None and norm_idx >= norm_start + len(norm_segment):
            return (orig_start, len(original))
        return None

    def _has_image_content(self, messages: List[dict]) -> bool:
        """Check if the message contains image content"""
        for msg in messages:
            content = msg.get("content")
            if isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        return True
        return False

    def _get_last_message_role(self, messages: List[dict]) -> str:
        """Get the role of the last message, converted to User or Agent"""
        if not messages:
            return "User"

        last_role = messages[-1].get("role", "user")
        return "Agent" if last_role == "assistant" else "User"

    def _messages_to_conversation_string(self, messages: List[dict]) -> str:
        """Convert messages list to conversation string format"""
        conversation_parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")

            # Handle multimodal content (list format)
            if isinstance(content, list):
                text_parts = []
                for part in content:
                    if isinstance(part, dict) and part.get("type") == "text":
                        text_parts.append(part.get("text", ""))
                content = " ".join(text_parts)

            # Convert role to display name
            display_role = "Agent" if role == "assistant" else "User"
            conversation_parts.append(f"{display_role}: {content}")

        return "\n".join(conversation_parts)

    async def close(self):
        """Close HTTP client"""
        if self._client:
            await self._client.aclose()

# Global model service instance
model_service = ModelService()