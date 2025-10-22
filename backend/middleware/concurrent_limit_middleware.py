"""
Concurrent limit middleware
Based on asyncio.Semaphore to implement service-level concurrent control, prevent resource exhaustion
"""
import asyncio
import time
from typing import Dict, Optional
from fastapi import Request, Response
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse
from utils.logger import setup_logger

logger = setup_logger()

class ConcurrentLimitMiddleware(BaseHTTPMiddleware):
    """Concurrent limit middleware"""
    
    # Global signal dictionary, stored by service type
    _semaphores: Dict[str, asyncio.Semaphore] = {}
    _stats: Dict[str, Dict[str, int]] = {}
    
    def __init__(self, app, service_type: str, max_concurrent: int):
        """
        Initialize concurrent limit middleware
        
        Args:
            app: FastAPI application
            service_type: Service type (admin/detection/proxy)
            max_concurrent: Maximum concurrent requests
        """
        super().__init__(app)
        self.service_type = service_type
        self.max_concurrent = max_concurrent
        
        # Create service-level semaphore
        if service_type not in self._semaphores:
            self._semaphores[service_type] = asyncio.Semaphore(max_concurrent)
            self._stats[service_type] = {
                'current_requests': 0,
                'total_requests': 0,
                'rejected_requests': 0,
                'max_concurrent_reached': 0
            }
            logger.info(f"Concurrent limit middleware initialized for {service_type}: max_concurrent={max_concurrent}")
    
    async def dispatch(self, request: Request, call_next):
        """Handle concurrent control for requests"""
        semaphore = self._semaphores[self.service_type]
        stats = self._stats[self.service_type]
        
        # Update statistics
        stats['total_requests'] += 1
        
        # Try to acquire semaphore
        acquired = False
        try:
            # Non-blocking way to try to acquire semaphore
            acquired = semaphore.locked() == False and await self._try_acquire(semaphore)
            
            if not acquired:
                # Concurrent limit reached, return 429 error
                stats['rejected_requests'] += 1
                current_concurrent = self.max_concurrent - (semaphore._value if hasattr(semaphore, '_value') else 0)
                
                logger.warning(
                    f"Concurrent limit reached for {self.service_type} service. "
                    f"Current: {current_concurrent}/{self.max_concurrent}, "
                    f"Path: {request.url.path}"
                )
                
                return JSONResponse(
                    status_code=429,
                    content={
                        "error": {
                            "message": f"Service temporarily overloaded. Maximum {self.max_concurrent} concurrent requests allowed.",
                            "type": "service_overloaded",
                            "code": 429,
                            "service": self.service_type,
                            "retry_after": 1
                        }
                    },
                    headers={"Retry-After": "1"}
                )
            
            # Update concurrent statistics
            stats['current_requests'] += 1
            current_concurrent = stats['current_requests']
            if current_concurrent > stats['max_concurrent_reached']:
                stats['max_concurrent_reached'] = current_concurrent
            
            # Handle request
            start_time = time.time()
            response = await call_next(request)
            end_time = time.time()
            
            # Add performance header information
            response.headers["X-Service-Type"] = self.service_type
            response.headers["X-Concurrent-Limit"] = str(self.max_concurrent)
            response.headers["X-Current-Concurrent"] = str(current_concurrent)
            response.headers["X-Processing-Time"] = f"{(end_time - start_time) * 1000:.2f}ms"
            
            return response
            
        finally:
            if acquired:
                # Release semaphore
                semaphore.release()
                stats['current_requests'] -= 1
    
    async def _try_acquire(self, semaphore: asyncio.Semaphore, timeout: float = 0.001) -> bool:
        """
        Non-blocking way to try to acquire semaphore
        
        Args:
            semaphore: Asynchronous semaphore
            timeout: Timeout (seconds)
            
        Returns:
            bool: Whether to successfully acquire
        """
        try:
            await asyncio.wait_for(semaphore.acquire(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False
    
    @classmethod
    def get_stats(cls, service_type: str) -> Optional[Dict[str, int]]:
        """Get service concurrent statistics information"""
        return cls._stats.get(service_type)
    
    @classmethod
    def get_all_stats(cls) -> Dict[str, Dict[str, int]]:
        """Get all service concurrent statistics information"""
        return cls._stats.copy()
    
    @classmethod
    def reset_stats(cls, service_type: str = None):
        """Reset statistics information"""
        if service_type:
            if service_type in cls._stats:
                stats = cls._stats[service_type]
                stats.update({
                    'total_requests': 0,
                    'rejected_requests': 0,
                    'max_concurrent_reached': 0
                })
                logger.info(f"Reset concurrent stats for {service_type}")
        else:
            for service in cls._stats:
                cls.reset_stats(service)
            logger.info("Reset concurrent stats for all services")