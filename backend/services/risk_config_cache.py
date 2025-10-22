import asyncio
from typing import Dict, Optional
from utils.logger import setup_logger
import time

logger = setup_logger()

class RiskConfigCache:
    """Risk config cache - memory cache for user risk type configuration"""
    
    def __init__(self):
        self._cache: Dict[str, Dict[str, bool]] = {}
        self._sensitivity_cache: Dict[str, Dict[str, float]] = {}
        self._trigger_level_cache: Dict[str, str] = {}
        self._cache_timestamps: Dict[str, float] = {}
        self._sensitivity_timestamps: Dict[str, float] = {}
        self._trigger_level_timestamps: Dict[str, float] = {}
        self._cache_ttl = 300  # 5 minutes cache
        self._lock = asyncio.Lock()
    
    async def get_user_risk_config(self, tenant_id: str) -> Dict[str, bool]:
        """Get user risk config (with cache)"""
        if not tenant_id:
            # Return default all enabled when no user ID
            return self._get_default_config()
        
        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (tenant_id in self._cache and 
                tenant_id in self._cache_timestamps and
                current_time - self._cache_timestamps[tenant_id] < self._cache_ttl):
                return self._cache[tenant_id]
            
            # Cache invalid or not exist, load from database
            try:
                config = await self._load_from_db(tenant_id)
                self._cache[tenant_id] = config
                self._cache_timestamps[tenant_id] = current_time
                return config
            except Exception as e:
                logger.error(f"Failed to load risk config for user {tenant_id}: {e}")
                # Return default configuration when database fails
                default_config = self._get_default_config()
                self._cache[tenant_id] = default_config
                self._cache_timestamps[tenant_id] = current_time
                return default_config
    
    async def _load_from_db(self, tenant_id: str) -> Dict[str, bool]:
        """Load risk config from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session
        
        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            config = db.query(RiskTypeConfig).filter(
                RiskTypeConfig.tenant_id == tenant_id
            ).first()
            
            if config:
                return {
                    'S1': config.s1_enabled, 'S2': config.s2_enabled, 'S3': config.s3_enabled, 'S4': config.s4_enabled,
                    'S5': config.s5_enabled, 'S6': config.s6_enabled, 'S7': config.s7_enabled, 'S8': config.s8_enabled,
                    'S9': config.s9_enabled, 'S10': config.s10_enabled, 'S11': config.s11_enabled, 'S12': config.s12_enabled
                }
            else:
                # Return default enabled when user has no configuration
                return self._get_default_config()
        finally:
            db.close()
    
    def _get_default_config(self) -> Dict[str, bool]:
        """Get default configuration (all enabled)"""
        return {
            'S1': True, 'S2': True, 'S3': True, 'S4': True,
            'S5': True, 'S6': True, 'S7': True, 'S8': True,
            'S9': True, 'S10': True, 'S11': True, 'S12': True
        }
    
    async def is_risk_type_enabled(self, tenant_id: str, risk_type: str) -> bool:
        """Check if specified risk type is enabled"""
        config = await self.get_user_risk_config(tenant_id)
        return config.get(risk_type, True)  # Default enabled
    
    async def invalidate_user_cache(self, tenant_id: str):
        """Invalidate cache for specified user"""
        async with self._lock:
            if tenant_id in self._cache:
                del self._cache[tenant_id]
            if tenant_id in self._cache_timestamps:
                del self._cache_timestamps[tenant_id]
            logger.info(f"Invalidated risk config cache for user {tenant_id}")
    
    async def clear_cache(self):
        """Clear all cache"""
        async with self._lock:
            self._cache.clear()
            self._cache_timestamps.clear()
            self._sensitivity_cache.clear()
            self._sensitivity_timestamps.clear()
            self._trigger_level_cache.clear()
            self._trigger_level_timestamps.clear()
            logger.info("Cleared all risk config cache")

    async def get_sensitivity_thresholds(self, tenant_id: str) -> Dict[str, float]:
        """Get user sensitivity threshold configuration (with cache) - new global thresholds"""
        if not tenant_id:
            return self._get_default_sensitivity_thresholds()

        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (tenant_id in self._sensitivity_cache and
                tenant_id in self._sensitivity_timestamps and
                current_time - self._sensitivity_timestamps[tenant_id] < self._cache_ttl):
                return self._sensitivity_cache[tenant_id]

            # Cache invalid or not exist, load from database
            try:
                config = await self._load_sensitivity_thresholds_from_db(tenant_id)
                self._sensitivity_cache[tenant_id] = config
                self._sensitivity_timestamps[tenant_id] = current_time
                return config
            except Exception as e:
                logger.error(f"Failed to load sensitivity thresholds for user {tenant_id}: {e}")
                # Return default configuration when database fails
                default_config = self._get_default_sensitivity_thresholds()
                self._sensitivity_cache[tenant_id] = default_config
                self._sensitivity_timestamps[tenant_id] = current_time
                return default_config

    async def _load_sensitivity_thresholds_from_db(self, tenant_id: str) -> Dict[str, float]:
        """Load sensitivity threshold configuration from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session

        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            config = db.query(RiskTypeConfig).filter(
                RiskTypeConfig.tenant_id == tenant_id
            ).first()

            if config:
                return {
                    'low': config.low_sensitivity_threshold or 0.95,
                    'medium': config.medium_sensitivity_threshold or 0.60,
                    'high': config.high_sensitivity_threshold or 0.40,
                }
            else:
                # Return default thresholds when user has no configuration
                return self._get_default_sensitivity_thresholds()
        finally:
            db.close()

    def _get_default_sensitivity_thresholds(self) -> Dict[str, float]:
        """Get default sensitivity threshold configuration"""
        return {
            'low': 0.95,
            'medium': 0.60,
            'high': 0.40
        }

    async def invalidate_sensitivity_cache(self, tenant_id: str):
        """Invalidate sensitivity cache for specified user"""
        async with self._lock:
            if tenant_id in self._sensitivity_cache:
                del self._sensitivity_cache[tenant_id]
            if tenant_id in self._sensitivity_timestamps:
                del self._sensitivity_timestamps[tenant_id]
            if tenant_id in self._trigger_level_cache:
                del self._trigger_level_cache[tenant_id]
            if tenant_id in self._trigger_level_timestamps:
                del self._trigger_level_timestamps[tenant_id]
            logger.info(f"Invalidated sensitivity config cache for user {tenant_id}")

    async def get_sensitivity_trigger_level(self, tenant_id: str) -> str:
        """Get user sensitivity trigger level configuration (with cache)"""
        if not tenant_id:
            return "low"

        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (tenant_id in self._trigger_level_cache and
                tenant_id in self._trigger_level_timestamps and
                current_time - self._trigger_level_timestamps[tenant_id] < self._cache_ttl):
                return self._trigger_level_cache[tenant_id]

            # Cache invalid or not exist, load from database
            try:
                trigger_level = await self._load_trigger_level_from_db(tenant_id)
                self._trigger_level_cache[tenant_id] = trigger_level
                self._trigger_level_timestamps[tenant_id] = current_time
                return trigger_level
            except Exception as e:
                logger.error(f"Failed to load trigger level for user {tenant_id}: {e}")
                # Return default configuration when database fails
                default_level = "low"
                self._trigger_level_cache[tenant_id] = default_level
                self._trigger_level_timestamps[tenant_id] = current_time
                return default_level

    async def _load_trigger_level_from_db(self, tenant_id: str) -> str:
        """Load sensitivity trigger level configuration from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session

        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            config = db.query(RiskTypeConfig).filter(
                RiskTypeConfig.tenant_id == tenant_id
            ).first()

            if config:
                return config.sensitivity_trigger_level or "medium"
            else:
                # Return default trigger level when user has no configuration
                return "medium"
        finally:
            db.close()

# Global instance
risk_config_cache = RiskConfigCache()