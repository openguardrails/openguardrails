"""
Image processing utility class
Only supports base64 encoding format, ensuring security
"""
import base64
import uuid
import re
from pathlib import Path
from typing import Tuple, Optional
from config import settings
from utils.logger import setup_logger

logger = setup_logger()

class ImageUtils:
    """Image processing utility class - only supports base64 encoding"""

    @staticmethod
    def is_base64_image(url: str) -> bool:
        """
        Check if it is a base64 encoded image
        Format: data:image/jpeg;base64,{base64_string}
        """
        return url.startswith("data:image/") and ";base64," in url

    @staticmethod
    def extract_base64_data(url: str) -> Tuple[Optional[str], Optional[bytes]]:
        """
        Extract image format and base64 data from data URL

        Returns:
            (image_format, binary_data) - e.g. ('jpeg', b'...')
        """
        try:
            # Format: data:image/jpeg;base64,/9j/4AAQSkZJRg...
            match = re.match(r'data:image/([^;]+);base64,(.+)', url)
            if not match:
                logger.error(f"Invalid base64 image format: {url[:50]}...")
                return None, None

            image_format = match.group(1)  # jpeg, png, etc.
            base64_data = match.group(2)

            # Decode base64
            image_bytes = base64.b64decode(base64_data)

            return image_format, image_bytes

        except Exception as e:
            logger.error(f"Failed to extract base64 data: {e}")
            return None, None

    @staticmethod
    def save_base64_image(url: str, tenant_id: str) -> Optional[str]:
        """
        Save base64 encoded image to user directory

        Args:
            url: base64 data URL
            tenant_id: User UUID

        Returns:
            Saved file absolute path, return None if failed
        """
        try:
            # Extract image data
            image_format, image_bytes = ImageUtils.extract_base64_data(url)
            if not image_bytes:
                return None

            # Create user media directory
            user_media_dir = Path(settings.media_dir) / tenant_id
            user_media_dir.mkdir(parents=True, exist_ok=True)

            # Generate unique filename
            file_extension = f".{image_format}" if image_format else ".jpg"
            unique_filename = f"{uuid.uuid4().hex}{file_extension}"
            file_path = user_media_dir / unique_filename

            # Save image
            with open(file_path, "wb") as f:
                f.write(image_bytes)

            logger.info(f"Saved base64 image to: {file_path}, size: {len(image_bytes)} bytes")
            return str(file_path)

        except Exception as e:
            logger.error(f"Failed to save base64 image: {e}")
            return None

    @staticmethod
    def process_image_url(url: str, tenant_id: Optional[str] = None) -> Tuple[str, Optional[str]]:
        """
        Process image URL - only supports base64 encoding format

        Args:
            url: Image URL (must be base64 format)
            tenant_id: User UUID (required when saving base64 image)

        Returns:
            (processed_url, saved_file_path)
            - processed_url: Original base64 URL
            - saved_file_path: Saved file path

        Raises:
            ValueError: If not base64 format
        """
        # Only supports Base64 image
        if ImageUtils.is_base64_image(url):
            saved_path = None
            if tenant_id:
                saved_path = ImageUtils.save_base64_image(url, tenant_id)
            return url, saved_path  # Return original base64 URL to model
        else:
            raise ValueError(f"Only supports base64 encoded image, format should be: data:image/[jpeg|png|...];base64,{{base64_string}}")

    @staticmethod
    def encode_file_to_base64(file_bytes: bytes, image_format: str = 'jpeg') -> str:
        """
        Encode file bytes to base64 data URL

        Args:
            file_bytes: File bytes data
            image_format: Image format (jpeg, png, gif, etc.)

        Returns:
            data:image/jpeg;base64,{base64_string} format URL
        """
        try:
            # Encode to base64
            base64_string = base64.b64encode(file_bytes).decode('utf-8')
            return f"data:image/{image_format};base64,{base64_string}"
        except Exception as e:
            logger.error(f"Failed to encode bytes to base64: {e}")
            raise

    @staticmethod
    def validate_image_size(base64_url: str, max_size_mb: int = 10) -> bool:
        """
        Validate base64 image size

        Args:
            base64_url: base64 image URL
            max_size_mb: Maximum allowed size (MB)

        Returns:
            Whether it meets the size limit
        """
        try:
            _, image_bytes = ImageUtils.extract_base64_data(base64_url)
            if image_bytes:
                size_mb = len(image_bytes) / (1024 * 1024)
                return size_mb <= max_size_mb
            return False
        except Exception as e:
            logger.error(f"Failed to validate image size: {e}")
            return False

# Create global instance
image_utils = ImageUtils()