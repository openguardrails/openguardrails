"""
Scanner Detection Service - New scanner package system detection logic

This service executes detection using the new scanner package system,
supporting three scanner types:
- GenAI: Uses OpenGuardrails-Text model for intelligent detection
- Regex: Python regex pattern matching
- Keyword: Case-insensitive keyword matching
"""

import re
from typing import List, Dict, Tuple, Optional, Any
from uuid import UUID
from sqlalchemy.orm import Session

from services.scanner_config_service import ScannerConfigService
from services.model_service import model_service
from utils.logger import setup_logger

logger = setup_logger()


class ScannerDetectionResult:
    """Single scanner detection result"""
    def __init__(self, scanner_tag: str, scanner_name: str, scanner_type: str,
                 risk_level: str, matched: bool, match_details: Optional[str] = None):
        self.scanner_tag = scanner_tag
        self.scanner_name = scanner_name
        self.scanner_type = scanner_type
        self.risk_level = risk_level
        self.matched = matched
        self.match_details = match_details


class AggregatedDetectionResult:
    """Aggregated detection result from all scanners"""
    def __init__(self, overall_risk_level: str, matched_scanners: List[ScannerDetectionResult],
                 compliance_categories: List[str], security_categories: List[str]):
        self.overall_risk_level = overall_risk_level
        self.matched_scanners = matched_scanners
        self.compliance_categories = compliance_categories
        self.security_categories = security_categories
        self.matched_scanner_tags = [s.scanner_tag for s in matched_scanners]


class ScannerDetectionService:
    """
    Scanner-based detection service

    Replaces the old hardcoded S1-S21 risk type detection logic with
    a flexible scanner system that supports:
    - Built-in scanners (migrated from S1-S21)
    - Purchased scanners (from marketplace)
    - Custom scanners (user-defined S100+)
    """

    def __init__(self, db: Session):
        self.db = db
        self.scanner_config_service = ScannerConfigService(db)

    async def execute_detection(
        self,
        content: str,
        application_id: UUID,
        tenant_id: str,
        scan_type: str = 'prompt',  # 'prompt' or 'response'
        messages_for_genai: Optional[List[Dict]] = None
    ) -> AggregatedDetectionResult:
        """
        Execute detection using enabled scanners for the application

        Args:
            content: Text content to check
            application_id: Application UUID
            tenant_id: Tenant ID (UUID string)
            scan_type: 'prompt' or 'response' (determines which scanners to use)
            messages_for_genai: Full message context for GenAI scanners (optional)

        Returns:
            AggregatedDetectionResult with all matched scanners and overall risk
        """
        logger.info(f"Executing scanner detection for app {application_id}, scan_type={scan_type}")

        # 1. Get ALL scanners for this application and scan type (including disabled ones)
        # We need to send all scanner definitions to the model, then filter results by enabled status
        all_scanners = self.scanner_config_service.get_application_scanners(
            application_id=application_id,
            tenant_id=UUID(tenant_id),
            include_disabled=True
        )

        # Filter by scan type
        if scan_type == 'prompt':
            scanners_for_scan_type = [s for s in all_scanners if s['scan_prompt']]
        elif scan_type == 'response':
            scanners_for_scan_type = [s for s in all_scanners if s['scan_response']]
        else:
            scanners_for_scan_type = all_scanners

        if not scanners_for_scan_type:
            logger.info(f"No scanners for app {application_id}, scan_type={scan_type}")
            return AggregatedDetectionResult(
                overall_risk_level="no_risk",
                matched_scanners=[],
                compliance_categories=[],
                security_categories=[]
            )

        # Get enabled scanners separately for filtering results later
        enabled_scanner_tags = set([
            s['tag'] for s in scanners_for_scan_type if s['is_enabled']
        ])

        logger.info(f"Found {len(scanners_for_scan_type)} total scanners, {len(enabled_scanner_tags)} enabled")

        # 2. Group ALL scanners by type (including disabled ones for GenAI)
        genai_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'genai']
        # For regex/keyword, we only execute enabled scanners to save computation
        regex_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'regex' and s['is_enabled']]
        keyword_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'keyword' and s['is_enabled']]

        logger.info(f"Scanner types: GenAI={len(genai_scanners)}, Regex={len(regex_scanners)}, Keyword={len(keyword_scanners)}")

        # 3. Execute scanners (can be parallelized in future)
        all_results = []

        # Execute GenAI scanners (single model call with ALL definitions, then filter)
        if genai_scanners:
            genai_results = await self._execute_genai_scanners(
                genai_scanners, content, messages_for_genai, enabled_scanner_tags
            )
            all_results.extend(genai_results)

        # Execute Regex scanners (Python regex matching) - only enabled
        if regex_scanners:
            regex_results = self._execute_regex_scanners(regex_scanners, content)
            all_results.extend(regex_results)

        # Execute Keyword scanners (case-insensitive search) - only enabled
        if keyword_scanners:
            keyword_results = self._execute_keyword_scanners(keyword_scanners, content)
            all_results.extend(keyword_results)

        # 4. Aggregate results
        return self._aggregate_results(all_results)

    async def _execute_genai_scanners(
        self,
        scanners: List[Dict],
        content: str,
        messages: Optional[List[Dict]] = None,
        enabled_scanner_tags: Optional[set] = None
    ) -> List[ScannerDetectionResult]:
        """
        Execute GenAI scanners using OpenGuardrails-Text model

        All GenAI scanner definitions (both enabled and disabled) are sent to the model
        in a single call. Results are then filtered to only include enabled scanners.

        Args:
            scanners: List of ALL GenAI scanner configs (both enabled and disabled)
            content: Content to check
            messages: Full message context (preferred over content)
            enabled_scanner_tags: Set of tags for enabled scanners (for filtering results)

        Returns:
            List of ScannerDetectionResult (only for enabled scanners)
        """
        logger.info(f"Executing {len(scanners)} GenAI scanners (including disabled ones)")

        try:
            # Prepare scanner definitions for model - send ALL scanners
            # Format for basic scanners: "S2: Sensitive Political Topics"
            # Format for custom/premium scanners: "S100: Custom Scanner Name. [definition]"
            scanner_definitions = []
            scanner_map = {}  # tag -> scanner config

            for scanner in scanners:
                tag = scanner['tag']
                name = scanner['name']
                definition = scanner['definition']
                package_type = scanner.get('package_type', 'custom')

                # For basic (builtin) scanners: only send tag and name (model already knows the definition)
                # For custom/premium (purchasable) scanners: send full definition
                if package_type == 'builtin':  # Basic packages
                    scanner_def = f"{tag}: {name}"
                else:
                    scanner_def = f"{tag}: {name}. {definition}"

                scanner_definitions.append(scanner_def)
                scanner_map[tag] = scanner

            # Sort scanner definitions by tag number (e.g., S1, S2, ..., S19, S20, S21)
            # Extract numeric part from tag like "S1", "S2", "S100" for proper ordering
            def extract_tag_number(scanner_def: str) -> int:
                """Extract numeric part from scanner definition (e.g., 'S19: ...' -> 19)"""
                try:
                    tag_part = scanner_def.split(':')[0].strip()
                    if tag_part.startswith('S'):
                        return int(tag_part[1:])
                    return 999999  # Put non-S tags at the end
                except (ValueError, IndexError):
                    return 999999  # Put malformed tags at the end
            
            scanner_definitions.sort(key=extract_tag_number)

            # Use messages if provided, otherwise wrap content as message
            if messages is None:
                messages = [{"role": "user", "content": content}]

            # Check if messages contain images
            has_image = False
            for msg in messages:
                msg_content = msg.get("content")
                if isinstance(msg_content, list):
                    for part in msg_content:
                        if isinstance(part, dict) and part.get("type") == "image_url":
                            has_image = True
                            break
                if has_image:
                    break

            # Call model with ALL scanner definitions (both enabled and disabled)
            # The model will return format: "unsafe\nS2,S5" or "safe"
            # Use VL model if messages contain images
            model_response, sensitivity_score = await model_service.check_messages_with_scanner_definitions(
                messages=messages,
                scanner_definitions=scanner_definitions,
                use_vl_model=has_image
            )

            logger.info(f"GenAI model response: {model_response}, sensitivity: {sensitivity_score}")

            # Parse model response
            results = []
            response = model_response.strip()

            if response == "safe":
                # No scanners matched - only return results for enabled scanners
                for scanner in scanners:
                    # Filter: only include enabled scanners in results
                    if enabled_scanner_tags is None or scanner['tag'] in enabled_scanner_tags:
                        results.append(ScannerDetectionResult(
                            scanner_tag=scanner['tag'],
                            scanner_name=scanner['name'],
                            scanner_type='genai',
                            risk_level=scanner['risk_level'],
                            matched=False
                        ))
            elif response.startswith("unsafe\n"):
                # Parse matched scanner tags from model response
                categories_line = response.split('\n')[1] if '\n' in response else ""
                matched_tags = [tag.strip() for tag in categories_line.split(',') if tag.strip()]

                logger.info(f"Model returned matched tags: {matched_tags}")

                # Filter matched tags: only keep enabled ones
                if enabled_scanner_tags is not None:
                    filtered_matched_tags = [tag for tag in matched_tags if tag in enabled_scanner_tags]
                    disabled_tags = [tag for tag in matched_tags if tag not in enabled_scanner_tags]
                    if disabled_tags:
                        logger.info(f"Filtered out disabled scanner tags: {disabled_tags}")
                    logger.info(f"Enabled matched tags after filtering: {filtered_matched_tags}")
                else:
                    filtered_matched_tags = matched_tags

                # Create results only for enabled scanners
                for scanner in scanners:
                    tag = scanner['tag']
                    # Skip disabled scanners
                    if enabled_scanner_tags is not None and tag not in enabled_scanner_tags:
                        continue

                    # Check if this enabled scanner was matched (after filtering)
                    matched = tag in filtered_matched_tags

                    results.append(ScannerDetectionResult(
                        scanner_tag=tag,
                        scanner_name=scanner['name'],
                        scanner_type='genai',
                        risk_level=scanner['risk_level'],
                        matched=matched,
                        match_details=f"Sensitivity: {sensitivity_score}" if matched else None
                    ))
            else:
                # Unexpected format, treat all as not matched - only return enabled scanners
                logger.warning(f"Unexpected model response format: {response}")
                for scanner in scanners:
                    if enabled_scanner_tags is None or scanner['tag'] in enabled_scanner_tags:
                        results.append(ScannerDetectionResult(
                            scanner_tag=scanner['tag'],
                            scanner_name=scanner['name'],
                            scanner_type='genai',
                            risk_level=scanner['risk_level'],
                            matched=False
                        ))

            return results

        except Exception as e:
            logger.error(f"Error executing GenAI scanners: {e}")
            # Return all enabled scanners as not matched on error
            return [
                ScannerDetectionResult(
                    scanner_tag=s['tag'],
                    scanner_name=s['name'],
                    scanner_type='genai',
                    risk_level=s['risk_level'],
                    matched=False
                ) for s in scanners
                if enabled_scanner_tags is None or s['tag'] in enabled_scanner_tags
            ]

    def _execute_regex_scanners(
        self,
        scanners: List[Dict],
        content: str
    ) -> List[ScannerDetectionResult]:
        """
        Execute Regex scanners using Python re module

        Args:
            scanners: List of Regex scanner configs
            content: Content to check

        Returns:
            List of ScannerDetectionResult
        """
        logger.info(f"Executing {len(scanners)} Regex scanners")

        results = []
        for scanner in scanners:
            tag = scanner['tag']
            name = scanner['name']
            pattern = scanner['definition']
            risk_level = scanner['risk_level']

            try:
                # Compile and search for pattern
                regex = re.compile(pattern, re.IGNORECASE | re.MULTILINE)
                matches = regex.findall(content)

                matched = len(matches) > 0
                match_details = None

                if matched:
                    # Limit match details to avoid huge strings
                    match_samples = matches[:5]  # Show first 5 matches
                    match_details = f"Matched {len(matches)} times. Samples: {match_samples}"
                    logger.info(f"Regex scanner {tag} matched: {match_details}")

                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    scanner_name=name,
                    scanner_type='regex',
                    risk_level=risk_level,
                    matched=matched,
                    match_details=match_details
                ))

            except re.error as e:
                # Invalid regex pattern
                logger.error(f"Invalid regex pattern for scanner {tag}: {e}")
                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    scanner_name=name,
                    scanner_type='regex',
                    risk_level=risk_level,
                    matched=False,
                    match_details=f"Error: Invalid regex pattern - {str(e)}"
                ))
            except Exception as e:
                # Other errors
                logger.error(f"Error executing regex scanner {tag}: {e}")
                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    scanner_name=name,
                    scanner_type='regex',
                    risk_level=risk_level,
                    matched=False
                ))

        return results

    def _execute_keyword_scanners(
        self,
        scanners: List[Dict],
        content: str
    ) -> List[ScannerDetectionResult]:
        """
        Execute Keyword scanners using case-insensitive string search

        Args:
            scanners: List of Keyword scanner configs
            content: Content to check

        Returns:
            List of ScannerDetectionResult
        """
        logger.info(f"Executing {len(scanners)} Keyword scanners")

        # Convert content to lowercase for case-insensitive matching
        content_lower = content.lower()

        results = []
        for scanner in scanners:
            tag = scanner['tag']
            name = scanner['name']
            keywords_str = scanner['definition']  # Comma-separated keywords
            risk_level = scanner['risk_level']

            try:
                # Split keywords by comma
                keywords = [k.strip().lower() for k in keywords_str.split(',') if k.strip()]

                if not keywords:
                    logger.warning(f"Keyword scanner {tag} has no valid keywords")
                    results.append(ScannerDetectionResult(
                        scanner_tag=tag,
                        scanner_name=name,
                        scanner_type='keyword',
                        risk_level=risk_level,
                        matched=False,
                        match_details="No valid keywords defined"
                    ))
                    continue

                # Check which keywords are present
                matched_keywords = [kw for kw in keywords if kw in content_lower]
                matched = len(matched_keywords) > 0
                match_details = None

                if matched:
                    # Limit to first 5 matched keywords
                    match_samples = matched_keywords[:5]
                    match_details = f"Matched keywords: {match_samples}"
                    logger.info(f"Keyword scanner {tag} matched: {match_details}")

                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    scanner_name=name,
                    scanner_type='keyword',
                    risk_level=risk_level,
                    matched=matched,
                    match_details=match_details
                ))

            except Exception as e:
                logger.error(f"Error executing keyword scanner {tag}: {e}")
                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    scanner_name=name,
                    scanner_type='keyword',
                    risk_level=risk_level,
                    matched=False
                ))

        return results

    def _aggregate_results(
        self,
        scanner_results: List[ScannerDetectionResult]
    ) -> AggregatedDetectionResult:
        """
        Aggregate scanner results and determine overall risk level

        Args:
            scanner_results: List of all scanner results

        Returns:
            AggregatedDetectionResult
        """
        # Filter matched scanners
        matched_scanners = [r for r in scanner_results if r.matched]

        if not matched_scanners:
            logger.info("No scanners matched - content is safe")
            return AggregatedDetectionResult(
                overall_risk_level="no_risk",
                matched_scanners=[],
                compliance_categories=[],
                security_categories=[]
            )

        logger.info(f"{len(matched_scanners)} scanners matched")

        # Determine highest risk level
        risk_priority = {"no_risk": 0, "low_risk": 1, "medium_risk": 2, "high_risk": 3}
        overall_risk_level = "no_risk"

        for scanner in matched_scanners:
            scanner_risk = scanner.risk_level
            if risk_priority[scanner_risk] > risk_priority[overall_risk_level]:
                overall_risk_level = scanner_risk

        # Separate security (S9 = Prompt Attacks) from compliance categories
        security_categories = []
        compliance_categories = []

        for scanner in matched_scanners:
            if scanner.scanner_tag == "S9":
                security_categories.append(scanner.scanner_name)
            else:
                compliance_categories.append(scanner.scanner_name)

        logger.info(f"Overall risk: {overall_risk_level}, Compliance: {len(compliance_categories)}, Security: {len(security_categories)}")

        return AggregatedDetectionResult(
            overall_risk_level=overall_risk_level,
            matched_scanners=matched_scanners,
            compliance_categories=compliance_categories,
            security_categories=security_categories
        )
