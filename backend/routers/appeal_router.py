"""
Appeal Processing API routes (Detection Service)
Public endpoint for users to submit false positive appeals
"""
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse
import logging

from services.appeal_service import appeal_service
from utils.i18n_loader import get_translation

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
    success = result.get('success', False)
    status = result.get('status', '')
    message = result.get('message', '')
    reason = result.get('reason', '')
    final_reviewer_email = result.get('final_reviewer_email', '')

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
        </style>
    </head>
    <body>
        <div class="container {status_class}">
            <div class="status-icon">{status_icon}</div>
            <div class="status-text">{status_text}</div>
            <div class="message">{message}</div>
            {reason_html}
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


@router.get("/appeal/{request_id}", response_class=HTMLResponse)
async def process_appeal(request_id: str, request: Request, lang: str = None):
    """
    Process appeal request - triggered by user clicking appeal link

    This is a public endpoint that doesn't require authentication.
    The request_id in the URL serves as the authentication token.

    Args:
        lang: Language parameter from URL (zh/en), takes priority over Accept-Language header

    Returns an HTML page showing the appeal result.
    """
    # Use lang query parameter if provided, otherwise detect from Accept-Language header
    if lang and lang in ['zh', 'en']:
        language = lang
    else:
        language = detect_language(request)

    # Get client info
    ip_address = request.client.host if request.client else None
    user_agent = request.headers.get('user-agent')

    logger.info(f"Processing appeal for request_id: {request_id}, ip: {ip_address}, lang: {language}")

    try:
        result = await appeal_service.process_appeal(
            request_id=request_id,
            ip_address=ip_address,
            user_agent=user_agent,
            language=language
        )

        return HTMLResponse(content=generate_result_html(result, language))

    except Exception as e:
        logger.error(f"Appeal processing error: {e}")
        error_result = {
            "success": False,
            "error": "system_error",
            "message": get_translation(language, 'appealPage', 'systemError')
        }
        return HTMLResponse(content=generate_result_html(error_result, language))
