"""
Content Segmentation Service

Intelligently segments content based on format to optimize GenAI detection.
- JSON: Segments by objects/arrays while maintaining valid JSON structure
- CSV: Segments by row batches with headers
- Markdown: Segments by sections (headers)
- YAML: Segments like JSON after parsing
- Plain Text: Segments by paragraphs
"""

import json
import re
import csv
from typing import List, Dict, Any
from dataclasses import dataclass
from io import StringIO


@dataclass
class ContentSegment:
    """Represents a segment of content with metadata"""
    content: str  # Segment content
    segment_index: int  # Index of this segment (0-based)
    original_start: int  # Start position in original text
    original_end: int  # End position in original text
    metadata: Dict[str, Any]  # Format-specific metadata


class SegmentationService:
    """Service for intelligently segmenting content by format"""

    # Configuration
    DEFAULT_MAX_SEGMENT_SIZE = 4000  # Characters (fits in most LLM contexts)
    DEFAULT_MIN_SEGMENT_SIZE = 100   # Minimum size to avoid tiny fragments

    def __init__(self, max_segment_size: int = None, min_segment_size: int = None):
        """
        Initialize segmentation service

        Args:
            max_segment_size: Maximum segment size in characters
            min_segment_size: Minimum segment size in characters
        """
        self.max_segment_size = max_segment_size or self.DEFAULT_MAX_SEGMENT_SIZE
        self.min_segment_size = min_segment_size or self.DEFAULT_MIN_SEGMENT_SIZE

    def segment_content(
        self,
        text: str,
        format_type: str,
        format_metadata: Dict[str, Any]
    ) -> List[ContentSegment]:
        """
        Intelligently segment content based on format

        Args:
            text: Content to segment
            format_type: Format type from FormatDetectionService
            format_metadata: Metadata from FormatDetectionService

        Returns:
            List of ContentSegment objects
        """
        if not text or len(text) <= self.max_segment_size:
            # No segmentation needed
            return [ContentSegment(
                content=text,
                segment_index=0,
                original_start=0,
                original_end=len(text),
                metadata={'format': format_type}
            )]

        # Dispatch to format-specific segmentation
        if format_type == 'json':
            return self._segment_json(text, format_metadata)
        elif format_type == 'yaml':
            return self._segment_yaml(text, format_metadata)
        elif format_type == 'csv':
            return self._segment_csv(text, format_metadata)
        elif format_type == 'markdown':
            return self._segment_markdown(text, format_metadata)
        else:  # plain_text
            return self._segment_plain_text(text)

    def _segment_json(self, text: str, metadata: Dict[str, Any]) -> List[ContentSegment]:
        """
        Segment JSON by objects/arrays while maintaining valid JSON

        Strategy:
        - Parse JSON structure
        - If it's an array, segment by elements
        - If it's an object, segment by top-level keys
        - Keep each segment as valid JSON
        """
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            # Fallback to plain text segmentation
            return self._segment_plain_text(text)

        segments = []

        if isinstance(data, list):
            # Segment array by grouping elements
            segments = self._segment_json_array(data, text)
        elif isinstance(data, dict):
            # Segment object by keys
            segments = self._segment_json_object(data, text)
        else:
            # Single primitive value - no segmentation
            return [ContentSegment(
                content=text,
                segment_index=0,
                original_start=0,
                original_end=len(text),
                metadata={'format': 'json', 'type': 'primitive'}
            )]

        return segments

    def _segment_json_array(self, data: List, original_text: str) -> List[ContentSegment]:
        """Segment JSON array by grouping elements"""
        segments = []
        current_batch = []
        current_size = 2  # Start with "[]"
        segment_index = 0
        char_offset = 0

        for item in data:
            item_json = json.dumps(item, ensure_ascii=False)
            item_size = len(item_json) + 1  # +1 for comma

            # Check if adding this item would exceed max size
            if current_size + item_size > self.max_segment_size and current_batch:
                # Save current batch as segment
                batch_json = json.dumps(current_batch, ensure_ascii=False, indent=2)
                segments.append(ContentSegment(
                    content=batch_json,
                    segment_index=segment_index,
                    original_start=char_offset,
                    original_end=char_offset + len(batch_json),
                    metadata={'format': 'json', 'type': 'array', 'element_count': len(current_batch)}
                ))
                char_offset += len(batch_json)
                segment_index += 1
                current_batch = []
                current_size = 2

            current_batch.append(item)
            current_size += item_size

        # Add remaining items
        if current_batch:
            batch_json = json.dumps(current_batch, ensure_ascii=False, indent=2)
            segments.append(ContentSegment(
                content=batch_json,
                segment_index=segment_index,
                original_start=char_offset,
                original_end=char_offset + len(batch_json),
                metadata={'format': 'json', 'type': 'array', 'element_count': len(current_batch)}
            ))

        return segments

    def _segment_json_object(self, data: Dict, original_text: str) -> List[ContentSegment]:
        """Segment JSON object by grouping keys"""
        segments = []
        current_obj = {}
        current_size = 2  # Start with "{}"
        segment_index = 0
        char_offset = 0

        for key, value in data.items():
            # Estimate size of this key-value pair
            pair_json = json.dumps({key: value}, ensure_ascii=False)
            pair_size = len(pair_json) - 2  # Subtract the {}

            # Check if adding this pair would exceed max size
            if current_size + pair_size > self.max_segment_size and current_obj:
                # Save current object as segment
                obj_json = json.dumps(current_obj, ensure_ascii=False, indent=2)
                segments.append(ContentSegment(
                    content=obj_json,
                    segment_index=segment_index,
                    original_start=char_offset,
                    original_end=char_offset + len(obj_json),
                    metadata={'format': 'json', 'type': 'object', 'key_count': len(current_obj)}
                ))
                char_offset += len(obj_json)
                segment_index += 1
                current_obj = {}
                current_size = 2

            current_obj[key] = value
            current_size += pair_size

        # Add remaining pairs
        if current_obj:
            obj_json = json.dumps(current_obj, ensure_ascii=False, indent=2)
            segments.append(ContentSegment(
                content=obj_json,
                segment_index=segment_index,
                original_start=char_offset,
                original_end=char_offset + len(obj_json),
                metadata={'format': 'json', 'type': 'object', 'key_count': len(current_obj)}
            ))

        return segments

    def _segment_yaml(self, text: str, metadata: Dict[str, Any]) -> List[ContentSegment]:
        """Segment YAML (similar to JSON after parsing)"""
        try:
            import yaml
            data = yaml.safe_load(text)
            # Convert to JSON and use JSON segmentation
            json_text = json.dumps(data, ensure_ascii=False, indent=2)
            return self._segment_json(json_text, metadata)
        except:
            # Fallback to plain text
            return self._segment_plain_text(text)

    def _segment_csv(self, text: str, metadata: Dict[str, Any]) -> List[ContentSegment]:
        """
        Segment CSV by row batches, always including headers

        Strategy:
        - Each segment gets the header row + batch of data rows
        - Maintains CSV validity
        """
        try:
            reader = csv.reader(StringIO(text))
            rows = list(reader)

            if len(rows) < 2:  # Need at least header + 1 row
                return [ContentSegment(
                    content=text,
                    segment_index=0,
                    original_start=0,
                    original_end=len(text),
                    metadata={'format': 'csv'}
                )]

            headers = rows[0]
            data_rows = rows[1:]
            header_line = ','.join([f'"{h}"' if ',' in h else h for h in headers])
            header_size = len(header_line) + 1  # +1 for newline

            segments = []
            segment_index = 0
            current_batch = []
            current_size = header_size
            char_offset = 0

            for row in data_rows:
                row_line = ','.join([f'"{c}"' if ',' in c else c for c in row])
                row_size = len(row_line) + 1

                # Check if adding this row would exceed max size
                if current_size + row_size > self.max_segment_size and current_batch:
                    # Save current batch
                    segment_text = header_line + '\n' + '\n'.join(current_batch)
                    segments.append(ContentSegment(
                        content=segment_text,
                        segment_index=segment_index,
                        original_start=char_offset,
                        original_end=char_offset + len(segment_text),
                        metadata={'format': 'csv', 'row_count': len(current_batch)}
                    ))
                    char_offset += len(segment_text)
                    segment_index += 1
                    current_batch = []
                    current_size = header_size

                current_batch.append(row_line)
                current_size += row_size

            # Add remaining rows
            if current_batch:
                segment_text = header_line + '\n' + '\n'.join(current_batch)
                segments.append(ContentSegment(
                    content=segment_text,
                    segment_index=segment_index,
                    original_start=char_offset,
                    original_end=char_offset + len(segment_text),
                    metadata={'format': 'csv', 'row_count': len(current_batch)}
                ))

            return segments

        except:
            # Fallback to plain text
            return self._segment_plain_text(text)

    def _segment_markdown(self, text: str, metadata: Dict[str, Any]) -> List[ContentSegment]:
        """
        Segment Markdown by sections (headers)

        Strategy:
        - Split on header markers (# ## ###)
        - Keep headers with their content
        - Group sections to fit within size limit
        """
        lines = text.split('\n')
        header_pattern = re.compile(r'^(#{1,6})\s+(.+)$')

        # Find all headers and their positions
        sections = []
        current_section = {
            'start_line': 0,
            'header': None,
            'content_lines': []
        }

        for i, line in enumerate(lines):
            match = header_pattern.match(line.strip())
            if match:
                # Save previous section if it has content
                if current_section['content_lines']:
                    sections.append(current_section)

                # Start new section
                current_section = {
                    'start_line': i,
                    'header': line,
                    'content_lines': [line]
                }
            else:
                current_section['content_lines'].append(line)

        # Add last section
        if current_section['content_lines']:
            sections.append(current_section)

        # Group sections into segments
        segments = []
        segment_index = 0
        current_segment_lines = []
        current_size = 0
        char_offset = 0

        for section in sections:
            section_text = '\n'.join(section['content_lines'])
            section_size = len(section_text)

            # Check if adding this section would exceed max size
            if current_size + section_size > self.max_segment_size and current_segment_lines:
                # Save current segment
                segment_text = '\n'.join(current_segment_lines)
                segments.append(ContentSegment(
                    content=segment_text,
                    segment_index=segment_index,
                    original_start=char_offset,
                    original_end=char_offset + len(segment_text),
                    metadata={'format': 'markdown', 'section_count': len(current_segment_lines)}
                ))
                char_offset += len(segment_text)
                segment_index += 1
                current_segment_lines = []
                current_size = 0

            current_segment_lines.extend(section['content_lines'])
            current_size += section_size

        # Add remaining sections
        if current_segment_lines:
            segment_text = '\n'.join(current_segment_lines)
            segments.append(ContentSegment(
                content=segment_text,
                segment_index=segment_index,
                original_start=char_offset,
                original_end=char_offset + len(segment_text),
                metadata={'format': 'markdown', 'section_count': len(current_segment_lines)}
            ))

        return segments if segments else [ContentSegment(
            content=text,
            segment_index=0,
            original_start=0,
            original_end=len(text),
            metadata={'format': 'markdown'}
        )]

    def _segment_plain_text(self, text: str) -> List[ContentSegment]:
        """
        Segment plain text by paragraphs

        Strategy:
        - Split on double newlines (paragraphs)
        - Group paragraphs to fit within size limit
        """
        # Split by double newline (paragraph separator)
        paragraphs = re.split(r'\n\s*\n', text)

        segments = []
        segment_index = 0
        current_segment_paras = []
        current_size = 0
        char_offset = 0

        for para in paragraphs:
            para_size = len(para) + 2  # +2 for paragraph separator

            # Check if adding this paragraph would exceed max size
            if current_size + para_size > self.max_segment_size and current_segment_paras:
                # Save current segment
                segment_text = '\n\n'.join(current_segment_paras)
                segments.append(ContentSegment(
                    content=segment_text,
                    segment_index=segment_index,
                    original_start=char_offset,
                    original_end=char_offset + len(segment_text),
                    metadata={'format': 'plain_text', 'paragraph_count': len(current_segment_paras)}
                ))
                char_offset += len(segment_text)
                segment_index += 1
                current_segment_paras = []
                current_size = 0

            current_segment_paras.append(para)
            current_size += para_size

        # Add remaining paragraphs
        if current_segment_paras:
            segment_text = '\n\n'.join(current_segment_paras)
            segments.append(ContentSegment(
                content=segment_text,
                segment_index=segment_index,
                original_start=char_offset,
                original_end=char_offset + len(segment_text),
                metadata={'format': 'plain_text', 'paragraph_count': len(current_segment_paras)}
            ))

        return segments if segments else [ContentSegment(
            content=text,
            segment_index=0,
            original_start=0,
            original_end=len(text),
            metadata={'format': 'plain_text'}
        )]


# Singleton instance
segmentation_service = SegmentationService()
