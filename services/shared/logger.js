/**
 * Structured JSON Logger
 * All Node.js services use this for consistent logging format
 */

const SERVICE_NAME = process.env.SERVICE_NAME || 'unknown-service';

const formatMessage = (level, message, context = {}) => {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    message,
    ...context,
  });
};

const logger = {
  info: (message, context = {}) => {
    console.log(formatMessage('info', message, context));
  },

  warn: (message, context = {}) => {
    console.warn(formatMessage('warn', message, context));
  },

  error: (message, context = {}) => {
    console.error(formatMessage('error', message, context));
  },

  debug: (message, context = {}) => {
    if (process.env.NODE_ENV === 'development') {
      console.log(formatMessage('debug', message, context));
    }
  },
};

module.exports = logger;
