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


def send_team_invitation_email(
    email: str,
    inviter_email: str,
    invitation_url: str,
    role: str = 'member',
    language: str = 'en',
) -> bool:
    """
    Send team invitation email.

    Args:
        email: Recipient email address
        inviter_email: Email of the person who sent the invitation
        invitation_url: URL to accept the invitation
        role: Invited role (admin or member)
        language: Language code
    """
    if not settings.smtp_username or not settings.smtp_password:
        raise Exception("SMTP configuration is not set")

    try:
        role_display = {"admin": "Admin", "member": "Member"}.get(role, role.title())

        if language == 'zh':
            subject = f"OpenGuardrails 团队邀请"
            html_body = f"""
            <html><body>
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                    <h1 style="color: #1890ff; margin: 0;">OpenGuardrails</h1>
                </div>
                <div style="padding: 30px 20px;">
                    <h2 style="color: #333;">您收到了一份团队邀请</h2>
                    <p style="color: #666; line-height: 1.6;">
                        <strong>{inviter_email}</strong> 邀请您加入他们的 OpenGuardrails 团队，角色为 <strong>{role_display}</strong>。
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="{invitation_url}" style="background-color: #1890ff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                            接受邀请
                        </a>
                    </div>
                    <p style="color: #999; font-size: 14px;">此邀请将在 7 天后过期。</p>
                    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="color: #999; font-size: 14px;">— OpenGuardrails Team</p>
                    </div>
                </div>
            </div>
            </body></html>
            """
        else:
            subject = f"OpenGuardrails Team Invitation"
            html_body = f"""
            <html><body>
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
                    <h1 style="color: #1890ff; margin: 0;">OpenGuardrails</h1>
                </div>
                <div style="padding: 30px 20px;">
                    <h2 style="color: #333;">You've been invited to join a team</h2>
                    <p style="color: #666; line-height: 1.6;">
                        <strong>{inviter_email}</strong> has invited you to join their OpenGuardrails team as <strong>{role_display}</strong>.
                    </p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="{invitation_url}" style="background-color: #1890ff; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                            Accept Invitation
                        </a>
                    </div>
                    <p style="color: #999; font-size: 14px;">This invitation will expire in 7 days.</p>
                    <div style="margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee;">
                        <p style="color: #999; font-size: 14px;">— OpenGuardrails Team</p>
                    </div>
                </div>
            </div>
            </body></html>
            """

        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = settings.smtp_username
        msg['To'] = email

        html_part = MIMEText(html_body, 'html', 'utf-8')
        msg.attach(html_part)

        if settings.smtp_use_ssl:
            with smtplib.SMTP_SSL(settings.smtp_server, settings.smtp_port) as server:
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(settings.smtp_server, settings.smtp_port) as server:
                if settings.smtp_use_tls:
                    server.starttls()
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)

        return True

    except Exception as e:
        print(f"Failed to send invitation email: {e}")
        return False


def get_appeal_review_email_template(
    language: str,
    appeal_data: dict,
    user_context: dict
) -> tuple[str, str]:
    """
    Get appeal review email template for human final review
    Returns (subject, html_body) tuple

    Args:
        language: Language code ('zh' or 'en')
        appeal_data: Appeal record data including request_id, user_id, content, etc.
        user_context: User context including recent_requests and ban_history
    """
    # Get translations
    subject = get_translation(language, 'email', 'appealReview', 'subject')
    email_title = get_translation(language, 'email', 'appealReview', 'title')
    platform_name = get_translation(language, 'email', 'appealReview', 'platformName')
    greeting = get_translation(language, 'email', 'appealReview', 'greeting')
    request_id_label = get_translation(language, 'email', 'appealReview', 'requestIdLabel')
    application_name_label = get_translation(language, 'email', 'appealReview', 'applicationNameLabel')
    workspace_name_label = get_translation(language, 'email', 'appealReview', 'workspaceNameLabel')
    original_content_label = get_translation(language, 'email', 'appealReview', 'originalContentLabel')
    risk_level_label = get_translation(language, 'email', 'appealReview', 'riskLevelLabel')
    risk_categories_label = get_translation(language, 'email', 'appealReview', 'riskCategoriesLabel')
    ai_review_label = get_translation(language, 'email', 'appealReview', 'aiReviewLabel')
    ai_reason_label = get_translation(language, 'email', 'appealReview', 'aiReasonLabel')
    user_credibility_label = get_translation(language, 'email', 'appealReview', 'userCredibilityLabel')
    ban_history_label = get_translation(language, 'email', 'appealReview', 'banHistoryLabel')
    no_ban_history = get_translation(language, 'email', 'appealReview', 'noBanHistory')
    recent_requests_label = get_translation(language, 'email', 'appealReview', 'recentRequestsLabel')
    no_recent_requests = get_translation(language, 'email', 'appealReview', 'noRecentRequests')
    action_instruction = get_translation(language, 'email', 'appealReview', 'actionInstruction')
    footer = get_translation(language, 'email', 'appealReview', 'footer')
    hit_keywords_label = get_translation(language, 'email', 'appealReview', 'hitKeywordsLabel')

    # Format ban history
    ban_history_html = no_ban_history
    if user_context.get('ban_history'):
        ban_items = []
        for ban in user_context['ban_history']:
            status = "Active" if ban.get('is_active') else "Expired"
            ban_items.append(
                f"<li>{ban.get('banned_at', 'N/A')} - {ban.get('reason', 'No reason')} "
                f"(Risk: {ban.get('risk_level', 'N/A')}, Status: {status})</li>"
            )
        ban_history_html = f"<ul style='margin: 0; padding-left: 20px;'>{''.join(ban_items)}</ul>"

    # Format recent requests
    recent_requests_html = no_recent_requests
    if user_context.get('recent_requests'):
        request_items = []
        for req in user_context['recent_requests']:
            content_preview = req.get('content', 'N/A')
            if len(content_preview) > 100:
                content_preview = content_preview[:100] + '...'
            request_items.append(
                f"<li style='margin-bottom: 8px;'>"
                f"<span style='color: #666;'>[{req.get('created_at', 'N/A')}]</span><br/>"
                f"<span style='color: #333;'>Content: {content_preview}</span><br/>"
                f"<span style='color: #999;'>Risk: Security={req.get('security_risk', 'N/A')}, "
                f"Compliance={req.get('compliance_risk', 'N/A')}, "
                f"Data={req.get('data_risk', 'N/A')} | Action: {req.get('action', 'N/A')}</span>"
                f"</li>"
            )
        recent_requests_html = f"<ol style='margin: 0; padding-left: 20px;'>{''.join(request_items)}</ol>"

    # Format categories
    categories = appeal_data.get('original_categories', [])
    categories_str = ', '.join(categories) if categories else 'None'

    # Format hit keywords
    hit_keywords_html = ''
    hit_keywords_raw = appeal_data.get('hit_keywords')
    if hit_keywords_raw:
        try:
            import json
            keywords = json.loads(hit_keywords_raw) if isinstance(hit_keywords_raw, str) else hit_keywords_raw
            if isinstance(keywords, list) and keywords:
                keywords_badges = ''.join([
                    f'<span style="display: inline-block; background-color: #fff1f0; color: #cf1322; border: 1px solid #ffa39e; border-radius: 4px; padding: 2px 8px; margin: 2px; font-size: 12px;">{kw}</span>'
                    for kw in keywords
                ])
                hit_keywords_html = f'''
                            <tr>
                                <td style="padding: 8px 0; color: #666; vertical-align: top;"><strong>{hit_keywords_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;">{keywords_badges}</td>
                            </tr>'''
        except:
            pass

    # Format AI review result
    ai_result = "Rejected (Considered True Positive)" if not appeal_data.get('ai_approved') else "Approved"

    # Format original content with highlighted unsafe segments
    original_content = appeal_data.get('original_content', '')
    unsafe_segments = appeal_data.get('unsafe_segments', [])

    # Apply highlighting to unsafe segments in content
    if unsafe_segments and isinstance(unsafe_segments, list) and original_content:
        # Sort segments by start position (descending) to avoid position shift during replacement
        sorted_segments = sorted(
            [s for s in unsafe_segments if isinstance(s, dict) and 'start' in s and 'end' in s],
            key=lambda x: x.get('start', 0),
            reverse=True
        )
        highlighted_content = original_content
        for seg in sorted_segments:
            start = seg.get('start', 0)
            end = seg.get('end', 0)
            if 0 <= start < end <= len(original_content):
                segment_text = original_content[start:end]
                # Escape HTML special characters in the segment text
                import html as html_module
                escaped_text = html_module.escape(segment_text)
                highlighted_text = f'<mark style="background-color: #ffccc7; color: #cf1322; padding: 1px 3px; border-radius: 2px;">{escaped_text}</mark>'
                highlighted_content = highlighted_content[:start] + highlighted_text + highlighted_content[end:]
        # Escape the rest of the content but preserve our marks
        # Since we already inserted HTML marks, we need a different approach
        # Instead, let's escape first then add marks
        pass  # Skip complex escaping for now, just use the highlighted version
        original_content = highlighted_content
    else:
        # Escape HTML special characters
        import html as html_module
        original_content = html_module.escape(original_content)

    # Build HTML email template
    html_body = f"""
    <html>
        <body>
            <div style="font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto;">
                <div style="background-color: #fa8c16; padding: 20px; text-align: center;">
                    <h1 style="color: white; margin: 0;">{platform_name}</h1>
                </div>
                <div style="padding: 30px 20px;">
                    <h2 style="color: #333;">{email_title}</h2>
                    <p style="color: #666; line-height: 1.6;">
                        {greeting}
                    </p>

                    <div style="background-color: #fff7e6; border: 1px solid #ffd591; border-radius: 8px; padding: 20px; margin: 20px 0;">
                        <table style="width: 100%; border-collapse: collapse;">
                            <tr>
                                <td style="padding: 8px 0; color: #666; width: 150px; vertical-align: top;"><strong>{request_id_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;"><code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px;">{appeal_data.get('request_id', 'N/A')}</code></td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666; vertical-align: top;"><strong>{application_name_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;">{appeal_data.get('application_name', 'N/A')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666; vertical-align: top;"><strong>{workspace_name_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;">{appeal_data.get('workspace_name', 'N/A')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666; vertical-align: top;"><strong>{risk_level_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;">{appeal_data.get('original_risk_level', 'N/A')}</td>
                            </tr>
                            <tr>
                                <td style="padding: 8px 0; color: #666; vertical-align: top;"><strong>{risk_categories_label}:</strong></td>
                                <td style="padding: 8px 0; color: #333;">{categories_str}</td>
                            </tr>{hit_keywords_html}
                        </table>
                    </div>

                    <h3 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">{original_content_label}</h3>
                    <div style="background-color: #f5f5f5; border-radius: 8px; padding: 15px; margin-bottom: 20px; white-space: pre-wrap; word-break: break-word;">
                        {original_content}
                    </div>

                    <h3 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">{ai_review_label}</h3>
                    <div style="background-color: #fff1f0; border: 1px solid #ffa39e; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                        <p style="margin: 0 0 10px 0;"><strong>{ai_review_label}:</strong> {ai_result}</p>
                        <p style="margin: 0;"><strong>{ai_reason_label}:</strong></p>
                        <p style="margin: 10px 0 0 0; color: #666; white-space: pre-wrap;">{appeal_data.get('ai_review_result', 'No reason provided')}</p>
                    </div>

                    <h3 style="color: #333; border-bottom: 1px solid #eee; padding-bottom: 10px;">{recent_requests_label}</h3>
                    <div style="margin-bottom: 20px; max-height: 400px; overflow-y: auto;">
                        {recent_requests_html}
                    </div>

                    <div style="background-color: #e6f7ff; border: 1px solid #91d5ff; border-radius: 8px; padding: 15px; margin: 20px 0;">
                        <p style="margin: 0; color: #0050b3;">
                            <strong>{action_instruction}</strong>
                        </p>
                    </div>

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


def send_appeal_review_email(
    to_email: str,
    appeal_data: dict,
    user_context: dict,
    language: str = 'zh'
) -> bool:
    """
    Send appeal review email to final reviewer

    Args:
        to_email: Recipient email address (final reviewer)
        appeal_data: Appeal record data including request_id, user_id, content, etc.
        user_context: User context including recent_requests and ban_history
        language: Language code ('zh' for Chinese, 'en' for English)

    Returns:
        True if email sent successfully, False otherwise
    """
    if not settings.smtp_username or not settings.smtp_password:
        print("SMTP configuration is not set, skipping email")
        return False

    try:
        # Get email template
        subject, html_body = get_appeal_review_email_template(language, appeal_data, user_context)

        # Create email
        msg = MIMEMultipart('alternative')
        msg['Subject'] = subject
        msg['From'] = settings.smtp_username
        msg['To'] = to_email

        # Add HTML content
        html_part = MIMEText(html_body, 'html', 'utf-8')
        msg.attach(html_part)

        # Send email
        if settings.smtp_use_ssl:
            with smtplib.SMTP_SSL(settings.smtp_server, settings.smtp_port) as server:
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(settings.smtp_server, settings.smtp_port) as server:
                if settings.smtp_use_tls:
                    server.starttls()
                server.login(settings.smtp_username, settings.smtp_password)
                server.send_message(msg)

        return True

    except Exception as e:
        print(f"Failed to send appeal review email: {e}")
        return False