from fastapi import APIRouter, Depends, Request, HTTPException
from pydantic import BaseModel
from pydantic import ConfigDict
from typing import List, Optional
import uuid
from sqlalchemy.orm import Session
from database.connection import get_db
from database.models import TestModelConfig, Tenant
from utils.logger import setup_logger

logger = setup_logger()
router = APIRouter(tags=["Test Models"])

class TestModelRequest(BaseModel):
    name: str
    base_url: str
    api_key: str
    model_name: str
    enabled: bool = True
    model_config = ConfigDict(protected_namespaces=())

class TestModelResponse(BaseModel):
    id: int
    name: str
    base_url: str
    model_name: str
    enabled: bool
    
    model_config = ConfigDict(from_attributes=True, protected_namespaces=())

@router.get("/test-models", response_model=List[TestModelResponse])
async def get_test_models(
    request: Request,
    db: Session = Depends(get_db)
):
    """Get the user's test model configuration"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        tenant_id = str(auth_context['data'].get('tenant_id'))
        tenant_uuid = uuid.UUID(tenant_id)
        
        # Query user's model configuration
        models = db.query(TestModelConfig).filter(
            TestModelConfig.tenant_id == tenant_uuid
        ).all()
        
        # Return without API Key (security consideration)
        return [TestModelResponse(
            id=model.id,
            name=model.name,
            base_url=model.base_url,
            model_name=model.model_name,
            enabled=model.enabled
        ) for model in models]
        
    except Exception as e:
        logger.error(f"Get test models error: {e}")
        raise HTTPException(status_code=500, detail="Failed to get model configuration")

@router.post("/test-models", response_model=TestModelResponse)
async def create_test_model(
    model_data: TestModelRequest,
    request: Request,
    db: Session = Depends(get_db)
):
    """Create the user's test model configuration"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        tenant_id = str(auth_context['data'].get('tenant_id'))
        tenant_uuid = uuid.UUID(tenant_id)
        
        # Create new model configuration
        new_model = TestModelConfig(
            tenant_id=tenant_uuid,
            name=model_data.name,
            base_url=model_data.base_url,
            api_key=model_data.api_key,
            model_name=model_data.model_name,
            enabled=model_data.enabled
        )
        
        db.add(new_model)
        db.commit()
        db.refresh(new_model)
        
        return TestModelResponse(
            id=new_model.id,
            name=new_model.name,
            base_url=new_model.base_url,
            model_name=new_model.model_name,
            enabled=new_model.enabled
        )
        
    except Exception as e:
        db.rollback()
        logger.error(f"Create test model error: {e}")
        raise HTTPException(status_code=500, detail="Failed to create model configuration")

@router.put("/test-models/{model_id}", response_model=TestModelResponse)
async def update_test_model(
    model_id: int,
    model_data: TestModelRequest,
    request: Request,
    db: Session = Depends(get_db)
):
    """Update the user's test model configuration"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        tenant_id = str(auth_context['data'].get('tenant_id'))
        tenant_uuid = uuid.UUID(tenant_id)
        
        # Query model configuration
        model = db.query(TestModelConfig).filter(
            TestModelConfig.id == model_id,
            TestModelConfig.tenant_id == tenant_uuid
        ).first()
        
        if not model:
            raise HTTPException(status_code=404, detail="Model configuration does not exist")
        
        # Update configuration
        model.name = model_data.name
        model.base_url = model_data.base_url
        model.api_key = model_data.api_key
        model.model_name = model_data.model_name
        model.enabled = model_data.enabled
        
        db.commit()
        db.refresh(model)
        
        return TestModelResponse(
            id=model.id,
            name=model.name,
            base_url=model.base_url,
            model_name=model.model_name,
            enabled=model.enabled
        )
        
    except Exception as e:
        db.rollback()
        logger.error(f"Update test model error: {e}")
        raise HTTPException(status_code=500, detail="Failed to update model configuration")

@router.delete("/test-models/{model_id}")
async def delete_test_model(
    model_id: int,
    request: Request,
    db: Session = Depends(get_db)
):
    """Delete the user's test model configuration"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        tenant_id = str(auth_context['data'].get('tenant_id'))
        tenant_uuid = uuid.UUID(tenant_id)
        
        # Query and delete model configuration
        model = db.query(TestModelConfig).filter(
            TestModelConfig.id == model_id,
            TestModelConfig.tenant_id == tenant_uuid
        ).first()
        
        if not model:
            raise HTTPException(status_code=404, detail="Model configuration does not exist")
        
        db.delete(model)
        db.commit()
        
        return {"message": "Model configuration has been deleted"}
        
    except Exception as e:
        db.rollback()
        logger.error(f"Delete test model error: {e}")
        raise HTTPException(status_code=500, detail="Failed to delete model configuration")

@router.patch("/test-models/{model_id}/toggle")
async def toggle_test_model(
    model_id: int,
    request: Request,
    db: Session = Depends(get_db)
):
    """Toggle the user's test model enabled status"""
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        if not auth_context:
            raise HTTPException(status_code=401, detail="User not authenticated")
        
        tenant_id = str(auth_context['data'].get('tenant_id'))
        tenant_uuid = uuid.UUID(tenant_id)
        
        # Query model configuration
        model = db.query(TestModelConfig).filter(
            TestModelConfig.id == model_id,
            TestModelConfig.tenant_id == tenant_uuid
        ).first()
        
        if not model:
            raise HTTPException(status_code=404, detail="Model configuration does not exist")
        
        # Toggle enabled status
        model.enabled = not model.enabled
        db.commit()
        
        return {"message": f"Model has been {'enabled' if model.enabled else 'disabled'}"}
        
    except Exception as e:
        db.rollback()
        logger.error(f"Toggle test model error: {e}")
        raise HTTPException(status_code=500, detail="Failed to toggle model status")