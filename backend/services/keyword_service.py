import re
from typing import List, Tuple, Optional
from sqlalchemy.orm import Session
from database.models import Blacklist, Whitelist
from utils.logger import setup_logger

logger = setup_logger()

class KeywordService:
    """Keyword matching service"""
    
    def __init__(self, db: Session):
        self.db = db
    
    def check_blacklist(self, content: str) -> Tuple[bool, Optional[str], List[str]]:
        """Check blacklist
        
        Returns:
            (is_hit, list_name, matched_keywords)
        """
        try:
            # Get enabled blacklist
            blacklists = self.db.query(Blacklist).filter_by(is_active=True).all()
            
            content_lower = content.lower()
            
            for blacklist in blacklists:
                keywords = blacklist.keywords if isinstance(blacklist.keywords, list) else []
                matched_keywords = []
                
                for keyword in keywords:
                    if keyword.lower() in content_lower:
                        matched_keywords.append(keyword)
                
                if matched_keywords:
                    logger.info(f"Blacklist hit: {blacklist.name}, keywords: {matched_keywords}")
                    return True, blacklist.name, matched_keywords
            
            return False, None, []
            
        except Exception as e:
            logger.error(f"Blacklist check error: {e}")
            return False, None, []
    
    def check_whitelist(self, content: str) -> Tuple[bool, Optional[str], List[str]]:
        """Check whitelist
        
        Returns:
            (is_hit, list_name, matched_keywords)
        """
        try:
            # Get enabled whitelist
            whitelists = self.db.query(Whitelist).filter_by(is_active=True).all()
            
            content_lower = content.lower()
            
            for whitelist in whitelists:
                keywords = whitelist.keywords if isinstance(whitelist.keywords, list) else []
                matched_keywords = []
                
                for keyword in keywords:
                    if keyword.lower() in content_lower:
                        matched_keywords.append(keyword)
                
                if matched_keywords:
                    logger.info(f"Whitelist hit: {whitelist.name}, keywords: {matched_keywords}")
                    return True, whitelist.name, matched_keywords
            
            return False, None, []
            
        except Exception as e:
            logger.error(f"Whitelist check error: {e}")
            return False, None, []
    
    def extract_sensitive_info(self, content: str) -> List[str]:
        """Extract sensitive information (through regular expressions)"""
        sensitive_patterns = [
            # Phone number
            (r'1[3-9]\d{9}', 'Phone number'),
            # ID number
            (r'\d{17}[\dX]|\d{15}', 'ID number'),
            # Email
            (r'[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}', 'Email address'),
            # IP address
            (r'\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b', 'IP address'),
            # Bank card number (simple matching)
            (r'\b\d{16,19}\b', 'Bank card number'),
        ]
        
        found_info = []
        
        for pattern, info_type in sensitive_patterns:
            matches = re.findall(pattern, content)
            if matches:
                found_info.extend([f"{info_type}: {match}" for match in matches])
        
        return found_info