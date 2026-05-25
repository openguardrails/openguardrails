from typing import Any
import logging

from dify_plugin import ToolProvider
from dify_plugin.errors.tool import ToolProviderCredentialValidationError
from openguardrails import OpenGuardrails

logger = logging.getLogger(__name__)


class OpenGuardrailsProvider(ToolProvider):

    def _validate_credentials(self, credentials: dict[str, Any]) -> None:
        try:
            # Get API key
            api_key = credentials.get("api_key")
            if not api_key:
                raise ToolProviderCredentialValidationError("API key is required")

            # Get base_url, if not provided, use default value
            base_url = credentials.get("base_url")

            if base_url:
                client = OpenGuardrails(api_key, base_url=base_url)
            else:
                client = OpenGuardrails(api_key)

            # Use a simple test to validate API key
            test_result = client.check_prompt("test")

            # If the call is successful and returns a result, the validation is successful
            if hasattr(test_result, 'suggest_action'):
                return  # Validate Successfully
            else:
                logger.error(f"Invalid response format, missing suggest_action attribute")
                raise ToolProviderCredentialValidationError("Invalid API key response format")

        except Exception as e:
            logger.error(f"Credential validation error: {str(e)}", exc_info=True)
            if "API key" in str(e).lower() or "auth" in str(e).lower():
                raise ToolProviderCredentialValidationError("Invalid API key")
            else:
                raise ToolProviderCredentialValidationError(f"Credential validation failed: {str(e)}")

    #########################################################################################
    # If OAuth is supported, uncomment the following functions.
    # Warning: please make sure that the sdk version is 0.4.2 or higher.
    #########################################################################################
    # def _oauth_get_authorization_url(self, redirect_uri: str, system_credentials: Mapping[str, Any]) -> str:
    #     """
    #     Generate the authorization URL for openguardrails OAuth.
    #     """
    #     try:
    #         """
    #         IMPLEMENT YOUR AUTHORIZATION URL GENERATION HERE
    #         """
    #     except Exception as e:
    #         raise ToolProviderOAuthError(str(e))
    #     return ""
        
    # def _oauth_get_credentials(
    #     self, redirect_uri: str, system_credentials: Mapping[str, Any], request: Request
    # ) -> Mapping[str, Any]:
    #     """
    #     Exchange code for access_token.
    #     """
    #     try:
    #         """
    #         IMPLEMENT YOUR CREDENTIALS EXCHANGE HERE
    #         """
    #     except Exception as e:
    #         raise ToolProviderOAuthError(str(e))
    #     return dict()

    # def _oauth_refresh_credentials(
    #     self, redirect_uri: str, system_credentials: Mapping[str, Any], credentials: Mapping[str, Any]
    # ) -> OAuthCredentials:
    #     """
    #     Refresh the credentials
    #     """
    #     return OAuthCredentials(credentials=credentials, expires_at=-1)
