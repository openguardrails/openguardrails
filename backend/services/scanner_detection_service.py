"""
Scanner Detection Service - New scanner package system detection logic

This service executes detection using the new scanner package system,
supporting three scanner types:
- GenAI: Uses OpenGuardrails-Text model for intelligent detection
- Regex: Python regex pattern matching
- Keyword: Case-insensitive keyword matching

Detection Modes:
1. Context-aware (default): Messages within MAX_DETECTION_CONTEXT_LENGTH are detected together
2. Sliding window detection: When content exceeds MAX_DETECTION_CONTEXT_LENGTH
   - User-only messages: Slide window on user content
   - Multi-turn (user+assistant): Only detect the LAST message with sliding window as user content
   - Only user/assistant messages are detected; system/developer/tool messages are ignored
"""

import asyncio
import re
from typing import List, Dict, Tuple, Optional, Any
from uuid import UUID
from sqlalchemy.orm import Session
from sqlalchemy.ext.asyncio import AsyncSession

from config import settings
from services.scanner_config_service import ScannerConfigService, AsyncScannerConfigService
from services.model_service import model_service
from utils.logger import setup_logger

logger = setup_logger()


def _truncate_for_log(text: str, max_len: int = 200) -> str:
    """Truncate text for logging, showing start and end if too long."""
    if not text or len(text) <= max_len:
        return text
    half = max_len // 2
    return f"{text[:half]}...({len(text)} chars)...{text[-half:]}"


class SlidingWindowProcessor:
    """
    Sliding window processor for long content detection.

    Handles two scenarios when content exceeds MAX_DETECTION_CONTEXT_LENGTH:
    1. User-only messages: Slide window on user content
    2. Multi-turn (user+assistant): Only detect the LAST message with sliding window as user content
    """

    def __init__(self, max_context_length: int = None):
        """
        Initialize sliding window processor.

        Args:
            max_context_length: Maximum context length for detection.
                               Defaults to settings.max_detection_context_length
        """
        self.max_context_length = max_context_length or settings.max_detection_context_length
        # Window overlap to avoid missing content at boundaries (20% overlap)
        self.overlap_ratio = 0.2

    def _create_windows(self, text: str, window_size: int) -> List[Tuple[str, int, int]]:
        """
        Create sliding windows for a text.

        Args:
            text: Text to create windows from
            window_size: Size of each window in characters

        Returns:
            List of (window_text, start_pos, end_pos) tuples
        """
        if not text or len(text) <= window_size:
            return [(text, 0, len(text))]

        windows = []
        step_size = int(window_size * (1 - self.overlap_ratio))  # 80% step, 20% overlap

        start = 0
        while start < len(text):
            end = min(start + window_size, len(text))
            window_text = text[start:end]
            windows.append((window_text, start, end))

            if end >= len(text):
                break
            start += step_size

        logger.info(f"Created {len(windows)} windows for text of length {len(text)} (window_size={window_size})")

        # DEBUG mode: print each window's content
        if settings.debug:
            for i, (win_text, win_start, win_end) in enumerate(windows):
                logger.info(f"[SLIDING_WINDOW DEBUG] Window {i+1}/{len(windows)}: "
                           f"chars [{win_start}-{win_end}], content: {_truncate_for_log(win_text, 300)}")

        return windows

    def get_message_windows(
        self,
        messages: List[Dict]
    ) -> 'SlidingWindowResult':
        """
        Generate message window combinations for detection.

        Only user/assistant messages should be passed in (caller filters others).

        Logic:
        - If content fits in MAX_DETECTION_CONTEXT_LENGTH: return as-is (single detection)
        - If exceeds limit and only user messages: sliding window on user content
        - If exceeds limit and multi-turn (user+assistant): only detect the LAST message
          with sliding window, treated as user content

        Args:
            messages: List of user/assistant messages only

        Returns:
            SlidingWindowResult with windows, scope, and window_count
        """
        if not messages:
            return SlidingWindowResult(windows=[[]], scope="all", window_count=1)

        user_messages = [m for m in messages if m.get("role") == "user"]
        assistant_messages = [m for m in messages if m.get("role") == "assistant"]

        # Combine all content to check total length
        user_content = "\n".join(get_text_content(m) for m in user_messages)
        assistant_content = "\n".join(get_text_content(m) for m in assistant_messages)

        total_length = len(user_content) + len(assistant_content)

        # If total content fits in context, return original messages
        if total_length <= self.max_context_length:
            logger.debug(f"Content length {total_length} <= max {self.max_context_length}, no sliding window needed")
            scope = "all" if assistant_messages else "user_only"
            return SlidingWindowResult(windows=[messages], scope=scope, window_count=1)

        logger.info(f"Content length {total_length} > max {self.max_context_length}, applying sliding window")

        # DEBUG mode: print message stats
        if settings.debug:
            logger.info(f"[SLIDING_WINDOW DEBUG] Message stats: "
                       f"total messages={len(messages)}, "
                       f"user messages={len(user_messages)}, "
                       f"assistant messages={len(assistant_messages)}, "
                       f"user content length={len(user_content)}, "
                       f"assistant content length={len(assistant_content)}")

        window_size = self.max_context_length

        # Case 1: Only user messages - sliding window on user content
        if not assistant_messages:
            user_windows = self._create_windows(user_content, window_size)

            result = []
            for window_text, start, end in user_windows:
                result.append([{"role": "user", "content": window_text}])

            logger.info(f"Created {len(result)} user-only sliding windows")
            return SlidingWindowResult(windows=result, scope="user_only", window_count=len(result))

        # Case 2: Multi-turn (user+assistant) - only detect the LAST message
        # Extract the last message and sliding window it as user content
        last_message = messages[-1]
        last_content = get_text_content(last_message)

        # DEBUG mode: explain why only last message is detected
        if settings.debug:
            logger.info(f"[SLIDING_WINDOW DEBUG] Multi-turn conversation detected. "
                       f"Only detecting the LAST message (role={last_message.get('role')}, "
                       f"length={len(last_content)} chars)")

        if not last_content:
            logger.warning("Last message has no text content, returning empty")
            return SlidingWindowResult(windows=[[]], scope="last_message", window_count=1)

        last_windows = self._create_windows(last_content, window_size)

        result = []
        for window_text, start, end in last_windows:
            result.append([{"role": "user", "content": window_text}])

        logger.info(f"Multi-turn: detecting only last message ({last_message.get('role')}) with {len(result)} sliding windows")
        return SlidingWindowResult(windows=result, scope="last_message", window_count=len(result))


def get_text_content(msg: Dict) -> str:
    """Extract text content from a message dict (handles string and multimodal)."""
    content = msg.get("content", "")
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    elif isinstance(content, list):
        text_parts = []
        for part in content:
            if isinstance(part, dict) and part.get("type") == "text":
                text_parts.append(part.get("text", ""))
        return " ".join(text_parts)
    return str(content)


class SlidingWindowResult:
    """Result from sliding window processor with scope info"""
    def __init__(self, windows: List[List[Dict]], scope: str, window_count: int):
        self.windows = windows  # List of message windows
        self.scope = scope  # 'all', 'last_message', 'user_only'
        self.window_count = window_count  # Number of windows (1 if no sliding window)


# Global sliding window processor instance
sliding_window_processor = SlidingWindowProcessor()


class ScannerDetectionResult:
    """Single scanner detection result"""
    def __init__(self, scanner_tag: str, guardrail_name: str, scanner_type: str,
                 risk_level: str, matched: bool, match_details: Optional[str] = None):
        self.scanner_tag = scanner_tag
        self.guardrail_name = guardrail_name
        self.scanner_type = scanner_type
        self.risk_level = risk_level
        self.matched = matched
        self.match_details = match_details


class AggregatedDetectionResult:
    """Aggregated detection result from all scanners"""
    def __init__(self, overall_risk_level: str, matched_scanners: List[ScannerDetectionResult],
                 compliance_categories: List[str], security_categories: List[str],
                 detection_scope: str = "all", sliding_window_count: Optional[int] = None,
                 matched_window_indices: Optional[List[int]] = None):
        self.overall_risk_level = overall_risk_level
        self.matched_scanners = matched_scanners
        self.compliance_categories = compliance_categories
        self.security_categories = security_categories
        self.matched_scanner_tags = [s.scanner_tag for s in matched_scanners]
        # Detection scope info for replay
        self.detection_scope = detection_scope  # 'all', 'last_message', 'user_only'
        self.sliding_window_count = sliding_window_count  # Number of windows used
        self.matched_window_indices = matched_window_indices  # Which windows matched


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

        # 1. Get ONLY enabled scanners for this application and scan type
        # Disabled scanners should not be sent to the model at all
        all_scanners = self.scanner_config_service.get_application_scanners(
            application_id=application_id,
            tenant_id=UUID(tenant_id),
            include_disabled=False  # Only get enabled scanners
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

        # All scanners are now enabled, so no need to filter tags
        logger.info(f"Found {len(scanners_for_scan_type)} enabled scanners")

        # 2. Group scanners by type (all are enabled now)
        genai_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'genai']
        regex_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'regex']
        keyword_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'keyword']

        logger.info(f"Scanner types: GenAI={len(genai_scanners)}, Regex={len(regex_scanners)}, Keyword={len(keyword_scanners)}")

        # 3. Execute scanners (can be parallelized in future)
        all_results = []
        detection_scope = "all"
        sliding_window_count = None
        matched_window_indices = None

        # Execute GenAI scanners (single model call with enabled definitions only)
        if genai_scanners:
            genai_results, scope_info = await self._execute_genai_scanners(
                genai_scanners, content, messages_for_genai
            )
            all_results.extend(genai_results)
            detection_scope = scope_info.get("scope", "all")
            sliding_window_count = scope_info.get("window_count")
            matched_window_indices = scope_info.get("matched_indices")

        # Execute Regex scanners (Python regex matching) - only enabled
        if regex_scanners:
            regex_results = self._execute_regex_scanners(regex_scanners, content)
            all_results.extend(regex_results)

        # Execute Keyword scanners (case-insensitive search) - only enabled
        if keyword_scanners:
            keyword_results = self._execute_keyword_scanners(keyword_scanners, content)
            all_results.extend(keyword_results)

        # 4. Aggregate results
        return self._aggregate_results(
            all_results,
            detection_scope=detection_scope,
            sliding_window_count=sliding_window_count,
            matched_window_indices=matched_window_indices
        )

    async def _execute_genai_scanners(
        self,
        scanners: List[Dict],
        content: str,
        messages: Optional[List[Dict]] = None
    ) -> Tuple[List[ScannerDetectionResult], Dict]:
        """
        Execute GenAI scanners using OpenGuardrails-Text model

        Only enabled GenAI scanner definitions are sent to the model
        in a single call. Only user/assistant messages are detected.

        Sliding window for long content:
        - User-only: Slide window on user content
        - Multi-turn (user+assistant): Only detect the LAST message with sliding window

        Args:
            scanners: List of enabled GenAI scanner configs only
            content: Content to check
            messages: Full message context (preferred over content)

        Returns:
            Tuple of (List of ScannerDetectionResult, scope_info dict)
            scope_info: {"scope": "all|last_message|user_only", "window_count": int, "matched_indices": list}
        """
        logger.info(f"Executing {len(scanners)} enabled GenAI scanners")
        scope_info = {"scope": "all", "window_count": 1, "matched_indices": None}

        try:
            # Prepare scanner definitions for model - send only enabled scanners
            scanner_definitions = self._prepare_scanner_definitions(scanners)

            # Use messages if provided, otherwise wrap content as message
            if messages is None:
                messages = [{"role": "user", "content": content}]

            # Check if messages contain images
            has_image = self._check_has_image(messages)

            # Only detect user/assistant messages - ignore system/developer/tool/etc.
            detected_messages = [m for m in messages if m.get("role") in ("user", "assistant")]

            if not detected_messages:
                logger.info("No user/assistant messages to detect")
                return ([
                    ScannerDetectionResult(
                        scanner_tag=s['tag'], guardrail_name=s['name'],
                        scanner_type='genai', risk_level=s['risk_level'], matched=False
                    ) for s in scanners
                ], scope_info)

            # Use sliding window processor for all cases (handles both within-limit and exceeding-limit)
            window_result = sliding_window_processor.get_message_windows(detected_messages)
            message_windows = window_result.windows
            scope_info["scope"] = window_result.scope
            scope_info["window_count"] = window_result.window_count

            if len(message_windows) == 1:
                # No sliding window needed - single detection
                results = await self._execute_single_genai_detection(
                    scanners, scanner_definitions, message_windows[0], has_image
                )
                return (results, scope_info)
            else:
                # Multiple windows - parallel detection and aggregate results
                logger.info(f"Executing sliding window detection with {len(message_windows)} windows")
                results, matched_indices = await self._execute_sliding_window_detection(
                    scanners, scanner_definitions, message_windows, has_image
                )
                scope_info["matched_indices"] = matched_indices
                return (results, scope_info)

        except Exception as e:
            logger.error(f"Error executing GenAI scanners: {e}")
            # Return all scanners as not matched on error
            return ([
                ScannerDetectionResult(
                    scanner_tag=s['tag'],
                    guardrail_name=s['name'],
                    scanner_type='genai',
                    risk_level=s['risk_level'],
                    matched=False
                ) for s in scanners
            ], scope_info)

    def _prepare_scanner_definitions(self, scanners: List[Dict]) -> List[str]:
        """
        Prepare scanner definitions for model.

        Args:
            scanners: List of scanner configs

        Returns:
            List of scanner definition strings
        """
        scanner_definitions = []

        for scanner in scanners:
            tag = scanner['tag']
            name = scanner['name']
            definition = scanner['definition']
            package_type = scanner.get('package_type', 'custom')

            # For basic/premium scanners: only send tag and name (model already knows the definition)
            # For custom scanners: send full definition
            if package_type in ['basic', 'premium']:
                scanner_def = f"{tag}: {name}"
            else:
                scanner_def = f"{tag}: {name}. {definition}"

            scanner_definitions.append(scanner_def)

        # Sort by tag number (e.g., S1, S2, ..., S19, S20, S21)
        def extract_tag_number(scanner_def: str) -> int:
            try:
                tag_part = scanner_def.split(':')[0].strip()
                if tag_part.startswith('S'):
                    return int(tag_part[1:])
                return 999999
            except (ValueError, IndexError):
                return 999999

        scanner_definitions.sort(key=extract_tag_number)
        return scanner_definitions

    def _check_has_image(self, messages: List[Dict]) -> bool:
        """Check if messages contain images."""
        for msg in messages:
            msg_content = msg.get("content")
            if isinstance(msg_content, list):
                for part in msg_content:
                    if isinstance(part, dict) and part.get("type") == "image_url":
                        return True
        return False

    async def _execute_single_genai_detection(
        self,
        scanners: List[Dict],
        scanner_definitions: List[str],
        messages: List[Dict],
        has_image: bool
    ) -> List[ScannerDetectionResult]:
        """
        Execute a single GenAI detection call.

        Args:
            scanners: List of scanner configs
            scanner_definitions: Prepared scanner definitions
            messages: Messages to check
            has_image: Whether messages contain images

        Returns:
            List of ScannerDetectionResult
        """
        model_response, sensitivity_score = await model_service.check_messages_with_scanner_definitions(
            messages=messages,
            scanner_definitions=scanner_definitions,
            use_vl_model=has_image
        )

        logger.info(f"GenAI model response: {model_response}, sensitivity: {sensitivity_score}")
        return self._parse_model_response(scanners, model_response, sensitivity_score)

    async def _execute_sliding_window_detection(
        self,
        scanners: List[Dict],
        scanner_definitions: List[str],
        message_windows: List[List[Dict]],
        has_image: bool
    ) -> Tuple[List[ScannerDetectionResult], List[int]]:
        """
        Execute sliding window detection with multiple windows.

        Runs all window detections in parallel and aggregates results.
        A scanner is considered matched if it matches in ANY window.

        Args:
            scanners: List of scanner configs
            scanner_definitions: Prepared scanner definitions
            message_windows: List of message windows to check
            has_image: Whether messages contain images

        Returns:
            Tuple of (List of ScannerDetectionResult, List of matched window indices)
        """
        # Create detection tasks for all windows
        tasks = []
        for i, window_messages in enumerate(message_windows):
            task = self._detect_single_window(
                window_index=i,
                scanners=scanners,
                scanner_definitions=scanner_definitions,
                messages=window_messages,
                has_image=has_image
            )
            tasks.append(task)

        # Execute all windows in parallel
        window_results = await asyncio.gather(*tasks, return_exceptions=True)

        # Aggregate results from all windows
        return self._aggregate_window_results(scanners, window_results)

    async def _detect_single_window(
        self,
        window_index: int,
        scanners: List[Dict],
        scanner_definitions: List[str],
        messages: List[Dict],
        has_image: bool
    ) -> Tuple[int, str, Optional[float]]:
        """
        Detect a single window and return raw response.

        Args:
            window_index: Index of this window
            scanners: List of scanner configs
            scanner_definitions: Prepared scanner definitions
            messages: Messages for this window
            has_image: Whether messages contain images

        Returns:
            Tuple of (window_index, model_response, sensitivity_score)
        """
        try:
            # DEBUG mode: print what this window is detecting
            if settings.debug:
                window_content = get_text_content(messages[0]) if messages else ""
                logger.info(f"[SLIDING_WINDOW DEBUG] Window {window_index} detecting: {_truncate_for_log(window_content, 300)}")

            model_response, sensitivity_score = await model_service.check_messages_with_scanner_definitions(
                messages=messages,
                scanner_definitions=scanner_definitions,
                use_vl_model=has_image
            )

            # DEBUG mode: print detection result for this window
            if settings.debug:
                is_hit = model_response.strip().startswith("unsafe")
                hit_info = ""
                if is_hit:
                    categories_line = model_response.strip().split('\n')[1] if '\n' in model_response else ""
                    hit_info = f", matched tags: {categories_line}"
                logger.info(f"[SLIDING_WINDOW DEBUG] Window {window_index} result: "
                           f"{'HIT' if is_hit else 'SAFE'}{hit_info}, sensitivity: {sensitivity_score}")

            logger.debug(f"Window {window_index} response: {model_response}, sensitivity: {sensitivity_score}")
            return (window_index, model_response, sensitivity_score)
        except Exception as e:
            logger.error(f"Error detecting window {window_index}: {e}")
            return (window_index, "safe", None)  # Treat errors as safe

    def _aggregate_window_results(
        self,
        scanners: List[Dict],
        window_results: List[Any]
    ) -> Tuple[List[ScannerDetectionResult], List[int]]:
        """
        Aggregate results from multiple windows.

        A scanner is matched if it matches in ANY window.
        Uses the highest sensitivity score among matched windows.

        Args:
            scanners: List of scanner configs
            window_results: List of (window_index, model_response, sensitivity_score) tuples

        Returns:
            Tuple of (Aggregated list of ScannerDetectionResult, List of matched window indices)
        """
        # Track matched scanners and their best sensitivity scores
        matched_scanner_info = {}  # tag -> (matched, best_sensitivity, window_indices)

        for scanner in scanners:
            matched_scanner_info[scanner['tag']] = {
                'matched': False,
                'sensitivity': None,
                'windows': []
            }

        # Process each window result
        for result in window_results:
            if isinstance(result, Exception):
                logger.error(f"Window detection exception: {result}")
                continue

            window_index, model_response, sensitivity_score = result
            response = model_response.strip()

            if response.startswith("unsafe\n"):
                categories_line = response.split('\n')[1] if '\n' in response else ""
                matched_tags = [tag.strip() for tag in categories_line.split(',') if tag.strip()]

                for tag in matched_tags:
                    if tag in matched_scanner_info:
                        info = matched_scanner_info[tag]
                        info['matched'] = True
                        info['windows'].append(window_index)
                        # Track best (highest) sensitivity score
                        if sensitivity_score is not None:
                            if info['sensitivity'] is None or sensitivity_score > info['sensitivity']:
                                info['sensitivity'] = sensitivity_score

        # Build final results
        results = []
        total_windows = len(window_results)

        for scanner in scanners:
            tag = scanner['tag']
            info = matched_scanner_info[tag]

            match_details = None
            if info['matched']:
                window_count = len(info['windows'])
                match_details = f"Matched in {window_count}/{total_windows} windows"
                if info['sensitivity'] is not None:
                    match_details += f", max sensitivity: {info['sensitivity']:.4f}"

            results.append(ScannerDetectionResult(
                scanner_tag=tag,
                guardrail_name=scanner['name'],
                scanner_type='genai',
                risk_level=scanner['risk_level'],
                matched=info['matched'],
                match_details=match_details
            ))

        # Log summary
        matched_count = sum(1 for r in results if r.matched)
        logger.info(f"Sliding window aggregation: {matched_count} scanners matched across {total_windows} windows")

        # Collect all matched window indices (unique, sorted)
        all_matched_indices = set()
        for scanner in scanners:
            info = matched_scanner_info[scanner['tag']]
            if info['matched']:
                all_matched_indices.update(info['windows'])
        all_matched_indices = sorted(all_matched_indices)

        # DEBUG mode: print detailed match summary per scanner
        if settings.debug and matched_count > 0:
            logger.info("[SLIDING_WINDOW DEBUG] === Match Summary ===")
            for scanner in scanners:
                tag = scanner['tag']
                info = matched_scanner_info[tag]
                if info['matched']:
                    logger.info(f"[SLIDING_WINDOW DEBUG] {tag} ({scanner['name']}): "
                               f"matched in windows {info['windows']}, "
                               f"max sensitivity: {info['sensitivity']}")
            logger.info("[SLIDING_WINDOW DEBUG] === End Summary ===")

        return (results, all_matched_indices)

    def _parse_model_response(
        self,
        scanners: List[Dict],
        model_response: str,
        sensitivity_score: Optional[float]
    ) -> List[ScannerDetectionResult]:
        """
        Parse model response into scanner results.

        Args:
            scanners: List of scanner configs
            model_response: Raw model response
            sensitivity_score: Sensitivity score from model

        Returns:
            List of ScannerDetectionResult
        """
        results = []
        response = model_response.strip()

        if response == "safe":
            for scanner in scanners:
                results.append(ScannerDetectionResult(
                    scanner_tag=scanner['tag'],
                    guardrail_name=scanner['name'],
                    scanner_type='genai',
                    risk_level=scanner['risk_level'],
                    matched=False
                ))
        elif response.startswith("unsafe\n"):
            categories_line = response.split('\n')[1] if '\n' in response else ""
            matched_tags = [tag.strip() for tag in categories_line.split(',') if tag.strip()]

            logger.info(f"Model returned matched tags: {matched_tags}")

            for scanner in scanners:
                tag = scanner['tag']
                matched = tag in matched_tags

                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    guardrail_name=scanner['name'],
                    scanner_type='genai',
                    risk_level=scanner['risk_level'],
                    matched=matched,
                    match_details=f"Sensitivity: {sensitivity_score}" if matched else None
                ))
        else:
            logger.warning(f"Unexpected model response format: {response}")
            for scanner in scanners:
                results.append(ScannerDetectionResult(
                    scanner_tag=scanner['tag'],
                    guardrail_name=scanner['name'],
                    scanner_type='genai',
                    risk_level=scanner['risk_level'],
                    matched=False
                ))

        return results

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
                    guardrail_name=name,
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
                    guardrail_name=name,
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
                    guardrail_name=name,
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
                        guardrail_name=name,
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
                    guardrail_name=name,
                    scanner_type='keyword',
                    risk_level=risk_level,
                    matched=matched,
                    match_details=match_details
                ))

            except Exception as e:
                logger.error(f"Error executing keyword scanner {tag}: {e}")
                results.append(ScannerDetectionResult(
                    scanner_tag=tag,
                    guardrail_name=name,
                    scanner_type='keyword',
                    risk_level=risk_level,
                    matched=False
                ))

        return results

    def _aggregate_results(
        self,
        scanner_results: List[ScannerDetectionResult],
        detection_scope: str = "all",
        sliding_window_count: Optional[int] = None,
        matched_window_indices: Optional[List[int]] = None
    ) -> AggregatedDetectionResult:
        """
        Aggregate scanner results and determine overall risk level

        Args:
            scanner_results: List of all scanner results
            detection_scope: What was detected ('all', 'last_message', 'user_only')
            sliding_window_count: Number of sliding windows used
            matched_window_indices: Which windows matched

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
                security_categories=[],
                detection_scope=detection_scope,
                sliding_window_count=sliding_window_count,
                matched_window_indices=matched_window_indices
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
                security_categories.append(scanner.guardrail_name)
            else:
                compliance_categories.append(scanner.guardrail_name)

        logger.info(f"Overall risk: {overall_risk_level}, Compliance: {len(compliance_categories)}, Security: {len(security_categories)}")

        return AggregatedDetectionResult(
            overall_risk_level=overall_risk_level,
            matched_scanners=matched_scanners,
            compliance_categories=compliance_categories,
            security_categories=security_categories,
            detection_scope=detection_scope,
            sliding_window_count=sliding_window_count,
            matched_window_indices=matched_window_indices
        )


# ---------------------------------------------------------------------------
# Phase 3 — async sibling.
#
# `ScannerDetectionService` only touches `self.db` once: in `__init__` to
# construct `ScannerConfigService(db)`. The DB call itself happens inside
# `execute_detection` line ~283 (`self.scanner_config_service.get_application_scanners`).
# Everything else — regex matching, keyword search, the model API call,
# the sliding-window helpers, and result aggregation — is pure compute or
# external HTTP, with no session dependency.
#
# So `AsyncScannerDetectionService` only overrides those two entry points
# and inherits every helper unchanged. This keeps the detection logic
# single-sourced — bug fixes to regex/keyword scanning land in one place.
# ---------------------------------------------------------------------------


class AsyncScannerDetectionService(ScannerDetectionService):
    """Async variant of ScannerDetectionService.

    Construction binds to an `AsyncSession` and uses `AsyncScannerConfigService`
    for the one DB lookup the detection chain needs. All other behaviour
    is inherited verbatim from the sync class — those helpers don't touch
    the session.
    """

    def __init__(self, db: AsyncSession):
        # Intentionally do NOT call `super().__init__(db)` — the parent
        # constructor would build a sync `ScannerConfigService` against
        # an `AsyncSession`, which would explode the first time any
        # method tries `self.db.query(...)`. We replicate the parent's
        # field assignments with the async equivalents.
        self.db = db
        self.scanner_config_service = AsyncScannerConfigService(db)

    async def execute_detection(
        self,
        content: str,
        application_id: UUID,
        tenant_id: str,
        scan_type: str = 'prompt',
        messages_for_genai: Optional[List[Dict]] = None,
    ) -> AggregatedDetectionResult:
        """Async execute_detection — same flow as the sync version, but the
        scanner-config lookup is awaited."""
        logger.info(f"Executing scanner detection for app {application_id}, scan_type={scan_type}")

        # 1. Pull only enabled scanners — async DB call.
        all_scanners = await self.scanner_config_service.get_application_scanners(
            application_id=application_id,
            tenant_id=UUID(tenant_id),
            include_disabled=False,
        )

        # Filter by scan type (pure Python, identical to sync version).
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
                security_categories=[],
            )

        logger.info(f"Found {len(scanners_for_scan_type)} enabled scanners")

        # 2. Group by scanner type.
        genai_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'genai']
        regex_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'regex']
        keyword_scanners = [s for s in scanners_for_scan_type if s['scanner_type'] == 'keyword']

        logger.info(f"Scanner types: GenAI={len(genai_scanners)}, Regex={len(regex_scanners)}, Keyword={len(keyword_scanners)}")

        # 3. Execute each group. None of these helpers touch self.db — they
        # call out to model_service (httpx), or compile regex / scan strings
        # in pure Python. They're inherited from the sync parent unchanged.
        all_results: List[ScannerDetectionResult] = []
        detection_scope = "all"
        sliding_window_count = None
        matched_window_indices = None

        if genai_scanners:
            genai_results, scope_info = await self._execute_genai_scanners(
                genai_scanners, content, messages_for_genai
            )
            all_results.extend(genai_results)
            detection_scope = scope_info.get("scope", "all")
            sliding_window_count = scope_info.get("window_count")
            matched_window_indices = scope_info.get("matched_indices")

        if regex_scanners:
            regex_results = self._execute_regex_scanners(regex_scanners, content)
            all_results.extend(regex_results)

        if keyword_scanners:
            keyword_results = self._execute_keyword_scanners(keyword_scanners, content)
            all_results.extend(keyword_results)

        # 4. Aggregate (pure compute).
        return self._aggregate_results(
            all_results,
            detection_scope=detection_scope,
            sliding_window_count=sliding_window_count,
            matched_window_indices=matched_window_indices,
        )
