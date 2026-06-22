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

const fs = require('fs');
const path = require('path');

const runMigrations = async () => {
  try {
    const migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) return;
    
    const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
      const filePath = path.join(migrationsDir, file);
      const sql = fs.readFileSync(filePath, 'utf8');
      logger.info(`Running database migration: ${file}`);
      await pool.query(sql);
      logger.info(`Migration completed: ${file}`);
    }
  } catch (error) {
    logger.error('Failed to run database migrations', { error: error.message });
  }
};

runMigrations();

module.exports = { pool, query, getClient };
