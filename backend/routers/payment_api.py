"""
Payment API router
Handles payment creation, webhooks, and payment history
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.orm import Session
from typing import Optional
from pydantic import BaseModel

from database.connection import get_db
from database.models import Tenant, TenantSubscription
from utils.auth import verify_token
from services.payment_service import payment_service
from services.alipay_service import alipay_service
from services.stripe_service import stripe_service
from utils.logger import get_logger
import uuid

logger = get_logger(__name__)

router = APIRouter(prefix="/api/v1/payment", tags=["Payment"])


def get_current_user(request: Request, db: Session) -> Tenant:
    """Get current tenant from request context or JWT token"""
    # First try to get from request.state.auth_context (set by middleware)
    auth_context = getattr(request.state, 'auth_context', None)

    if auth_context:
        data = auth_context['data']
        tenant_id = str(data.get('tenant_id'))
        if tenant_id:
            try:
                tenant_uuid = uuid.UUID(tenant_id)
                tenant = db.query(Tenant).filter(Tenant.id == tenant_uuid).first()
                if tenant:
                    return tenant
            except (ValueError, AttributeError):
                pass

    # If not found in auth_context, try JWT token from Authorization header
    auth_header = request.headers.get('Authorization')

    if not auth_header or not auth_header.startswith('Bearer '):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = auth_header.replace('Bearer ', '')

    try:
        payload = verify_token(token)
        email = payload.get('sub')

        if not email:
            raise HTTPException(status_code=401, detail="Invalid token")

        tenant = db.query(Tenant).filter(Tenant.email == email).first()
        if not tenant:
            raise HTTPException(status_code=401, detail="Tenant not found")

        if not tenant.is_active or not tenant.is_verified:
            raise HTTPException(status_code=403, detail="Tenant account not active")

        return tenant

    except Exception as e:
        logger.error(f"Token verification failed: {e}")
        raise HTTPException(status_code=401, detail="Invalid token")


# Request/Response models
class CreateSubscriptionPaymentRequest(BaseModel):
    """Request to create a subscription payment"""
    pass  # No additional fields needed


class CreatePackagePaymentRequest(BaseModel):
    """Request to create a package payment"""
    package_id: str


class PaymentResponse(BaseModel):
    """Generic payment response"""
    success: bool
    payment_id: Optional[str] = None
    order_id: Optional[str] = None
    provider: Optional[str] = None
    payment_url: Optional[str] = None
    checkout_url: Optional[str] = None
    session_id: Optional[str] = None
    amount: Optional[float] = None
    currency: Optional[str] = None
    error: Optional[str] = None


class PaymentConfigResponse(BaseModel):
    """Payment configuration response"""
    provider: str
    currency: str
    subscription_price: float
    stripe_publishable_key: Optional[str] = None


# Endpoints

@router.get("/config", response_model=PaymentConfigResponse)
async def get_payment_config():
    """
    Get payment configuration for frontend
    Returns provider type and necessary keys
    """
    config = payment_service.get_payment_config()
    return PaymentConfigResponse(**config)


@router.post("/subscription/create", response_model=PaymentResponse)
async def create_subscription_payment(
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Create a subscription payment order
    Returns payment URL for redirect
    """
    try:
        current_user = get_current_user(request, db)

        # Check if already subscribed
        subscription = db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == current_user.id
        ).first()

        if subscription and subscription.subscription_type == 'subscribed':
            return PaymentResponse(
                success=False,
                error="Already subscribed"
            )

        result = await payment_service.create_subscription_payment(
            db=db,
            tenant_id=str(current_user.id),
            email=current_user.email
        )

        return PaymentResponse(**result)

    except ValueError as e:
        logger.error(f"Subscription payment creation failed: {e}")
        return PaymentResponse(success=False, error=str(e))
    except Exception as e:
        logger.error(f"Subscription payment creation error: {e}")
        raise HTTPException(status_code=500, detail="Payment creation failed")


@router.post("/package/create", response_model=PaymentResponse)
async def create_package_payment(
    request: Request,
    package_id: str,
    db: Session = Depends(get_db)
):
    """
    Create a package purchase payment order
    Returns payment URL for redirect
    """
    try:
        current_user = get_current_user(request, db)

        result = await payment_service.create_package_payment(
            db=db,
            tenant_id=str(current_user.id),
            email=current_user.email,
            package_id=package_id
        )

        return PaymentResponse(**result)

    except ValueError as e:
        logger.error(f"Package payment creation failed: {e}")
        return PaymentResponse(success=False, error=str(e))
    except Exception as e:
        logger.error(f"Package payment creation error: {e}")
        raise HTTPException(status_code=500, detail="Payment creation failed")


@router.post("/subscription/cancel")
async def cancel_subscription(
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Cancel the current subscription
    Subscription will remain active until the end of the billing period
    """
    try:
        current_user = get_current_user(request, db)

        result = await payment_service.cancel_subscription(
            db=db,
            tenant_id=str(current_user.id)
        )

        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Cancellation failed"))

        return result

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Subscription cancellation error: {e}")
        raise HTTPException(status_code=500, detail="Cancellation failed")


@router.get("/orders")
async def get_payment_orders(
    request: Request,
    order_type: Optional[str] = None,
    status: Optional[str] = None,
    limit: int = 50,
    db: Session = Depends(get_db)
):
    """
    Get payment order history for the current user
    """
    current_user = get_current_user(request, db)

    orders = payment_service.get_payment_orders(
        db=db,
        tenant_id=str(current_user.id),
        order_type=order_type,
        status=status,
        limit=limit
    )

    return {"orders": orders}


@router.get("/subscription/status")
async def get_subscription_status(
    request: Request,
    db: Session = Depends(get_db)
):
    """
    Get current subscription status
    """
    current_user = get_current_user(request, db)

    from database.models import SubscriptionPayment
    from sqlalchemy import and_

    subscription = db.query(TenantSubscription).filter(
        TenantSubscription.tenant_id == current_user.id
    ).first()

    if not subscription:
        return {
            "subscription_type": "free",
            "is_active": False
        }

    # Get active subscription payment
    sub_payment = db.query(SubscriptionPayment).filter(
        and_(
            SubscriptionPayment.tenant_id == current_user.id,
            SubscriptionPayment.status == 'active'
        )
    ).first()

    return {
        "subscription_type": subscription.subscription_type,
        "is_active": subscription.subscription_type == 'subscribed',
        "started_at": subscription.subscription_started_at.isoformat() if subscription.subscription_started_at else None,
        "expires_at": subscription.subscription_expires_at.isoformat() if subscription.subscription_expires_at else None,
        "cancel_at_period_end": sub_payment.cancel_at_period_end if sub_payment else False,
        "next_payment_date": sub_payment.next_payment_date.isoformat() if sub_payment and sub_payment.next_payment_date else None
    }


# Webhook endpoints (no authentication required)

@router.post("/webhook/alipay")
async def alipay_webhook(request: Request, db: Session = Depends(get_db)):
    """
    Handle Alipay payment callback notification
    """
    try:
        # Get form data
        form_data = await request.form()
        params = dict(form_data)

        logger.info(f"Received Alipay webhook: {params.get('out_trade_no')}")

        # Verify signature
        if not alipay_service.verify_callback(params):
            logger.error("Alipay webhook signature verification failed")
            return "fail"

        # Parse callback data
        callback_data = alipay_service.parse_callback(params)

        # Check trade status
        trade_status = params.get('trade_status')
        if trade_status not in ['TRADE_SUCCESS', 'TRADE_FINISHED']:
            logger.info(f"Alipay trade status not success: {trade_status}")
            return "success"  # Acknowledge but don't process

        # Process based on order type
        order_id = callback_data['order_id']

        if order_id.startswith('sub_'):
            # Subscription payment
            result = await payment_service.handle_subscription_paid(
                db=db,
                order_id=order_id,
                transaction_id=callback_data['transaction_id'],
                paid_at=callback_data.get('paid_at')
            )
        elif order_id.startswith('pkg_'):
            # Package payment
            result = await payment_service.handle_package_paid(
                db=db,
                order_id=order_id,
                transaction_id=callback_data['transaction_id'],
                paid_at=callback_data.get('paid_at')
            )
        else:
            logger.error(f"Unknown order type: {order_id}")
            return "fail"

        if result.get('success'):
            return "success"
        else:
            return "fail"

    except Exception as e:
        logger.error(f"Alipay webhook error: {e}")
        return "fail"


@router.post("/webhook/stripe")
async def stripe_webhook(
    request: Request,
    stripe_signature: str = Header(None, alias="Stripe-Signature"),
    db: Session = Depends(get_db)
):
    """
    Handle Stripe webhook events
    """
    try:
        # Get raw body
        payload = await request.body()

        # Verify and parse webhook
        event = stripe_service.verify_webhook(payload, stripe_signature)

        event_type = event['type']
        logger.info(f"Received Stripe webhook: {event_type}")

        # Handle different event types
        if event_type == 'checkout.session.completed':
            session_data = stripe_service.parse_checkout_completed(event)
            metadata = session_data.get('metadata', {})
            order_type = metadata.get('order_type')

            if order_type == 'subscription':
                # Find order by session ID
                from database.models import PaymentOrder
                order = db.query(PaymentOrder).filter(
                    PaymentOrder.metadata['stripe_session_id'].astext == session_data['session_id']
                ).first()

                if order:
                    # Update with subscription ID
                    from database.models import SubscriptionPayment
                    sub_payment = db.query(SubscriptionPayment).filter(
                        SubscriptionPayment.payment_order_id == order.id
                    ).first()

                    if sub_payment:
                        sub_payment.stripe_subscription_id = session_data.get('subscription_id')
                        sub_payment.stripe_customer_id = session_data.get('customer_id')
                        db.commit()

                    await payment_service.handle_subscription_paid(
                        db=db,
                        order_id=order.provider_order_id,
                        transaction_id=session_data.get('payment_intent_id') or session_data['session_id']
                    )

            elif order_type == 'package':
                from database.models import PaymentOrder
                order = db.query(PaymentOrder).filter(
                    PaymentOrder.metadata['stripe_session_id'].astext == session_data['session_id']
                ).first()

                if order:
                    await payment_service.handle_package_paid(
                        db=db,
                        order_id=order.provider_order_id,
                        transaction_id=session_data.get('payment_intent_id') or session_data['session_id']
                    )

        elif event_type == 'invoice.paid':
            # Recurring subscription payment
            invoice_data = stripe_service.parse_invoice_paid(event)
            subscription_id = invoice_data.get('subscription_id')

            if subscription_id:
                from database.models import SubscriptionPayment
                sub_payment = db.query(SubscriptionPayment).filter(
                    SubscriptionPayment.stripe_subscription_id == subscription_id
                ).first()

                if sub_payment:
                    # Update billing cycle
                    sub_payment.billing_cycle_start = invoice_data.get('period_start')
                    sub_payment.billing_cycle_end = invoice_data.get('period_end')
                    sub_payment.next_payment_date = invoice_data.get('period_end')

                    # Update tenant subscription expiry
                    subscription = db.query(TenantSubscription).filter(
                        TenantSubscription.tenant_id == sub_payment.tenant_id
                    ).first()

                    if subscription:
                        subscription.subscription_expires_at = invoice_data.get('period_end')

                    db.commit()

        elif event_type == 'customer.subscription.deleted':
            # Subscription cancelled
            subscription_data = event['data']['object']
            subscription_id = subscription_data.get('id')

            from database.models import SubscriptionPayment
            sub_payment = db.query(SubscriptionPayment).filter(
                SubscriptionPayment.stripe_subscription_id == subscription_id
            ).first()

            if sub_payment:
                sub_payment.status = 'cancelled'
                sub_payment.cancelled_at = datetime.utcnow()

                # Downgrade tenant subscription
                subscription = db.query(TenantSubscription).filter(
                    TenantSubscription.tenant_id == sub_payment.tenant_id
                ).first()

                if subscription:
                    subscription.subscription_type = 'free'
                    subscription.monthly_quota = 10000

                db.commit()

        return {"received": True}

    except Exception as e:
        logger.error(f"Stripe webhook error: {e}")
        raise HTTPException(status_code=400, detail=str(e))


# Import datetime for webhook handlers
from datetime import datetime
