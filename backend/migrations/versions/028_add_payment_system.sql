-- Migration: 028_add_payment_system
-- Description: Add payment system tables for Alipay and Stripe integration
-- Created: 2024

-- Create the update_updated_at_column function if it doesn't exist
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Payment orders table - stores all payment transactions
CREATE TABLE IF NOT EXISTS payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_type VARCHAR(50) NOT NULL, -- 'subscription' or 'package'
    amount DECIMAL(10, 2) NOT NULL,
    currency VARCHAR(10) NOT NULL, -- 'CNY' or 'USD'
    payment_provider VARCHAR(50) NOT NULL, -- 'alipay' or 'stripe'
    status VARCHAR(50) NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'failed', 'refunded', 'cancelled'

    -- Provider-specific IDs
    provider_order_id VARCHAR(255), -- Our order ID sent to provider
    provider_transaction_id VARCHAR(255), -- Transaction ID from provider

    -- For package purchases
    package_id UUID REFERENCES scanner_packages(id) ON DELETE SET NULL,

    -- Additional metadata
    order_metadata JSONB DEFAULT '{}',

    -- Timestamps
    paid_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for payment_orders
CREATE INDEX IF NOT EXISTS idx_payment_orders_tenant_id ON payment_orders(tenant_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status);
CREATE INDEX IF NOT EXISTS idx_payment_orders_order_type ON payment_orders(order_type);
CREATE INDEX IF NOT EXISTS idx_payment_orders_provider_order_id ON payment_orders(provider_order_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_provider_transaction_id ON payment_orders(provider_transaction_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_created_at ON payment_orders(created_at);

-- Subscription payments table - tracks recurring subscription payments
CREATE TABLE IF NOT EXISTS subscription_payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    payment_order_id UUID REFERENCES payment_orders(id) ON DELETE SET NULL,

    -- Billing cycle
    billing_cycle_start TIMESTAMP WITH TIME ZONE NOT NULL,
    billing_cycle_end TIMESTAMP WITH TIME ZONE NOT NULL,

    -- Provider-specific subscription IDs
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    alipay_agreement_id VARCHAR(255),

    -- Status
    status VARCHAR(50) NOT NULL DEFAULT 'active', -- 'active', 'cancelled', 'expired', 'past_due'
    cancel_at_period_end BOOLEAN DEFAULT FALSE,

    -- Next payment info
    next_payment_date TIMESTAMP WITH TIME ZONE,
    next_payment_amount DECIMAL(10, 2),

    -- Timestamps
    cancelled_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for subscription_payments
CREATE INDEX IF NOT EXISTS idx_subscription_payments_tenant_id ON subscription_payments(tenant_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status ON subscription_payments(status);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_stripe_subscription_id ON subscription_payments(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_alipay_agreement_id ON subscription_payments(alipay_agreement_id);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_next_payment_date ON subscription_payments(next_payment_date);

-- Add unique constraint to ensure one active subscription per tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_tenant_active
ON subscription_payments(tenant_id)
WHERE status = 'active';

-- Add trigger to update updated_at timestamp for payment_orders
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_payment_orders_updated_at'
    ) THEN
        CREATE TRIGGER update_payment_orders_updated_at
            BEFORE UPDATE ON payment_orders
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Add trigger to update updated_at timestamp for subscription_payments
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
        WHERE tgname = 'update_subscription_payments_updated_at'
    ) THEN
        CREATE TRIGGER update_subscription_payments_updated_at
            BEFORE UPDATE ON subscription_payments
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at_column();
    END IF;
END $$;

-- Add payment-related fields to tenant_subscriptions if not exists
DO $$
BEGIN
    -- Add stripe_customer_id if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_subscriptions' AND column_name = 'stripe_customer_id'
    ) THEN
        ALTER TABLE tenant_subscriptions ADD COLUMN stripe_customer_id VARCHAR(255);
    END IF;

    -- Add alipay_user_id if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_subscriptions' AND column_name = 'alipay_user_id'
    ) THEN
        ALTER TABLE tenant_subscriptions ADD COLUMN alipay_user_id VARCHAR(255);
    END IF;

    -- Add subscription_started_at if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_subscriptions' AND column_name = 'subscription_started_at'
    ) THEN
        ALTER TABLE tenant_subscriptions ADD COLUMN subscription_started_at TIMESTAMP WITH TIME ZONE;
    END IF;

    -- Add subscription_expires_at if not exists
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'tenant_subscriptions' AND column_name = 'subscription_expires_at'
    ) THEN
        ALTER TABLE tenant_subscriptions ADD COLUMN subscription_expires_at TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;
