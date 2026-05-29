require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const promClient = require('prom-client');
const Redis = require('ioredis');
const { query } = require('./db');
const logger = require('../../shared/logger');
const { authenticate, authorize } = require('../../shared/auth-middleware');

const app = express();
const PORT = process.env.PORT || 3002;

// ─── Redis Client ────────────────────────────────────────────────────────────
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  retryDelayOnFailover: 1000,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('connect', () => logger.info('Connected to Redis'));
redis.on('error', (err) => logger.error('Redis error', { error: err.message }));

// Try to connect, but don't crash if Redis is unavailable
redis.connect().catch((err) => {
  logger.warn('Redis connection failed, caching disabled', { error: err.message });
});

const CACHE_TTL = 300; // 5 minutes

// ─── Prometheus Metrics ──────────────────────────────────────────────────────
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'product_service_' });

const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : req.path;
    end({ method: req.method, route, status_code: res.statusCode });
    httpRequestsTotal.inc({ method: req.method, route, status_code: res.statusCode });
  });
  next();
});

// ─── Helper: Cache wrapper ───────────────────────────────────────────────────
const cacheGet = async (key) => {
  try {
    if (redis.status !== 'ready') return null;
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch (err) {
    logger.warn('Cache get failed', { key, error: err.message });
    return null;
  }
};

const cacheSet = async (key, data, ttl = CACHE_TTL) => {
  try {
    if (redis.status !== 'ready') return;
    await redis.set(key, JSON.stringify(data), 'EX', ttl);
  } catch (err) {
    logger.warn('Cache set failed', { key, error: err.message });
  }
};

const cacheInvalidate = async (pattern) => {
  try {
    if (redis.status !== 'ready') return;
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch (err) {
    logger.warn('Cache invalidation failed', { pattern, error: err.message });
  }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'product-service', timestamp: new Date().toISOString() });
});

// Prometheus metrics
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// ─── GET /products ──────────────────────────────────────────────────────────
app.get('/products', async (req, res, next) => {
  try {
    const {
      search, category, page = 1, limit = 20, sort = 'created_at', order = 'DESC',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    // Check cache
    const cacheKey = `products:list:${search || ''}:${category || ''}:${pageNum}:${limitNum}:${sort}:${order}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const validSorts = ['created_at', 'price', 'name'];
    const validOrders = ['ASC', 'DESC'];
    const sortField = validSorts.includes(sort) ? sort : 'created_at';
    const sortOrder = validOrders.includes(order.toUpperCase()) ? order.toUpperCase() : 'DESC';

    let whereClause = 'WHERE p.is_active = true';
    const params = [];
    let paramIndex = 1;

    if (search) {
      whereClause += ` AND p.search_vector @@ plainto_tsquery('english', $${paramIndex})`;
      params.push(search);
      paramIndex++;
    }

    if (category) {
      whereClause += ` AND c.slug = $${paramIndex}`;
      params.push(category);
      paramIndex++;
    }

    // Count total results
    const countQuery = `
      SELECT COUNT(*) as total
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereClause}
    `;
    const countResult = await query(countQuery, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Fetch products
    const productQuery = `
      SELECT p.id, p.name, p.description, p.price, p.sku, p.image_url,
             p.is_active, p.metadata, p.created_at, p.updated_at,
             c.id as category_id, c.name as category_name, c.slug as category_slug
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      ${whereClause}
      ORDER BY p.${sortField} ${sortOrder}
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `;
    params.push(limitNum, offset);

    const result = await query(productQuery, params);

    const response = {
      products: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        price: parseFloat(row.price),
        sku: row.sku,
        imageUrl: row.image_url,
        isActive: row.is_active,
        metadata: row.metadata,
        category: row.category_id ? {
          id: row.category_id,
          name: row.category_name,
          slug: row.category_slug,
        } : null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };

    await cacheSet(cacheKey, response);
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ─── GET /products/category/:slug ───────────────────────────────────────────
app.get('/products/category/:slug', async (req, res, next) => {
  try {
    const { slug } = req.params;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = `products:category:${slug}:${pageNum}:${limitNum}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // Find category
    const categoryResult = await query('SELECT id, name, slug, description FROM categories WHERE slug = $1', [slug]);
    if (categoryResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Category not found.' });
    }

    const category = categoryResult.rows[0];

    const countResult = await query(
      'SELECT COUNT(*) as total FROM products WHERE category_id = $1 AND is_active = true',
      [category.id],
    );
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT id, name, description, price, sku, image_url, metadata, created_at, updated_at
       FROM products
       WHERE category_id = $1 AND is_active = true
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [category.id, limitNum, offset],
    );

    const response = {
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
      },
      products: result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        price: parseFloat(row.price),
        sku: row.sku,
        imageUrl: row.image_url,
        metadata: row.metadata,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };

    await cacheSet(cacheKey, response);
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ─── GET /products/:id ──────────────────────────────────────────────────────
app.get('/products/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const cacheKey = `products:detail:${id}`;
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const result = await query(
      `SELECT p.id, p.name, p.description, p.price, p.sku, p.image_url,
              p.is_active, p.metadata, p.created_at, p.updated_at,
              c.id as category_id, c.name as category_name, c.slug as category_slug
       FROM products p
       LEFT JOIN categories c ON p.category_id = c.id
       WHERE p.id = $1`,
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Product not found.' });
    }

    const row = result.rows[0];
    const product = {
      id: row.id,
      name: row.name,
      description: row.description,
      price: parseFloat(row.price),
      sku: row.sku,
      imageUrl: row.image_url,
      isActive: row.is_active,
      metadata: row.metadata,
      category: row.category_id ? {
        id: row.category_id,
        name: row.category_name,
        slug: row.category_slug,
      } : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    // Fetch AI recommendations (non-blocking)
    let recommendations = null;
    try {
      const aiUrl = process.env.AI_SERVICE_URL || 'http://localhost:8000';
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      const aiResponse = await fetch(`${aiUrl}/recommendations/${id}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (aiResponse.ok) {
        recommendations = await aiResponse.json();
      }
    } catch (aiError) {
      logger.warn('Failed to fetch AI recommendations', { productId: id, error: aiError.message });
    }

    const response = {
      product,
      recommendations,
    };

    await cacheSet(cacheKey, response, 600); // 10 min cache for detail
    res.json(response);
  } catch (error) {
    next(error);
  }
});

// ─── POST /products (admin only) ────────────────────────────────────────────
app.post('/products', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const {
      name, description, price, sku, categoryId, imageUrl, metadata,
    } = req.body;

    if (!name || !price || !sku) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Name, price, and SKU are required.',
      });
    }

    if (price < 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Price must be a non-negative number.',
      });
    }

    // Check for duplicate SKU
    const existing = await query('SELECT id FROM products WHERE sku = $1', [sku]);
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A product with this SKU already exists.',
      });
    }

    const result = await query(
      `INSERT INTO products (name, description, price, sku, category_id, image_url, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, description, price, sku, category_id, image_url, metadata, created_at, updated_at`,
      [name, description || null, price, sku, categoryId || null, imageUrl || null, metadata || {}],
    );

    const product = result.rows[0];

    // Invalidate cache
    await cacheInvalidate('products:*');

    logger.info('Product created', { productId: product.id, sku });

    res.status(201).json({
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        price: parseFloat(product.price),
        sku: product.sku,
        categoryId: product.category_id,
        imageUrl: product.image_url,
        metadata: product.metadata,
        createdAt: product.created_at,
        updatedAt: product.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /products/:id (admin only) ─────────────────────────────────────────
app.put('/products/:id', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const {
      name, description, price, sku, categoryId, imageUrl, isActive, metadata,
    } = req.body;

    // Check product exists
    const existing = await query('SELECT id FROM products WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Product not found.' });
    }

    // Check SKU uniqueness if updating
    if (sku) {
      const skuCheck = await query('SELECT id FROM products WHERE sku = $1 AND id != $2', [sku, id]);
      if (skuCheck.rows.length > 0) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A product with this SKU already exists.',
        });
      }
    }

    const result = await query(
      `UPDATE products SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        price = COALESCE($3, price),
        sku = COALESCE($4, sku),
        category_id = COALESCE($5, category_id),
        image_url = COALESCE($6, image_url),
        is_active = COALESCE($7, is_active),
        metadata = COALESCE($8, metadata),
        updated_at = NOW()
       WHERE id = $9
       RETURNING id, name, description, price, sku, category_id, image_url, is_active, metadata, created_at, updated_at`,
      [name, description, price, sku, categoryId, imageUrl, isActive, metadata, id],
    );

    const product = result.rows[0];

    // Invalidate cache
    await cacheInvalidate('products:*');

    logger.info('Product updated', { productId: id });

    res.json({
      product: {
        id: product.id,
        name: product.name,
        description: product.description,
        price: parseFloat(product.price),
        sku: product.sku,
        categoryId: product.category_id,
        imageUrl: product.image_url,
        isActive: product.is_active,
        metadata: product.metadata,
        createdAt: product.created_at,
        updatedAt: product.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── Error Handling Middleware ────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  res.status(err.status || 500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong.',
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found', message: 'The requested resource was not found.' });
});

// ─── Server Start ────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  logger.info(`Product service started on port ${PORT}`, { port: PORT });
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await redis.quit();
    } catch (e) { /* ignore */ }
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('Forced shutdown due to timeout');
    process.exit(1);
  }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
