require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const promClient = require('prom-client');
const crypto = require('crypto');
const { query } = require('./db');
const logger = require('../../shared/logger');
const { authenticate } = require('../../shared/auth-middleware');
const rabbitmq = require('../../shared/rabbitmq');

const app = express();
const PORT = process.env.PORT || 3005;

// ─── Prometheus Metrics ──────────────────────────────────────────────────────
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics({ prefix: 'payment_service_' });

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

const paymentsProcessed = new promClient.Counter({
  name: 'payments_processed_total',
  help: 'Total payments processed',
  labelNames: ['status'],
});

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
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

// ─── Helper: Generate mock Stripe-like IDs ──────────────────────────────────
const generatePaymentIntentId = () => `pi_${crypto.randomBytes(16).toString('hex')}`;
const generateClientSecret = (piId) => `${piId}_secret_${crypto.randomBytes(12).toString('hex')}`;

// ─── Initialize RabbitMQ ─────────────────────────────────────────────────────
const initRabbitMQ = async () => {
  try {
    await rabbitmq.connect();
    logger.info('Payment service RabbitMQ connected');
  } catch (error) {
    logger.error('Failed to initialize RabbitMQ', { error: error.message });
  }
};

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'payment-service', timestamp: new Date().toISOString() });
});

app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', promClient.register.contentType);
    res.end(await promClient.register.metrics());
  } catch (error) {
    res.status(500).end(error.message);
  }
});

// ─── POST /payments/initiate ────────────────────────────────────────────────
app.post('/payments/initiate', authenticate, async (req, res, next) => {
  try {
    const { orderId, amount, currency = 'USD', paymentMethod = 'credit_card' } = req.body;
    const { userId } = req.user;

    if (!orderId || !amount) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'orderId and amount are required.',
      });
    }

    if (amount <= 0) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'Amount must be greater than 0.',
      });
    }

    // Check if payment already exists for this order
    const existingPayment = await query(
      "SELECT id, status FROM payments WHERE order_id = $1 AND status != 'cancelled'",
      [orderId],
    );

    if (existingPayment.rows.length > 0) {
      const existing = existingPayment.rows[0];
      if (existing.status === 'succeeded') {
        return res.status(409).json({
          error: 'Payment exists',
          message: 'Payment has already been completed for this order.',
        });
      }
    }

    // Generate mock Stripe payment intent
    const stripePaymentIntentId = generatePaymentIntentId();
    const clientSecret = generateClientSecret(stripePaymentIntentId);

    const result = await query(
      `INSERT INTO payments (order_id, user_id, amount, currency, payment_method, stripe_payment_intent_id, client_secret, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING id, order_id, amount, currency, status, stripe_payment_intent_id, client_secret, created_at`,
      [orderId, userId, amount, currency, paymentMethod, stripePaymentIntentId, clientSecret],
    );

    const payment = result.rows[0];

    // Record the transaction
    await query(
      `INSERT INTO transactions (payment_id, type, amount, status, gateway_response)
       VALUES ($1, 'charge', $2, 'pending', $3)`,
      [payment.id, amount, JSON.stringify({ paymentIntentId: stripePaymentIntentId })],
    );

    logger.info('Payment initiated', { paymentId: payment.id, orderId, amount });

    res.status(201).json({
      payment: {
        paymentId: payment.id,
        orderId: payment.order_id,
        amount: parseFloat(payment.amount),
        currency: payment.currency,
        status: payment.status,
        clientSecret: payment.client_secret,
        stripePaymentIntentId: payment.stripe_payment_intent_id,
        createdAt: payment.created_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /payments/confirm ─────────────────────────────────────────────────
app.post('/payments/confirm', authenticate, async (req, res, next) => {
  try {
    const { paymentId } = req.body;

    if (!paymentId) {
      return res.status(400).json({
        error: 'Validation error',
        message: 'paymentId is required.',
      });
    }

    // Find payment
    const paymentResult = await query(
      'SELECT id, order_id, user_id, amount, currency, status FROM payments WHERE id = $1',
      [paymentId],
    );

    if (paymentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Not found', message: 'Payment not found.' });
    }

    const payment = paymentResult.rows[0];

    if (payment.status === 'succeeded') {
      return res.status(400).json({
        error: 'Already confirmed',
        message: 'This payment has already been confirmed.',
      });
    }

    if (payment.status !== 'pending') {
      return res.status(400).json({
        error: 'Invalid status',
        message: `Cannot confirm a payment with status: ${payment.status}`,
      });
    }

    // Simulate payment processing (mock success)
    const updatedPayment = await query(
      "UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE id = $1 RETURNING *",
      [paymentId],
    );

    // Record successful transaction
    await query(
      `INSERT INTO transactions (payment_id, type, amount, status, gateway_response)
       VALUES ($1, 'charge', $2, 'succeeded', $3)`,
      [paymentId, payment.amount, JSON.stringify({
        message: 'Payment processed successfully (mock)',
        processedAt: new Date().toISOString(),
      })],
    );

    paymentsProcessed.inc({ status: 'succeeded' });

    // Publish payment.confirmed event
    try {
      await rabbitmq.publish('ecommerce.events', 'payment.confirmed', {
        paymentId: payment.id,
        orderId: payment.order_id,
        userId: payment.user_id,
        amount: parseFloat(payment.amount),
        currency: payment.currency,
        confirmedAt: new Date().toISOString(),
      });
      logger.info('payment.confirmed event published', { paymentId, orderId: payment.order_id });
    } catch (mqError) {
      logger.error('Failed to publish payment.confirmed', { error: mqError.message });
    }

    logger.info('Payment confirmed', { paymentId, orderId: payment.order_id });

    const result = updatedPayment.rows[0];
    res.json({
      payment: {
        paymentId: result.id,
        orderId: result.order_id,
        amount: parseFloat(result.amount),
        currency: result.currency,
        status: result.status,
        confirmedAt: result.updated_at,
      },
    });
  } catch (error) {
    next(error);
  }
});

// ─── POST /payments/webhook ─────────────────────────────────────────────────
app.post('/payments/webhook', async (req, res, next) => {
  try {
    const { type, data } = req.body;

    if (!type || !data) {
      return res.status(400).json({
        error: 'Invalid webhook',
        message: 'Webhook type and data are required.',
      });
    }

    logger.info('Webhook received', { type, paymentIntentId: data.paymentIntentId });

    switch (type) {
      case 'payment_intent.succeeded': {
        const { paymentIntentId } = data;
        await query(
          "UPDATE payments SET status = 'succeeded', updated_at = NOW() WHERE stripe_payment_intent_id = $1",
          [paymentIntentId],
        );
        paymentsProcessed.inc({ status: 'succeeded' });
        break;
      }

      case 'payment_intent.payment_failed': {
        const { paymentIntentId } = data;
        await query(
          "UPDATE payments SET status = 'failed', updated_at = NOW() WHERE stripe_payment_intent_id = $1",
          [paymentIntentId],
        );
        paymentsProcessed.inc({ status: 'failed' });

        // Publish payment.failed event
        try {
          const paymentResult = await query(
            'SELECT id, order_id, user_id FROM payments WHERE stripe_payment_intent_id = $1',
            [paymentIntentId],
          );
          if (paymentResult.rows.length > 0) {
            const payment = paymentResult.rows[0];
            await rabbitmq.publish('ecommerce.events', 'payment.failed', {
              paymentId: payment.id,
              orderId: payment.order_id,
              userId: payment.user_id,
              reason: data.failureMessage || 'Payment failed',
              timestamp: new Date().toISOString(),
            });
          }
        } catch (mqError) {
          logger.error('Failed to publish payment.failed event', { error: mqError.message });
        }
        break;
      }

      default:
        logger.warn('Unhandled webhook type', { type });
    }

    // Always respond 200 to webhooks
    res.json({ received: true });
  } catch (error) {
    next(error);
  }
});

// ─── GET /payments/:orderId ─────────────────────────────────────────────────
app.get('/payments/:orderId', authenticate, async (req, res, next) => {
  try {
    const { orderId } = req.params;

    const result = await query(
      `SELECT p.id, p.order_id, p.amount, p.currency, p.status, p.payment_method,
              p.stripe_payment_intent_id, p.created_at, p.updated_at
       FROM payments p
       WHERE p.order_id = $1
       ORDER BY p.created_at DESC`,
      [orderId],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Not found',
        message: 'No payments found for this order.',
      });
    }

    const payments = result.rows.map((row) => ({
      paymentId: row.id,
      orderId: row.order_id,
      amount: parseFloat(row.amount),
      currency: row.currency,
      status: row.status,
      paymentMethod: row.payment_method,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    res.json({ payments });
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
  logger.info(`Payment service started on port ${PORT}`, { port: PORT });
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
