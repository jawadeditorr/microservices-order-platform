import os
import asyncpg
from pgvector.asyncpg import register_vector
import logging

logger = logging.getLogger("ai_service")

async def get_db_pool():
    try:
        # We use the product_db since it has the pgvector extension and product data
        db_url = os.getenv("DATABASE_URL", "postgresql://postgres:password@localhost:5433/product_db")
        
        # Parse connection URL or use asyncpg format
        pool = await asyncpg.create_pool(db_url)
        
        # Register pgvector type with asyncpg
        async with pool.acquire() as conn:
            await conn.execute('CREATE EXTENSION IF NOT EXISTS vector;')
            await register_vector(conn)
            
        logger.info("Connected to PostgreSQL and registered pgvector")
        return pool
    except Exception as e:
        logger.error(f"Failed to connect to PostgreSQL: {e}")
        raise e
