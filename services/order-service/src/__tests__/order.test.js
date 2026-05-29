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
process.env.SERVICE_NAME = 'order-service';

const app = require('../../index');
const { query } = require('../../db');
const jwt = require('jsonwebtoken');

const generateToken = (userId = '1', role = 'customer') => jwt.sign(
  { userId, email: 'test@example.com', role },
  process.env.JWT_SECRET,
  { expiresIn: '15m' },
);

describe('Order Service', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('order-service');
    });
  });

  describe('GET /cart', () => {
    it('should return empty cart for new user', async () => {
      const token = generateToken();
      query.mockResolvedValueOnce({ rows: [] }); // No cart exists

      const res = await request(app)
        .get('/cart')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.cart.items).toHaveLength(0);
      expect(res.body.cart.subtotal).toBe(0);
    });

    it('should require authentication', async () => {
      const res = await request(app).get('/cart');
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /orders', () => {
    it('should return paginated orders', async () => {
      const token = generateToken();
      query.mockResolvedValueOnce({ rows: [{ total: '0' }] });
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/orders')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.orders).toHaveLength(0);
      expect(res.body.pagination.total).toBe(0);
    });
  });

  describe('POST /cart/items', () => {
    it('should add item to cart', async () => {
      const token = generateToken();
      // Get/create cart
      query.mockResolvedValueOnce({ rows: [{ id: 'cart-1' }] });
      // Upsert item
      query.mockResolvedValueOnce({
        rows: [{
          id: 'item-1', product_id: 'prod-1', product_name: 'Test Product',
          price: '29.99', quantity: 1,
        }],
      });

      const res = await request(app)
        .post('/cart/items')
        .set('Authorization', `Bearer ${token}`)
        .send({ productId: 'prod-1', productName: 'Test Product', price: 29.99 });

      expect(res.statusCode).toBe(201);
      expect(res.body.cartItem.productName).toBe('Test Product');
    });
  });
});
