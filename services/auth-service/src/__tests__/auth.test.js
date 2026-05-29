const request = require('supertest');

// Mock the database module before requiring the app
jest.mock('../../db', () => ({
  query: jest.fn(),
  pool: { end: jest.fn() },
}));

// Mock the shared modules
jest.mock('../../../../shared/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

// Set env vars before requiring app
process.env.JWT_SECRET = 'test-secret-key';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-key';
process.env.SERVICE_NAME = 'auth-service';

const app = require('../../index');
const { query } = require('../../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

describe('Auth Service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /health', () => {
    it('should return health status', async () => {
      const res = await request(app).get('/health');
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('auth-service');
      expect(res.body.timestamp).toBeDefined();
    });
  });

  describe('POST /auth/register', () => {
    it('should register a new user successfully', async () => {
      const mockUser = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'test@example.com',
        first_name: 'John',
        last_name: 'Doe',
        role: 'customer',
        created_at: new Date().toISOString(),
      };

      // Mock: no existing user
      query.mockResolvedValueOnce({ rows: [] });
      // Mock: insert user
      query.mockResolvedValueOnce({ rows: [mockUser] });
      // Mock: insert refresh token
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'test@example.com',
          password: 'SecurePassword123',
          firstName: 'John',
          lastName: 'Doe',
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.user.email).toBe('test@example.com');
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
    });

    it('should return 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'test@example.com' });

      expect(res.statusCode).toBe(400);
      expect(res.body.error).toBe('Validation error');
    });

    it('should return 409 for duplicate email', async () => {
      query.mockResolvedValueOnce({ rows: [{ id: 'existing-id' }] });

      const res = await request(app)
        .post('/auth/register')
        .send({
          email: 'existing@example.com',
          password: 'SecurePassword123',
          firstName: 'Jane',
          lastName: 'Doe',
        });

      expect(res.statusCode).toBe(409);
      expect(res.body.error).toBe('Conflict');
    });
  });

  describe('POST /auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const passwordHash = await bcrypt.hash('SecurePassword123', 12);
      const mockUser = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'test@example.com',
        password_hash: passwordHash,
        first_name: 'John',
        last_name: 'Doe',
        role: 'customer',
        is_active: true,
      };

      // Mock: find user
      query.mockResolvedValueOnce({ rows: [mockUser] });
      // Mock: revoke old tokens
      query.mockResolvedValueOnce({ rows: [] });
      // Mock: insert new refresh token
      query.mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'SecurePassword123' });

      expect(res.statusCode).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeDefined();
      expect(res.body.user.email).toBe('test@example.com');
    });

    it('should return 401 for invalid password', async () => {
      const passwordHash = await bcrypt.hash('CorrectPassword', 12);
      query.mockResolvedValueOnce({
        rows: [{
          id: '1', email: 'test@example.com', password_hash: passwordHash,
          first_name: 'John', last_name: 'Doe', role: 'customer', is_active: true,
        }],
      });

      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'test@example.com', password: 'WrongPassword' });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /auth/me', () => {
    it('should return user profile with valid token', async () => {
      const token = jwt.sign(
        { userId: '550e8400-e29b-41d4-a716-446655440000', email: 'test@example.com', role: 'customer' },
        process.env.JWT_SECRET,
        { expiresIn: '15m' },
      );

      const mockUser = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        email: 'test@example.com',
        first_name: 'John',
        last_name: 'Doe',
        role: 'customer',
        is_active: true,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      query.mockResolvedValueOnce({ rows: [mockUser] });

      const res = await request(app)
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toBe(200);
      expect(res.body.user.email).toBe('test@example.com');
    });

    it('should return 401 without auth header', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.statusCode).toBe(401);
    });
  });
});
