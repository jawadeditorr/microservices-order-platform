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
process.env.SERVICE_NAME = 'inventory-service';

const app = require('../../index');
const { query } = require('../../db');
const jwt = require('jsonwebtoken');

describe('Inventory Service', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('inventory-service');
    });
  });

  describe('GET /inventory/:productId', () => {
    it('should return inventory for a product', async () => {
      query.mockResolvedValueOnce({
        rows: [{
          id: '1', product_id: 'prod-1', stock: 50, reserved: 5,
          low_stock_threshold: 10, warehouse_id: 'wh-1',
          warehouse_name: 'Main', warehouse_location: 'NY', updated_at: new Date().toISOString(),
        }],
      });

      const res = await request(app).get('/inventory/prod-1');
      expect(res.statusCode).toBe(200);
      expect(res.body.inventory.stock).toBe(50);
      expect(res.body.inventory.available).toBe(45);
    });

    it('should return 404 for unknown product', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app).get('/inventory/unknown');
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PUT /inventory/:productId', () => {
    it('should require admin role', async () => {
      const token = jwt.sign(
        { userId: '1', email: 'user@test.com', role: 'customer' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' },
      );

      const res = await request(app)
        .put('/inventory/prod-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ stock: 100 });

      expect(res.statusCode).toBe(403);
    });

    it('should update stock as admin', async () => {
      const token = jwt.sign(
        { userId: '1', email: 'admin@test.com', role: 'admin' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' },
      );

      // Get default warehouse
      query.mockResolvedValueOnce({ rows: [{ id: 'wh-1' }] });
      // Upsert inventory
      query.mockResolvedValueOnce({
        rows: [{
          id: '1', product_id: 'prod-1', warehouse_id: 'wh-1',
          stock: 100, reserved: 0, low_stock_threshold: 10,
          updated_at: new Date().toISOString(),
        }],
      });
      // Record movement
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .put('/inventory/prod-1')
        .set('Authorization', `Bearer ${token}`)
        .send({ stock: 100 });

      expect(res.statusCode).toBe(200);
      expect(res.body.inventory.stock).toBe(100);
    });
  });
});
