"""
Stripe payment service for international users
Uses Stripe SDK for payment processing
"""

import stripe
from stripe import _error as stripe_error
from datetime import datetime
from typing import Optional, Dict, Any
from urllib.parse import quote

from config import settings
from utils.logger import get_logger

logger = get_logger(__name__)


class StripeService:
    """Stripe payment service"""

    def __init__(self):
        self.secret_key = settings.stripe_secret_key
        self.publishable_key = settings.stripe_publishable_key
        self.webhook_secret = settings.stripe_webhook_secret
        self.price_id_monthly = settings.stripe_price_id_monthly

        # Initialize Stripe
        if self.secret_key:
            stripe.api_key = self.secret_key

    async def customer_exists(self, customer_id: str) -> bool:
        """
        Check if a Stripe customer exists

        Args:
            customer_id: Stripe customer ID

        Returns:
            True if customer exists, False otherwise
        """
        if not self.secret_key:
            return False

        try:
            stripe.Customer.retrieve(customer_id)
            return True
        except stripe_error.InvalidRequestError as e:
            if 'No such customer' in str(e):
                logger.warning(f"Stripe customer not found: {customer_id}")
                return False
            raise
        except Exception as e:
            logger.error(f"Error checking customer existence: {e}")
            return False

    async def create_customer(
        self,
        email: str,
        tenant_id: str,
        name: Optional[str] = None
    ) -> str:
        """
        Create a Stripe customer

        Args:
            email: Customer email
            tenant_id: Tenant ID for metadata
            name: Customer name

        Returns:
            Stripe customer ID
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        customer = stripe.Customer.create(
            email=email,
            name=name,
            metadata={
                "tenant_id": str(tenant_id)
            }
        )

        logger.info(f"Created Stripe customer: {customer.id} for tenant: {tenant_id}")
        return customer.id

    async def create_subscription_checkout(
        self,
        customer_id: str,
        success_url: str,
        cancel_url: str,
        tenant_id: str,
        price_id: Optional[str] = None,
        tier_number: Optional[int] = None
    ) -> Dict[str, Any]:
        """
        Create a Stripe Checkout session for subscription

        Args:
            customer_id: Stripe customer ID
            success_url: URL to redirect after successful payment
            cancel_url: URL to redirect after cancelled payment
            tenant_id: Tenant ID for metadata
            price_id: Optional tier-specific Stripe Price ID (overrides default)
            tier_number: Optional tier number for metadata

        Returns:
            Dict containing checkout session URL
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        # Use tier-specific price_id if provided, otherwise fall back to default
        effective_price_id = price_id or self.price_id_monthly
        if not effective_price_id:
            raise ValueError("Stripe price ID not configured")

        # Strip any surrounding quotes from URLs (in case .env file has quoted values)
        success_url = success_url.strip('\'"')
        cancel_url = cancel_url.strip('\'"')

        # Ensure URLs are ASCII-encoded (Stripe requirement)
        # encode('ascii') will fail if there are non-ASCII chars, so we encode to UTF-8 bytes then decode
        try:
            success_url_encoded = success_url.encode('ascii').decode('ascii')
            cancel_url_encoded = cancel_url.encode('ascii').decode('ascii')
        except UnicodeEncodeError:
            # If URLs contain non-ASCII, encode them properly
            logger.warning(f"URLs contain non-ASCII characters, encoding them")
            success_url_encoded = quote(success_url, safe=':/?#[]@!$&\'()*+,;=')
            cancel_url_encoded = quote(cancel_url, safe=':/?#[]@!$&\'()*+,;=')

        checkout_metadata = {
            "tenant_id": str(tenant_id),
            "order_type": "subscription"
        }
        if tier_number is not None:
            checkout_metadata["tier_number"] = str(tier_number)

        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price': effective_price_id,
                'quantity': 1,
            }],
            mode='subscription',
            success_url=success_url_encoded,
            cancel_url=cancel_url_encoded,
            metadata=checkout_metadata
        )

        logger.info(f"Created Stripe checkout session: {session.id}")

        return {
            "session_id": session.id,
            "checkout_url": session.url,
            "customer_id": customer_id
        }

    async def create_package_checkout(
        self,
        customer_id: str,
        amount: int,  # Amount in cents
        package_id: str,
        package_name: str,
        success_url: str,
        cancel_url: str,
        tenant_id: str
    ) -> Dict[str, Any]:
        """
        Create a Stripe Checkout session for one-time package purchase

        Args:
            customer_id: Stripe customer ID
            amount: Amount in cents (USD)
            package_id: Package ID being purchased
            package_name: Package name for display
            success_url: URL to redirect after successful payment
            cancel_url: URL to redirect after cancelled payment
            tenant_id: Tenant ID for metadata

        Returns:
            Dict containing checkout session URL
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        # Strip any surrounding quotes from URLs (in case .env file has quoted values)
        success_url = success_url.strip('\'"')
        cancel_url = cancel_url.strip('\'"')

        # Ensure URLs are ASCII-encoded (Stripe requirement)
        try:
            success_url_encoded = success_url.encode('ascii').decode('ascii')
            cancel_url_encoded = cancel_url.encode('ascii').decode('ascii')
        except UnicodeEncodeError:
            # If URLs contain non-ASCII, encode them properly
            logger.warning(f"URLs contain non-ASCII characters, encoding them")
            success_url_encoded = quote(success_url, safe=':/?#[]@!$&\'()*+,;=')
            cancel_url_encoded = quote(cancel_url, safe=':/?#[]@!$&\'()*+,;=')

        # Ensure package name is ASCII-safe (Stripe doesn't accept non-ASCII in product names)
        # If package name contains non-ASCII, we'll use a sanitized version for Stripe
        # but keep the original in metadata for our records
        try:
            package_name_safe = package_name.encode('ascii').decode('ascii')
        except UnicodeEncodeError:
            # Package name has non-ASCII characters - use generic name for Stripe display
            logger.warning(f"Package name contains non-ASCII characters: {package_name}")
            package_name_safe = f"Scanner Package (ID: {package_id[:8]})"

        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=['card'],
            line_items=[{
                'price_data': {
                    'currency': 'usd',
                    'product_data': {
                        'name': package_name_safe,
                        'description': 'OpenGuardrails Scanner Package',
                    },
                    'unit_amount': amount,
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=success_url_encoded,
            cancel_url=cancel_url_encoded,
            metadata={
                "tenant_id": str(tenant_id),
                "package_id": str(package_id),
                "package_name": package_name,  # Store original name in metadata
                "order_type": "package"
            }
        )

        logger.info(f"Created Stripe package checkout session: {session.id}")

        return {
            "session_id": session.id,
            "checkout_url": session.url,
            "customer_id": customer_id
        }

    async def get_checkout_session(self, session_id: str) -> Optional[Dict[str, Any]]:
        """
        Retrieve a Stripe Checkout session by ID
        Used as fallback to check payment status when webhook hasn't arrived

        Args:
            session_id: Stripe checkout session ID

        Returns:
            Session details including payment_status
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        try:
            session = stripe.checkout.Session.retrieve(session_id)

            logger.info(f"Retrieved Stripe session {session_id}: status={session.status}, payment_status={session.payment_status}")

            return {
                "id": session.id,
                "status": session.status,
                "payment_status": session.payment_status,
                "customer": session.customer,
                "subscription": session.subscription,
                "payment_intent": session.payment_intent,
                "amount_total": session.amount_total,
                "currency": session.currency,
                "metadata": session.metadata
            }
        except stripe_error.StripeError as e:
            logger.error(f"Failed to retrieve Stripe session {session_id}: {e}")
            return None

    async def create_payment_intent(
        self,
        amount: int,  # Amount in cents
        currency: str = "usd",
        customer_id: Optional[str] = None,
        metadata: Optional[Dict[str, str]] = None
    ) -> Dict[str, Any]:
        """
        Create a Stripe PaymentIntent for custom payment flows

        Args:
            amount: Amount in cents
            currency: Currency code
            customer_id: Optional Stripe customer ID
            metadata: Optional metadata

        Returns:
            Dict containing client_secret for frontend
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        intent_params = {
            "amount": amount,
            "currency": currency,
            "automatic_payment_methods": {"enabled": True},
        }

        if customer_id:
            intent_params["customer"] = customer_id

        if metadata:
            intent_params["metadata"] = metadata

        intent = stripe.PaymentIntent.create(**intent_params)

        logger.info(f"Created PaymentIntent: {intent.id}")

        return {
            "client_secret": intent.client_secret,
            "payment_intent_id": intent.id
        }

    async def cancel_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Cancel a Stripe subscription at period end

        Args:
            subscription_id: Stripe subscription ID

        Returns:
            Updated subscription info
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        subscription = stripe.Subscription.modify(
            subscription_id,
            cancel_at_period_end=True
        )

        logger.info(f"Cancelled subscription: {subscription_id} at period end")

        return {
            "subscription_id": subscription.id,
            "status": subscription.status,
            "cancel_at_period_end": subscription.cancel_at_period_end,
            "current_period_end": datetime.fromtimestamp(subscription.current_period_end)
        }

    async def reactivate_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Reactivate a cancelled subscription

        Args:
            subscription_id: Stripe subscription ID

        Returns:
            Updated subscription info
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        subscription = stripe.Subscription.modify(
            subscription_id,
            cancel_at_period_end=False
        )

        logger.info(f"Reactivated subscription: {subscription_id}")

        return {
            "subscription_id": subscription.id,
            "status": subscription.status,
            "cancel_at_period_end": subscription.cancel_at_period_end
        }

    async def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Get subscription details

        Args:
            subscription_id: Stripe subscription ID

        Returns:
            Subscription details
        """
        if not self.secret_key:
            raise ValueError("Stripe is not configured")

        subscription = stripe.Subscription.retrieve(subscription_id)

        return {
            "subscription_id": subscription.id,
            "status": subscription.status,
            "current_period_start": datetime.fromtimestamp(subscription.current_period_start),
            "current_period_end": datetime.fromtimestamp(subscription.current_period_end),
            "cancel_at_period_end": subscription.cancel_at_period_end,
            "customer_id": subscription.customer
        }

    def verify_webhook(self, payload: bytes, sig_header: str) -> Dict[str, Any]:
        """
        Verify and parse Stripe webhook event

        Args:
            payload: Raw request body
            sig_header: Stripe-Signature header

        Returns:
            Parsed webhook event
        """
        if not self.webhook_secret:
            raise ValueError("Stripe webhook secret not configured")

        event = stripe.Webhook.construct_event(
            payload, sig_header, self.webhook_secret
        )

        return event

    def parse_checkout_completed(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Parse checkout.session.completed event

        Args:
            event: Stripe webhook event

        Returns:
            Parsed checkout result
        """
        session = event['data']['object']

        result = {
            "session_id": session.get('id'),
            "customer_id": session.get('customer'),
            "subscription_id": session.get('subscription'),
            "payment_intent_id": session.get('payment_intent'),
            "amount_total": session.get('amount_total'),
            "currency": session.get('currency'),
            "payment_status": session.get('payment_status'),
            "metadata": session.get('metadata', {}),
        }

        return result

    def parse_invoice_paid(self, event: Dict[str, Any]) -> Dict[str, Any]:
        """
        Parse invoice.paid event (for recurring subscription payments)

        Args:
            event: Stripe webhook event

        Returns:
            Parsed invoice result
        """
        invoice = event['data']['object']

        return {
            "invoice_id": invoice.get('id'),
            "customer_id": invoice.get('customer'),
            "subscription_id": invoice.get('subscription'),
            "amount_paid": invoice.get('amount_paid'),
            "currency": invoice.get('currency'),
            "period_start": datetime.fromtimestamp(invoice['period_start']) if invoice.get('period_start') else None,
            "period_end": datetime.fromtimestamp(invoice['period_end']) if invoice.get('period_end') else None,
        }

    def get_publishable_key(self) -> str:
        """Get publishable key for frontend"""
        return self.publishable_key


# Global instance
stripe_service = StripeService()
