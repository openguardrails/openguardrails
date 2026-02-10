"""
Alipay payment service for Chinese users
Uses official Alipay SDK for payment processing
"""

import logging
import traceback
from datetime import datetime
from typing import Optional, Dict, Any

# Apply monkey patch BEFORE importing alipay SDK to fix RSA signing issues in Python 3.11+
try:
    from services.alipay_rsa_patch import apply_alipay_rsa_patch
    apply_alipay_rsa_patch()
except Exception as e:
    print(f"⚠️  Failed to apply Alipay RSA patch: {e}")

from alipay.aop.api.AlipayClientConfig import AlipayClientConfig
from alipay.aop.api.DefaultAlipayClient import DefaultAlipayClient
from alipay.aop.api.domain.AlipayTradePagePayModel import AlipayTradePagePayModel
from alipay.aop.api.domain.AlipayTradeQueryModel import AlipayTradeQueryModel
from alipay.aop.api.domain.AlipayTradeCloseModel import AlipayTradeCloseModel
from alipay.aop.api.request.AlipayTradePagePayRequest import AlipayTradePagePayRequest
from alipay.aop.api.request.AlipayTradeQueryRequest import AlipayTradeQueryRequest
from alipay.aop.api.request.AlipayTradeCloseRequest import AlipayTradeCloseRequest
from alipay.aop.api.response.AlipayTradeQueryResponse import AlipayTradeQueryResponse
from alipay.aop.api.response.AlipayTradeCloseResponse import AlipayTradeCloseResponse
from alipay.aop.api.util.SignatureUtils import verify_with_rsa

from config import settings
from utils.logger import get_logger

logger = get_logger(__name__)

# Configure alipay SDK logging
logging.getLogger('alipay').setLevel(logging.INFO)


class AlipayService:
    """Alipay payment service using official SDK"""

    def __init__(self):
        self.app_id = settings.alipay_app_id
        self.private_key = settings.alipay_private_key
        self.public_key = settings.alipay_public_key
        self.notify_url = settings.alipay_notify_url
        self.return_url = settings.alipay_return_url
        self.gateway = settings.alipay_gateway
        self._client = None

    def _get_client(self) -> DefaultAlipayClient:
        """Get or create Alipay client"""
        if self._client is None:
            logger.info(f"Initializing Alipay client: app_id={self.app_id}, gateway={self.gateway}")
            logger.info(f"Config check - app_id: {'SET' if self.app_id else 'NOT SET'}, private_key: {'SET' if self.private_key else 'NOT SET'}, public_key: {'SET' if self.public_key else 'NOT SET'}")
            
            if not self.app_id or not self.private_key or not self.public_key:
                error_msg = f"Alipay is not configured - app_id: {bool(self.app_id)}, private_key: {bool(self.private_key)}, public_key: {bool(self.public_key)}"
                logger.error(error_msg)
                raise ValueError(error_msg)

            # Configure client
            config = AlipayClientConfig()
            config.server_url = self.gateway
            config.app_id = self.app_id
            config.app_private_key = self.private_key
            config.alipay_public_key = self.public_key

            logger.info("Creating DefaultAlipayClient instance")
            self._client = DefaultAlipayClient(alipay_client_config=config, logger=logger)
            logger.info("Alipay client initialized successfully")

        return self._client

    async def create_subscription_order(
        self,
        order_id: str,
        amount: float,
        subject: str = "象信AI安全护栏订阅服务",
        body: str = "象信AI安全护栏月度订阅"
    ) -> Dict[str, Any]:
        """
        Create a subscription payment order (PC page payment)

        Args:
            order_id: Unique order ID
            amount: Payment amount in CNY
            subject: Payment subject
            body: Payment description

        Returns:
            Dict containing payment URL
        """
        try:
            client = self._get_client()

            # Build payment model
            model = AlipayTradePagePayModel()
            model.out_trade_no = order_id
            model.total_amount = f"{amount:.2f}"
            model.subject = subject
            model.body = body
            model.product_code = "FAST_INSTANT_TRADE_PAY"

            # Create request
            request = AlipayTradePagePayRequest(biz_model=model)
            request.notify_url = self.notify_url
            request.return_url = self.return_url

            # Execute and get redirect URL
            payment_url = client.page_execute(request, http_method="GET")

            logger.info(f"Created Alipay subscription order: {order_id}, amount: {amount}")

            return {
                "order_id": order_id,
                "payment_url": payment_url,
                "amount": amount,
                "currency": "CNY"
            }

        except Exception as e:
            logger.error(f"Failed to create Alipay order: {traceback.format_exc()}")
            raise

    async def create_package_order(
        self,
        order_id: str,
        amount: float,
        package_name: str
    ) -> Dict[str, Any]:
        """
        Create a package purchase payment order

        Args:
            order_id: Unique order ID
            amount: Payment amount in CNY
            package_name: Name of the package being purchased

        Returns:
            Dict containing payment URL
        """
        return await self.create_subscription_order(
            order_id=order_id,
            amount=amount,
            subject=f"象信AI安全护栏 - {package_name}",
            body=f"购买扫描器包: {package_name}"
        )

    async def query_order(self, order_id: str) -> Dict[str, Any]:
        """
        Query order status from Alipay

        Args:
            order_id: Order ID to query

        Returns:
            Order status information
        """
        try:
            client = self._get_client()

            # Build query model
            model = AlipayTradeQueryModel()
            model.out_trade_no = order_id

            # Create request
            request = AlipayTradeQueryRequest(biz_model=model)

            # Execute
            response_content = client.execute(request)

            if not response_content:
                return {"success": False, "error": "No response from Alipay"}

            response = AlipayTradeQueryResponse()
            response.parse_response_content(response_content)

            if response.is_success():
                return {
                    "success": True,
                    "trade_no": response.trade_no,
                    "out_trade_no": response.out_trade_no,
                    "trade_status": response.trade_status,
                    "total_amount": response.total_amount,
                    "buyer_user_id": response.buyer_user_id
                }
            else:
                return {
                    "success": False,
                    "code": response.code,
                    "msg": response.msg,
                    "sub_code": response.sub_code,
                    "sub_msg": response.sub_msg
                }

        except Exception as e:
            logger.error(f"Failed to query Alipay order: {traceback.format_exc()}")
            return {"success": False, "error": str(e)}

    async def close_order(self, order_id: str) -> Dict[str, Any]:
        """
        Close an unpaid order

        Args:
            order_id: Order ID to close

        Returns:
            Close result
        """
        try:
            client = self._get_client()

            # Build close model
            model = AlipayTradeCloseModel()
            model.out_trade_no = order_id

            # Create request
            request = AlipayTradeCloseRequest(biz_model=model)

            # Execute
            response_content = client.execute(request)

            if not response_content:
                return {"success": False, "error": "No response from Alipay"}

            response = AlipayTradeCloseResponse()
            response.parse_response_content(response_content)

            if response.is_success():
                return {"success": True, "trade_no": response.trade_no}
            else:
                return {
                    "success": False,
                    "code": response.code,
                    "msg": response.msg
                }

        except Exception as e:
            logger.error(f"Failed to close Alipay order: {traceback.format_exc()}")
            return {"success": False, "error": str(e)}

    def verify_callback(self, params: Dict[str, Any]) -> bool:
        """
        Verify Alipay callback notification signature

        Args:
            params: Callback parameters from Alipay

        Returns:
            True if signature is valid
        """
        try:
            if not self.public_key:
                logger.error("Alipay public key not configured")
                return False

            signature = params.get('sign', '')
            sign_type = params.get('sign_type', 'RSA2')

            if not signature:
                logger.error("No signature in callback params")
                return False

            # Remove sign and sign_type from params for verification
            verify_params = {k: v for k, v in params.items() if k not in ['sign', 'sign_type']}

            # Sort and create sign string
            sorted_params = sorted(verify_params.items())
            sign_string = "&".join([f"{k}={v}" for k, v in sorted_params if v])

            # Verify signature
            result = verify_with_rsa(
                self.public_key,
                sign_string.encode('utf-8'),
                signature
            )

            return result

        except Exception as e:
            logger.error(f"Signature verification failed: {traceback.format_exc()}")
            return False

    async def create_subscription_agreement(
        self,
        order_id: str,
        amount: float,
        tier_name: str = "订阅服务"
    ) -> Dict[str, Any]:
        """
        Create Alipay recurring billing agreement (周期扣款签约)
        Uses alipay.user.agreement.page.sign API

        Args:
            order_id: Unique order/external agreement ID
            amount: Monthly deduction amount in CNY
            tier_name: Tier name for display

        Returns:
            Dict containing signing page URL
        """
        try:
            client = self._get_client()

            from alipay.aop.api.domain.AlipayUserAgreementPageSignModel import AlipayUserAgreementPageSignModel
            from alipay.aop.api.request.AlipayUserAgreementPageSignRequest import AlipayUserAgreementPageSignRequest
            from alipay.aop.api.domain.PeriodRuleParams import PeriodRuleParams

            model = AlipayUserAgreementPageSignModel()
            model.personal_product_code = "CYCLE_PAY_AUTH"
            model.sign_scene = "INDUSTRY|DIGITAL_MEDIA"
            model.external_agreement_no = order_id
            model.access_params = {"channel": "ALIPAYAPP"}

            # Period rule: monthly deduction
            period_rule = PeriodRuleParams()
            period_rule.period_type = "MONTH"
            period_rule.period = 1
            period_rule.single_amount = f"{amount:.2f}"
            period_rule.total_amount = f"{amount * 12:.2f}"  # Max 12 months
            period_rule.total_payments = 12
            period_rule.execute_time = datetime.now().strftime("%Y-%m-%d")
            model.period_rule_params = period_rule

            model.product_code = "GENERAL_WITHHOLDING"

            request = AlipayUserAgreementPageSignRequest(biz_model=model)
            request.return_url = self.return_url
            request.notify_url = self.notify_url

            signing_url = client.page_execute(request, http_method="GET")

            logger.info(f"Created Alipay agreement signing: order={order_id}, amount={amount}, tier={tier_name}")

            return {
                "order_id": order_id,
                "signing_url": signing_url,
                "amount": amount
            }

        except ImportError:
            logger.warning("Alipay agreement signing SDK classes not available, falling back to page pay")
            # Fallback to regular page pay if SDK doesn't support agreement signing
            return await self.create_subscription_order(
                order_id=order_id,
                amount=amount,
                subject=f"象信AI安全护栏 - {tier_name}",
                body=f"订阅套餐: {tier_name}"
            )
        except Exception as e:
            logger.error(f"Failed to create Alipay agreement: {traceback.format_exc()}")
            raise

    async def execute_agreement_pay(
        self,
        agreement_no: str,
        amount: float,
        order_id: str
    ) -> Dict[str, Any]:
        """
        Execute recurring deduction using agreement (代扣执行)

        Args:
            agreement_no: Alipay agreement number
            amount: Deduction amount
            order_id: Unique order ID for this deduction

        Returns:
            Payment result
        """
        try:
            client = self._get_client()

            from alipay.aop.api.domain.AlipayTradePayModel import AlipayTradePayModel
            from alipay.aop.api.request.AlipayTradePayRequest import AlipayTradePayRequest
            from alipay.aop.api.response.AlipayTradePayResponse import AlipayTradePayResponse

            model = AlipayTradePayModel()
            model.out_trade_no = order_id
            model.total_amount = f"{amount:.2f}"
            model.subject = "象信AI安全护栏月度订阅续费"
            model.product_code = "GENERAL_WITHHOLDING"
            model.agreement_params = {"agreement_no": agreement_no}

            request = AlipayTradePayRequest(biz_model=model)
            response_content = client.execute(request)

            if not response_content:
                return {"success": False, "error": "No response from Alipay"}

            response = AlipayTradePayResponse()
            response.parse_response_content(response_content)

            if response.is_success():
                logger.info(f"Agreement pay executed: order={order_id}, agreement={agreement_no}")
                return {
                    "success": True,
                    "trade_no": response.trade_no,
                    "out_trade_no": response.out_trade_no
                }
            else:
                logger.warning(f"Agreement pay failed: {response.sub_code} - {response.sub_msg}")
                return {
                    "success": False,
                    "code": response.code,
                    "msg": response.msg,
                    "sub_code": response.sub_code,
                    "sub_msg": response.sub_msg
                }

        except ImportError:
            logger.error("Alipay agreement pay SDK classes not available")
            return {"success": False, "error": "Agreement pay not supported"}
        except Exception as e:
            logger.error(f"Failed to execute agreement pay: {traceback.format_exc()}")
            return {"success": False, "error": str(e)}

    async def unsign_agreement(self, agreement_no: str) -> Dict[str, Any]:
        """
        Cancel recurring billing agreement (解约)

        Args:
            agreement_no: Alipay agreement number

        Returns:
            Unsign result
        """
        try:
            client = self._get_client()

            from alipay.aop.api.domain.AlipayUserAgreementUnsignModel import AlipayUserAgreementUnsignModel
            from alipay.aop.api.request.AlipayUserAgreementUnsignRequest import AlipayUserAgreementUnsignRequest
            from alipay.aop.api.response.AlipayUserAgreementUnsignResponse import AlipayUserAgreementUnsignResponse

            model = AlipayUserAgreementUnsignModel()
            model.agreement_no = agreement_no
            model.personal_product_code = "CYCLE_PAY_AUTH"

            request = AlipayUserAgreementUnsignRequest(biz_model=model)
            response_content = client.execute(request)

            if not response_content:
                return {"success": False, "error": "No response from Alipay"}

            response = AlipayUserAgreementUnsignResponse()
            response.parse_response_content(response_content)

            if response.is_success():
                logger.info(f"Agreement unsigned: {agreement_no}")
                return {"success": True}
            else:
                logger.warning(f"Agreement unsign failed: {response.sub_code} - {response.sub_msg}")
                return {
                    "success": False,
                    "code": response.code,
                    "msg": response.msg
                }

        except ImportError:
            logger.error("Alipay agreement unsign SDK classes not available")
            return {"success": False, "error": "Agreement unsign not supported"}
        except Exception as e:
            logger.error(f"Failed to unsign agreement: {traceback.format_exc()}")
            return {"success": False, "error": str(e)}

    def parse_callback(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Parse Alipay callback notification

        Args:
            params: Callback parameters from Alipay

        Returns:
            Parsed payment result
        """
        return {
            "order_id": params.get("out_trade_no"),
            "transaction_id": params.get("trade_no"),
            "amount": float(params.get("total_amount", 0)),
            "status": params.get("trade_status"),
            "paid_at": params.get("gmt_payment"),
            "buyer_id": params.get("buyer_id"),
        }


# Global instance
alipay_service = AlipayService()
