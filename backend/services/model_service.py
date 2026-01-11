import asyncio
import httpx
import json
import math
from typing import List, Tuple, Optional
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