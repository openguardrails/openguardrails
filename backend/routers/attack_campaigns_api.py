"""
API endpoints for Red Teaming Attack Campaigns
"""
from fastapi import APIRouter, Depends, HTTPException, Request, BackgroundTasks
from typing import Optional, List
from uuid import UUID

from database.connection import get_db_session
from services.attack_campaigns_service import get_attack_campaigns_service
from models.attack_campaigns import (
    TestPackage,
    TestQuestionCreate,
    TestQuestionResponse,
    GenerateQuestionsRequest,
    GenerateQuestionsResponse,
    AttackCampaignCreate,
    AttackCampaignUpdate,
    AttackCampaignResponse,
    AttackCampaignDetailResponse,
    AttackCampaignResultResponse,
    RunCampaignResponse,
)
from utils.logger import setup_logger

logger = setup_logger()

router = APIRouter(prefix="/api/v1/attack-campaigns", tags=["Attack Campaigns"])


def get_tenant_id(request: Request) -> UUID:
    """Extract tenant ID from request auth context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Unauthorized")
    tenant_id = auth_context.get('data', {}).get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Unauthorized")
    return UUID(tenant_id)


# =====================================================
# Package Endpoints
# =====================================================

@router.get("/packages", response_model=List[TestPackage])
async def get_packages(request: Request):
    """Get available test packages with question counts"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        return service.get_packages(tenant_id)
    finally:
        db.close()


# =====================================================
# Question Endpoints
# =====================================================

@router.get("/questions")
async def list_questions(
    request: Request,
    package_type: Optional[str] = None,
    category: Optional[str] = None,
    is_preset: Optional[bool] = None,
    page: int = 1,
    page_size: int = 50
):
    """List test questions with filtering and pagination"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        result = service.get_questions(
            tenant_id=tenant_id,
            package_type=package_type,
            category=category,
            is_preset=is_preset,
            page=page,
            page_size=page_size
        )
        # Convert SQLAlchemy objects to response models
        result['items'] = [
            TestQuestionResponse(
                id=q.id,
                tenant_id=q.tenant_id,
                package_type=q.package_type,
                category=q.category,
                content=q.content,
                expected_action=q.expected_action,
                is_preset=q.is_preset,
                created_at=q.created_at
            )
            for q in result['items']
        ]
        return result
    finally:
        db.close()


@router.post("/questions", response_model=TestQuestionResponse)
async def create_question(
    request: Request,
    data: TestQuestionCreate
):
    """Create a custom test question"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        question = service.create_question(tenant_id, data)
        return TestQuestionResponse(
            id=question.id,
            tenant_id=question.tenant_id,
            package_type=question.package_type,
            category=question.category,
            content=question.content,
            expected_action=question.expected_action,
            is_preset=question.is_preset,
            created_at=question.created_at
        )
    finally:
        db.close()


@router.post("/questions/generate", response_model=GenerateQuestionsResponse)
async def generate_questions(
    request: Request,
    data: GenerateQuestionsRequest
):
    """Generate new test questions using AI"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        questions = await service.generate_questions(
            tenant_id=tenant_id,
            package_type=data.package_type,
            category=data.category,
            count=data.count
        )
        return GenerateQuestionsResponse(
            success=True,
            questions=[
                TestQuestionResponse(
                    id=q.id,
                    tenant_id=q.tenant_id,
                    package_type=q.package_type,
                    category=q.category,
                    content=q.content,
                    expected_action=q.expected_action,
                    is_preset=q.is_preset,
                    created_at=q.created_at
                )
                for q in questions
            ],
            message=f"Generated {len(questions)} new questions"
        )
    except Exception as e:
        logger.error(f"Failed to generate questions: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to generate questions: {str(e)}")
    finally:
        db.close()


# =====================================================
# Campaign Endpoints
# =====================================================

@router.get("")
async def list_campaigns(
    request: Request,
    status: Optional[str] = None,
    page: int = 1,
    page_size: int = 20
):
    """List attack campaigns"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        return service.list_campaigns(
            tenant_id=tenant_id,
            status=status,
            page=page,
            page_size=page_size
        )
    finally:
        db.close()


@router.post("", response_model=AttackCampaignResponse)
async def create_campaign(
    request: Request,
    data: AttackCampaignCreate
):
    """Create a new attack campaign"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        campaign = service.create_campaign(tenant_id, data)
        return AttackCampaignResponse(
            id=campaign.id,
            tenant_id=campaign.tenant_id,
            name=campaign.name,
            description=campaign.description,
            packages=campaign.packages,
            selected_categories=campaign.selected_categories,
            workspace_id=campaign.workspace_id,
            workspace_name=campaign.workspace.name if campaign.workspace else None,
            status=campaign.status,
            total_tests=campaign.total_tests,
            passed_tests=campaign.passed_tests,
            failed_tests=campaign.failed_tests,
            pass_rate=None,
            started_at=campaign.started_at,
            completed_at=campaign.completed_at,
            created_at=campaign.created_at
        )
    finally:
        db.close()


@router.get("/{campaign_id}", response_model=AttackCampaignDetailResponse)
async def get_campaign(
    request: Request,
    campaign_id: UUID
):
    """Get campaign details with results"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        campaign = service.get_campaign(tenant_id, campaign_id)
        if not campaign:
            raise HTTPException(status_code=404, detail="Campaign not found")

        return AttackCampaignDetailResponse(
            id=campaign.id,
            tenant_id=campaign.tenant_id,
            name=campaign.name,
            description=campaign.description,
            packages=campaign.packages,
            selected_categories=campaign.selected_categories,
            workspace_id=campaign.workspace_id,
            workspace_name=campaign.workspace.name if campaign.workspace else None,
            status=campaign.status,
            total_tests=campaign.total_tests,
            passed_tests=campaign.passed_tests,
            failed_tests=campaign.failed_tests,
            pass_rate=(campaign.passed_tests / campaign.total_tests * 100) if campaign.total_tests > 0 else None,
            started_at=campaign.started_at,
            completed_at=campaign.completed_at,
            created_at=campaign.created_at,
            results=[
                AttackCampaignResultResponse(
                    id=r.id,
                    question_id=r.question_id,
                    question_content=r.question_content,
                    category=r.category,
                    expected_action=r.expected_action,
                    actual_action=r.actual_action,
                    detection_result=r.detection_result,
                    passed=r.passed,
                    created_at=r.created_at
                )
                for r in campaign.results
            ]
        )
    finally:
        db.close()


@router.put("/{campaign_id}", response_model=AttackCampaignResponse)
async def update_campaign(
    request: Request,
    campaign_id: UUID,
    data: AttackCampaignUpdate
):
    """Update a campaign"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        campaign = service.update_campaign(tenant_id, campaign_id, data)
        if not campaign:
            raise HTTPException(status_code=404, detail="Campaign not found")

        return AttackCampaignResponse(
            id=campaign.id,
            tenant_id=campaign.tenant_id,
            name=campaign.name,
            description=campaign.description,
            packages=campaign.packages,
            selected_categories=campaign.selected_categories,
            workspace_id=campaign.workspace_id,
            workspace_name=campaign.workspace.name if campaign.workspace else None,
            status=campaign.status,
            total_tests=campaign.total_tests,
            passed_tests=campaign.passed_tests,
            failed_tests=campaign.failed_tests,
            pass_rate=(campaign.passed_tests / campaign.total_tests * 100) if campaign.total_tests > 0 else None,
            started_at=campaign.started_at,
            completed_at=campaign.completed_at,
            created_at=campaign.created_at
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.delete("/{campaign_id}")
async def delete_campaign(
    request: Request,
    campaign_id: UUID
):
    """Delete a campaign"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        success = service.delete_campaign(tenant_id, campaign_id)
        if not success:
            raise HTTPException(status_code=404, detail="Campaign not found")
        return {"success": True, "message": "Campaign deleted"}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.post("/{campaign_id}/run", response_model=RunCampaignResponse)
async def run_campaign(
    request: Request,
    campaign_id: UUID,
    background_tasks: BackgroundTasks
):
    """Run an attack campaign (starts in background)"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        campaign = service.get_campaign(tenant_id, campaign_id)
        if not campaign:
            raise HTTPException(status_code=404, detail="Campaign not found")

        if campaign.status == 'running':
            raise HTTPException(status_code=400, detail="Campaign is already running")

        # Run campaign asynchronously
        async def run_campaign_task():
            task_db = get_db_session()
            try:
                task_service = get_attack_campaigns_service(task_db)
                await task_service.run_campaign(tenant_id, campaign_id)
            except Exception as e:
                logger.error(f"Campaign {campaign_id} failed: {e}")
            finally:
                task_db.close()

        background_tasks.add_task(run_campaign_task)

        return RunCampaignResponse(
            success=True,
            campaign_id=campaign_id,
            status='running',
            message="Campaign started"
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    finally:
        db.close()


@router.get("/{campaign_id}/results")
async def get_campaign_results(
    request: Request,
    campaign_id: UUID,
    page: int = 1,
    page_size: int = 50
):
    """Get campaign results with pagination"""
    tenant_id = get_tenant_id(request)
    db = get_db_session()
    try:
        service = get_attack_campaigns_service(db)
        result = service.get_campaign_results(
            tenant_id=tenant_id,
            campaign_id=campaign_id,
            page=page,
            page_size=page_size
        )
        # Convert SQLAlchemy objects to response models
        result['items'] = [
            AttackCampaignResultResponse(
                id=r.id,
                question_id=r.question_id,
                question_content=r.question_content,
                category=r.category,
                expected_action=r.expected_action,
                actual_action=r.actual_action,
                detection_result=r.detection_result,
                passed=r.passed,
                created_at=r.created_at
            )
            for r in result['items']
        ]
        return result
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    finally:
        db.close()
