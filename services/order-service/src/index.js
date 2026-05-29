require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const promClient = require('prom-client');
const { query, getClient } = require('./db');
const logger = require('../../shared/logger');
const { authenticate } = require('../../shared/auth-middleware');
const rabbitmq = require('../../shared/rabbitmq');

const app = express();
const PORT = process.env.PORT || 3003;

// ─── Prometheus Metrics ──────────────────────────────────────────────────────
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'order_service_' });

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

// ─── Initialize RabbitMQ ─────────────────────────────────────────────────────
const initRabbitMQ = async () => {
  try {
    await rabbitmq.connect();

    // Subscribe to payment.confirmed events to update order status
    await rabbitmq.subscribe(
      'order-payment-confirmed',
      'ecommerce.events',
      'payment.confirmed',
      async (message, { ack }) => {
        try {
          const { orderId, paymentId } = message;
          await query(
            "UPDATE orders SET payment_status = 'paid', status = 'confirmed', updated_at = NOW() WHERE id = $1",
            [orderId],
          );
          logger.info('Order payment confirmed', { orderId, paymentId });
          ack();
        } catch (error) {
          logger.error('Failed to process payment.confirmed', { error: error.message });
          ack(); // Ack to prevent infinite retries
        }
      },
    );

    logger.info('RabbitMQ consumers initialized');
  } catch (error) {
    logger.error('Failed to initialize RabbitMQ', { error: error.message });
    // Don't crash — service can still work without RabbitMQ for HTTP endpoints
  }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'order-service', timestamp: new Date().toISOString() });
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

// ─── POST /cart/items ───────────────────────────────────────────────────────
app.post('/cart/items', authenticate, async (req, res, next) => {
  try {
    const { productId, productName, price, quantity = 1 } = req.body;
    const { userId } = req.user;

    if (!productId || !productName || !price) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'productId, productName, and price are required.',
      });
    }

    if (quantity < 1) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Quantity must be at least 1.',
      });
    }

    // Get or create cart for the user
    let cartResult = await query('SELECT id FROM carts WHERE user_id = $1', [userId]);

    if (cartResult.rows.length === 0) {
      cartResult = await query(
        'INSERT INTO carts (user_id) VALUES ($1) RETURNING id',
        [userId],
      );
    }

    const cartId = cartResult.rows[0].id;

    // Upsert cart item
    const result = await query(
      `INSERT INTO cart_items (cart_id, product_id, product_name, price, quantity)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (cart_id, product_id)
       DO UPDATE SET quantity = cart_items.quantity + $5, price = $4, updated_at = NOW()
       RETURNING id, product_id, product_name, price, quantity`,
      [cartId, productId, productName, price, quantity],
    );

    const cartItem = result.rows[0];

    logger.info('Cart item added', { userId, productId, quantity });

    res.status(201).json({
      cartItem: {
        id: cartItem.id,
        productId: cartItem.product_id,
        productName: cartItem.product_name,
        price: parseFloat(cartItem.price),
        quantity: cartItem.quantity,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /cart ──────────────────────────────────────────────────────────────
app.get('/cart', authenticate, async (req, res, next) => {
  try {
    const { userId } = req.user;

    const cartResult = await query('SELECT id FROM carts WHERE user_id = $1', [userId]);

    if (cartResult.rows.length === 0) {
      return res.json({ cart: { items: [], subtotal: 0, itemCount: 0 } });
    }

    const cartId = cartResult.rows[0].id;

    const itemsResult = await query(
      `SELECT id, product_id, product_name, price, quantity
       FROM cart_items WHERE cart_id = $1 ORDER BY created_at`,
      [cartId],
    );

    const items = itemsResult.rows.map((item) => ({
      id: item.id,
      productId: item.product_id,
      productName: item.product_name,
      price: parseFloat(item.price),
      quantity: item.quantity,
      subtotal: parseFloat(item.price) * item.quantity,
    }));

    const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
    const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);

    res.json({
      cart: {
        id: cartId,
        items,
        subtotal: Math.round(subtotal * 100) / 100,
        itemCount,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /orders ───────────────────────────────────────────────────────────
app.post('/orders', authenticate, async (req, res, next) => {
  const client = await getClient();

  try {
    const { userId } = req.user;
    const { shippingAddress, notes } = req.body;

    await client.query('BEGIN');

    // Get cart
    const cartResult = await client.query('SELECT id FROM carts WHERE user_id = $1', [userId]);
    if (cartResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Empty cart',
        message: 'Your cart is empty. Add items before creating an order.',
      });
    }

    const cartId = cartResult.rows[0].id;

    // Get cart items
    const itemsResult = await client.query(
      'SELECT product_id, product_name, price, quantity FROM cart_items WHERE cart_id = $1',
      [cartId],
    );

    if (itemsResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'Empty cart',
        message: 'Your cart is empty. Add items before creating an order.',
      });
    }

    const cartItems = itemsResult.rows;
    const subtotal = cartItems.reduce(
      (sum, item) => sum + parseFloat(item.price) * item.quantity,
      0,
    );
    const tax = Math.round(subtotal * 0.08 * 100) / 100; // 8% tax
    const total = Math.round((subtotal + tax) * 100) / 100;

    // Create order
    const orderResult = await client.query(
      `INSERT INTO orders (user_id, subtotal, tax, total, shipping_address, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, user_id, status, payment_status, subtotal, tax, total, shipping_address, notes, created_at`,
      [userId, subtotal, tax, total, shippingAddress ? JSON.stringify(shippingAddress) : null, notes],
    );

    const order = orderResult.rows[0];

    // Create order items
    const orderItems = [];
    for (const item of cartItems) {
      const itemSubtotal = parseFloat(item.price) * item.quantity;
      const orderItemResult = await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, price, quantity, subtotal)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, product_id, product_name, price, quantity, subtotal`,
        [order.id, item.product_id, item.product_name, item.price, item.quantity, itemSubtotal],
      );
      orderItems.push(orderItemResult.rows[0]);
    }

    // Clear cart
    await client.query('DELETE FROM cart_items WHERE cart_id = $1', [cartId]);

    await client.query('COMMIT');

    // Publish order.created event to RabbitMQ
    try {
      await rabbitmq.publish('ecommerce.events', 'order.created', {
        orderId: order.id,
        userId: order.user_id,
        items: orderItems.map((item) => ({
          productId: item.product_id,
          quantity: item.quantity,
          price: parseFloat(item.price),
        })),
        total: parseFloat(order.total),
        createdAt: order.created_at,
      });
      logger.info('order.created event published', { orderId: order.id });
    } catch (mqError) {
      logger.error('Failed to publish order.created event', {
        orderId: order.id,
        error: mqError.message,
      });
      // Don't fail the request — the order was created successfully
    }

    res.status(201).json({
      order: {
        id: order.id,
        userId: order.user_id,
        status: order.status,
        paymentStatus: order.payment_status,
        subtotal: parseFloat(order.subtotal),
        tax: parseFloat(order.tax),
        total: parseFloat(order.total),
        shippingAddress: order.shipping_address,
        notes: order.notes,
        items: orderItems.map((item) => ({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          price: parseFloat(item.price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
        })),
        createdAt: order.created_at,
      },
    });
  } catch (error) {
    await client.query('ROLLBACK');
    next(error);
  } finally {
    client.release();
  }
});

// ─── GET /orders ────────────────────────────────────────────────────────────
app.get('/orders', authenticate, async (req, res, next) => {
  try {
    const { userId } = req.user;
    const { page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const countResult = await query('SELECT COUNT(*) as total FROM orders WHERE user_id = $1', [userId]);
    const total = parseInt(countResult.rows[0].total, 10);

    const result = await query(
      `SELECT id, status, payment_status, subtotal, tax, total, created_at, updated_at
       FROM orders WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limitNum, offset],
    );

    res.json({
      orders: result.rows.map((order) => ({
        id: order.id,
        status: order.status,
        paymentStatus: order.payment_status,
        subtotal: parseFloat(order.subtotal),
        tax: parseFloat(order.tax),
        total: parseFloat(order.total),
        createdAt: order.created_at,
        updatedAt: order.updated_at,
      })),
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── GET /orders/:id ────────────────────────────────────────────────────────
app.get('/orders/:id', authenticate, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { userId } = req.user;

    const orderResult = await query(
      `SELECT id, user_id, status, payment_status, subtotal, tax, total,
              shipping_address, notes, created_at, updated_at
       FROM orders WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );

    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Order not found.' });
    }

    const order = orderResult.rows[0];

    const itemsResult = await query(
      `SELECT id, product_id, product_name, price, quantity, subtotal
       FROM order_items WHERE order_id = $1`,
      [id],
    );

    res.json({
      order: {
        id: order.id,
        userId: order.user_id,
        status: order.status,
        paymentStatus: order.payment_status,
        subtotal: parseFloat(order.subtotal),
        tax: parseFloat(order.tax),
        total: parseFloat(order.total),
        shippingAddress: order.shipping_address,
        notes: order.notes,
        items: itemsResult.rows.map((item) => ({
          id: item.id,
          productId: item.product_id,
          productName: item.product_name,
          price: parseFloat(item.price),
          quantity: item.quantity,
          subtotal: parseFloat(item.subtotal),
        })),
        createdAt: order.created_at,
        updatedAt: order.updated_at,
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
  logger.info(`Order service started on port ${PORT}`, { port: PORT });
  await initRabbitMQ();
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
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
