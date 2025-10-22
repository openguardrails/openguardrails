"""
Replace Knowledge Base Service
Use FAISS for vector search, support vectorized storage and retrieval of Q&A pairs
Use OpenAI API for vectorization instead of local model
"""
import os
import json
import pickle
import logging
import uuid
from typing import List, Optional, Dict, Tuple, Any
from pathlib import Path

import faiss
import numpy as np
from openai import OpenAI
from sqlalchemy.orm import Session

from database.models import KnowledgeBase, Tenant
from config import settings

logger = logging.getLogger(__name__)

class KnowledgeBaseService:
    def __init__(self):
        self.client = None
        self.vector_dimension = settings.embedding_model_dimension  # Embedding vector dimension
        self.similarity_threshold = settings.embedding_similarity_threshold  # Similarity threshold
        self.max_results = settings.embedding_max_results  # Maximum return results

        # Set storage path
        self.storage_path = Path(settings.data_dir) / "knowledge_bases"
        self.storage_path.mkdir(parents=True, exist_ok=True)

    def _get_client(self) -> OpenAI:
        """Lazy load OpenAI client"""
        if self.client is None:
            try:
                self.client = OpenAI(
                    api_key=settings.embedding_api_key,
                    base_url=settings.embedding_api_base_url,
                )
                logger.info(f"OpenAI embedding client initialized with base_url: {settings.embedding_api_base_url}")
            except Exception as e:
                logger.error(f"Failed to initialize OpenAI embedding client: {e}")
                raise
        return self.client

    def _get_embeddings(self, texts: List[str]) -> List[List[float]]:
        """Get text embeddings (process one by one to avoid server OOM)"""
        if not texts:
            return []
            
        try:
            client = self._get_client()
            all_embeddings = []
            
            logger.info(f"Processing {len(texts)} texts one by one to avoid server OOM")
            
            for i, text in enumerate(texts):
                logger.info(f"Processing text {i+1}/{len(texts)}")
                
                response = client.embeddings.create(
                    input=[text],  # Process one by one
                    model=settings.embedding_model_name
                )
                
                embedding = response.data[0].embedding
                all_embeddings.append(embedding)
                
                if (i + 1) % 10 == 0:  # Record progress every 10
                    logger.info(f"Completed {i+1}/{len(texts)} texts")
            
            logger.info(f"Generated embeddings for all {len(texts)} texts")
            return all_embeddings
            
        except Exception as e:
            logger.error(f"Failed to get embeddings: {e}")
            raise

    def parse_jsonl_file(self, file_content: bytes) -> List[Dict[str, str]]:
        """
        Parse JSONL file content
        Args:
            file_content: File content
        Returns:
            Q&A pairs list
        """
        qa_pairs = []
        try:
            content_str = file_content.decode('utf-8')
            lines = content_str.strip().split('\n')

            for line_num, line in enumerate(lines, 1):
                if not line.strip():
                    continue

                try:
                    qa_data = json.loads(line)

                    # Validate required fields
                    if not all(key in qa_data for key in ['questionid', 'question', 'answer']):
                        logger.warning(f"Line {line_num}: Missing required fields (questionid, question, answer)")
                        continue

                    # Validate field types
                    if not all(isinstance(qa_data[key], str) for key in ['questionid', 'question', 'answer']):
                        logger.warning(f"Line {line_num}: All fields must be strings")
                        continue

                    # Validate content is not empty
                    if not qa_data['question'].strip() or not qa_data['answer'].strip():
                        logger.warning(f"Line {line_num}: Question and answer cannot be empty")
                        continue

                    qa_pairs.append({
                        'questionid': qa_data['questionid'].strip(),
                        'question': qa_data['question'].strip(),
                        'answer': qa_data['answer'].strip()
                    })

                except json.JSONDecodeError as e:
                    logger.warning(f"Line {line_num}: Invalid JSON format - {e}")
                    continue

        except UnicodeDecodeError as e:
            raise ValueError(f"File encoding error: {e}")

        if not qa_pairs:
            raise ValueError("No valid QA pairs found in the file")

        logger.info(f"Parsed {len(qa_pairs)} QA pairs from JSONL file")
        return qa_pairs

    def create_vector_index(self, qa_pairs: List[Dict[str, str]], knowledge_base_id: int) -> str:
        """
        Create FAISS vector index
        Args:
            qa_pairs: Q&A pairs list
            knowledge_base_id: Knowledge base ID
        Returns:
            Vector file path
        """
        try:
            # Extract questions
            questions = [qa['question'] for qa in qa_pairs]

            # Generate embeddings
            logger.info(f"Generating embeddings for {len(questions)} questions...")
            embeddings = self._get_embeddings(questions)
            vectors = np.array(embeddings, dtype=np.float32)

            # Create FAISS index
            index = faiss.IndexFlatIP(self.vector_dimension)  # 使用内积相似度

            # Normalize vectors (for cosine similarity)
            faiss.normalize_L2(vectors)

            # Add vectors to index
            index.add(vectors)

            # Save index and metadata
            vector_file_path = self.storage_path / f"kb_{knowledge_base_id}_vectors.pkl"

            vector_data = {
                'index': faiss.serialize_index(index),
                'qa_pairs': qa_pairs,
                'vector_dimension': self.vector_dimension,
                'total_pairs': len(qa_pairs)
            }

            with open(vector_file_path, 'wb') as f:
                pickle.dump(vector_data, f)

            logger.info(f"Vector index created successfully: {vector_file_path}")
            return str(vector_file_path)

        except Exception as e:
            logger.error(f"Failed to create vector index: {e}")
            raise

    def search_similar_questions(self, query: str, knowledge_base_id: int, top_k: Optional[int] = None) -> List[Dict[str, Any]]:
        """
        Search similar questions
        Args:
            query: Query question
            knowledge_base_id: Knowledge base ID
            top_k: Return results number
        Returns:
            Similar questions list, containing question, answer and similarity score
        """
        if top_k is None:
            top_k = self.max_results

        try:
            vector_file_path = self.storage_path / f"kb_{knowledge_base_id}_vectors.pkl"

            if not vector_file_path.exists():
                logger.warning(f"Vector file not found: {vector_file_path}")
                return []

            # Load vector data
            with open(vector_file_path, 'rb') as f:
                vector_data = pickle.load(f)

            # Deserialize FAISS index
            index = faiss.deserialize_index(vector_data['index'])
            qa_pairs = vector_data['qa_pairs']

            # Vectorize query
            query_embeddings = self._get_embeddings([query])
            query_vector = np.array(query_embeddings, dtype=np.float32)
            faiss.normalize_L2(query_vector)

            # Search similar vectors
            scores, indices = index.search(query_vector, min(top_k, len(qa_pairs)))

            results = []
            for i, (score, idx) in enumerate(zip(scores[0], indices[0])):
                if idx >= 0 and score >= self.similarity_threshold:
                    qa_pair = qa_pairs[idx]
                    results.append({
                        'questionid': qa_pair['questionid'],
                        'question': qa_pair['question'],
                        'answer': qa_pair['answer'],
                        'similarity_score': float(score),
                        'rank': i + 1
                    })

            logger.info(f"Found {len(results)} similar questions for query: {query[:50]}...")
            return results

        except Exception as e:
            logger.error(f"Failed to search similar questions: {e}")
            return []

    def save_original_file(self, file_content: bytes, knowledge_base_id: int, original_filename: str = None) -> str:
        """
        Save original JSONL file
        Args:
            file_content: File content
            knowledge_base_id: Knowledge base ID
            original_filename: Original file name (optional)
        Returns:
            File path
        """
        # If original file name is provided, use it; otherwise use default naming
        if original_filename:
            file_path = self.storage_path / f"kb_{knowledge_base_id}_{original_filename}"
        else:
            file_path = self.storage_path / f"kb_{knowledge_base_id}_original.jsonl"

        with open(file_path, 'wb') as f:
            f.write(file_content)

        logger.info(f"Original file saved: {file_path}")
        return str(file_path)

    def delete_knowledge_base_files(self, knowledge_base_id: int) -> None:
        """
        Delete knowledge base related files
        Args:
            knowledge_base_id: Knowledge base ID
        """
        try:
            # Delete all matching original files (support new and old naming formats)
            import glob
            pattern = str(self.storage_path / f"kb_{knowledge_base_id}_*.jsonl")
            original_files = glob.glob(pattern)
            for file_path in original_files:
                os.unlink(file_path)
                logger.info(f"Deleted original file: {file_path}")
            
            # If no new format file is found, try to delete old format file
            if not original_files:
                original_file = self.storage_path / f"kb_{knowledge_base_id}_original.jsonl"
                if original_file.exists():
                    original_file.unlink()
                    logger.info(f"Deleted original file: {original_file}")

            # Delete vector file
            vector_file = self.storage_path / f"kb_{knowledge_base_id}_vectors.pkl"
            if vector_file.exists():
                vector_file.unlink()
                logger.info(f"Deleted vector file: {vector_file}")

        except Exception as e:
            logger.error(f"Failed to delete knowledge base files: {e}")
            raise

    def get_file_info(self, knowledge_base_id: int) -> Dict[str, Any]:
        """
        Get knowledge base file information
        Args:
            knowledge_base_id: Knowledge base ID
        Returns:
            File information dictionary
        """
        info = {
            'original_file_exists': False,
            'vector_file_exists': False,
            'original_file_size': 0,
            'vector_file_size': 0,
            'total_qa_pairs': 0
        }

        try:
            # Check original file (support new and old naming formats)
            import glob
            pattern = str(self.storage_path / f"kb_{knowledge_base_id}_*.jsonl")
            original_files = glob.glob(pattern)
            
            if original_files:
                # Use the first found file
                original_file = Path(original_files[0])
                info['original_file_exists'] = True
                info['original_file_size'] = original_file.stat().st_size
            else:
                # Try old format
                original_file = self.storage_path / f"kb_{knowledge_base_id}_original.jsonl"
                if original_file.exists():
                    info['original_file_exists'] = True
                    info['original_file_size'] = original_file.stat().st_size

            # Check vector file
            vector_file = self.storage_path / f"kb_{knowledge_base_id}_vectors.pkl"
            if vector_file.exists():
                info['vector_file_exists'] = True
                info['vector_file_size'] = vector_file.stat().st_size

                # Get Q&A pairs number
                with open(vector_file, 'rb') as f:
                    vector_data = pickle.load(f)
                    info['total_qa_pairs'] = vector_data.get('total_pairs', 0)

        except Exception as e:
            logger.error(f"Failed to get file info: {e}")

        return info

# Global instance
knowledge_base_service = KnowledgeBaseService()