"""
Proxy Answer Generation Service

When knowledge base is hit, instead of directly returning KB content,
this service calls the guardrail model to generate a safe, positive response
using the KB content as reference context.
"""
import httpx
from typing import Optional, List
from config import settings
from utils.logger import setup_logger
from utils.i18n_loader import get_translation

logger = setup_logger()


class ProxyAnswerService:
    """Service for generating proxy answers using guardrail model"""

    def __init__(self):
        # Reuse HTTP client for performance
        timeout = httpx.Timeout(60.0, connect=5.0)  # Longer timeout for generation
        limits = httpx.Limits(max_keepalive_connections=50, max_connections=100)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            limits=limits,
            http2=False
        )
        self._headers = {
            "Authorization": f"Bearer {settings.guardrails_model_api_key}",
            "Content-Type": "application/json"
        }
        self._api_url = f"{settings.guardrails_model_api_url}/chat/completions"

    async def generate_proxy_answer(
        self,
        user_query: str,
        kb_reference: str,
        scanner_name: str,
        risk_level: str = "medium_risk",
        user_language: str = "en"
    ) -> str:
        """
        Generate a safe, positive proxy answer using guardrail model.

        Instead of directly returning knowledge base content, this method:
        1. Uses KB content as reference context
        2. Emphasizes the detected risk (scanner_name)
        3. Asks the model to generate a careful, positive response
        4. Emphasizes legal compliance, ethics, and user well-being

        Args:
            user_query: The original user question
            kb_reference: The knowledge base content to use as reference
            scanner_name: The detected risk scanner name (e.g., "Self-Harm", "Violence")
            risk_level: The risk level (high_risk, medium_risk, low_risk)
            user_language: User's preferred language ('en' or 'zh')

        Returns:
            Generated safe, positive response
        """
        try:
            # Build system prompt based on language
            system_prompt = self._build_system_prompt(scanner_name, risk_level, user_language)

            # Build user message with KB reference
            user_message = self._build_user_message(user_query, kb_reference, user_language)

            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ]

            logger.info(f"Generating proxy answer for risk: {scanner_name}, query: {user_query[:50]}...")

            response = await self._call_model(messages)

            logger.info(f"Generated proxy answer: {response[:100]}...")
            return response

        except Exception as e:
            logger.error(f"Failed to generate proxy answer: {e}", exc_info=True)
            # Fallback to a safe default message
            return self._get_fallback_message(scanner_name, user_language)

    def _build_system_prompt(self, scanner_name: str, risk_level: str, language: str) -> str:
        """Build the system prompt for proxy answer generation"""

        if language == 'zh':
            return f"""你是一个负责任的AI助手。用户的问题可能涉及"{scanner_name}"相关的敏感话题。

你的任务是：
1. 仔细参考提供的参考内容，理解如何安全地回应此类问题
2. 生成一个正向、积极、有建设性的回复
3. 在回复中强调以下重要原则：
   - 遵守法律法规
   - 遵守道德伦理
   - 关注用户的身心健康
   - 提供正确的引导和建议

重要要求：
- 不要直接复制参考内容，而是用你自己的话重新组织
- 回复要温和、有同理心，但同时要坚定地引导用户远离风险
- 如果用户的问题确实有害，要明确但礼貌地拒绝
- 可以提供正向的替代建议或资源
- 回复要简洁明了，不要过长

风险等级：{risk_level}"""
        else:
            return f"""You are a responsible AI assistant. The user's question may involve sensitive topics related to "{scanner_name}".

Your task is to:
1. Carefully reference the provided reference content to understand how to safely respond to such questions
2. Generate a positive, constructive response
3. Emphasize the following important principles in your response:
   - Compliance with laws and regulations
   - Adherence to moral and ethical standards
   - Care for the user's physical and mental well-being
   - Provide correct guidance and suggestions

Important requirements:
- Do not directly copy the reference content; rephrase it in your own words
- Be warm and empathetic, but firmly guide users away from risks
- If the user's question is truly harmful, decline clearly but politely
- Provide positive alternative suggestions or resources when appropriate
- Keep your response concise and clear

Risk level: {risk_level}"""

    def _build_user_message(self, user_query: str, kb_reference: str, language: str) -> str:
        """Build the user message with KB reference"""

        if language == 'zh':
            return f"""用户问题：
{user_query}

参考内容（请参考但不要直接复制）：
{kb_reference}

请根据上述参考内容，生成一个安全、正向的回复。"""
        else:
            return f"""User question:
{user_query}

Reference content (use as reference but do not copy directly):
{kb_reference}

Please generate a safe, positive response based on the above reference content."""

    async def _call_model(self, messages: List[dict]) -> str:
        """Call the guardrail model API"""
        try:
            payload = {
                "model": settings.guardrails_model_name,
                "messages": messages,
                "temperature": 0.7,  # Slightly higher temperature for more natural responses
                "max_tokens": 500   # Limit response length
            }

            response = await self._client.post(
                self._api_url,
                json=payload,
                headers=self._headers
            )

            if response.status_code == 200:
                result_data = response.json()
                return result_data["choices"][0]["message"]["content"].strip()
            else:
                logger.error(f"Model API error: {response.status_code} - {response.text}")
                raise Exception(f"API call failed with status {response.status_code}")

        except Exception as e:
            logger.error(f"Model API call error: {e}")
            raise

    def _get_fallback_message(self, scanner_name: str, language: str) -> str:
        """Get fallback message when generation fails"""
        try:
            template = get_translation(language, 'guardrail', 'responseTemplates', 'securityRisk')
            return template.replace('{scanner_name}', scanner_name)
        except Exception:
            if language == 'zh':
                return f"抱歉，我无法回答涉及{scanner_name}的问题。如果您需要帮助，请联系专业人士或相关机构。"
            else:
                return f"Sorry, I cannot answer questions involving {scanner_name}. If you need help, please contact professionals or relevant organizations."

    async def close(self):
        """Close the HTTP client"""
        await self._client.aclose()


# Global instance
proxy_answer_service = ProxyAnswerService()
