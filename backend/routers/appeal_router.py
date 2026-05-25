"""
Appeal Processing API routes (Detection Service)
Public endpoint for users to submit false positive appeals
"""
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
import logging

from services.appeal_service import appeal_service
from utils.i18n_loader import get_translation

# Detection records are written async (JSONL → DB import runs every ~5s),
# so we retry up to ~60s on the client side before giving up.
APPEAL_MAX_RETRIES = 30
APPEAL_RETRY_INTERVAL_SECONDS = 2

logger = logging.getLogger(__name__)


def detect_language(request: Request) -> str:
    """Detect language from Accept-Language header"""
    accept_language = request.headers.get('accept-language', 'en')
    # Check for Chinese language preference
    if 'zh' in accept_language.lower():
        return 'zh'
    return 'en'

router = APIRouter(prefix="/v1", tags=["appeal"])


def generate_result_html(result: dict, language: str = 'zh') -> str:
    """Generate HTML response for appeal result with i18n support"""
    import json
    success = result.get('success', False)
    status = result.get('status', '')
    message = result.get('message', '')
    reason = result.get('reason', '')
    final_reviewer_email = result.get('final_reviewer_email', '')
    hit_keywords_raw = result.get('hit_keywords', '')

    # Get translations
    def t(key: str) -> str:
        return get_translation(language, 'appealPage', key)

    # Determine style based on result
    if success or status == 'approved':
        status_class = 'success'
        status_icon = '&#10004;'  # checkmark
        status_text = t('statusApproved') if status == 'approved' else t('statusProcessing')
    elif status == 'rejected':
        status_class = 'rejected'
        status_icon = '&#10008;'  # x mark
        status_text = t('statusRejected')
    elif status == 'pending_review':
        status_class = 'pending'
        status_icon = '&#128100;'  # person silhouette
        status_text = t('statusPendingReview')
    elif status == 'reviewing' or status == 'pending':
        status_class = 'pending'
        status_icon = '&#8987;'  # hourglass
        status_text = t('statusProcessing')
    else:
        status_class = 'error'
        status_icon = '&#9888;'  # warning
        status_text = t('statusFailed')

    reason_html = ''
    if reason:
        reason_html = f'''
        <div class="reason-section">
            <h3>{t('reviewDetails')}</h3>
            <p class="reason-text">{reason}</p>
        </div>
        '''

    # Generate hit keywords HTML for rejected or pending_review status
    hit_keywords_html = ''
    if hit_keywords_raw and status in ['rejected', 'pending_review']:
        try:
            keywords = json.loads(hit_keywords_raw) if isinstance(hit_keywords_raw, str) else hit_keywords_raw
            if isinstance(keywords, list) and keywords:
                hit_keywords_label = '命中关键词' if language == 'zh' else 'Hit Keywords'
                keywords_badges = ''.join([
                    f'<span class="keyword-badge">{kw}</span>'
                    for kw in keywords
                ])
                hit_keywords_html = f'''
        <div class="hit-keywords-section">
            <h3>{hit_keywords_label}</h3>
            <div class="keywords-container">{keywords_badges}</div>
        </div>
        '''
        except:
            pass

    # Generate unsafe segments HTML for rejected or pending_review status
    unsafe_segments_raw = result.get('unsafe_segments', [])
    unsafe_segments_html = ''
    if unsafe_segments_raw and status in ['rejected', 'pending_review']:
        try:
            segments = unsafe_segments_raw if isinstance(unsafe_segments_raw, list) else []
            if segments:
                unsafe_content_label = '风险内容' if language == 'zh' else 'Unsafe Content'
                import html as html_module
                segments_list = ''.join([
                    f'<div class="unsafe-segment">{html_module.escape(seg.get("text", str(seg)) if isinstance(seg, dict) else str(seg))}</div>'
                    for seg in segments
                ])
                unsafe_segments_html = f'''
        <div class="unsafe-segments-section">
            <h3>{unsafe_content_label}</h3>
            <div class="segments-container">{segments_list}</div>
        </div>
        '''
        except:
            pass

    # Add final reviewer info for pending_review status
    reviewer_html = ''
    if status == 'pending_review' and final_reviewer_email:
        reviewer_html = f'''
        <div class="reviewer-section">
            <h3>{t('finalReviewer')}</h3>
            <p class="reviewer-email">{final_reviewer_email}</p>
        </div>
        '''

    # Set HTML lang attribute based on language
    html_lang = 'zh-CN' if language == 'zh' else 'en'

    html = f'''
    <!DOCTYPE html>
    <html lang="{html_lang}">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>{t('title')} - OpenGuardrails</title>
        <style>
            * {{
                margin: 0;
                padding: 0;
                box-sizing: border-box;
            }}
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }}
            .container {{
                background: white;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                max-width: 500px;
                width: 100%;
                padding: 40px;
                text-align: center;
            }}
            .status-icon {{
                font-size: 64px;
                margin-bottom: 20px;
            }}
            .success .status-icon {{
                color: #10b981;
            }}
            .rejected .status-icon {{
                color: #ef4444;
            }}
            .pending .status-icon {{
                color: #f59e0b;
            }}
            .error .status-icon {{
                color: #6b7280;
            }}
            .status-text {{
                font-size: 24px;
                font-weight: 600;
                margin-bottom: 8px;
            }}
            .success .status-text {{
                color: #10b981;
            }}
            .rejected .status-text {{
                color: #ef4444;
            }}
            .pending .status-text {{
                color: #f59e0b;
            }}
            .error .status-text {{
                color: #6b7280;
            }}
            .message {{
                font-size: 16px;
                color: #374151;
                line-height: 1.6;
                margin-bottom: 24px;
            }}
            .reason-section {{
                background: #f9fafb;
                border-radius: 8px;
                padding: 16px;
                text-align: left;
                margin-top: 24px;
            }}
            .reason-section h3 {{
                font-size: 14px;
                color: #6b7280;
                margin-bottom: 8px;
            }}
            .reason-text {{
                font-size: 14px;
                color: #374151;
                line-height: 1.6;
                white-space: pre-wrap;
            }}
            .reviewer-section {{
                background: #eff6ff;
                border: 1px solid #bfdbfe;
                border-radius: 8px;
                padding: 16px;
                text-align: left;
                margin-top: 16px;
            }}
            .reviewer-section h3 {{
                font-size: 14px;
                color: #1e40af;
                margin-bottom: 8px;
            }}
            .reviewer-email {{
                font-size: 14px;
                color: #1d4ed8;
                font-weight: 500;
            }}
            .footer {{
                margin-top: 32px;
                padding-top: 20px;
                border-top: 1px solid #e5e7eb;
            }}
            .footer-text {{
                font-size: 12px;
                color: #9ca3af;
            }}
            .close-hint {{
                margin-top: 24px;
                padding: 12px;
                background: #f3f4f6;
                border-radius: 8px;
                font-size: 14px;
                color: #6b7280;
            }}
            .hit-keywords-section {{
                background: #fef2f2;
                border: 1px solid #fecaca;
                border-radius: 8px;
                padding: 16px;
                text-align: left;
                margin-top: 16px;
            }}
            .hit-keywords-section h3 {{
                font-size: 14px;
                color: #991b1b;
                margin-bottom: 8px;
            }}
            .keywords-container {{
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            }}
            .keyword-badge {{
                display: inline-block;
                background-color: #fee2e2;
                color: #dc2626;
                border: 1px solid #fca5a5;
                border-radius: 4px;
                padding: 4px 10px;
                font-size: 13px;
                font-weight: 500;
            }}
            .unsafe-segments-section {{
                background: #fff1f2;
                border: 1px solid #fecdd3;
                border-radius: 8px;
                padding: 16px;
                text-align: left;
                margin-top: 16px;
            }}
            .unsafe-segments-section h3 {{
                font-size: 14px;
                color: #be123c;
                margin-bottom: 12px;
            }}
            .segments-container {{
                display: flex;
                flex-direction: column;
                gap: 8px;
            }}
            .unsafe-segment {{
                background-color: #ffe4e6;
                color: #9f1239;
                border-left: 3px solid #f43f5e;
                border-radius: 4px;
                padding: 8px 12px;
                font-size: 13px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-word;
            }}
        </style>
    </head>
    <body>
        <div class="container {status_class}">
            <div class="status-icon">{status_icon}</div>
            <div class="status-text">{status_text}</div>
            <div class="message">{message}</div>
            {reason_html}
            {hit_keywords_html}
            {unsafe_segments_html}
            {reviewer_html}
            <div class="close-hint">
                {t('closeHint')}
            </div>
            <div class="footer">
                <div class="footer-text">{t('poweredBy')}</div>
            </div>
        </div>
    </body>
    </html>
    '''
    return html


def generate_processing_html(request_id: str, language: str, retry: int) -> str:
    """Render a self-refreshing 'processing' page.

    Used when the detection record hasn't been imported from the JSONL log
    into the database yet. The page auto-refreshes every
    APPEAL_RETRY_INTERVAL_SECONDS seconds, incrementing ?retry= each time,
    until the record appears or APPEAL_MAX_RETRIES is hit.
    """
    def t(key: str) -> str:
        return get_translation(language, 'appealPage', key)

    next_retry = retry + 1
    refresh_url = f"/v1/appeal/{request_id}?lang={language}&retry={next_retry}"
    html_lang = 'zh-CN' if language == 'zh' else 'en'

    title = t('processingTitle')
    message = t('processingMessage')
    hint = t('processingHint')
    powered = t('poweredBy')

    return f'''
    <!DOCTYPE html>
    <html lang="{html_lang}">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="refresh" content="{APPEAL_RETRY_INTERVAL_SECONDS}; url={refresh_url}">
        <title>{title} - OpenGuardrails</title>
        <style>
            * {{ margin: 0; padding: 0; box-sizing: border-box; }}
            body {{
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
                display: flex;
                justify-content: center;
                align-items: center;
                padding: 20px;
            }}
            .container {{
                background: white;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0,0,0,0.2);
                max-width: 500px;
                width: 100%;
                padding: 40px;
                text-align: center;
            }}
            .spinner {{
                width: 64px;
                height: 64px;
                margin: 0 auto 24px;
                border: 6px solid #e5e7eb;
                border-top-color: #667eea;
                border-radius: 50%;
                animation: spin 0.9s linear infinite;
            }}
            @keyframes spin {{
                to {{ transform: rotate(360deg); }}
            }}
            .status-text {{
                font-size: 22px;
                font-weight: 600;
                color: #4b5563;
                margin-bottom: 12px;
            }}
            .message {{
                font-size: 16px;
                color: #374151;
                line-height: 1.6;
                margin-bottom: 16px;
            }}
            .hint {{
                font-size: 13px;
                color: #9ca3af;
                margin-bottom: 24px;
            }}
            .footer {{
                margin-top: 24px;
                padding-top: 20px;
                border-top: 1px solid #e5e7eb;
            }}
            .footer-text {{
                font-size: 12px;
                color: #9ca3af;
            }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="spinner"></div>
            <div class="status-text">{title}</div>
            <div class="message">{message}</div>
            <div class="hint">{hint}</div>
            <div class="footer">
                <div class="footer-text">{powered}</div>
            </div>
        </div>
    </body>
    </html>
    '''


@router.get("/appeal/{request_id}", response_class=HTMLResponse)
async def process_appeal(request_id: str, request: Request, lang: str = None, retry: int = 0):
    """
    Process appeal request - triggered by user clicking appeal link

    This is a public endpoint that doesn't require authentication.
    The request_id in the URL serves as the authentication token.

    Args:
        lang: Language parameter from URL (zh/en), takes priority over Accept-Language header
        retry: Auto-refresh retry counter — incremented by the processing page
            when the detection record is not yet imported into the DB.

    Returns an HTML page showing the appeal result, or a self-refreshing
    "processing" page while waiting for the detection record to land in the DB.
    """
    # Use lang query parameter if provided, otherwise detect from Accept-Language header
    if lang and lang in ['zh', 'en']:
        language = lang
    else:
        language = detect_language(request)

    # Get client info
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get('user-agent')

    logger.info(f"Processing appeal for request_id: {request_id}, ip: {ip_address}, lang: {language}, retry: {retry}")

    try:
        result = await appeal_service.process_appeal(
            request_id=request_id,
            ip_address=ip_address,
            user_agent=user_agent,
            language=language
        )

        # If the detection record isn't in the DB yet (async JSONL → DB import
        # hasn't caught up), show a self-refreshing "processing" page instead
        # of a hard error. Give up only after APPEAL_MAX_RETRIES.
        if (
            not result.get('success')
            and result.get('error') == 'detection_not_found'
            and retry < APPEAL_MAX_RETRIES
        ):
            return HTMLResponse(content=generate_processing_html(request_id, language, retry))

        return HTMLResponse(content=generate_result_html(result, language))

    except Exception as e:
        logger.error(f"Appeal processing error: {e}")
        error_result = {
            "success": False,
            "error": "system_error",
            "message": get_translation(language, 'appealPage', 'systemError')
        }
        return HTMLResponse(content=generate_result_html(error_result, language))
