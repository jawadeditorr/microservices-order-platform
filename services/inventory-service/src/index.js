require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const promClient = require('prom-client');
const { query, getClient } = require('./db');
const logger = require('../../shared/logger');
const { authenticate, authorize } = require('../../shared/auth-middleware');
const rabbitmq = require('../../shared/rabbitmq');

const app = express();
const PORT = process.env.PORT || 3004;

// ─── Prometheus Metrics ──────────────────────────────────────────────────────
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'inventory_service_' });

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

const lowStockGauge = new promClient.Gauge({
  name: 'inventory_low_stock_products',
  help: 'Number of products with low stock',
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

// ─── Initialize RabbitMQ ─────────────────────────────────────────────────────
const initRabbitMQ = async () => {
  try {
    await rabbitmq.connect();

    // Subscribe to order.created events to decrement stock
    await rabbitmq.subscribe(
      'inventory-order-created',
      'ecommerce.events',
      'order.created',
      async (message, { ack, retry }) => {
        const client = await getClient();
        try {
          const { orderId, items } = message;

          await client.query('BEGIN');

          for (const item of items) {
            // Decrement stock
            const result = await client.query(
              `UPDATE inventory
               SET stock = stock - $1, updated_at = NOW()
               WHERE product_id = $2 AND stock >= $1
               RETURNING id, product_id, stock, low_stock_threshold`,
              [item.quantity, item.productId],
            );

            if (result.rows.length === 0) {
              logger.warn('Insufficient stock or product not found', {
                productId: item.productId,
                requestedQuantity: item.quantity,
              });
              // Still continue — log but don't fail the whole order
              continue;
            }

            const inventory = result.rows[0];

            // Record stock movement
            await client.query(
              `INSERT INTO stock_movements (product_id, warehouse_id, quantity, movement_type, reference_id, reference_type)
               SELECT $1, warehouse_id, $2, 'outbound', $3, 'order'
               FROM inventory WHERE product_id = $1 LIMIT 1`,
              [item.productId, -item.quantity, orderId],
            );

            // Check for low stock and publish event
            if (inventory.stock < inventory.low_stock_threshold) {
              try {
                await rabbitmq.publish('ecommerce.events', 'inventory.low', {
                  productId: inventory.product_id,
                  currentStock: inventory.stock,
                  threshold: inventory.low_stock_threshold,
                  timestamp: new Date().toISOString(),
                });
                logger.warn('Low stock alert published', {
                  productId: inventory.product_id,
                  stock: inventory.stock,
                });
              } catch (pubError) {
                logger.error('Failed to publish inventory.low event', { error: pubError.message });
              }
            }
          }

          await client.query('COMMIT');
          ack();

          logger.info('Stock decremented for order', { orderId, itemCount: items.length });
        } catch (error) {
          await client.query('ROLLBACK');
          logger.error('Failed to process order.created', { error: error.message });
          await retry(3);
        } finally {
          client.release();
        }
      },
    );

    logger.info('Inventory RabbitMQ consumers initialized');
  } catch (error) {
    logger.error('Failed to initialize RabbitMQ', { error: error.message });
  }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'inventory-service', timestamp: new Date().toISOString() });
});

app.get('/metrics', async (_req, res) => {
  try {
    // Update low stock gauge
    const lowStockResult = await query(
      'SELECT COUNT(*) as count FROM inventory WHERE stock < low_stock_threshold',
    );
    lowStockGauge.set(parseInt(lowStockResult.rows[0].count, 10));

    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// ─── GET /inventory/:productId ──────────────────────────────────────────────
app.get('/inventory/:productId', async (req, res, next) => {
  try {
    const { productId } = req.params;

    const result = await query(
      `SELECT i.id, i.product_id, i.stock, i.reserved, i.low_stock_threshold,
              w.id as warehouse_id, w.name as warehouse_name, w.location as warehouse_location,
              i.updated_at
       FROM inventory i
       JOIN warehouses w ON i.warehouse_id = w.id
       WHERE i.product_id = $1`,
      [productId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'Inventory record not found for this product.',
      });
    }

    const row = result.rows[0];
    res.json({
      inventory: {
        productId: row.product_id,
        stock: row.stock,
        reserved: row.reserved,
        available: row.stock - row.reserved,
        lowStockThreshold: row.low_stock_threshold,
        isLowStock: row.stock < row.low_stock_threshold,
        warehouse: {
          id: row.warehouse_id,
          name: row.warehouse_name,
          location: row.warehouse_location,
        },
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── PUT /inventory/:productId (admin only) ─────────────────────────────────
app.put('/inventory/:productId', authenticate, authorize('admin'), async (req, res, next) => {
  try {
    const { productId } = req.params;
    const { stock, warehouseId, lowStockThreshold } = req.body;

    if (stock === undefined || stock === null) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Stock level is required.',
      });
    }

    if (stock < 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Stock level must be non-negative.',
      });
    }

    // Get warehouse ID — use provided or get default
    let targetWarehouseId = warehouseId;
    if (!targetWarehouseId) {
      const whResult = await query('SELECT id FROM warehouses WHERE is_active = true LIMIT 1');
      if (whResult.rows.length === 0) {
        return res.status(400).json({
          error: 'No warehouse',
          message: 'No active warehouse found. Create a warehouse first.',
        });
      }
      targetWarehouseId = whResult.rows[0].id;
    }

    // Upsert inventory record
    const result = await query(
      `INSERT INTO inventory (product_id, warehouse_id, stock, low_stock_threshold)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (product_id, warehouse_id)
       DO UPDATE SET stock = $3, low_stock_threshold = COALESCE($4, inventory.low_stock_threshold), updated_at = NOW()
       RETURNING id, product_id, warehouse_id, stock, reserved, low_stock_threshold, updated_at`,
      [productId, targetWarehouseId, stock, lowStockThreshold || 10],
    );

    const inv = result.rows[0];

    // Record adjustment
    await query(
      `INSERT INTO stock_movements (product_id, warehouse_id, quantity, movement_type, notes)
       VALUES ($1, $2, $3, 'adjustment', $4)`,
      [productId, targetWarehouseId, stock, `Stock set to ${stock} by admin`],
    );

    // Check for low stock
    if (inv.stock < inv.low_stock_threshold) {
      try {
        await rabbitmq.publish('ecommerce.events', 'inventory.low', {
          productId: inv.product_id,
          currentStock: inv.stock,
          threshold: inv.low_stock_threshold,
          timestamp: new Date().toISOString(),
        });
      } catch (mqError) {
        logger.warn('Failed to publish low stock alert', { error: mqError.message });
      }
    }

    logger.info('Inventory updated', { productId, newStock: stock });

    res.json({
      inventory: {
        productId: inv.product_id,
        warehouseId: inv.warehouse_id,
        stock: inv.stock,
        reserved: inv.reserved,
        available: inv.stock - inv.reserved,
        lowStockThreshold: inv.low_stock_threshold,
        updatedAt: inv.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── Error Handling ──────────────────────────────────────────────────────────
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
const server = app.listen(PORT, async () => {
  logger.info(`Inventory service started on port ${PORT}`, { port: PORT });
  await initRabbitMQ();
});

const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}. Shutting down gracefully...`);
  server.close(async () => {
    await rabbitmq.close();
    logger.info('HTTP server closed');
    process.exit(0);
  });
  setTimeout(() => { logger.error('Forced shutdown'); process.exit(1); }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
