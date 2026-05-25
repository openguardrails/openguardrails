import socket
import ssl
import json
import logging
from typing import Dict, Any, Optional, List
from datetime import datetime, timezone
from config import settings
from utils.logger import get_logger

logger = get_logger(__name__)

# Syslog facility codes
FACILITY_MAP = {
    "KERN": 0, "USER": 1, "MAIL": 2, "DAEMON": 3,
    "AUTH": 4, "SYSLOG": 5, "LPR": 6, "NEWS": 7,
    "UUCP": 8, "CRON": 9, "AUTHPRIV": 10, "FTP": 11,
    "LOCAL0": 16, "LOCAL1": 17, "LOCAL2": 18, "LOCAL3": 19,
    "LOCAL4": 20, "LOCAL5": 21, "LOCAL6": 22, "LOCAL7": 23,
}

# Risk level to CEF severity
SEVERITY_MAP = {
    "no_risk": 0,
    "low": 3,
    "medium": 6,
    "high": 9,
}


def _escape_cef_value(value: str) -> str:
    """Escape special characters in CEF extension values."""
    if not value:
        return ""
    return value.replace("\\", "\\\\").replace("=", "\\=").replace("\n", "\\n").replace("\r", "\\r")


def _list_to_csv(items: Optional[List]) -> str:
    """Convert a list to a comma-separated string."""
    if not items:
        return ""
    return ",".join(str(i) for i in items)


def _get_overall_severity(data: Dict[str, Any]) -> int:
    """Get the highest CEF severity from all risk dimensions."""
    levels = [
        data.get("security_risk_level") or "no_risk",
        data.get("compliance_risk_level") or "no_risk",
        data.get("data_risk_level") or "no_risk",
    ]
    model_response = data.get("model_response") or ""
    if model_response.startswith("error:"):
        return 5
    return max(SEVERITY_MAP.get(level, 0) for level in levels)


def format_as_cef(data: Dict[str, Any]) -> str:
    """Format a detection event dict as a CEF syslog message."""
    version = getattr(settings, "app_version", "1.0.0")
    severity = _get_overall_severity(data)

    # Build extension key=value pairs
    ext_parts = []

    def add(key: str, value, label: str = None):
        if value is None:
            value = ""
        ext_parts.append(f"{key}={_escape_cef_value(str(value))}")
        if label:
            ext_parts.append(f"{key}Label={_escape_cef_value(label)}")

    add("externalId", data.get("request_id"))

    # Convert ISO timestamp to epoch milliseconds
    created_at = data.get("created_at", "")
    try:
        dt = datetime.fromisoformat(created_at)
        epoch_ms = int(dt.timestamp() * 1000)
    except (ValueError, TypeError):
        epoch_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    add("rt", epoch_ms)

    add("src", data.get("ip_address"))
    add("duid", data.get("tenant_id"))
    add("cs1", data.get("application_id"), "ApplicationId")
    add("cs17", data.get("workspace_id"), "WorkspaceId")
    add("suid", data.get("user_id"))  # Source user ID (end user)
    add("act", data.get("suggest_action"))
    add("requestClientApplication", data.get("user_agent"))

    add("cs2", data.get("security_risk_level"), "SecurityRiskLevel")
    add("cs3", _list_to_csv(data.get("security_categories")), "SecurityCategories")
    add("cs4", data.get("compliance_risk_level"), "ComplianceRiskLevel")
    add("cs5", _list_to_csv(data.get("compliance_categories")), "ComplianceCategories")
    add("cs6", data.get("data_risk_level"), "DataRiskLevel")
    add("cs7", _list_to_csv(data.get("data_categories")), "DataCategories")

    score = data.get("sensitivity_score")
    add("cn1", score if score is not None else "", "SensitivityScore")

    add("cs8", _list_to_csv(data.get("matched_scanner_tags")), "MatchedScannerTags")
    add("cs9", _list_to_csv(data.get("hit_keywords")) if data.get("hit_keywords") else "", "HitKeywords")

    # Truncate content to 1024 chars for syslog
    content = data.get("content", "") or ""
    if len(content) > 1024:
        content = content[:1021] + "..."
    add("msg", content)

    add("cn2", data.get("image_count", 0), "ImageCount")
    add("cs10", data.get("source", ""), "DetectionSource")

    # Doublecheck fields (v5.4.19+)
    add("cs11", data.get("doublecheck_result", ""), "DoublecheckResult")
    add("cs12", _list_to_csv(data.get("doublecheck_categories")), "DoublecheckCategories")

    # Model response and suggest answer
    model_resp = data.get("model_response", "") or ""
    if len(model_resp) > 512:
        model_resp = model_resp[:509] + "..."
    add("cs13", model_resp, "ModelResponse")

    suggest_answer = data.get("suggest_answer", "") or ""
    if len(suggest_answer) > 512:
        suggest_answer = suggest_answer[:509] + "..."
    add("cs14", suggest_answer, "SuggestAnswer")

    # Image flag
    add("cn3", 1 if data.get("has_image") else 0, "HasImage")

    # Detection replay fields (v5.4.22+)
    add("cs15", data.get("detection_scope", ""), "DetectionScope")
    add("cn4", data.get("sliding_window_count") or 0, "SlidingWindowCount")
    add("cs16", _list_to_csv(data.get("matched_window_indices")), "MatchedWindowIndices")

    extensions = " ".join(ext_parts)
    return f"CEF:0|OpenGuardrails|AI-Safety-Platform|{version}|detection|AI Content Detection|{severity}|{extensions}"


def format_as_json(data: Dict[str, Any]) -> str:
    """Format a detection event dict as a JSON syslog message."""
    version = getattr(settings, "app_version", "1.0.0")
    severity = _get_overall_severity(data)

    content = data.get("content", "") or ""
    if len(content) > 1024:
        content = content[:1021] + "..."

    model_resp = data.get("model_response", "") or ""
    if len(model_resp) > 512:
        model_resp = model_resp[:509] + "..."

    suggest_answer = data.get("suggest_answer", "") or ""
    if len(suggest_answer) > 512:
        suggest_answer = suggest_answer[:509] + "..."

    event = {
        "timestamp": data.get("created_at", datetime.now(timezone.utc).isoformat()),
        "version": version,
        "event_type": "detection",
        "severity": severity,
        "request_id": data.get("request_id"),
        "ip_address": data.get("ip_address"),
        "tenant_id": data.get("tenant_id"),
        "application_id": data.get("application_id"),
        "workspace_id": data.get("workspace_id"),
        "user_id": data.get("user_id"),
        "action": data.get("suggest_action"),
        "user_agent": data.get("user_agent"),
        "security_risk_level": data.get("security_risk_level", "no_risk"),
        "security_categories": data.get("security_categories") or [],
        "compliance_risk_level": data.get("compliance_risk_level", "no_risk"),
        "compliance_categories": data.get("compliance_categories") or [],
        "data_risk_level": data.get("data_risk_level", "no_risk"),
        "data_categories": data.get("data_categories") or [],
        "sensitivity_score": data.get("sensitivity_score"),
        "matched_scanner_tags": data.get("matched_scanner_tags") or [],
        "hit_keywords": data.get("hit_keywords") or [],
        "content": content,
        "has_image": bool(data.get("has_image")),
        "image_count": data.get("image_count", 0),
        "source": data.get("source", ""),
        "model_response": model_resp,
        "suggest_answer": suggest_answer,
        "doublecheck_result": data.get("doublecheck_result"),
        "doublecheck_categories": data.get("doublecheck_categories") or [],
        "doublecheck_reasoning": data.get("doublecheck_reasoning"),
        # Detection replay fields (v5.4.22+)
        "detection_scope": data.get("detection_scope"),
        "sliding_window_count": data.get("sliding_window_count"),
        "matched_window_indices": data.get("matched_window_indices") or [],
    }

    return json.dumps(event, ensure_ascii=False, separators=(",", ":"))


class SyslogForwarder:
    """Forwards detection events to a remote syslog server via UDP, TCP, or TLS."""

    def __init__(self):
        self._enabled = bool(settings.syslog_host)
        self._sock: Optional[socket.socket] = None
        self._ssl_sock: Optional[ssl.SSLSocket] = None
        self._connected = False

        if self._enabled:
            self._host = settings.syslog_host
            self._port = settings.syslog_port
            self._protocol = settings.syslog_protocol.upper()
            self._facility = FACILITY_MAP.get(settings.syslog_facility.upper(), 16)
            self._ca_cert = settings.syslog_ca_cert or None
            self._format = settings.syslog_format.lower()  # cef | json
            logger.info(
                f"Syslog forwarder enabled: {self._protocol}://{self._host}:{self._port} "
                f"facility={settings.syslog_facility} format={self._format}"
            )
        else:
            logger.debug("Syslog forwarder disabled (SYSLOG_HOST not set)")

    @property
    def enabled(self) -> bool:
        return self._enabled

    def _connect(self):
        """Establish socket connection (TCP/TLS only)."""
        if self._protocol == "UDP":
            self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self._connected = True
            return

        # TCP or TLS
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(5)
        try:
            if self._protocol == "TLS":
                ctx = ssl.create_default_context()
                if self._ca_cert:
                    ctx.load_verify_locations(self._ca_cert)
                self._ssl_sock = ctx.wrap_socket(sock, server_hostname=self._host)
                self._ssl_sock.connect((self._host, self._port))
            else:
                sock.connect((self._host, self._port))
                self._sock = sock
            self._connected = True
        except Exception as e:
            logger.error(f"Syslog connection failed: {e}")
            self._connected = False
            try:
                sock.close()
            except Exception:
                pass

    def _ensure_connected(self):
        if not self._connected:
            self._connect()

    def send(self, data: Dict[str, Any]):
        """Format and send a detection event via syslog. Non-blocking best-effort."""
        if not self._enabled:
            return

        try:
            self._ensure_connected()
            if not self._connected:
                return

            if self._format == "json":
                formatted_msg = format_as_json(data)
            else:
                formatted_msg = format_as_cef(data)

            # Wrap in syslog priority header: <facility*8 + severity>
            event_severity = _get_overall_severity(data)
            # Map severity (0-10) to syslog severity (0-7)
            if event_severity >= 9:
                syslog_severity = 2  # critical
            elif event_severity >= 6:
                syslog_severity = 4  # warning
            elif event_severity >= 3:
                syslog_severity = 5  # notice
            else:
                syslog_severity = 6  # informational

            priority = self._facility * 8 + syslog_severity
            syslog_msg = f"<{priority}>{formatted_msg}"
            payload = syslog_msg.encode("utf-8")

            if self._protocol == "UDP":
                self._sock.sendto(payload, (self._host, self._port))
            elif self._protocol == "TLS" and self._ssl_sock:
                self._ssl_sock.sendall(payload + b"\n")
            elif self._sock:
                self._sock.sendall(payload + b"\n")

        except (ConnectionError, OSError, BrokenPipeError) as e:
            logger.warning(f"Syslog send failed, will reconnect: {e}")
            self._close()
            self._connected = False
        except Exception as e:
            logger.error(f"Syslog send error: {e}")

    def _close(self):
        """Close socket connections."""
        for s in (self._ssl_sock, self._sock):
            if s:
                try:
                    s.close()
                except Exception:
                    pass
        self._sock = None
        self._ssl_sock = None
        self._connected = False

    def close(self):
        """Public close for shutdown."""
        self._close()
        logger.info("Syslog forwarder closed")


# Global singleton
syslog_forwarder = SyslogForwarder()
