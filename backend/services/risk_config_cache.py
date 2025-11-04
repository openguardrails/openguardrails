import asyncio
from typing import Dict, Optional
from utils.logger import setup_logger
import time

logger = setup_logger()

class RiskConfigCache:
    """Risk config cache - memory cache for application risk type configuration"""

    def __init__(self):
        self._cache: Dict[str, Dict[str, bool]] = {}
        self._sensitivity_cache: Dict[str, Dict[str, float]] = {}
        self._trigger_level_cache: Dict[str, str] = {}
        self._cache_timestamps: Dict[str, float] = {}
        self._sensitivity_timestamps: Dict[str, float] = {}
        self._trigger_level_timestamps: Dict[str, float] = {}
        self._cache_ttl = 300  # 5 minutes cache
        self._lock = asyncio.Lock()

    async def get_user_risk_config(self, tenant_id: str = None, application_id: str = None) -> Dict[str, bool]:
        """
        Get risk config (with cache)

        Args:
            tenant_id: DEPRECATED - kept for backward compatibility
            application_id: Application ID to get config for

        Returns:
            Risk type configuration dict
        """
        # Prefer application_id, fallback to tenant_id
        cache_key = application_id if application_id else tenant_id

        if not cache_key:
            # Return default all enabled when no ID
            return self._get_default_config()

        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (cache_key in self._cache and
                cache_key in self._cache_timestamps and
                current_time - self._cache_timestamps[cache_key] < self._cache_ttl):
                return self._cache[cache_key]

            # Cache invalid or not exist, load from database
            try:
                config = await self._load_from_db(cache_key, use_application_id=bool(application_id))
                self._cache[cache_key] = config
                self._cache_timestamps[cache_key] = current_time
                return config
            except Exception as e:
                logger.error(f"Failed to load risk config for {cache_key}: {e}")
                # Return default configuration when database fails
                default_config = self._get_default_config()
                self._cache[cache_key] = default_config
                self._cache_timestamps[cache_key] = current_time
                return default_config

    async def _load_from_db(self, cache_key: str, use_application_id: bool = True) -> Dict[str, bool]:
        """Load risk config from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session

        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            if use_application_id:
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.application_id == cache_key
                ).first()
            else:
                # Backward compatibility: lookup by tenant_id (will use first application)
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.tenant_id == cache_key
                ).first()

            if config:
                return {
                    'S1': config.s1_enabled, 'S2': config.s2_enabled, 'S3': config.s3_enabled, 'S4': config.s4_enabled,
                    'S5': config.s5_enabled, 'S6': config.s6_enabled, 'S7': config.s7_enabled, 'S8': config.s8_enabled,
                    'S9': config.s9_enabled, 'S10': config.s10_enabled, 'S11': config.s11_enabled, 'S12': config.s12_enabled,
                    'S13': config.s13_enabled, 'S14': config.s14_enabled, 'S15': config.s15_enabled, 'S16': config.s16_enabled,
                    'S17': config.s17_enabled, 'S18': config.s18_enabled, 'S19': config.s19_enabled, 'S20': config.s20_enabled,
                    'S21': config.s21_enabled
                }
            else:
                # Return default enabled when no configuration found
                return self._get_default_config()
        finally:
            db.close()
    
    def _get_default_config(self) -> Dict[str, bool]:
        """Get default configuration (all enabled)"""
        return {
            'S1': True, 'S2': True, 'S3': True, 'S4': True,
            'S5': True, 'S6': True, 'S7': True, 'S8': True,
            'S9': True, 'S10': True, 'S11': True, 'S12': True,
            'S13': True, 'S14': True, 'S15': True, 'S16': True,
            'S17': True, 'S18': True, 'S19': True, 'S20': True,
            'S21': True
        }

    async def is_risk_type_enabled(self, tenant_id: str = None, application_id: str = None, risk_type: str = None) -> bool:
        """Check if specified risk type is enabled"""
        config = await self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        return config.get(risk_type, True)  # Default enabled

    async def invalidate_user_cache(self, tenant_id: str = None, application_id: str = None):
        """Invalidate cache for specified user/application"""
        cache_key = application_id if application_id else tenant_id
        if not cache_key:
            return

        async with self._lock:
            if cache_key in self._cache:
                del self._cache[cache_key]
            if cache_key in self._cache_timestamps:
                del self._cache_timestamps[cache_key]
            logger.info(f"Invalidated risk config cache for {cache_key}")
    
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

    async def get_sensitivity_thresholds(self, tenant_id: str = None, application_id: str = None) -> Dict[str, float]:
        """Get sensitivity threshold configuration (with cache)"""
        cache_key = application_id if application_id else tenant_id
        if not cache_key:
            return self._get_default_sensitivity_thresholds()

        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (cache_key in self._sensitivity_cache and
                cache_key in self._sensitivity_timestamps and
                current_time - self._sensitivity_timestamps[cache_key] < self._cache_ttl):
                return self._sensitivity_cache[cache_key]

            # Cache invalid or not exist, load from database
            try:
                config = await self._load_sensitivity_thresholds_from_db(cache_key, use_application_id=bool(application_id))
                self._sensitivity_cache[cache_key] = config
                self._sensitivity_timestamps[cache_key] = current_time
                return config
            except Exception as e:
                logger.error(f"Failed to load sensitivity thresholds for {cache_key}: {e}")
                # Return default configuration when database fails
                default_config = self._get_default_sensitivity_thresholds()
                self._sensitivity_cache[cache_key] = default_config
                self._sensitivity_timestamps[cache_key] = current_time
                return default_config

    async def _load_sensitivity_thresholds_from_db(self, cache_key: str, use_application_id: bool = True) -> Dict[str, float]:
        """Load sensitivity threshold configuration from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session

        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            if use_application_id:
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.application_id == cache_key
                ).first()
            else:
                # Backward compatibility: lookup by tenant_id
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.tenant_id == cache_key
                ).first()

            if config:
                return {
                    'low': config.low_sensitivity_threshold or 0.95,
                    'medium': config.medium_sensitivity_threshold or 0.60,
                    'high': config.high_sensitivity_threshold or 0.40,
                }
            else:
                # Return default thresholds when no configuration found
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

    async def invalidate_sensitivity_cache(self, tenant_id: str = None, application_id: str = None):
        """Invalidate sensitivity cache for specified user/application"""
        cache_key = application_id if application_id else tenant_id
        if not cache_key:
            return

        async with self._lock:
            if cache_key in self._sensitivity_cache:
                del self._sensitivity_cache[cache_key]
            if cache_key in self._sensitivity_timestamps:
                del self._sensitivity_timestamps[cache_key]
            if cache_key in self._trigger_level_cache:
                del self._trigger_level_cache[cache_key]
            if cache_key in self._trigger_level_timestamps:
                del self._trigger_level_timestamps[cache_key]
            logger.info(f"Invalidated sensitivity config cache for {cache_key}")

    async def get_sensitivity_trigger_level(self, tenant_id: str = None, application_id: str = None) -> str:
        """Get sensitivity trigger level configuration (with cache)"""
        cache_key = application_id if application_id else tenant_id
        if not cache_key:
            return "medium"

        async with self._lock:
            # Check if cache is valid
            current_time = time.time()
            if (cache_key in self._trigger_level_cache and
                cache_key in self._trigger_level_timestamps and
                current_time - self._trigger_level_timestamps[cache_key] < self._cache_ttl):
                return self._trigger_level_cache[cache_key]

            # Cache invalid or not exist, load from database
            try:
                trigger_level = await self._load_trigger_level_from_db(cache_key, use_application_id=bool(application_id))
                self._trigger_level_cache[cache_key] = trigger_level
                self._trigger_level_timestamps[cache_key] = current_time
                return trigger_level
            except Exception as e:
                logger.error(f"Failed to load trigger level for {cache_key}: {e}")
                # Return default configuration when database fails
                default_level = "medium"
                self._trigger_level_cache[cache_key] = default_level
                self._trigger_level_timestamps[cache_key] = current_time
                return default_level

    async def _load_trigger_level_from_db(self, cache_key: str, use_application_id: bool = True) -> str:
        """Load sensitivity trigger level configuration from database"""
        from database.connection import get_db
        from database.models import RiskTypeConfig
        from sqlalchemy.orm import Session

        # Use synchronous database connection
        db: Session = next(get_db())
        try:
            if use_application_id:
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.application_id == cache_key
                ).first()
            else:
                # Backward compatibility: lookup by tenant_id
                config = db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.tenant_id == cache_key
                ).first()

            if config:
                return config.sensitivity_trigger_level or "medium"
            else:
                # Return default trigger level when no configuration found
                return "medium"
        finally:
            db.close()

# Global instance
risk_config_cache = RiskConfigCache()