"""
Payment service - Unified payment handling for both Alipay and Stripe
Automatically selects payment provider based on DEFAULT_LANGUAGE configuration
"""

import uuid
from datetime import datetime, timedelta
from typing import Optional, Dict, Any
from urllib.parse import quote
from sqlalchemy.orm import Session
from sqlalchemy import and_

from config import settings
from database.models import (
    PaymentOrder, SubscriptionPayment, TenantSubscription,
    Tenant, ScannerPackage, PackagePurchase
)
from services.alipay_service import alipay_service
from services.stripe_service import stripe_service
from services.billing_service import billing_service
from utils.logger import get_logger

logger = get_logger(__name__)


class PaymentService:
    """Unified payment service that handles both Alipay and Stripe"""

    def __init__(self):
        pass

    def get_payment_provider(self) -> str:
        """Get payment provider based on DEFAULT_LANGUAGE"""
        if settings.default_language == 'zh':
            return 'alipay'
        return 'stripe'

    def get_currency(self) -> str:
        """Get currency based on payment provider"""
        if self.get_payment_provider() == 'alipay':
            return 'CNY'
        return 'USD'

    def get_subscription_price(self) -> float:
        """Get subscription price based on currency"""
        if self.get_payment_provider() == 'alipay':
            return settings.subscription_price_cny
        return settings.subscription_price_usd

    async def create_subscription_payment(
        self,
        db: Session,
        tenant_id: str,
        email: str
    ) -> Dict[str, Any]:
        """
        Create a subscription payment order

        Args:
            db: Database session
            tenant_id: Tenant ID
            email: Tenant email

        Returns:
            Payment creation result with redirect URL
        """
        provider = self.get_payment_provider()
        currency = self.get_currency()
        amount = self.get_subscription_price()

        logger.info(f"Creating subscription payment: provider={provider}, currency={currency}, amount={amount}, tenant_id={tenant_id}")

        # Generate order ID
        order_id = f"sub_{uuid.uuid4().hex[:16]}"

        # Create payment order in database
        payment_order = PaymentOrder(
            tenant_id=tenant_id,
            order_type='subscription',
            amount=amount,
            currency=currency,
            payment_provider=provider,
            status='pending',
            provider_order_id=order_id,
            order_metadata={'email': email}
        )
        db.add(payment_order)
        db.commit()
        db.refresh(payment_order)
        logger.info(f"Payment order created in database: {order_id}")

        try:
            if provider == 'alipay':
                logger.info(f"Creating Alipay subscription order: {order_id}")
                # Create Alipay payment
                result = await alipay_service.create_subscription_order(
                    order_id=order_id,
                    amount=amount
                )
                return {
                    "success": True,
                    "payment_id": str(payment_order.id),
                    "order_id": order_id,
                    "provider": "alipay",
                    "payment_url": result["payment_url"],
                    "amount": amount,
                    "currency": currency
                }
            else:
                # Create Stripe payment
                # Get or create Stripe customer
                subscription = db.query(TenantSubscription).filter(
                    TenantSubscription.tenant_id == tenant_id
                ).first()

                customer_id = subscription.stripe_customer_id if subscription else None

                # Verify customer exists in Stripe, create new one if not
                if customer_id:
                    customer_exists = await stripe_service.customer_exists(customer_id)
                    if not customer_exists:
                        logger.warning(f"Stored customer {customer_id} not found in Stripe, creating new customer for tenant {tenant_id}")
                        customer_id = None

                if not customer_id:
                    customer_id = await stripe_service.create_customer(
                        email=email,
                        tenant_id=tenant_id
                    )
                    # Update subscription with customer ID
                    if subscription:
                        subscription.stripe_customer_id = customer_id
                        db.commit()

                # Create checkout session
                # Use configured URLs if available, otherwise use frontend_url
                if settings.stripe_subscription_success_url:
                    success_url = settings.stripe_subscription_success_url
                else:
                    success_url = f"{settings.frontend_url}/platform/subscription?payment=success&session_id={{CHECKOUT_SESSION_ID}}"

                if settings.stripe_subscription_cancel_url:
                    cancel_url = settings.stripe_subscription_cancel_url
                else:
                    cancel_url = f"{settings.frontend_url}/platform/subscription?payment=cancelled"

                result = await stripe_service.create_subscription_checkout(
                    customer_id=customer_id,
                    success_url=success_url,
                    cancel_url=cancel_url,
                    tenant_id=tenant_id
                )

                # Update order with session ID
                payment_order.order_metadata = {
                    **payment_order.order_metadata,
                    'stripe_session_id': result['session_id']
                }
                db.commit()

                return {
                    "success": True,
                    "payment_id": str(payment_order.id),
                    "order_id": order_id,
                    "provider": "stripe",
                    "checkout_url": result["checkout_url"],
                    "session_id": result["session_id"],
                    "amount": amount,
                    "currency": currency
                }

        except Exception as e:
            logger.error(f"Failed to create subscription payment: {e}")
            payment_order.status = 'failed'
            db.commit()
            raise

    async def create_package_payment(
        self,
        db: Session,
        tenant_id: str,
        email: str,
        package_id: str
    ) -> Dict[str, Any]:
        """
        Create a package purchase payment order

        Args:
            db: Database session
            tenant_id: Tenant ID
            email: Tenant email
            package_id: Package ID to purchase

        Returns:
            Payment creation result with redirect URL
        """
        # Get package details
        package = db.query(ScannerPackage).filter(
            ScannerPackage.id == package_id
        ).first()

        if not package:
            raise ValueError("Package not found")

        if not package.price:
            raise ValueError("Package price not set")

        provider = self.get_payment_provider()
        currency = self.get_currency()
        amount = package.price

        # Generate order ID
        order_id = f"pkg_{uuid.uuid4().hex[:16]}"

        # Create payment order in database
        payment_order = PaymentOrder(
            tenant_id=tenant_id,
            order_type='package',
            amount=amount,
            currency=currency,
            payment_provider=provider,
            status='pending',
            provider_order_id=order_id,
            package_id=package_id,
            order_metadata={
                'email': email,
                'package_name': package.package_name
            }
        )
        db.add(payment_order)
        db.commit()
        db.refresh(payment_order)

        try:
            if provider == 'alipay':
                # Create Alipay payment
                result = await alipay_service.create_package_order(
                    order_id=order_id,
                    amount=amount,
                    package_name=package.package_name
                )
                return {
                    "success": True,
                    "payment_id": str(payment_order.id),
                    "order_id": order_id,
                    "provider": "alipay",
                    "payment_url": result["payment_url"],
                    "amount": amount,
                    "currency": currency,
                    "package_name": package.package_name
                }
            else:
                # Create Stripe payment
                subscription = db.query(TenantSubscription).filter(
                    TenantSubscription.tenant_id == tenant_id
                ).first()

                customer_id = subscription.stripe_customer_id if subscription else None

                # Verify customer exists in Stripe, create new one if not
                if customer_id:
                    customer_exists = await stripe_service.customer_exists(customer_id)
                    if not customer_exists:
                        logger.warning(f"Stored customer {customer_id} not found in Stripe, creating new customer for tenant {tenant_id}")
                        customer_id = None

                if not customer_id:
                    customer_id = await stripe_service.create_customer(
                        email=email,
                        tenant_id=tenant_id
                    )
                    if subscription:
                        subscription.stripe_customer_id = customer_id
                        db.commit()

                # Create checkout session
                # Use configured URLs if available, otherwise use frontend_url
                if settings.stripe_package_success_url:
                    success_url = settings.stripe_package_success_url
                else:
                    success_url = f"{settings.frontend_url}/platform/config/scanner-packages?payment=success&session_id={{CHECKOUT_SESSION_ID}}"

                if settings.stripe_package_cancel_url:
                    cancel_url = settings.stripe_package_cancel_url
                else:
                    cancel_url = f"{settings.frontend_url}/platform/config/scanner-packages?payment=cancelled"

                # Amount in cents for Stripe
                amount_cents = int(amount * 100)

                result = await stripe_service.create_package_checkout(
                    customer_id=customer_id,
                    amount=amount_cents,
                    package_id=package_id,
                    package_name=package.package_name,
                    success_url=success_url,
                    cancel_url=cancel_url,
                    tenant_id=tenant_id
                )

                # Update order with session ID
                payment_order.order_metadata = {
                    **payment_order.order_metadata,
                    'stripe_session_id': result['session_id']
                }
                db.commit()

                return {
                    "success": True,
                    "payment_id": str(payment_order.id),
                    "order_id": order_id,
                    "provider": "stripe",
                    "checkout_url": result["checkout_url"],
                    "session_id": result["session_id"],
                    "amount": amount,
                    "currency": currency,
                    "package_name": package.package_name
                }

        except Exception as e:
            logger.error(f"Failed to create package payment: {e}")
            payment_order.status = 'failed'
            db.commit()
            raise

    async def handle_subscription_paid(
        self,
        db: Session,
        order_id: str,
        transaction_id: str,
        paid_at: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Handle successful subscription payment

        Args:
            db: Database session
            order_id: Provider order ID
            transaction_id: Provider transaction ID
            paid_at: Payment timestamp

        Returns:
            Processing result
        """
        # Find payment order
        payment_order = db.query(PaymentOrder).filter(
            PaymentOrder.provider_order_id == order_id
        ).first()

        if not payment_order:
            logger.error(f"Payment order not found: {order_id}")
            return {"success": False, "error": "Order not found"}

        if payment_order.status == 'paid':
            logger.info(f"Order already processed: {order_id}")
            return {"success": True, "message": "Already processed"}

        # Update payment order
        payment_order.status = 'paid'
        payment_order.provider_transaction_id = transaction_id
        payment_order.paid_at = paid_at or datetime.utcnow()

        # Update tenant subscription
        subscription = db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == payment_order.tenant_id
        ).first()

        if subscription:
            now = datetime.utcnow()
            subscription.subscription_type = 'subscribed'
            subscription.monthly_quota = billing_service.SUBSCRIPTION_CONFIGS['subscribed']['monthly_quota']
            subscription.subscription_started_at = now
            subscription.subscription_expires_at = now + timedelta(days=30)

        # Create subscription payment record
        billing_start = datetime.utcnow()
        billing_end = billing_start + timedelta(days=30)

        sub_payment = SubscriptionPayment(
            tenant_id=payment_order.tenant_id,
            payment_order_id=payment_order.id,
            billing_cycle_start=billing_start,
            billing_cycle_end=billing_end,
            status='active',
            next_payment_date=billing_end,
            next_payment_amount=payment_order.amount
        )
        db.add(sub_payment)

        db.commit()

        logger.info(f"Subscription activated for tenant: {payment_order.tenant_id}")

        return {
            "success": True,
            "tenant_id": str(payment_order.tenant_id),
            "subscription_type": "subscribed"
        }

    async def handle_package_paid(
        self,
        db: Session,
        order_id: str,
        transaction_id: str,
        paid_at: Optional[datetime] = None
    ) -> Dict[str, Any]:
        """
        Handle successful package purchase payment

        Args:
            db: Database session
            order_id: Provider order ID
            transaction_id: Provider transaction ID
            paid_at: Payment timestamp

        Returns:
            Processing result
        """
        # Find payment order
        payment_order = db.query(PaymentOrder).filter(
            PaymentOrder.provider_order_id == order_id
        ).first()

        if not payment_order:
            logger.error(f"Payment order not found: {order_id}")
            return {"success": False, "error": "Order not found"}

        if payment_order.status == 'paid':
            logger.info(f"Order already processed: {order_id}")
            return {"success": True, "message": "Already processed"}

        # Update payment order
        payment_order.status = 'paid'
        payment_order.provider_transaction_id = transaction_id
        payment_order.paid_at = paid_at or datetime.utcnow()

        # Create or update package purchase record
        existing_purchase = db.query(PackagePurchase).filter(
            and_(
                PackagePurchase.tenant_id == payment_order.tenant_id,
                PackagePurchase.package_id == payment_order.package_id
            )
        ).first()

        if existing_purchase:
            existing_purchase.status = 'approved'
            existing_purchase.approved_at = datetime.utcnow()
        else:
            purchase = PackagePurchase(
                tenant_id=payment_order.tenant_id,
                package_id=payment_order.package_id,
                status='approved',
                request_email=payment_order.order_metadata.get('email', '') if payment_order.order_metadata else '',
                approved_at=datetime.utcnow()
            )
            db.add(purchase)

        db.commit()

        logger.info(f"Package purchase completed for tenant: {payment_order.tenant_id}, package: {payment_order.package_id}")

        return {
            "success": True,
            "tenant_id": str(payment_order.tenant_id),
            "package_id": str(payment_order.package_id)
        }

    async def cancel_subscription(
        self,
        db: Session,
        tenant_id: str
    ) -> Dict[str, Any]:
        """
        Cancel a subscription

        Args:
            db: Database session
            tenant_id: Tenant ID

        Returns:
            Cancellation result
        """
        # Find active subscription payment
        sub_payment = db.query(SubscriptionPayment).filter(
            and_(
                SubscriptionPayment.tenant_id == tenant_id,
                SubscriptionPayment.status == 'active'
            )
        ).first()

        if not sub_payment:
            return {"success": False, "error": "No active subscription found"}

        provider = self.get_payment_provider()

        if provider == 'stripe' and sub_payment.stripe_subscription_id:
            # Cancel Stripe subscription at period end
            await stripe_service.cancel_subscription(sub_payment.stripe_subscription_id)

        # Mark subscription to cancel at period end
        sub_payment.cancel_at_period_end = True
        db.commit()

        logger.info(f"Subscription cancellation scheduled for tenant: {tenant_id}")

        return {
            "success": True,
            "cancel_at": sub_payment.billing_cycle_end.isoformat() if sub_payment.billing_cycle_end else None
        }

    def get_payment_orders(
        self,
        db: Session,
        tenant_id: str,
        order_type: Optional[str] = None,
        status: Optional[str] = None,
        limit: int = 50
    ) -> list:
        """
        Get payment orders for a tenant

        Args:
            db: Database session
            tenant_id: Tenant ID
            order_type: Filter by order type
            status: Filter by status
            limit: Maximum number of results

        Returns:
            List of payment orders
        """
        query = db.query(PaymentOrder).filter(
            PaymentOrder.tenant_id == tenant_id
        )

        if order_type:
            query = query.filter(PaymentOrder.order_type == order_type)

        if status:
            query = query.filter(PaymentOrder.status == status)

        orders = query.order_by(PaymentOrder.created_at.desc()).limit(limit).all()

        return [
            {
                "id": str(order.id),
                "order_type": order.order_type,
                "amount": order.amount,
                "currency": order.currency,
                "payment_provider": order.payment_provider,
                "status": order.status,
                "paid_at": order.paid_at.isoformat() if order.paid_at else None,
                "created_at": order.created_at.isoformat() if order.created_at else None,
                "package_id": str(order.package_id) if order.package_id else None
            }
            for order in orders
        ]

    def get_payment_config(self) -> Dict[str, Any]:
        """
        Get payment configuration for frontend

        Returns:
            Payment configuration
        """
        provider = self.get_payment_provider()

        config = {
            "provider": provider,
            "currency": self.get_currency(),
            "subscription_price": self.get_subscription_price()
        }

        if provider == 'stripe':
            config["stripe_publishable_key"] = stripe_service.get_publishable_key()

        return config


# Global instance
payment_service = PaymentService()
