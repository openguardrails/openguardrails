"""
Payment API router
Handles payment creation, webhooks, and payment history
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Header
from sqlalchemy.orm import Session
from typing import Optional
from pydantic import BaseModel
import traceback

from database.connection import get_admin_db
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
    db: Session = Depends(get_admin_db)
):
    """
    Create a subscription payment order
    Returns payment URL for redirect
    """
    try:
        current_user = get_current_user(request, db)
        logger.info(f"Creating subscription payment for tenant: {current_user.id}, email: {current_user.email}")

        # Check if already subscribed
        subscription = db.query(TenantSubscription).filter(
            TenantSubscription.tenant_id == current_user.id
        ).first()

        if subscription and subscription.subscription_type == 'subscribed':
            logger.info(f"Tenant {current_user.id} is already subscribed")
            return PaymentResponse(
                success=False,
                error="Already subscribed"
            )

        logger.info(f"Calling payment_service.create_subscription_payment for tenant {current_user.id}")
        result = await payment_service.create_subscription_payment(
            db=db,
            tenant_id=str(current_user.id),
            email=current_user.email
        )
        logger.info(f"Payment creation successful for tenant {current_user.id}")

        return PaymentResponse(**result)

    except ValueError as e:
        logger.error(f"Subscription payment creation failed: {e}")
        return PaymentResponse(success=False, error=str(e))
    except Exception as e:
        logger.error(f"Subscription payment creation error: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Payment creation failed: {str(e)}")


@router.post("/package/create", response_model=PaymentResponse)
async def create_package_payment(
    request: Request,
    payment_request: CreatePackagePaymentRequest,
    db: Session = Depends(get_admin_db)
):
    """
    Create a package purchase payment order
    Returns payment URL for redirect
    """
    try:
        current_user = get_current_user(request, db)
        
        logger.info(f"Creating package payment for tenant: {current_user.id}, package_id: {payment_request.package_id}")

        result = await payment_service.create_package_payment(
            db=db,
            tenant_id=str(current_user.id),
            email=current_user.email,
            package_id=payment_request.package_id
        )
        
        logger.info(f"Package payment created successfully: {result}")

        return PaymentResponse(**result)

    except ValueError as e:
        logger.error(f"Package payment creation failed: {e}")
        return PaymentResponse(success=False, error=str(e))
    except Exception as e:
        logger.error(f"Package payment creation error: {str(e)}\n{traceback.format_exc()}")
        raise HTTPException(status_code=500, detail=f"Payment creation failed: {str(e)}")


@router.post("/subscription/cancel")
async def cancel_subscription(
    request: Request,
    db: Session = Depends(get_admin_db)
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
    db: Session = Depends(get_admin_db)
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
    db: Session = Depends(get_admin_db)
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


@router.get("/verify-session/{session_id}")
async def verify_payment_session(
    session_id: str,
    request: Request,
    db: Session = Depends(get_admin_db)
):
    """
    Verify payment status by session ID
    Used by frontend to poll payment completion after redirect

    Returns:
    - status: 'pending' | 'completed' | 'failed' | 'not_found'
    - order_type: 'subscription' | 'package'
    - order_id: Payment order ID
    - details: Additional order details (package_id for packages, etc.)

    NOTE: This endpoint has a fallback mechanism:
    1. First check database for webhook-updated status
    2. If still pending AND provider is Stripe, query Stripe API directly
    3. If Stripe says payment is complete, process it immediately

    This solves the issue where webhooks may not arrive in test environments.
    """
    try:
        current_user = get_current_user(request, db)

        from database.models import PaymentOrder, PackagePurchase
        from sqlalchemy import text

        # Find order by session ID in metadata
        # Use PostgreSQL JSON operator ->> to extract text value
        order = db.query(PaymentOrder).filter(
            PaymentOrder.tenant_id == current_user.id,
            text("order_metadata->>'stripe_session_id' = :session_id")
        ).params(session_id=session_id).first()

        if not order:
            # Also check Alipay trade_no (if using Alipay)
            order = db.query(PaymentOrder).filter(
                PaymentOrder.tenant_id == current_user.id,
                text("order_metadata->>'trade_no' = :session_id")
            ).params(session_id=session_id).first()

        if not order:
            return {
                "status": "not_found",
                "message": "Payment session not found"
            }

        # Determine order type from order_id prefix
        order_type = None
        details = {}

        if order.provider_order_id.startswith('sub_'):
            order_type = 'subscription'
        elif order.provider_order_id.startswith('pkg_'):
            order_type = 'package'
            # Get package details from order metadata
            if order.package_id:
                details['package_id'] = str(order.package_id)
                # Find package purchase record by tenant_id and package_id
                package_purchase = db.query(PackagePurchase).filter(
                    PackagePurchase.tenant_id == current_user.id,
                    PackagePurchase.package_id == order.package_id
                ).first()
                if package_purchase:
                    details['purchase_status'] = package_purchase.status

        # FALLBACK MECHANISM: If order is still pending and provider is Stripe, check Stripe API
        if order.status == 'pending' and order.payment_provider == 'stripe':
            logger.info(f"Order {order.provider_order_id} still pending, checking Stripe API for session {session_id}")
            try:
                # Query Stripe API to check if payment is actually complete
                stripe_session = await stripe_service.get_checkout_session(session_id)

                if stripe_session:
                    payment_status = stripe_session.get('payment_status')
                    logger.info(f"Stripe session {session_id} payment_status: {payment_status}")

                    if payment_status == 'paid':
                        logger.info(f"Stripe payment confirmed as paid, processing order {order.provider_order_id}")
                        # Payment is confirmed by Stripe - process it now
                        if order_type == 'subscription':
                            await payment_service.handle_subscription_paid(
                                db=db,
                                order_id=order.provider_order_id,
                                transaction_id=stripe_session.get('payment_intent') or session_id
                            )
                        elif order_type == 'package':
                            await payment_service.handle_package_paid(
                                db=db,
                                order_id=order.provider_order_id,
                                transaction_id=stripe_session.get('payment_intent') or session_id
                            )

                        # Refresh order from database
                        db.refresh(order)
                        logger.info(f"Order {order.provider_order_id} status after processing: {order.status}")
                    elif payment_status in ['unpaid', 'no_payment_required']:
                        # Still not paid
                        logger.info(f"Stripe session {session_id} not yet paid: {payment_status}")
                    else:
                        logger.warning(f"Unknown Stripe payment_status: {payment_status}")
            except Exception as e:
                logger.error(f"Failed to check Stripe API for session {session_id}: {e}")
                # Continue with database status - don't fail the request

        # Map payment order status
        status_map = {
            'pending': 'pending',
            'paid': 'completed',
            'failed': 'failed',
            'cancelled': 'failed'
        }

        return {
            "status": status_map.get(order.status, 'pending'),
            "order_type": order_type,
            "order_id": order.provider_order_id,
            "payment_status": order.status,
            "details": details,
            "paid_at": order.paid_at.isoformat() if order.paid_at else None
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Payment verification error: {e}")
        raise HTTPException(status_code=500, detail="Verification failed")


# Webhook endpoints (no authentication required)

@router.post("/webhook/alipay")
async def alipay_webhook(request: Request, db: Session = Depends(get_admin_db)):
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
    db: Session = Depends(get_admin_db)
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
                from sqlalchemy import text
                order = db.query(PaymentOrder).filter(
                    text("order_metadata->>'stripe_session_id' = :session_id")
                ).params(session_id=session_data['session_id']).first()

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
                from sqlalchemy import text
                order = db.query(PaymentOrder).filter(
                    text("order_metadata->>'stripe_session_id' = :session_id")
                ).params(session_id=session_data['session_id']).first()

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
