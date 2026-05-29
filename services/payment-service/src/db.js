const { Pool } = require('pg');
const logger = require('../../shared/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('connect', () => { logger.debug('New client connected to PostgreSQL'); });
pool.on('error', (err) => { logger.error('Unexpected PostgreSQL pool error', { error: err.message }); });

const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { text: text.substring(0, 80), duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Query failed', { text: text.substring(0, 80), error: error.message });
    throw error;
  }
};

const getClient = async () => pool.connect();

module.exports = { pool, query, getClient };
