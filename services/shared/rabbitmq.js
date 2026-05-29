const amqplib = require('amqplib');

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672';
const RECONNECT_DELAY = 5000;
const MAX_RETRIES = 10;

let connection = null;
let channel = null;
let retryCount = 0;

const logger = {
  info: (message, context = {}) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'info',
      service: process.env.SERVICE_NAME || 'unknown',
      message,
      ...context,
    }));
  },
  error: (message, context = {}) => {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      service: process.env.SERVICE_NAME || 'unknown',
      message,
      ...context,
    }));
  },
};

/**
 * Connect to RabbitMQ with auto-reconnect
 */
async function connect() {
  try {
    connection = await amqplib.connect(RABBITMQ_URL);
    channel = await connection.createChannel();

    // Set prefetch to process one message at a time
    await channel.prefetch(1);

    retryCount = 0;
    logger.info('Connected to RabbitMQ', { url: RABBITMQ_URL.replace(/\/\/.*@/, '//***@') });

    // Handle connection close — attempt reconnect
    connection.on('close', () => {
      logger.error('RabbitMQ connection closed. Attempting reconnect...');
      channel = null;
      connection = null;
      setTimeout(connect, RECONNECT_DELAY);
    });

    connection.on('error', (err) => {
      logger.error('RabbitMQ connection error', { error: err.message });
    });

    return channel;
  } catch (error) {
    retryCount++;
    if (retryCount >= MAX_RETRIES) {
      logger.error('Max RabbitMQ reconnection attempts reached', { retryCount });
      throw error;
    }

    logger.error(`RabbitMQ connection failed. Retry ${retryCount}/${MAX_RETRIES}...`, {
      error: error.message,
    });

    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY));
    return connect();
  }
}

/**
 * Get the current channel, connecting if necessary
 */
async function getChannel() {
  if (!channel) {
    await connect();
  }
  return channel;
}

/**
 * Publish a message to an exchange with a routing key
 * @param {string} exchange - Exchange name
 * @param {string} routingKey - Routing key for the message
 * @param {object} message - Message payload (will be JSON-stringified)
 * @param {object} options - Additional publish options
 */
async function publish(exchange, routingKey, message, options = {}) {
  try {
    const ch = await getChannel();

    // Ensure the exchange exists (topic type for flexible routing)
    await ch.assertExchange(exchange, 'topic', { durable: true });

    const messageBuffer = Buffer.from(JSON.stringify(message));
    const publishOptions = {
      persistent: true,
      contentType: 'application/json',
      timestamp: Date.now(),
      ...options,
    };

    ch.publish(exchange, routingKey, messageBuffer, publishOptions);

    logger.info('Message published', { exchange, routingKey, messageId: options.messageId });
  } catch (error) {
    logger.error('Failed to publish message', {
      exchange,
      routingKey,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Subscribe to messages on a queue bound to an exchange with a routing key
 * @param {string} queue - Queue name
 * @param {string} exchange - Exchange name
 * @param {string} routingKey - Routing key pattern
 * @param {function} handler - Async handler function(message, ack, nack)
 * @param {object} options - Queue options
 */
async function subscribe(queue, exchange, routingKey, handler, options = {}) {
  try {
    const ch = await getChannel();

    // Ensure exchange exists
    await ch.assertExchange(exchange, 'topic', { durable: true });

    // Create dead letter exchange and queue
    const dlxExchange = `${exchange}.dlx`;
    const dlqQueue = `${queue}.dlq`;

    await ch.assertExchange(dlxExchange, 'topic', { durable: true });
    await ch.assertQueue(dlqQueue, { durable: true });
    await ch.bindQueue(dlqQueue, dlxExchange, routingKey);

    // Create the main queue with dead letter config
    await ch.assertQueue(queue, {
      durable: true,
      deadLetterExchange: dlxExchange,
      deadLetterRoutingKey: routingKey,
      ...options,
    });

    // Bind queue to exchange
    await ch.bindQueue(queue, exchange, routingKey);

    logger.info('Subscribed to queue', { queue, exchange, routingKey });

    // Consume messages
    ch.consume(queue, async (msg) => {
      if (!msg) return;

      try {
        const content = JSON.parse(msg.content.toString());
        const retryCount = (msg.properties.headers && msg.properties.headers['x-retry-count']) || 0;

        await handler(content, {
          ack: () => ch.ack(msg),
          nack: (requeue = false) => ch.nack(msg, false, requeue),
          retry: async (maxRetries = 3) => {
            if (retryCount < maxRetries) {
              // Republish with incremented retry count
              const headers = { ...msg.properties.headers, 'x-retry-count': retryCount + 1 };
              ch.publish(exchange, routingKey, msg.content, {
                ...msg.properties,
                headers,
              });
              ch.ack(msg);
              logger.info('Message requeued for retry', {
                queue,
                retryCount: retryCount + 1,
                maxRetries,
              });
            } else {
              // Max retries exceeded — send to DLQ
              ch.nack(msg, false, false);
              logger.error('Message sent to DLQ after max retries', {
                queue,
                retryCount,
                maxRetries,
              });
            }
          },
        });
      } catch (error) {
        logger.error('Error processing message', {
          queue,
          error: error.message,
        });
        // Reject and send to DLQ
        ch.nack(msg, false, false);
      }
    });
  } catch (error) {
    logger.error('Failed to subscribe to queue', {
      queue,
      exchange,
      routingKey,
      error: error.message,
    });
    throw error;
  }
}

/**
 * Close the RabbitMQ connection gracefully
 */
async function close() {
  try {
    if (channel) {
      await channel.close();
      channel = null;
    }
    if (connection) {
      await connection.close();
      connection = null;
    }
    logger.info('RabbitMQ connection closed gracefully');
  } catch (error) {
    logger.error('Error closing RabbitMQ connection', { error: error.message });
  }
}

module.exports = {
  connect,
  getChannel,
  publish,
  subscribe,
  close,
};
