import smtplib
import random
import string
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime, timedelta
from typing import Optional
from config import settings
from utils.i18n_loader import get_translation

def generate_verification_code(length: int = 6) -> str:
    """Generate verification code"""
    return ''.join(random.choices(string.digits, k=length))

def get_email_template(language: str, verification_code: str) -> tuple[str, str]:
    """
    Get email template based on language using i18n
    Returns (subject, html_body) tuple
    """
    # Get translations for the specified language
    subject = get_translation(language, 'email', 'verification', 'subject')
    email_title = get_translation(language, 'email', 'verification', 'title')
    platform_name = get_translation(language, 'email', 'verification', 'platformName')
    greeting = get_translation(language, 'email', 'verification', 'greeting')
    code_prompt = get_translation(language, 'email', 'verification', 'codePrompt')
    validity_note = get_translation(language, 'email', 'verification', 'validityNote')
    footer = get_translation(language, 'email', 'verification', 'footer')

    # Build HTML email template
    html_body = f"""
    <html>
        <body>
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                    <h1 style="color: #1890ff; margin: 0;">{platform_name}</h1>
                </div>
                <div style="padding: 30px 20px;">
                    <h2 style="color: #333;">{email_title}</h2>
                    <p style="color: #666; line-height: 1.6;">
                        {greeting}
                    </p>
                    <p style="color: #666; line-height: 1.6;">
                        {code_prompt}
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <span style="background-color: #1890ff; color: white; padding: 15px 30px; font-size: 24px; font-weight: bold; border-radius: 5px; letter-spacing: 5px;">
                            {verification_code}
                        </span>
                    </div>
                    <p style="color: #666; line-height: 1.6;">
                        {validity_note}
                    </p>
                    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="color: #999; font-size: 14px;">
                            {footer}
                        </p>
                    </div>
                </div>
            </div>
        </body>
    </html>
    """

    return subject, html_body

def send_verification_email(email: str, verification_code: str, language: str = 'en') -> bool:
    """
    Send verification email

    Args:
        email: Recipient email address
        verification_code: Verification code
        language: Language code ('zh' for Chinese, 'en' for English)
    """
    if not settings.smtp_username or not settings.smtp_password:
        raise Exception("SMTP configuration is not set")

    try:
        # Get email template based on language
        subject, html_body = get_email_template(language, verification_code)
        
        # Create email
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = settings.smtp_username
        msg['To'] = email
        
        # Add HTML content
        html_part = MIMEText(html_body, 'html', 'utf-8')
        msg.attach(html_part)
        
        # Send email
        if settings.smtp_use_ssl:
            # Use SSL connection
            with smtplib.SMTP_SSL(settings.smtp_server, settings.smtp_port) as server:
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)
        else:
            # Use TLS connection
            with smtplib.SMTP(settings.smtp_server, settings.smtp_port) as server:
                if settings.smtp_use_tls:
                    server.starttls()
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)
        
        return True
        
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False

def get_verification_expiry() -> datetime:
    """Get verification code expiry time (10 minutes later)"""
    return datetime.utcnow() + timedelta(minutes=10)

def get_password_reset_email_template(language: str, reset_url: str) -> tuple[str, str]:
    """
    Get password reset email template based on language using i18n
    Returns (subject, html_body) tuple
    """
    # Get translations for the specified language
    subject = get_translation(language, 'email', 'passwordReset', 'subject')
    email_title = get_translation(language, 'email', 'passwordReset', 'title')
    platform_name = get_translation(language, 'email', 'passwordReset', 'platformName')
    greeting = get_translation(language, 'email', 'passwordReset', 'greeting')
    instruction = get_translation(language, 'email', 'passwordReset', 'instruction')
    button_text = get_translation(language, 'email', 'passwordReset', 'buttonText')
    validity_note = get_translation(language, 'email', 'passwordReset', 'validityNote')
    ignore_note = get_translation(language, 'email', 'passwordReset', 'ignoreNote')
    footer = get_translation(language, 'email', 'passwordReset', 'footer')

    # Build HTML email template
    html_body = f"""
    <html>
        <body>
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                    <h1 style="color: #1890ff; margin: 0;">{platform_name}</h1>
                </div>
                <div style="padding: 30px 20px;">
                    <h2 style="color: #333;">{email_title}</h2>
                    <p style="color: #666; line-height: 1.6;">
                        {greeting}
                    </p>
                    <p style="color: #666; line-height: 1.6;">
                        {instruction}
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="{reset_url}" style="background-color: #1890ff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                            {button_text}
                        </a>
                    </div>
                    <p style="color: #666; line-height: 1.6; font-size: 14px;">
                        {validity_note}
                    </p>
                    <p style="color: #999; line-height: 1.6; font-size: 14px;">
                        {ignore_note}
                    </p>
                    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="color: #999; font-size: 14px;">
                            {footer}
                        </p>
                    </div>
                </div>
            </div>
        </body>
    </html>
    """

    return subject, html_body

def send_password_reset_email(email: str, reset_url: str, language: str = 'en') -> bool:
    """
    Send password reset email

    Args:
        email: Recipient email address
        reset_url: Password reset URL with token
        language: Language code ('zh' for Chinese, 'en' for English)
    """
    if not settings.smtp_username or not settings.smtp_password:
        raise Exception("SMTP configuration is not set")

    try:
        # Get email template based on language
        subject, html_body = get_password_reset_email_template(language, reset_url)

        # Create email
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = settings.smtp_username
        msg['To'] = email

        # Add HTML content
        html_part = MIMEText(html_body, 'html', 'utf-8')
        msg.attach(html_part)

        # Send email
        if settings.smtp_use_ssl:
            # Use SSL connection
            with smtplib.SMTP_SSL(settings.smtp_server, settings.smtp_port) as server:
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)
        else:
            # Use TLS connection
            with smtplib.SMTP(settings.smtp_server, settings.smtp_port) as server:
                if settings.smtp_use_tls:
                    server.starttls()
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)

        return True

    except Exception as e:
        print(f"Failed to send password reset email: {e}")
        return False

def get_reset_token_expiry() -> datetime:
    """Get password reset token expiry time (1 hour later)"""
    return datetime.utcnow() + timedelta(hours=1)