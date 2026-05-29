const request = require('supertest');

jest.mock('../../db', () => ({
  query: jest.fn(),
  getClient: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('../../../../shared/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));

jest.mock('../../../../shared/rabbitmq', () => ({
  connect: jest.fn().mockResolvedValue(),
  publish: jest.fn().mockResolvedValue(),
  subscribe: jest.fn().mockResolvedValue(),
  close: jest.fn().mockResolvedValue(),
}));

process.env.JWT_SECRET = 'test-secret-key';
process.env.SERVICE_NAME = 'payment-service';

const app = require('../../index');
const { query } = require('../../db');
const jwt = require('jsonwebtoken');

const generateToken = (userId = '1') => jwt.sign(
  { userId, email: 'test@example.com', role: 'customer' },
  process.env.JWT_SECRET,
  { expiresIn: '15m' },
);

describe('Payment Service', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('payment-service');
    });
  });

  describe('POST /payments/initiate', () => {
    it('should create a payment intent', async () => {
      const token = generateToken();

      // Check existing payments
      query.mockResolvedValueOnce({ rows: [] });
      // Insert payment
      query.mockResolvedValueOnce({
        rows: [{
          id: 'pay-1', order_id: 'order-1', amount: '49.99', currency: 'USD',
          status: 'pending', stripe_payment_intent_id: 'pi_test',
          client_secret: 'pi_test_secret_xxx', created_at: new Date().toISOString(),
        }],
      });
      // Insert transaction
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/payments/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({ orderId: 'order-1', amount: 49.99 });

      expect(res.statusCode).toBe(201);
      expect(res.body.payment.status).toBe('pending');
      expect(res.body.payment.clientSecret).toBeDefined();
    });

    it('should require orderId and amount', async () => {
      const token = generateToken();

      const res = await request(app)
        .post('/payments/initiate')
        .set('Authorization', `Bearer ${token}`)
        .send({});

      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /payments/webhook', () => {
    it('should handle payment_intent.succeeded webhook', async () => {
      query.mockResolvedValueOnce({ rows: [] }); // Update payment status

      const res = await request(app)
        .post('/payments/webhook')
        .send({
          type: 'payment_intent.succeeded',
          data: { paymentIntentId: 'pi_test123' },
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.received).toBe(true);
    });
  });

  describe('GET /payments/:orderId', () => {
    it('should return 404 if no payments found', async () => {
      const token = generateToken();
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/payments/nonexistent-order')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(404);
    });
  });
});
