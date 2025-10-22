from fastapi import APIRouter, Depends, Request, HTTPException, UploadFile, File, Query
from fastapi.responses import FileResponse
from typing import Optional
import uuid
import os
from pathlib import Path
from config import settings
from utils.logger import setup_logger
from utils.url_signature import (
    verify_media_url_signature,
    generate_signed_media_url
)

logger = setup_logger()
router = APIRouter(tags=["Media"])

# 导入认证依赖（用于上传、删除、列表等需要认证的接口）
# 注意：这里不能直接从main导入，因为会产生循环依赖
# 我们在每个需要认证的路由上单独添加认证逻辑

# 允许的图片文件类型
ALLOWED_IMAGE_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/gif",
    "image/bmp", "image/webp", "image/tiff"
}

# 最大文件大小：10MB
MAX_FILE_SIZE = 10 * 1024 * 1024

@router.post("/media/upload/image")
async def upload_image(
    request: Request,
    file: UploadFile = File(...)
):
    """
    Upload image file

    The image file uploaded by the user will be stored in the /mnt/data/openguardrails-data/media/{tenant_id}/ directory
    Return the relative path of the image, which can be used for subsequent detection requests
    """
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('user_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")
        # Verify file type
        if file.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported file type: {file.content_type}. Supported types: {', '.join(ALLOWED_IMAGE_TYPES)}"
            )

        # Read file content
        file_content = await file.read()

        # Verify file size
        if len(file_content) > MAX_FILE_SIZE:
            raise HTTPException(
                status_code=400,
                detail=f"File size exceeds limit: {len(file_content)} bytes > {MAX_FILE_SIZE} bytes (10MB)"
            )

        # Verify file is not empty
        if len(file_content) == 0:
            raise HTTPException(status_code=400, detail="File content is empty")

        # Create user media directory
        user_media_dir = Path(settings.media_dir) / tenant_id
        user_media_dir.mkdir(parents=True, exist_ok=True)

        # Generate unique filename
        file_extension = Path(file.filename).suffix if file.filename else ".jpg"
        unique_filename = f"{uuid.uuid4().hex}{file_extension}"
        file_path = user_media_dir / unique_filename

        # Save file
        with open(file_path, "wb") as f:
            f.write(file_content)

        logger.info(f"Image uploaded successfully: {file_path}")

        # Generate signed access URL
        signed_url = generate_signed_media_url(
            tenant_id=tenant_id,
            filename=unique_filename,
            expires_in_seconds=86400  # 24 hours expiration
        )

        # Return file path (relative path and absolute path)
        return {
            "success": True,
            "file_path": str(file_path),
            "relative_path": f"{tenant_id}/{unique_filename}",
            "filename": unique_filename,
            "size": len(file_content),
            "content_type": file.content_type,
            "url": signed_url  # Signed access URL
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image upload error: {e}")
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@router.delete("/media/image/{filename}")
async def delete_image(
    request: Request,
    filename: str
):
    """
    Delete the image uploaded by the user
    """
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('user_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # Build file path
        file_path = Path(settings.media_dir) / tenant_id / filename

        # Security check: ensure file is in user directory
        if not str(file_path).startswith(str(Path(settings.media_dir) / tenant_id)):
            raise HTTPException(status_code=403, detail="No permission to access this file")

        # Delete file
        if file_path.exists():
            file_path.unlink()
            logger.info(f"Image deleted successfully: {file_path}")
            return {"success": True, "message": "Image deleted successfully"}
        else:
            raise HTTPException(status_code=404, detail="Image does not exist")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Image delete error: {e}")
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")

@router.get("/media/images")
async def list_images(request: Request):
    """
    List all images uploaded by the user
    """
    try:
        # Get user context
        auth_context = getattr(request.state, 'auth_context', None)
        tenant_id = None
        if auth_context:
            tenant_id = str(auth_context['data'].get('user_id'))

        if not tenant_id:
            raise HTTPException(status_code=401, detail="User ID not found in auth context")

        # User media directory
        user_media_dir = Path(settings.media_dir) / tenant_id

        # If directory does not exist, return empty list
        if not user_media_dir.exists():
            return {"images": []}

        # List all image files
        images = []
        for file_path in user_media_dir.iterdir():
            if file_path.is_file():
                stat = file_path.stat()
                # Generate signed access URL
                signed_url = generate_signed_media_url(
                    tenant_id=tenant_id,
                    filename=file_path.name,
                    expires_in_seconds=86400  # 24 hours expiration
                )
                images.append({
                    "filename": file_path.name,
                    "file_path": str(file_path),
                    "relative_path": f"{tenant_id}/{file_path.name}",
                    "size": stat.st_size,
                    "created_at": stat.st_ctime,
                    "url": signed_url  # Signed access URL
                })

        return {"images": images}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"List images error: {e}")
        raise HTTPException(status_code=500, detail=f"Get image list failed: {str(e)}")

@router.get("/media/image/{tenant_id}/{filename}")
async def get_image(
    tenant_id: str,
    filename: str,
    token: str = Query(..., description="Signed token"),
    expires: int = Query(..., description="Expiration timestamp")
):
    """
    Get image file (requires signature verification)

    Return the image file based on the user ID and filename, requiring a valid signed token and expiration timestamp
    Image storage path: /mnt/data/openguardrails-data/media/{tenant_id}/{filename}

    Query parameters:
        - token: Signed token
        - expires: Expiration timestamp
    """
    try:
        # Verify signature
        if not verify_media_url_signature(tenant_id, filename, token, expires):
            raise HTTPException(
                status_code=403,
                detail="Signed token is invalid or expired"
            )

        # Build file path
        file_path = Path(settings.media_dir) / tenant_id / filename

        # Security check: ensure file is in media directory
        if not str(file_path).startswith(str(Path(settings.media_dir))):
            raise HTTPException(status_code=403, detail="No permission to access this file")

        # Check if file exists
        if not file_path.exists() or not file_path.is_file():
            raise HTTPException(status_code=404, detail="File does not exist")

        # Dynamically set media type based on file extension
        media_type_map = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".gif": "image/gif",
            ".bmp": "image/bmp",
            ".webp": "image/webp",
            ".tiff": "image/tiff"
        }
        file_extension = Path(filename).suffix.lower()
        media_type = media_type_map.get(file_extension, "image/jpeg")

        # Return image file
        return FileResponse(
            path=str(file_path),
            media_type=media_type,
            filename=filename
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Get image error: {e}")
        raise HTTPException(status_code=500, detail=f"Get image failed: {str(e)}")