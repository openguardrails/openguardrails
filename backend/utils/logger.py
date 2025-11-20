import logging
import os
from datetime import datetime
from pathlib import Path
from config import settings

def setup_logger():
    """Setup logger"""
    # Get or create logger
    logger = logging.getLogger("openguardrails")
    
    # If already configured handlers, return
    if logger.handlers:
        return logger
    
    # Create log directory
    log_dir = Path(settings.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    
    # Configure log format
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s'
    )
    
    # Create file handler
    log_file = log_dir / f"guardrails_{datetime.now().strftime('%Y%m%d')}.log"
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setFormatter(formatter)
    
    # Create console handler
    console_handler = logging.StreamHandler()
    console_handler.setFormatter(formatter)
    
    # Configure logger
    logger.setLevel(getattr(logging, settings.log_level.upper()))
    logger.addHandler(file_handler)
    logger.addHandler(console_handler)

    return logger


def get_logger(name: str = None):
    """
    Get a logger instance with the given name.

    Args:
        name: Logger name (typically __name__ of the calling module)

    Returns:
        Logger instance
    """
    # Ensure base logger is set up
    setup_logger()

    # Return child logger with the given name
    if name:
        return logging.getLogger(f"openguardrails.{name}")
    return logging.getLogger("openguardrails")