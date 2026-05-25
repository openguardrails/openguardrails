-- Migration: Add password_reset_tokens table for password reset functionality
-- Version: 005
-- Date: 2025-10-24

-- Create password_reset_tokens table
CREATE TABLE IF NOT EXISTS password_reset_tokens (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    reset_token VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    is_used BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_email
    ON password_reset_tokens(email);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_token
    ON password_reset_tokens(reset_token);

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_is_used
    ON password_reset_tokens(is_used);

-- Add comment
COMMENT ON TABLE password_reset_tokens IS 'Stores password reset tokens for user password recovery';
COMMENT ON COLUMN password_reset_tokens.email IS 'Email address of user requesting password reset';
COMMENT ON COLUMN password_reset_tokens.reset_token IS 'Unique secure token for password reset (URL-safe)';
COMMENT ON COLUMN password_reset_tokens.expires_at IS 'Token expiration timestamp (typically 1 hour from creation)';
COMMENT ON COLUMN password_reset_tokens.is_used IS 'Whether the token has been used for password reset';
COMMENT ON COLUMN password_reset_tokens.created_at IS 'Token creation timestamp';
