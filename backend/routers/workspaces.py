"""Workspace Management Router - CRUD operations for workspaces and workspace guardrail configs"""
from fastapi import APIRouter, Depends, HTTPException, Request, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from sqlalchemy import func
from database.connection import get_admin_db
from database.models import (
    Workspace, Application, Tenant, RiskTypeConfig,
    Blacklist, Whitelist, ApplicationDataLeakagePolicy,
    ApplicationScannerConfig, Scanner, ScannerPackage, ApplicationSettings,
    DataSecurityEntityType, CustomScanner, UpstreamApiConfig,
    ApiKey, KnowledgeBase, AppealConfig, AppealRecord
)
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from datetime import datetime
import uuid
import json
from utils.logger import setup_logger
from services.keyword_cache import keyword_cache
from services.audit_log_service import log_operation, compute_changes

logger = setup_logger()


def copy_workspace_config(db: Session, source_ws_id: str, target_ws_id: str, tenant_id: str):
    """Copy all configuration from source workspace to target workspace.
    Used when creating a new workspace to snapshot the global config."""
    source_uuid = uuid.UUID(str(source_ws_id))
    target_uuid = uuid.UUID(str(target_ws_id))
    tenant_uuid = uuid.UUID(str(tenant_id))

    # 1. RiskTypeConfig
    src_risk = db.query(RiskTypeConfig).filter(
        RiskTypeConfig.workspace_id == source_uuid
    ).first()
    if src_risk:
        new_risk = RiskTypeConfig(
            tenant_id=tenant_uuid,
            workspace_id=target_uuid,
            **{col: getattr(src_risk, col) for col in [
                's1_enabled', 's2_enabled', 's3_enabled', 's4_enabled', 's5_enabled',
                's6_enabled', 's7_enabled', 's8_enabled', 's9_enabled', 's10_enabled',
                's11_enabled', 's12_enabled', 's13_enabled', 's14_enabled', 's15_enabled',
                's16_enabled', 's17_enabled', 's18_enabled', 's19_enabled', 's20_enabled',
                's21_enabled', 'high_sensitivity_threshold', 'medium_sensitivity_threshold',
                'low_sensitivity_threshold', 'sensitivity_trigger_level',
            ]}
        )
        db.add(new_risk)

    # 2. Blacklists
    src_blacklists = db.query(Blacklist).filter(
        Blacklist.workspace_id == source_uuid
    ).all()
    for bl in src_blacklists:
        db.add(Blacklist(
            tenant_id=tenant_uuid, workspace_id=target_uuid,
            name=bl.name, keywords=bl.keywords, is_active=bl.is_active,
        ))

    # 4. Whitelists
    src_whitelists = db.query(Whitelist).filter(
        Whitelist.workspace_id == source_uuid
    ).all()
    for wl in src_whitelists:
        db.add(Whitelist(
            tenant_id=tenant_uuid, workspace_id=target_uuid,
            name=wl.name, keywords=wl.keywords, is_active=wl.is_active,
        ))

    # 5. ApplicationDataLeakagePolicy
    src_dlp = db.query(ApplicationDataLeakagePolicy).filter(
        ApplicationDataLeakagePolicy.workspace_id == source_uuid
    ).first()
    if src_dlp:
        new_dlp = ApplicationDataLeakagePolicy(
            tenant_id=tenant_uuid,
            workspace_id=target_uuid,
            **{col: getattr(src_dlp, col) for col in [
                'input_high_risk_action', 'input_medium_risk_action', 'input_low_risk_action',
                'output_high_risk_anonymize', 'output_medium_risk_anonymize', 'output_low_risk_anonymize',
                'output_high_risk_action', 'output_medium_risk_action', 'output_low_risk_action',
                'general_high_risk_action', 'general_medium_risk_action', 'general_low_risk_action',
                'general_input_high_risk_action', 'general_input_medium_risk_action', 'general_input_low_risk_action',
                'general_output_high_risk_action', 'general_output_medium_risk_action', 'general_output_low_risk_action',
                'private_model_id', 'enable_format_detection', 'enable_smart_segmentation',
            ]}
        )
        db.add(new_dlp)

    # 6. ApplicationScannerConfig (one per scanner)
    src_scanner_configs = db.query(ApplicationScannerConfig).filter(
        ApplicationScannerConfig.workspace_id == source_uuid
    ).all()
    for sc in src_scanner_configs:
        db.add(ApplicationScannerConfig(
            workspace_id=target_uuid,
            scanner_id=sc.scanner_id,
            is_enabled=sc.is_enabled,
            risk_level_override=sc.risk_level_override,
            scan_prompt_override=sc.scan_prompt_override,
            scan_response_override=sc.scan_response_override,
        ))

    # 7. ApplicationSettings
    src_settings = db.query(ApplicationSettings).filter(
        ApplicationSettings.workspace_id == source_uuid
    ).first()
    if src_settings:
        db.add(ApplicationSettings(
            tenant_id=tenant_uuid, workspace_id=target_uuid,
            security_risk_template=src_settings.security_risk_template,
            data_leakage_template=src_settings.data_leakage_template,
        ))

    # 8. DataSecurityEntityType (copy workspace's entity types)
    src_entities = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.workspace_id == source_uuid
    ).all()
    for et in src_entities:
        db.add(DataSecurityEntityType(
            tenant_id=tenant_uuid, workspace_id=target_uuid,
            entity_type=et.entity_type, entity_type_name=et.entity_type_name,
            category=et.category, recognition_method=et.recognition_method,
            recognition_config=(et.recognition_config or {}).copy() if isinstance(et.recognition_config, dict) else {},
            anonymization_method=et.anonymization_method,
            anonymization_config=(et.anonymization_config or {}).copy() if isinstance(et.anonymization_config, dict) else {},
            is_active=et.is_active, is_global=et.is_global,
            source_type=et.source_type, template_id=et.template_id,
            restore_code=et.restore_code, restore_code_hash=et.restore_code_hash,
            restore_natural_desc=et.restore_natural_desc,
        ))

    # 9. CustomScanner
    src_custom = db.query(CustomScanner).filter(
        CustomScanner.workspace_id == source_uuid
    ).all()
    for cs in src_custom:
        db.add(CustomScanner(
            workspace_id=target_uuid,
            scanner_id=cs.scanner_id,
            created_by=cs.created_by,
            notes=cs.notes,
        ))

    # 10. AppealConfig
    src_appeal = db.query(AppealConfig).filter(
        AppealConfig.workspace_id == source_uuid,
        AppealConfig.application_id.is_(None),
    ).first()
    if src_appeal:
        db.add(AppealConfig(
            tenant_id=tenant_uuid,
            workspace_id=target_uuid,
            enabled=src_appeal.enabled,
            message_template=src_appeal.message_template,
            appeal_base_url=src_appeal.appeal_base_url,
            final_reviewer_email=src_appeal.final_reviewer_email,
        ))

    logger.info(f"Copied config from workspace {source_ws_id} to {target_ws_id}")

router = APIRouter(prefix="/api/v1/workspaces", tags=["Workspaces"])


def get_current_tenant_id(request: Request) -> str:
    """Get current tenant ID from request context"""
    auth_context = getattr(request.state, 'auth_context', None)
    if not auth_context:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if 'data' not in auth_context:
        raise HTTPException(status_code=401, detail="Invalid auth context")
    tenant_id = auth_context['data'].get('tenant_id')
    if not tenant_id:
        raise HTTPException(status_code=401, detail="Tenant ID not found in auth context")
    return str(tenant_id)


# Pydantic models
class WorkspaceCreate(BaseModel):
    name: str
    description: Optional[str] = None
    owner: Optional[str] = None
    enable_doublecheck: bool = True
    import_config: Optional[Dict[str, Any]] = None  # If provided, import this config instead of copying from Global

class WorkspaceUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    enable_doublecheck: Optional[bool] = None

class WorkspaceResponse(BaseModel):
    id: str
    tenant_id: str
    name: str
    description: Optional[str]
    owner: Optional[str] = None
    enable_doublecheck: bool = False
    is_global: bool = False
    created_at: datetime
    updated_at: datetime
    application_count: int = 0

    class Config:
        from_attributes = True

class WorkspaceAssignRequest(BaseModel):
    application_ids: List[str]


@router.get("", response_model=List[WorkspaceResponse])
async def list_workspaces(
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """List all workspaces for current tenant"""
    tenant_id = get_current_tenant_id(request)

    workspaces = db.query(Workspace).filter(
        Workspace.tenant_id == tenant_id
    ).order_by(Workspace.created_at.desc()).all()

    result = []
    for ws in workspaces:
        app_count = db.query(func.count(Application.id)).filter(
            Application.workspace_id == ws.id
        ).scalar()
        result.append(WorkspaceResponse(
            id=str(ws.id),
            tenant_id=str(ws.tenant_id),
            name=ws.name,
            description=ws.description,
            owner=ws.owner,
            enable_doublecheck=getattr(ws, 'enable_doublecheck', False),
            is_global=getattr(ws, 'is_global', False),
            created_at=ws.created_at,
            updated_at=ws.updated_at,
            application_count=app_count,
        ))

    return result


@router.post("", response_model=WorkspaceResponse)
async def create_workspace(
    request: Request,
    body: WorkspaceCreate,
    db: Session = Depends(get_admin_db),
):
    """Create a new workspace. Copies config from the global workspace as initial config."""
    tenant_id = get_current_tenant_id(request)

    # Check name uniqueness
    existing = db.query(Workspace).filter(
        Workspace.tenant_id == tenant_id,
        Workspace.name == body.name
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Workspace name already exists")

    workspace = Workspace(
        tenant_id=uuid.UUID(tenant_id),
        name=body.name,
        description=body.description,
        owner=body.owner,
        enable_doublecheck=body.enable_doublecheck,
    )
    db.add(workspace)
    db.flush()  # Get workspace.id before copying config

    # Initialize config: from import or copy from global workspace
    if body.import_config:
        try:
            import_workspace_config(db, str(workspace.id), tenant_id, body.import_config)
        except Exception as e:
            logger.error(f"Failed to import config to new workspace: {e}")
    else:
        global_ws = db.query(Workspace).filter(
            Workspace.tenant_id == tenant_id,
            Workspace.is_global == True
        ).first()
        if global_ws:
            try:
                copy_workspace_config(db, str(global_ws.id), str(workspace.id), tenant_id)
            except Exception as e:
                logger.error(f"Failed to copy global config to new workspace: {e}")

    db.commit()
    db.refresh(workspace)

    await log_operation(
        db=db, request=request, action="create",
        resource_type="workspace", resource_id=str(workspace.id), resource_name=workspace.name,
    )

    return WorkspaceResponse(
        id=str(workspace.id),
        tenant_id=str(workspace.tenant_id),
        name=workspace.name,
        description=workspace.description,
        owner=workspace.owner,
        enable_doublecheck=workspace.enable_doublecheck,
        is_global=False,
        created_at=workspace.created_at,
        updated_at=workspace.updated_at,
        application_count=0,
    )


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: str,
    request: Request,
    body: WorkspaceUpdate,
    db: Session = Depends(get_admin_db),
):
    """Update a workspace"""
    tenant_id = get_current_tenant_id(request)

    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    old_data = {"name": workspace.name, "description": workspace.description, "owner": workspace.owner, "enable_doublecheck": workspace.enable_doublecheck}

    if body.name is not None:
        # Protect Global workspace name
        if getattr(workspace, 'is_global', False) and body.name != workspace.name:
            raise HTTPException(status_code=400, detail="Cannot rename the Global workspace")
        # Check name uniqueness
        existing = db.query(Workspace).filter(
            Workspace.tenant_id == tenant_id,
            Workspace.name == body.name,
            Workspace.id != workspace.id,
        ).first()
        if existing:
            raise HTTPException(status_code=400, detail="Workspace name already exists")
        workspace.name = body.name

    if body.description is not None:
        workspace.description = body.description

    if body.owner is not None:
        workspace.owner = body.owner

    if body.enable_doublecheck is not None:
        workspace.enable_doublecheck = body.enable_doublecheck

    db.commit()
    db.refresh(workspace)

    new_data = {"name": workspace.name, "description": workspace.description, "owner": workspace.owner, "enable_doublecheck": workspace.enable_doublecheck}
    changes = compute_changes(old_data, new_data)
    await log_operation(
        db=db, request=request, action="update",
        resource_type="workspace", resource_id=str(workspace.id), resource_name=workspace.name,
        changes=changes,
    )

    app_count = db.query(func.count(Application.id)).filter(
        Application.workspace_id == workspace.id
    ).scalar()

    return WorkspaceResponse(
        id=str(workspace.id),
        tenant_id=str(workspace.tenant_id),
        name=workspace.name,
        description=workspace.description,
        owner=workspace.owner,
        enable_doublecheck=workspace.enable_doublecheck,
        is_global=getattr(workspace, 'is_global', False),
        created_at=workspace.created_at,
        updated_at=workspace.updated_at,
        application_count=app_count,
    )


@router.delete("/{workspace_id}")
async def delete_workspace(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Delete a workspace (applications are unassigned, not deleted)"""
    tenant_id = get_current_tenant_id(request)

    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    if getattr(workspace, 'is_global', False):
        raise HTTPException(status_code=400, detail="Cannot delete the Global workspace")

    # Move applications to global workspace
    global_ws = db.query(Workspace).filter(
        Workspace.tenant_id == tenant_id,
        Workspace.is_global == True,
    ).first()
    if global_ws:
        db.query(Application).filter(
            Application.workspace_id == workspace.id
        ).update({Application.workspace_id: global_ws.id})
    else:
        db.query(Application).filter(
            Application.workspace_id == workspace.id
        ).update({Application.workspace_id: None})

    ws_name = workspace.name
    ws_id_str = str(workspace.id)
    db.delete(workspace)
    db.commit()

    await log_operation(
        db=db, request=request, action="delete",
        resource_type="workspace", resource_id=ws_id_str, resource_name=ws_name,
    )

    return {"message": "Workspace deleted successfully"}


@router.post("/{workspace_id}/assign", response_model=WorkspaceResponse)
async def assign_applications(
    workspace_id: str,
    request: Request,
    body: WorkspaceAssignRequest,
    db: Session = Depends(get_admin_db),
):
    """Assign applications to a workspace"""
    tenant_id = get_current_tenant_id(request)

    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Update applications
    for app_id in body.application_ids:
        app = db.query(Application).filter(
            Application.id == app_id,
            Application.tenant_id == tenant_id,
        ).first()
        if app:
            app.workspace_id = workspace.id

    db.commit()
    db.refresh(workspace)

    await log_operation(
        db=db, request=request, action="update",
        resource_type="workspace", resource_id=str(workspace.id), resource_name=workspace.name,
        changes={"assigned_applications": body.application_ids},
    )

    app_count = db.query(func.count(Application.id)).filter(
        Application.workspace_id == workspace.id
    ).scalar()

    return WorkspaceResponse(
        id=str(workspace.id),
        tenant_id=str(workspace.tenant_id),
        name=workspace.name,
        description=workspace.description,
        owner=workspace.owner,
        enable_doublecheck=getattr(workspace, 'enable_doublecheck', False),
        is_global=getattr(workspace, 'is_global', False),
        created_at=workspace.created_at,
        updated_at=workspace.updated_at,
        application_count=app_count,
    )


@router.post("/{workspace_id}/unassign")
async def unassign_applications(
    workspace_id: str,
    request: Request,
    body: WorkspaceAssignRequest,
    db: Session = Depends(get_admin_db),
):
    """Remove applications from a workspace (moves them to Global workspace)"""
    tenant_id = get_current_tenant_id(request)

    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    # Move unassigned apps to Global workspace (apps must always belong to a workspace)
    from services.workspace_resolver import ensure_global_workspace
    global_ws_id = ensure_global_workspace(db, tenant_id)

    for app_id in body.application_ids:
        app = db.query(Application).filter(
            Application.id == app_id,
            Application.tenant_id == tenant_id,
            Application.workspace_id == workspace.id,
        ).first()
        if app:
            app.workspace_id = uuid.UUID(global_ws_id)

    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="workspace", resource_id=str(workspace.id), resource_name=workspace.name,
        changes={"unassigned_applications": body.application_ids},
    )

    return {"message": "Applications moved to Global workspace"}


@router.get("/{workspace_id}/applications")
async def list_workspace_applications(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """List applications in a workspace"""
    tenant_id = get_current_tenant_id(request)

    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")

    apps = db.query(Application).filter(
        Application.workspace_id == workspace.id,
        Application.tenant_id == tenant_id,
    ).order_by(Application.created_at.desc()).all()

    results = []
    for app in apps:
        key_count = db.query(ApiKey).filter(ApiKey.application_id == app.id).count()

        # Build protection summary from workspace config
        ws_id = workspace.id

        enabled_scanners_count = db.query(ApplicationScannerConfig).filter(
            ApplicationScannerConfig.workspace_id == ws_id,
            ApplicationScannerConfig.is_enabled == True
        ).count()

        total_scanners_count = db.query(ApplicationScannerConfig).filter(
            ApplicationScannerConfig.workspace_id == ws_id
        ).count()

        risk_config = db.query(RiskTypeConfig).filter(
            RiskTypeConfig.workspace_id == ws_id
        ).first()

        data_security_count = db.query(DataSecurityEntityType).filter(
            DataSecurityEntityType.workspace_id == ws_id,
            DataSecurityEntityType.is_active == True
        ).count()

        blacklist_count = db.query(Blacklist).filter(
            Blacklist.workspace_id == ws_id,
            Blacklist.is_active == True
        ).count()

        whitelist_count = db.query(Whitelist).filter(
            Whitelist.workspace_id == ws_id,
            Whitelist.is_active == True
        ).count()

        knowledge_base_count = db.query(KnowledgeBase).filter(
            KnowledgeBase.application_id == app.id,
            KnowledgeBase.is_active == True
        ).count()

        protection_summary = {
            "risk_types_enabled": enabled_scanners_count,
            "total_risk_types": total_scanners_count,
            "sensitivity_level": risk_config.sensitivity_trigger_level if risk_config else "medium",
            "data_security_entities": data_security_count,
            "blacklist_count": blacklist_count,
            "whitelist_count": whitelist_count,
            "knowledge_base_count": knowledge_base_count
        }

        results.append({
            "id": str(app.id),
            "name": app.name,
            "description": app.description,
            "is_active": app.is_active,
            "source": getattr(app, 'source', 'manual') or 'manual',
            "external_id": getattr(app, 'external_id', None),
            "workspace_id": str(app.workspace_id) if app.workspace_id else None,
            "created_at": app.created_at.isoformat() if app.created_at else None,
            "updated_at": app.updated_at.isoformat() if app.updated_at else None,
            "api_keys_count": key_count,
            "protection_summary": protection_summary,
        })

    return results


# ============================================================
# Workspace Guardrail Configuration Endpoints
# ============================================================

def _verify_workspace_ownership(db: Session, workspace_id: str, tenant_id: str) -> Workspace:
    """Verify workspace exists and belongs to tenant"""
    workspace = db.query(Workspace).filter(
        Workspace.id == workspace_id,
        Workspace.tenant_id == tenant_id,
    ).first()
    if not workspace:
        raise HTTPException(status_code=404, detail="Workspace not found")
    return workspace


# --- Risk Type Config ---

class WorkspaceRiskTypeConfigUpdate(BaseModel):
    s1_enabled: Optional[bool] = None
    s2_enabled: Optional[bool] = None
    s3_enabled: Optional[bool] = None
    s4_enabled: Optional[bool] = None
    s5_enabled: Optional[bool] = None
    s6_enabled: Optional[bool] = None
    s7_enabled: Optional[bool] = None
    s8_enabled: Optional[bool] = None
    s9_enabled: Optional[bool] = None
    s10_enabled: Optional[bool] = None
    s11_enabled: Optional[bool] = None
    s12_enabled: Optional[bool] = None
    s13_enabled: Optional[bool] = None
    s14_enabled: Optional[bool] = None
    s15_enabled: Optional[bool] = None
    s16_enabled: Optional[bool] = None
    s17_enabled: Optional[bool] = None
    s18_enabled: Optional[bool] = None
    s19_enabled: Optional[bool] = None
    s20_enabled: Optional[bool] = None
    s21_enabled: Optional[bool] = None
    high_sensitivity_threshold: Optional[float] = None
    medium_sensitivity_threshold: Optional[float] = None
    low_sensitivity_threshold: Optional[float] = None
    sensitivity_trigger_level: Optional[str] = None


@router.get("/{workspace_id}/config/risk-types")
async def get_workspace_risk_config(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level risk type configuration"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    config = db.query(RiskTypeConfig).filter(
        RiskTypeConfig.workspace_id == workspace_id
    ).first()

    if not config:
        return {f"s{i}_enabled": True for i in range(1, 22)} | {
            "high_sensitivity_threshold": 0.40,
            "medium_sensitivity_threshold": 0.60,
            "low_sensitivity_threshold": 0.95,
            "sensitivity_trigger_level": "medium",
            "exists": False,
        }

    result = {}
    for i in range(1, 22):
        result[f"s{i}_enabled"] = getattr(config, f"s{i}_enabled", True)
    result["high_sensitivity_threshold"] = config.high_sensitivity_threshold or 0.40
    result["medium_sensitivity_threshold"] = config.medium_sensitivity_threshold or 0.60
    result["low_sensitivity_threshold"] = config.low_sensitivity_threshold or 0.95
    result["sensitivity_trigger_level"] = config.sensitivity_trigger_level or "medium"
    result["exists"] = True
    return result


@router.put("/{workspace_id}/config/risk-types")
async def update_workspace_risk_config(
    workspace_id: str,
    request: Request,
    body: WorkspaceRiskTypeConfigUpdate,
    db: Session = Depends(get_admin_db),
):
    """Update workspace-level risk type configuration"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    config = db.query(RiskTypeConfig).filter(
        RiskTypeConfig.workspace_id == workspace_id
    ).first()

    if not config:
        config = RiskTypeConfig(
            tenant_id=uuid.UUID(tenant_id),
            workspace_id=uuid.UUID(workspace_id),
        )
        db.add(config)

    updates = body.dict(exclude_none=True)
    for field, value in updates.items():
        if hasattr(config, field):
            setattr(config, field, value)

    db.commit()
    db.refresh(config)

    await log_operation(
        db=db, request=request, action="update",
        resource_type="risk_config", resource_id=workspace_id, resource_name=workspace.name,
        changes=updates,
    )

    result = {}
    for i in range(1, 22):
        result[f"s{i}_enabled"] = getattr(config, f"s{i}_enabled", True)
    result["high_sensitivity_threshold"] = config.high_sensitivity_threshold or 0.40
    result["medium_sensitivity_threshold"] = config.medium_sensitivity_threshold or 0.60
    result["low_sensitivity_threshold"] = config.low_sensitivity_threshold or 0.95
    result["sensitivity_trigger_level"] = config.sensitivity_trigger_level or "medium"
    return result


# --- Blacklist / Whitelist ---

class WorkspaceKeywordListCreate(BaseModel):
    name: str
    keywords: List[str]
    description: Optional[str] = None
    is_active: bool = True

class WorkspaceKeywordListUpdate(BaseModel):
    name: Optional[str] = None
    keywords: Optional[List[str]] = None
    description: Optional[str] = None
    is_active: Optional[bool] = None


@router.get("/{workspace_id}/config/blacklist")
async def get_workspace_blacklists(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level blacklists"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    lists = db.query(Blacklist).filter(
        Blacklist.workspace_id == workspace_id,
    ).all()

    return [{
        "id": item.id,
        "name": item.name,
        "keywords": item.keywords,
        "description": item.description,
        "is_active": item.is_active,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    } for item in lists]


@router.post("/{workspace_id}/config/blacklist")
async def create_workspace_blacklist(
    workspace_id: str,
    request: Request,
    body: WorkspaceKeywordListCreate,
    db: Session = Depends(get_admin_db),
):
    """Create a workspace-level blacklist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = Blacklist(
        tenant_id=uuid.UUID(tenant_id),
        workspace_id=uuid.UUID(workspace_id),
        name=body.name,
        keywords=body.keywords,
        description=body.description,
        is_active=body.is_active,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    await keyword_cache.invalidate_cache()

    await log_operation(
        db=db, request=request, action="create",
        resource_type="blacklist", resource_id=str(item.id), resource_name=item.name,
    )

    return {
        "id": item.id,
        "name": item.name,
        "keywords": item.keywords,
        "description": item.description,
        "is_active": item.is_active,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


@router.put("/{workspace_id}/config/blacklist/{item_id}")
async def update_workspace_blacklist(
    workspace_id: str,
    item_id: int,
    request: Request,
    body: WorkspaceKeywordListUpdate,
    db: Session = Depends(get_admin_db),
):
    """Update a workspace-level blacklist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = db.query(Blacklist).filter(
        Blacklist.id == item_id,
        Blacklist.workspace_id == workspace_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Blacklist not found")

    old_data = {"name": item.name, "keywords": item.keywords, "is_active": item.is_active}
    updates = body.dict(exclude_none=True)
    for field, value in updates.items():
        if hasattr(item, field):
            setattr(item, field, value)

    db.commit()
    await keyword_cache.invalidate_cache()

    new_data = {"name": item.name, "keywords": item.keywords, "is_active": item.is_active}
    await log_operation(
        db=db, request=request, action="update",
        resource_type="blacklist", resource_id=str(item.id), resource_name=item.name,
        changes=compute_changes(old_data, new_data),
    )

    return {"message": "Updated successfully"}


@router.delete("/{workspace_id}/config/blacklist/{item_id}")
async def delete_workspace_blacklist(
    workspace_id: str,
    item_id: int,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Delete a workspace-level blacklist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = db.query(Blacklist).filter(
        Blacklist.id == item_id,
        Blacklist.workspace_id == workspace_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Blacklist not found")

    bl_name = item.name
    bl_id = item.id
    db.delete(item)
    db.commit()
    await keyword_cache.invalidate_cache()

    await log_operation(
        db=db, request=request, action="delete",
        resource_type="blacklist", resource_id=str(bl_id), resource_name=bl_name,
    )

    return {"message": "Deleted successfully"}


@router.get("/{workspace_id}/config/whitelist")
async def get_workspace_whitelists(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level whitelists"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    lists = db.query(Whitelist).filter(
        Whitelist.workspace_id == workspace_id,
    ).all()

    return [{
        "id": item.id,
        "name": item.name,
        "keywords": item.keywords,
        "description": item.description,
        "is_active": item.is_active,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    } for item in lists]


@router.post("/{workspace_id}/config/whitelist")
async def create_workspace_whitelist(
    workspace_id: str,
    request: Request,
    body: WorkspaceKeywordListCreate,
    db: Session = Depends(get_admin_db),
):
    """Create a workspace-level whitelist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = Whitelist(
        tenant_id=uuid.UUID(tenant_id),
        workspace_id=uuid.UUID(workspace_id),
        name=body.name,
        keywords=body.keywords,
        description=body.description,
        is_active=body.is_active,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    await keyword_cache.invalidate_cache()

    await log_operation(
        db=db, request=request, action="create",
        resource_type="whitelist", resource_id=str(item.id), resource_name=item.name,
    )

    return {
        "id": item.id,
        "name": item.name,
        "keywords": item.keywords,
        "description": item.description,
        "is_active": item.is_active,
        "created_at": item.created_at.isoformat() if item.created_at else None,
        "updated_at": item.updated_at.isoformat() if item.updated_at else None,
    }


@router.put("/{workspace_id}/config/whitelist/{item_id}")
async def update_workspace_whitelist(
    workspace_id: str,
    item_id: int,
    request: Request,
    body: WorkspaceKeywordListUpdate,
    db: Session = Depends(get_admin_db),
):
    """Update a workspace-level whitelist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = db.query(Whitelist).filter(
        Whitelist.id == item_id,
        Whitelist.workspace_id == workspace_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Whitelist not found")

    old_data = {"name": item.name, "keywords": item.keywords, "is_active": item.is_active}
    updates = body.dict(exclude_none=True)
    for field, value in updates.items():
        if hasattr(item, field):
            setattr(item, field, value)

    db.commit()
    await keyword_cache.invalidate_cache()

    new_data = {"name": item.name, "keywords": item.keywords, "is_active": item.is_active}
    await log_operation(
        db=db, request=request, action="update",
        resource_type="whitelist", resource_id=str(item.id), resource_name=item.name,
        changes=compute_changes(old_data, new_data),
    )

    return {"message": "Updated successfully"}


@router.delete("/{workspace_id}/config/whitelist/{item_id}")
async def delete_workspace_whitelist(
    workspace_id: str,
    item_id: int,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Delete a workspace-level whitelist"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    item = db.query(Whitelist).filter(
        Whitelist.id == item_id,
        Whitelist.workspace_id == workspace_id,
    ).first()
    if not item:
        raise HTTPException(status_code=404, detail="Whitelist not found")

    wl_name = item.name
    wl_id = item.id
    db.delete(item)
    db.commit()
    await keyword_cache.invalidate_cache()

    await log_operation(
        db=db, request=request, action="delete",
        resource_type="whitelist", resource_id=str(wl_id), resource_name=wl_name,
    )

    return {"message": "Deleted successfully"}




# --- Data Masking Policy ---

class WorkspaceDataLeakagePolicyUpdate(BaseModel):
    input_high_risk_action: Optional[str] = None
    input_medium_risk_action: Optional[str] = None
    input_low_risk_action: Optional[str] = None
    output_high_risk_action: Optional[str] = None
    output_medium_risk_action: Optional[str] = None
    output_low_risk_action: Optional[str] = None
    general_input_high_risk_action: Optional[str] = None
    general_input_medium_risk_action: Optional[str] = None
    general_input_low_risk_action: Optional[str] = None
    general_output_high_risk_action: Optional[str] = None
    general_output_medium_risk_action: Optional[str] = None
    general_output_low_risk_action: Optional[str] = None
    private_model_id: Optional[str] = None
    enable_format_detection: Optional[bool] = None
    enable_smart_segmentation: Optional[bool] = None


@router.get("/{workspace_id}/config/data-leakage-policy")
async def get_workspace_data_leakage_policy(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level data masking policy"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    policy = db.query(ApplicationDataLeakagePolicy).filter(
        ApplicationDataLeakagePolicy.workspace_id == workspace_id,
        ApplicationDataLeakagePolicy.application_id.is_(None),
    ).first()

    # Fetch available private models for this tenant
    private_models = db.query(UpstreamApiConfig).filter(
        UpstreamApiConfig.tenant_id == tenant_id,
        UpstreamApiConfig.is_private_model == True,
        UpstreamApiConfig.is_active == True,
    ).order_by(
        UpstreamApiConfig.is_default_private_model.desc(),
        UpstreamApiConfig.created_at.asc(),
    ).all()

    available_private_models = [
        {
            "id": str(m.id),
            "config_name": m.config_name,
            "provider": m.provider,
            "is_default_private_model": m.is_default_private_model,
            "private_model_names": m.private_model_names or [],
        }
        for m in private_models
    ]

    if not policy:
        return {"exists": False, "available_private_models": available_private_models}

    return {
        "exists": True,
        "input_high_risk_action": policy.input_high_risk_action,
        "input_medium_risk_action": policy.input_medium_risk_action,
        "input_low_risk_action": policy.input_low_risk_action,
        "output_high_risk_action": policy.output_high_risk_action,
        "output_medium_risk_action": policy.output_medium_risk_action,
        "output_low_risk_action": policy.output_low_risk_action,
        "general_input_high_risk_action": policy.general_input_high_risk_action,
        "general_input_medium_risk_action": policy.general_input_medium_risk_action,
        "general_input_low_risk_action": policy.general_input_low_risk_action,
        "general_output_high_risk_action": policy.general_output_high_risk_action,
        "general_output_medium_risk_action": policy.general_output_medium_risk_action,
        "general_output_low_risk_action": policy.general_output_low_risk_action,
        "private_model_id": str(policy.private_model_id) if policy.private_model_id else None,
        "enable_format_detection": policy.enable_format_detection,
        "enable_smart_segmentation": policy.enable_smart_segmentation,
        "available_private_models": available_private_models,
    }


@router.put("/{workspace_id}/config/data-leakage-policy")
async def update_workspace_data_leakage_policy(
    workspace_id: str,
    request: Request,
    body: WorkspaceDataLeakagePolicyUpdate,
    db: Session = Depends(get_admin_db),
):
    """Update workspace-level data masking policy"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    policy = db.query(ApplicationDataLeakagePolicy).filter(
        ApplicationDataLeakagePolicy.workspace_id == workspace_id,
        ApplicationDataLeakagePolicy.application_id.is_(None),
    ).first()

    if not policy:
        policy = ApplicationDataLeakagePolicy(
            tenant_id=uuid.UUID(tenant_id),
            workspace_id=uuid.UUID(workspace_id),
        )
        db.add(policy)

    updates = body.dict(exclude_none=True)
    if "private_model_id" in updates:
        val = updates.pop("private_model_id")
        policy.private_model_id = uuid.UUID(val) if val else None
    for field, value in updates.items():
        if hasattr(policy, field):
            setattr(policy, field, value)

    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="data_leakage_policy", resource_id=workspace_id, resource_name=workspace.name,
        changes=body.dict(exclude_none=True),
    )

    return {"message": "Updated successfully"}


# --- Scanner Configs ---

class WorkspaceScannerConfigUpdate(BaseModel):
    scanner_id: str
    is_enabled: Optional[bool] = None
    risk_level: Optional[str] = None
    scan_prompt: Optional[bool] = None
    scan_response: Optional[bool] = None


class WorkspaceScannerConfigBulkUpdate(BaseModel):
    configs: List[WorkspaceScannerConfigUpdate]


@router.get("/{workspace_id}/config/scanners")
async def get_workspace_scanner_configs(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level scanner configurations"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    # Get available scanners (built-in + purchased)
    from services.scanner_config_service import ScannerConfigService
    svc = ScannerConfigService(db)
    available_scanners = svc._get_available_scanners(uuid.UUID(tenant_id))

    # Get workspace configs
    configs = db.query(ApplicationScannerConfig).filter(
        ApplicationScannerConfig.workspace_id == workspace_id,
        ApplicationScannerConfig.application_id.is_(None),
    ).all()
    config_map = {str(c.scanner_id): c for c in configs}

    result = []
    for scanner in available_scanners:
        config = config_map.get(str(scanner.id))
        is_enabled = config.is_enabled if config else True
        risk_level = config.risk_level_override if config and config.risk_level_override else scanner.default_risk_level
        scan_prompt = config.scan_prompt_override if config and config.scan_prompt_override is not None else scanner.default_scan_prompt
        scan_response = config.scan_response_override if config and config.scan_response_override is not None else scanner.default_scan_response

        result.append({
            "id": str(scanner.id),
            "tag": scanner.tag,
            "name": scanner.name,
            "description": scanner.description,
            "scanner_type": scanner.scanner_type,
            "package_name": scanner.package.package_name if scanner.package else "Custom",
            "package_id": str(scanner.package_id) if scanner.package_id else None,
            "package_type": scanner.package.package_type if scanner.package else "custom",
            "is_custom": False,
            "is_enabled": is_enabled,
            "risk_level": risk_level,
            "scan_prompt": scan_prompt,
            "scan_response": scan_response,
            "default_risk_level": scanner.default_risk_level,
            "default_scan_prompt": scanner.default_scan_prompt,
            "default_scan_response": scanner.default_scan_response,
            "has_risk_level_override": config is not None and config.risk_level_override is not None if config else False,
            "has_scan_prompt_override": config is not None and config.scan_prompt_override is not None if config else False,
            "has_scan_response_override": config is not None and config.scan_response_override is not None if config else False,
        })

    return result


@router.put("/{workspace_id}/config/scanners")
async def update_workspace_scanner_configs(
    workspace_id: str,
    request: Request,
    body: WorkspaceScannerConfigBulkUpdate,
    db: Session = Depends(get_admin_db),
):
    """Bulk update workspace-level scanner configurations"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    ws_uuid = uuid.UUID(workspace_id)
    for item in body.configs:
        scanner_uuid = uuid.UUID(item.scanner_id)

        config = db.query(ApplicationScannerConfig).filter(
            ApplicationScannerConfig.workspace_id == ws_uuid,
            ApplicationScannerConfig.scanner_id == scanner_uuid,
            ApplicationScannerConfig.application_id.is_(None),
        ).first()

        if not config:
            config = ApplicationScannerConfig(
                workspace_id=ws_uuid,
                scanner_id=scanner_uuid,
            )
            db.add(config)

        if item.is_enabled is not None:
            config.is_enabled = item.is_enabled
        if item.risk_level is not None:
            config.risk_level_override = item.risk_level
        if item.scan_prompt is not None:
            config.scan_prompt_override = item.scan_prompt
        if item.scan_response is not None:
            config.scan_response_override = item.scan_response

    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="scanner_config", resource_id=workspace_id, resource_name=workspace.name,
        changes={"scanners_updated": len(body.configs)},
    )

    return {"message": "Updated successfully"}


# --- Fixed Answer Templates ---

DEFAULT_TEMPLATES = {
    "security_risk_template": {
        "en": "Request blocked by OpenGuardrails due to possible violation of policy related to {guardrail_name}.",
        "zh": "请求已被OpenGuardrails拦截，原因：可能违反了与{guardrail_name}有关的策略要求。"
    },
    "data_leakage_template": {
        "en": "Request blocked by OpenGuardrails due to possible sensitive data ({entity_type_names}).",
        "zh": "请求已被OpenGuardrails拦截，原因：可能包含敏感数据（{entity_type_names}）。"
    }
}


@router.get("/{workspace_id}/config/fixed-answer-templates")
async def get_workspace_fixed_answer_templates(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level fixed answer templates"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    settings = db.query(ApplicationSettings).filter(
        ApplicationSettings.workspace_id == workspace_id,
        ApplicationSettings.application_id.is_(None),
    ).first()

    if settings:
        return {
            "security_risk_template": settings.security_risk_template or DEFAULT_TEMPLATES["security_risk_template"],
            "data_leakage_template": settings.data_leakage_template or DEFAULT_TEMPLATES["data_leakage_template"],
        }
    return DEFAULT_TEMPLATES


@router.put("/{workspace_id}/config/fixed-answer-templates")
async def update_workspace_fixed_answer_templates(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Update workspace-level fixed answer templates"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    body = await request.json()

    settings = db.query(ApplicationSettings).filter(
        ApplicationSettings.workspace_id == workspace_id,
        ApplicationSettings.application_id.is_(None),
    ).first()

    if not settings:
        settings = ApplicationSettings(
            tenant_id=uuid.UUID(tenant_id),
            workspace_id=uuid.UUID(workspace_id),
            security_risk_template=DEFAULT_TEMPLATES["security_risk_template"],
            data_leakage_template=DEFAULT_TEMPLATES["data_leakage_template"],
        )
        db.add(settings)

    if "security_risk_template" in body:
        existing = dict(settings.security_risk_template or DEFAULT_TEMPLATES["security_risk_template"])
        if isinstance(body["security_risk_template"], dict):
            existing.update(body["security_risk_template"])
        else:
            existing = body["security_risk_template"]
        settings.security_risk_template = existing

    if "data_leakage_template" in body:
        existing = dict(settings.data_leakage_template or DEFAULT_TEMPLATES["data_leakage_template"])
        if isinstance(body["data_leakage_template"], dict):
            existing.update(body["data_leakage_template"])
        else:
            existing = body["data_leakage_template"]
        settings.data_leakage_template = existing

    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="response_template", resource_id=workspace_id, resource_name=workspace.name,
        changes={"templates_updated": list(body.keys())},
    )

    return {"success": True, "message": "Fixed answer templates updated successfully"}


# ============================================================
# Workspace Appeal Config
# ============================================================

DEFAULT_APPEAL_CONFIG = {
    "enabled": False,
    "message_template": "If you think this is a false positive, please click the following link to appeal: {appeal_url}",
    "appeal_base_url": "",
    "final_reviewer_email": None,
}


@router.get("/{workspace_id}/config/appeal")
async def get_workspace_appeal_config(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Get workspace-level appeal configuration"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    config = db.query(AppealConfig).filter(
        AppealConfig.workspace_id == workspace_id,
        AppealConfig.application_id.is_(None),
    ).first()

    if config:
        return {
            "id": str(config.id),
            "enabled": config.enabled,
            "message_template": config.message_template,
            "appeal_base_url": config.appeal_base_url,
            "final_reviewer_email": config.final_reviewer_email,
            "created_at": config.created_at.isoformat() if config.created_at else None,
            "updated_at": config.updated_at.isoformat() if config.updated_at else None,
        }
    return DEFAULT_APPEAL_CONFIG


@router.put("/{workspace_id}/config/appeal")
async def update_workspace_appeal_config(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Update workspace-level appeal configuration"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    body = await request.json()

    config = db.query(AppealConfig).filter(
        AppealConfig.workspace_id == workspace_id,
        AppealConfig.application_id.is_(None),
    ).first()

    if not config:
        config = AppealConfig(
            tenant_id=uuid.UUID(tenant_id),
            workspace_id=uuid.UUID(workspace_id),
            enabled=False,
            message_template=DEFAULT_APPEAL_CONFIG["message_template"],
            appeal_base_url="",
        )
        db.add(config)

    if "enabled" in body:
        config.enabled = body["enabled"]
    if "message_template" in body:
        config.message_template = body["message_template"]
    if "appeal_base_url" in body:
        config.appeal_base_url = body["appeal_base_url"]
    if "final_reviewer_email" in body:
        config.final_reviewer_email = body["final_reviewer_email"] or None

    db.commit()

    await log_operation(
        db=db, request=request, action="update",
        resource_type="appeal_config", resource_id=workspace_id, resource_name=workspace.name,
        changes={k: v for k, v in body.items() if k in ("enabled", "message_template", "appeal_base_url", "final_reviewer_email")},
    )

    return {
        "id": str(config.id),
        "enabled": config.enabled,
        "message_template": config.message_template,
        "appeal_base_url": config.appeal_base_url,
        "final_reviewer_email": config.final_reviewer_email,
    }


@router.get("/{workspace_id}/config/appeal/records")
async def get_workspace_appeal_records(
    workspace_id: str,
    request: Request,
    status: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_admin_db),
):
    """Get appeal records for all applications in a workspace"""
    tenant_id = get_current_tenant_id(request)
    _verify_workspace_ownership(db, workspace_id, tenant_id)

    # Get all application IDs in this workspace
    ws_uuid = uuid.UUID(workspace_id)
    app_ids = [row[0] for row in db.query(Application.id).filter(
        Application.workspace_id == ws_uuid,
        Application.is_active == True,
    ).all()]

    if not app_ids:
        return {"items": [], "total": 0, "page": page, "page_size": page_size, "pages": 0}

    from sqlalchemy import desc
    query = db.query(AppealRecord).filter(AppealRecord.application_id.in_(app_ids))
    if status:
        query = query.filter(AppealRecord.status == status)

    total = query.count()
    pages = (total + page_size - 1) // page_size
    records = query.order_by(desc(AppealRecord.created_at)).offset((page - 1) * page_size).limit(page_size).all()

    # Get application names
    app_name_map = {}
    if records:
        rec_app_ids = set(r.application_id for r in records if r.application_id)
        if rec_app_ids:
            apps = db.query(Application).filter(Application.id.in_(rec_app_ids)).all()
            app_name_map = {app.id: app.name for app in apps}

    items = []
    for r in records:
        items.append({
            "id": str(r.id),
            "request_id": r.request_id,
            "user_id": r.user_id,
            "application_name": app_name_map.get(r.application_id, ""),
            "original_content": r.original_content,
            "original_risk_level": r.original_risk_level,
            "original_categories": r.original_categories or [],
            "status": r.status,
            "ai_approved": r.ai_approved,
            "ai_review_result": r.ai_review_result,
            "processor_type": r.processor_type,
            "processor_id": r.processor_id,
            "processor_reason": r.processor_reason,
            "created_at": r.created_at.isoformat() if r.created_at else None,
            "ai_reviewed_at": r.ai_reviewed_at.isoformat() if r.ai_reviewed_at else None,
            "processed_at": r.processed_at.isoformat() if r.processed_at else None,
        })

    return {"items": items, "total": total, "page": page, "page_size": page_size, "pages": pages}


# ============================================================
# Workspace Config Export / Import
# ============================================================

def export_workspace_config(db: Session, workspace_id: str, workspace_name: str) -> Dict[str, Any]:
    """Export all workspace configuration to a serializable dict."""
    ws_uuid = uuid.UUID(workspace_id)

    config = {}

    # 1. RiskTypeConfig
    risk = db.query(RiskTypeConfig).filter(RiskTypeConfig.workspace_id == ws_uuid).first()
    if risk:
        config["risk_types"] = {
            **{f"s{i}_enabled": getattr(risk, f"s{i}_enabled", True) for i in range(1, 22)},
            "high_sensitivity_threshold": risk.high_sensitivity_threshold,
            "medium_sensitivity_threshold": risk.medium_sensitivity_threshold,
            "low_sensitivity_threshold": risk.low_sensitivity_threshold,
            "sensitivity_trigger_level": risk.sensitivity_trigger_level,
        }

    # 2. Blacklists
    blacklists = db.query(Blacklist).filter(Blacklist.workspace_id == ws_uuid).all()
    if blacklists:
        config["blacklists"] = [{
            "name": bl.name, "keywords": bl.keywords,
            "description": bl.description, "is_active": bl.is_active,
        } for bl in blacklists]

    # 4. Whitelists
    whitelists = db.query(Whitelist).filter(Whitelist.workspace_id == ws_uuid).all()
    if whitelists:
        config["whitelists"] = [{
            "name": wl.name, "keywords": wl.keywords,
            "description": wl.description, "is_active": wl.is_active,
        } for wl in whitelists]

    # 5. DataLeakagePolicy
    dlp = db.query(ApplicationDataLeakagePolicy).filter(
        ApplicationDataLeakagePolicy.workspace_id == ws_uuid,
        ApplicationDataLeakagePolicy.application_id.is_(None),
    ).first()
    if dlp:
        config["data_leakage_policy"] = {
            col: getattr(dlp, col) for col in [
                'input_high_risk_action', 'input_medium_risk_action', 'input_low_risk_action',
                'output_high_risk_anonymize', 'output_medium_risk_anonymize', 'output_low_risk_anonymize',
                'output_high_risk_action', 'output_medium_risk_action', 'output_low_risk_action',
                'general_high_risk_action', 'general_medium_risk_action', 'general_low_risk_action',
                'general_input_high_risk_action', 'general_input_medium_risk_action', 'general_input_low_risk_action',
                'general_output_high_risk_action', 'general_output_medium_risk_action', 'general_output_low_risk_action',
                'enable_format_detection', 'enable_smart_segmentation',
            ]
        }
        # private_model_id stored as string (not portable across deployments)
        if dlp.private_model_id:
            config["data_leakage_policy"]["private_model_id"] = str(dlp.private_model_id)

    # 6. ScannerConfigs (use scanner tag for portability)
    scanner_configs = db.query(ApplicationScannerConfig).filter(
        ApplicationScannerConfig.workspace_id == ws_uuid,
        ApplicationScannerConfig.application_id.is_(None),
    ).all()
    if scanner_configs:
        sc_list = []
        for sc in scanner_configs:
            scanner = db.query(Scanner).filter(Scanner.id == sc.scanner_id).first()
            if scanner:
                sc_list.append({
                    "scanner_tag": scanner.tag,
                    "is_enabled": sc.is_enabled,
                    "risk_level_override": sc.risk_level_override,
                    "scan_prompt_override": sc.scan_prompt_override,
                    "scan_response_override": sc.scan_response_override,
                })
        if sc_list:
            config["scanner_configs"] = sc_list

    # 7. ApplicationSettings (templates)
    settings = db.query(ApplicationSettings).filter(
        ApplicationSettings.workspace_id == ws_uuid,
        ApplicationSettings.application_id.is_(None),
    ).first()
    if settings:
        config["application_settings"] = {
            "security_risk_template": settings.security_risk_template,
            "data_leakage_template": settings.data_leakage_template,
        }

    # 8. DataSecurityEntityType
    entities = db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.workspace_id == ws_uuid,
    ).all()
    if entities:
        config["data_security_entity_types"] = [{
            "entity_type": et.entity_type,
            "entity_type_name": et.entity_type_name,
            "category": et.category,
            "recognition_method": et.recognition_method,
            "recognition_config": et.recognition_config,
            "anonymization_method": et.anonymization_method,
            "anonymization_config": et.anonymization_config,
            "is_active": et.is_active,
            "is_global": et.is_global,
            "source_type": et.source_type,
            "template_id": str(et.template_id) if et.template_id else None,
            "restore_code": et.restore_code,
            "restore_code_hash": et.restore_code_hash,
            "restore_natural_desc": et.restore_natural_desc,
        } for et in entities]

    # 9. CustomScanner (use scanner tag for portability)
    custom_scanners = db.query(CustomScanner).filter(
        CustomScanner.workspace_id == ws_uuid,
    ).all()
    if custom_scanners:
        cs_list = []
        for cs in custom_scanners:
            scanner = db.query(Scanner).filter(Scanner.id == cs.scanner_id, Scanner.is_active == True).first()
            if scanner:
                cs_list.append({
                    "scanner_tag": scanner.tag,
                    "scanner_name": scanner.name,
                    "scanner_description": scanner.description,
                    "scanner_type": scanner.scanner_type,
                    "scanner_definition": scanner.definition,
                    "default_risk_level": scanner.default_risk_level,
                    "default_scan_prompt": scanner.default_scan_prompt,
                    "default_scan_response": scanner.default_scan_response,
                    "notes": cs.notes,
                })
        if cs_list:
            config["custom_scanners"] = cs_list

    # 10. AppealConfig
    appeal = db.query(AppealConfig).filter(
        AppealConfig.workspace_id == ws_uuid,
        AppealConfig.application_id.is_(None),
    ).first()
    if appeal:
        config["appeal_config"] = {
            "enabled": appeal.enabled,
            "message_template": appeal.message_template,
            "appeal_base_url": appeal.appeal_base_url,
            "final_reviewer_email": appeal.final_reviewer_email,
        }

    return {
        "version": "1.0",
        "exported_at": datetime.utcnow().isoformat(),
        "workspace_name": workspace_name,
        "config": config,
    }


def import_workspace_config(db: Session, workspace_id: str, tenant_id: str, config_data: Dict[str, Any]):
    """Import workspace configuration from a config dict (from export JSON).
    Overwrites existing config for the target workspace."""
    ws_uuid = uuid.UUID(workspace_id)
    tenant_uuid = uuid.UUID(tenant_id)

    # If config_data has a "config" wrapper (full export format), unwrap it
    if "config" in config_data and isinstance(config_data["config"], dict):
        config_data = config_data["config"]

    # 1. RiskTypeConfig - delete existing then create
    db.query(RiskTypeConfig).filter(RiskTypeConfig.workspace_id == ws_uuid).delete()
    if "risk_types" in config_data:
        rt = config_data["risk_types"]
        new_risk = RiskTypeConfig(
            tenant_id=tenant_uuid,
            workspace_id=ws_uuid,
            **{k: v for k, v in rt.items() if hasattr(RiskTypeConfig, k)}
        )
        db.add(new_risk)

    # 2. Blacklists
    db.query(Blacklist).filter(Blacklist.workspace_id == ws_uuid).delete()
    for bl in config_data.get("blacklists", []):
        db.add(Blacklist(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            name=bl["name"], keywords=bl["keywords"],
            description=bl.get("description"), is_active=bl.get("is_active", True),
        ))

    # 4. Whitelists
    db.query(Whitelist).filter(Whitelist.workspace_id == ws_uuid).delete()
    for wl in config_data.get("whitelists", []):
        db.add(Whitelist(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            name=wl["name"], keywords=wl["keywords"],
            description=wl.get("description"), is_active=wl.get("is_active", True),
        ))

    # 5. DataLeakagePolicy
    db.query(ApplicationDataLeakagePolicy).filter(
        ApplicationDataLeakagePolicy.workspace_id == ws_uuid,
        ApplicationDataLeakagePolicy.application_id.is_(None),
    ).delete()
    if "data_leakage_policy" in config_data:
        dlp = config_data["data_leakage_policy"]
        private_model_id = None
        if dlp.get("private_model_id"):
            try:
                private_model_id = uuid.UUID(dlp["private_model_id"])
                # Verify it exists for this tenant
                exists = db.query(UpstreamApiConfig).filter(
                    UpstreamApiConfig.id == private_model_id,
                    UpstreamApiConfig.tenant_id == tenant_uuid,
                ).first()
                if not exists:
                    private_model_id = None
            except (ValueError, TypeError):
                private_model_id = None
        policy_fields = {k: v for k, v in dlp.items()
                         if k != "private_model_id" and hasattr(ApplicationDataLeakagePolicy, k)}
        db.add(ApplicationDataLeakagePolicy(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            private_model_id=private_model_id,
            **policy_fields,
        ))

    # 6. ScannerConfigs (resolve by scanner tag)
    db.query(ApplicationScannerConfig).filter(
        ApplicationScannerConfig.workspace_id == ws_uuid,
        ApplicationScannerConfig.application_id.is_(None),
    ).delete()
    for sc in config_data.get("scanner_configs", []):
        scanner = db.query(Scanner).filter(Scanner.tag == sc["scanner_tag"]).first()
        if not scanner:
            logger.warning(f"Import: scanner tag '{sc['scanner_tag']}' not found, skipping")
            continue
        db.add(ApplicationScannerConfig(
            workspace_id=ws_uuid,
            scanner_id=scanner.id,
            is_enabled=sc.get("is_enabled", True),
            risk_level_override=sc.get("risk_level_override"),
            scan_prompt_override=sc.get("scan_prompt_override"),
            scan_response_override=sc.get("scan_response_override"),
        ))

    # 7. ApplicationSettings
    db.query(ApplicationSettings).filter(
        ApplicationSettings.workspace_id == ws_uuid,
        ApplicationSettings.application_id.is_(None),
    ).delete()
    if "application_settings" in config_data:
        s = config_data["application_settings"]
        db.add(ApplicationSettings(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            security_risk_template=s.get("security_risk_template"),
            data_leakage_template=s.get("data_leakage_template"),
        ))

    # 8. DataSecurityEntityType
    db.query(DataSecurityEntityType).filter(
        DataSecurityEntityType.workspace_id == ws_uuid,
    ).delete()
    for et in config_data.get("data_security_entity_types", []):
        db.add(DataSecurityEntityType(
            tenant_id=tenant_uuid, workspace_id=ws_uuid,
            entity_type=et["entity_type"],
            entity_type_name=et.get("entity_type_name"),
            category=et.get("category"),
            recognition_method=et.get("recognition_method"),
            recognition_config=et.get("recognition_config", {}),
            anonymization_method=et.get("anonymization_method"),
            anonymization_config=et.get("anonymization_config", {}),
            is_active=et.get("is_active", True),
            is_global=et.get("is_global", False),
            source_type=et.get("source_type"),
            template_id=et.get("template_id"),
            restore_code=et.get("restore_code"),
            restore_code_hash=et.get("restore_code_hash"),
            restore_natural_desc=et.get("restore_natural_desc"),
        ))

    # 9. CustomScanner - create scanner record + custom scanner link
    db.query(CustomScanner).filter(CustomScanner.workspace_id == ws_uuid).delete()
    for cs in config_data.get("custom_scanners", []):
        # Check if scanner with this tag already exists
        scanner = db.query(Scanner).filter(Scanner.tag == cs["scanner_tag"]).first()
        if not scanner:
            # Create new scanner record for custom scanner
            scanner = Scanner(
                tag=cs["scanner_tag"],
                name=cs.get("scanner_name", cs["scanner_tag"]),
                description=cs.get("scanner_description"),
                scanner_type=cs.get("scanner_type", "genai"),
                definition=cs.get("scanner_definition", ""),
                default_risk_level=cs.get("default_risk_level", "medium_risk"),
                default_scan_prompt=cs.get("default_scan_prompt", True),
                default_scan_response=cs.get("default_scan_response", True),
            )
            db.add(scanner)
            db.flush()
        db.add(CustomScanner(
            workspace_id=ws_uuid,
            scanner_id=scanner.id,
            created_by=tenant_uuid,
            notes=cs.get("notes"),
        ))

    # 10. AppealConfig
    db.query(AppealConfig).filter(
        AppealConfig.workspace_id == ws_uuid,
        AppealConfig.application_id.is_(None),
    ).delete()
    if "appeal_config" in config_data:
        ac = config_data["appeal_config"]
        db.add(AppealConfig(
            tenant_id=tenant_uuid,
            workspace_id=ws_uuid,
            enabled=ac.get("enabled", False),
            message_template=ac.get("message_template", DEFAULT_APPEAL_CONFIG["message_template"]),
            appeal_base_url=ac.get("appeal_base_url", ""),
            final_reviewer_email=ac.get("final_reviewer_email"),
        ))

    logger.info(f"Imported config to workspace {workspace_id}")


class WorkspaceConfigImport(BaseModel):
    config: Dict[str, Any]


@router.get("/{workspace_id}/export")
async def export_workspace(
    workspace_id: str,
    request: Request,
    db: Session = Depends(get_admin_db),
):
    """Export workspace configuration as JSON file"""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    data = export_workspace_config(db, workspace_id, workspace.name)

    response = JSONResponse(content=data)
    safe_name = workspace.name.replace(' ', '_').replace('/', '_')
    filename = f"workspace_config_{safe_name}.json"
    from urllib.parse import quote
    encoded_filename = quote(filename)
    response.headers["Content-Disposition"] = f"attachment; filename=\"workspace_config.json\"; filename*=UTF-8''{encoded_filename}"
    return response


@router.post("/{workspace_id}/import")
async def import_workspace(
    workspace_id: str,
    request: Request,
    body: WorkspaceConfigImport,
    db: Session = Depends(get_admin_db),
):
    """Import workspace configuration from JSON. Overwrites existing config."""
    tenant_id = get_current_tenant_id(request)
    workspace = _verify_workspace_ownership(db, workspace_id, tenant_id)

    try:
        import_workspace_config(db, workspace_id, tenant_id, body.config)
        db.commit()
        await keyword_cache.invalidate_cache()
    except Exception as e:
        db.rollback()
        logger.error(f"Failed to import workspace config: {e}", exc_info=True)
        raise HTTPException(status_code=400, detail=f"Import failed: {str(e)}")

    await log_operation(
        db=db, request=request, action="update",
        resource_type="workspace", resource_id=workspace_id, resource_name=workspace.name,
        changes={"action": "config_import"},
    )

    return {"success": True, "message": "Workspace configuration imported successfully"}
