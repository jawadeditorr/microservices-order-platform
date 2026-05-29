const request = require('supertest');

jest.mock('../../db', () => ({
  query: jest.fn(),
  pool: { end: jest.fn() },
}));

jest.mock('ioredis', () => {
  const Redis = jest.fn(() => ({
    status: 'ready',
    connect: jest.fn().mockResolvedValue(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    keys: jest.fn().mockResolvedValue([]),
    del: jest.fn().mockResolvedValue(0),
    quit: jest.fn().mockResolvedValue(),
    on: jest.fn(),
  }));
  return Redis;
});

jest.mock('../../../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

process.env.JWT_SECRET = 'test-secret-key';
process.env.SERVICE_NAME = 'product-service';

const app = require('../../index');
const { query } = require('../../db');
const jwt = require('jsonwebtoken');

describe('Product Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('product-service');
    });
  });

  describe('GET /products', () => {
    it('should return paginated products', async () => {
      query.mockResolvedValueOnce({ rows: [{ total: '2' }] });
      query.mockResolvedValueOnce({
        rows: [
          {
            id: '1', name: 'Product A', description: 'Desc A', price: '29.99',
            sku: 'SKU-001', image_url: null, is_active: true, metadata: {},
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            category_id: null, category_name: null, category_slug: null,
          },
          {
            id: '2', name: 'Product B', description: 'Desc B', price: '49.99',
            sku: 'SKU-002', image_url: null, is_active: true, metadata: {},
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            category_id: null, category_name: null, category_slug: null,
          },
        ],
      });

      const res = await request(app).get('/products?page=1&limit=10');
      expect(res.statusCode).toBe(200);
      expect(res.body.products).toHaveLength(2);
      expect(res.body.pagination.total).toBe(2);
    });
  });

  describe('POST /products', () => {
    it('should require admin role', async () => {
      const token = jwt.sign(
        { userId: '1', email: 'user@test.com', role: 'customer' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' },
      );

      const res = await request(app)
        .post('/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Test', price: 10, sku: 'TEST-001' });

      expect(res.statusCode).toBe(403);
    });

    it('should create product as admin', async () => {
      const token = jwt.sign(
        { userId: '1', email: 'admin@test.com', role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' },
      );

      query.mockResolvedValueOnce({ rows: [] }); // SKU check
      query.mockResolvedValueOnce({
        rows: [{
          id: '1', name: 'New Product', description: 'Desc', price: '29.99',
          sku: 'SKU-NEW', category_id: null, image_url: null, metadata: {},
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        }],
      });

      const res = await request(app)
        .post('/products')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'New Product', description: 'Desc', price: 29.99, sku: 'SKU-NEW' });

      expect(res.statusCode).toBe(201);
      expect(res.body.product.name).toBe('New Product');
    });
  });

  describe('GET /products/:id', () => {
    it('should return 404 for non-existent product', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/products/nonexistent-id');
      expect(res.statusCode).toBe(404);
    });
  });
});
