import os
import json
import logging
from datetime import datetime
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Depends, Request
from pydantic import BaseModel
from dotenv import load_dotenv
from anthropic import AsyncAnthropic
from prometheus_fastapi_instrumentator import Instrumentator
import asyncpg

from database import get_db_pool

# Load environment variables
load_dotenv()

# Setup logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger("ai_service")

# Initialize app
app = FastAPI(title="AI Recommendation Service")

Instrumentator().instrument(app).expose(app)

# Initialize Anthropic client
anthropic_client = AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# DB Pool global reference
db_pool = None

@app.on_event("startup")
async def startup_event():
    global db_pool
    db_pool = await get_db_pool()
    logger.info("AI Recommendation Service started")

@app.on_event("shutdown")
async def shutdown_event():
    if db_pool:
        await db_pool.close()
        logger.info("Database pool closed")

# Pydantic models
class EmbeddingRequest(BaseModel):
    product_id: str
    text: str

class RecommendationResponse(BaseModel):
    products: List[Dict[str, Any]]
    explanation: str

class HealthResponse(BaseModel):
    status: str
    service: str
    timestamp: str

# Helper functions
async def generate_mock_embedding(text: str) -> List[float]:
    # In a real app, you would call OpenAI text-embedding-3-small or similar
    # For portfolio demo purposes without requiring a paid API key for embeddings, 
    # we generate a pseudo-random deterministic embedding based on the text hash
    import hashlib
    hash_val = int(hashlib.md5(text.encode()).hexdigest(), 16)
    
    # 1536 dimensions (OpenAI standard)
    import random
    random.seed(hash_val)
    embedding = [random.uniform(-1, 1) for _ in range(1536)]
    
    # Normalize
    magnitude = sum(x**2 for x in embedding) ** 0.5
    return [x / magnitude for x in embedding]

async def ask_claude_for_explanation(source_product: dict, similar_products: list) -> str:
    if not os.getenv("ANTHROPIC_API_KEY"):
        return "Because you viewed " + source_product.get("name", "this product") + ", we thought you might like these similar items based on their features and category."

    try:
        source_name = source_product.get("name", "Unknown Product")
        source_desc = source_product.get("description", "")
        
        similar_items_text = "\n".join([f"- {p.get('name')}: {p.get('description', '')}" for p in similar_products])
        
        prompt = f"""
        A customer is looking at this product:
        Name: {source_name}
        Description: {source_desc}
        
        Based on our similarity engine, we are recommending these products to them:
        {similar_items_text}
        
        Write a short, engaging 2-sentence explanation for the customer about why we are recommending these specific products based on what they are currently viewing. 
        Adopt the persona of a helpful, premium e-commerce personal shopper.
        Do not use words like "similarity engine" or "algorithm". Keep it natural.
        """

        message = await anthropic_client.messages.create(
            max_tokens=150,
            messages=[
                {
                    "role": "user",
                    "content": prompt,
                }
            ],
            model="claude-3-sonnet-20240229",
        )
        
        return message.content[0].text
    except Exception as e:
        logger.error(f"Claude API error: {e}")
        return f"We recommend these items because they share similar features with {source_product.get('name', 'what you are viewing')}."

# Routes
@app.get("/health", response_model=HealthResponse)
async def health_check():
    return {
        "status": "ok",
        "service": "ai-recommendation-service",
        "timestamp": datetime.utcnow().isoformat()
    }

@app.get("/recommendations/{product_id}", response_model=RecommendationResponse)
async def get_recommendations(product_id: str, limit: int = 4):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not ready")
        
    try:
        async with db_pool.acquire() as conn:
            # 1. Fetch source product
            source_product = await conn.fetchrow(
                "SELECT id, name, description, embedding FROM products WHERE id = $1", 
                product_id
            )
            
            if not source_product:
                raise HTTPException(status_code=404, detail="Product not found")
                
            # If no embedding yet, generate it on the fly
            embedding = source_product['embedding']
            if embedding is None:
                text_to_embed = f"{source_product['name']} {source_product['description'] or ''}"
                embedding_list = await generate_mock_embedding(text_to_embed)
                # Note: asyncpg vector requires list/array, not string
                await conn.execute(
                    "UPDATE products SET embedding = $1 WHERE id = $2",
                    embedding_list, product_id
                )
                embedding = embedding_list

            # 2. Find similar products using pgvector cosine distance (<=>)
            # Order by distance ascending (closest first)
            similar_rows = await conn.fetch(
                """
                SELECT id, name, description, price, image_url, 
                       1 - (embedding <=> $1) AS similarity_score
                FROM products 
                WHERE id != $2 AND is_active = true AND embedding IS NOT NULL
                ORDER BY embedding <=> $1
                LIMIT $3
                """,
                embedding, product_id, limit
            )
            
            similar_products = [dict(row) for row in similar_rows]
            
            # Ensure price is float, not Decimal for JSON serialization
            for p in similar_products:
                if 'price' in p and p['price'] is not None:
                    p['price'] = float(p['price'])
            
            if not similar_products:
                return {"products": [], "explanation": "No similar products found at this time."}
                
            # 3. Get explanation from Claude
            explanation = await ask_claude_for_explanation(dict(source_product), similar_products)
            
            return {
                "products": similar_products,
                "explanation": explanation
            }
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating recommendations: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/embeddings/generate")
async def generate_embedding(req: EmbeddingRequest):
    if not db_pool:
        raise HTTPException(status_code=503, detail="Database not ready")
        
    try:
        embedding_list = await generate_mock_embedding(req.text)
        
        async with db_pool.acquire() as conn:
            # Check if product exists
            exists = await conn.fetchval("SELECT 1 FROM products WHERE id = $1", req.product_id)
            if not exists:
                raise HTTPException(status_code=404, detail="Product not found")
                
            await conn.execute(
                "UPDATE products SET embedding = $1 WHERE id = $2",
                embedding_list, req.product_id
            )
            
        return {"status": "success", "message": "Embedding generated and stored"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating embedding: {e}")
        raise HTTPException(status_code=500, detail=str(e))
