from typing import Optional, Dict
from sqlalchemy.orm import Session
from database.models import RiskTypeConfig, Tenant
from utils.logger import setup_logger

logger = setup_logger()

class RiskConfigService:
    """Risk type configuration service"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def get_user_risk_config(self, tenant_id: str = None, application_id: str = None) -> Optional[RiskTypeConfig]:
        """Get user risk config (supports both tenant_id and application_id)"""
        try:
            # Prefer application_id (new multi-app model)
            if application_id:
                config = self.db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.application_id == application_id
                ).first()
            elif tenant_id:
                # Fallback to tenant_id (legacy model, get first application's config)
                config = self.db.query(RiskTypeConfig).filter(
                    RiskTypeConfig.tenant_id == tenant_id
                ).first()
            else:
                raise ValueError("Either tenant_id or application_id must be provided")
            return config
        except Exception as e:
            logger.error(f"Failed to get user risk config for tenant_id={tenant_id}, application_id={application_id}: {e}")
            return None
    
    def create_default_risk_config(self, tenant_id: str = None, application_id: str = None) -> RiskTypeConfig:
        """Create default risk config for user/application (all types default enabled)"""
        try:
            if not application_id and not tenant_id:
                raise ValueError("Either tenant_id or application_id must be provided")

            config_data = {}
            if application_id:
                config_data['application_id'] = application_id
                # Get tenant_id from application
                from database.models import Application
                app = self.db.query(Application).filter(Application.id == application_id).first()
                if app:
                    config_data['tenant_id'] = app.tenant_id
            if tenant_id:
                config_data['tenant_id'] = tenant_id

            config = RiskTypeConfig(**config_data)
            self.db.add(config)
            self.db.commit()
            self.db.refresh(config)
            logger.info(f"Created default risk config for tenant_id={tenant_id}, application_id={application_id}")
            return config
        except Exception as e:
            logger.error(f"Failed to create default risk config for tenant_id={tenant_id}, application_id={application_id}: {e}")
            self.db.rollback()
            raise
    
    def update_risk_config(self, tenant_id: str = None, application_id: str = None, config_data: Dict = None) -> Optional[RiskTypeConfig]:
        """Update user/application risk config"""
        try:
            if not config_data:
                config_data = {}

            config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
            if not config:
                config = self.create_default_risk_config(tenant_id=tenant_id, application_id=application_id)

            # Update config fields
            for field, value in config_data.items():
                if hasattr(config, field):
                    setattr(config, field, value)

            self.db.commit()
            self.db.refresh(config)
            logger.info(f"Updated risk config for tenant_id={tenant_id}, application_id={application_id}")
            return config
        except Exception as e:
            logger.error(f"Failed to update risk config for tenant_id={tenant_id}, application_id={application_id}: {e}")
            self.db.rollback()
            return None
    
    def get_enabled_risk_types(self, tenant_id: str = None, application_id: str = None) -> Dict[str, bool]:
        """Get user enabled risk type mapping"""
        config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        if not config:
            # Return default all enabled when user has no configuration
            return {
                'S1': True, 'S2': True, 'S3': True, 'S4': True,
                'S5': True, 'S6': True, 'S7': True, 'S8': True,
                'S9': True, 'S10': True, 'S11': True, 'S12': True,
                'S13': True, 'S14': True, 'S15': True, 'S16': True,
                'S17': True, 'S18': True, 'S19': True, 'S20': True, 'S21': True
            }

        return {
            'S1': config.s1_enabled,
            'S2': config.s2_enabled,
            'S3': config.s3_enabled,
            'S4': config.s4_enabled,
            'S5': config.s5_enabled,
            'S6': config.s6_enabled,
            'S7': config.s7_enabled,
            'S8': config.s8_enabled,
            'S9': config.s9_enabled,
            'S10': config.s10_enabled,
            'S11': config.s11_enabled,
            'S12': config.s12_enabled,
            'S13': config.s13_enabled if hasattr(config, 's13_enabled') else True,
            'S14': config.s14_enabled if hasattr(config, 's14_enabled') else True,
            'S15': config.s15_enabled if hasattr(config, 's15_enabled') else True,
            'S16': config.s16_enabled if hasattr(config, 's16_enabled') else True,
            'S17': config.s17_enabled if hasattr(config, 's17_enabled') else True,
            'S18': config.s18_enabled if hasattr(config, 's18_enabled') else True,
            'S19': config.s19_enabled if hasattr(config, 's19_enabled') else True,
            'S20': config.s20_enabled if hasattr(config, 's20_enabled') else True,
            'S21': config.s21_enabled if hasattr(config, 's21_enabled') else True,
        }
    
    def is_risk_type_enabled(self, tenant_id: str = None, application_id: str = None, risk_type: str = None) -> bool:
        """Check if specified risk type is enabled"""
        enabled_types = self.get_enabled_risk_types(tenant_id=tenant_id, application_id=application_id)
        return enabled_types.get(risk_type, True)  # Default enabled
    
    def get_risk_config_dict(self, tenant_id: str = None, application_id: str = None) -> Dict:
        """Get user/application risk config dictionary format"""
        config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        if not config:
            return {
                's1_enabled': True, 's2_enabled': True, 's3_enabled': True, 's4_enabled': True,
                's5_enabled': True, 's6_enabled': True, 's7_enabled': True, 's8_enabled': True,
                's9_enabled': True, 's10_enabled': True, 's11_enabled': True, 's12_enabled': True,
                's13_enabled': True, 's14_enabled': True, 's15_enabled': True, 's16_enabled': True,
                's17_enabled': True, 's18_enabled': True, 's19_enabled': True, 's20_enabled': True, 's21_enabled': True
            }

        return {
            's1_enabled': config.s1_enabled,
            's2_enabled': config.s2_enabled,
            's3_enabled': config.s3_enabled,
            's4_enabled': config.s4_enabled,
            's5_enabled': config.s5_enabled,
            's6_enabled': config.s6_enabled,
            's7_enabled': config.s7_enabled,
            's8_enabled': config.s8_enabled,
            's9_enabled': config.s9_enabled,
            's10_enabled': config.s10_enabled,
            's11_enabled': config.s11_enabled,
            's12_enabled': config.s12_enabled,
            's13_enabled': config.s13_enabled if hasattr(config, 's13_enabled') else True,
            's14_enabled': config.s14_enabled if hasattr(config, 's14_enabled') else True,
            's15_enabled': config.s15_enabled if hasattr(config, 's15_enabled') else True,
            's16_enabled': config.s16_enabled if hasattr(config, 's16_enabled') else True,
            's17_enabled': config.s17_enabled if hasattr(config, 's17_enabled') else True,
            's18_enabled': config.s18_enabled if hasattr(config, 's18_enabled') else True,
            's19_enabled': config.s19_enabled if hasattr(config, 's19_enabled') else True,
            's20_enabled': config.s20_enabled if hasattr(config, 's20_enabled') else True,
            's21_enabled': config.s21_enabled if hasattr(config, 's21_enabled') else True,
        }

    def update_sensitivity_thresholds(self, tenant_id: str = None, application_id: str = None, threshold_data: Dict = None) -> Optional[RiskTypeConfig]:
        """Update user/application sensitivity threshold configuration"""
        try:
            if not threshold_data:
                threshold_data = {}

            config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
            if not config:
                config = self.create_default_risk_config(tenant_id=tenant_id, application_id=application_id)

            # Update sensitivity threshold fields
            for field, value in threshold_data.items():
                if hasattr(config, field):
                    setattr(config, field, value)

            self.db.commit()
            self.db.refresh(config)
            logger.info(f"Updated sensitivity thresholds for tenant_id={tenant_id}, application_id={application_id}")
            return config
        except Exception as e:
            logger.error(f"Failed to update sensitivity thresholds for tenant_id={tenant_id}, application_id={application_id}: {e}")
            self.db.rollback()
            return None

    def get_sensitivity_threshold_dict(self, tenant_id: str = None, application_id: str = None) -> Dict:
        """Get user/application sensitivity threshold configuration dictionary format"""
        config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        if not config:
            return {
                'low_sensitivity_threshold': 0.95,
                'medium_sensitivity_threshold': 0.60,
                'high_sensitivity_threshold': 0.40,
                'sensitivity_trigger_level': "medium"
            }

        return {
            'low_sensitivity_threshold': config.low_sensitivity_threshold or 0.95,
            'medium_sensitivity_threshold': config.medium_sensitivity_threshold or 0.60,
            'high_sensitivity_threshold': config.high_sensitivity_threshold or 0.40,
            'sensitivity_trigger_level': config.sensitivity_trigger_level or "medium",
        }

    def get_sensitivity_thresholds(self, tenant_id: str = None, application_id: str = None) -> Dict[str, float]:
        """Get user/application sensitivity threshold mapping"""
        config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        if not config:
            return {
                'low': 0.95,
                'medium': 0.60,
                'high': 0.40
            }

        return {
            'low': config.low_sensitivity_threshold or 0.95,
            'medium': config.medium_sensitivity_threshold or 0.60,
            'high': config.high_sensitivity_threshold or 0.40
        }

    def get_sensitivity_trigger_level(self, tenant_id: str = None, application_id: str = None) -> str:
        """Get user/application sensitivity trigger level"""
        config = self.get_user_risk_config(tenant_id=tenant_id, application_id=application_id)
        if not config:
            return "medium"
        return config.sensitivity_trigger_level or "medium"