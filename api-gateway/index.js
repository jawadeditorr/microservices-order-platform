const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const cors = require('cors');

const app = express();

app.use(cors());

// Health check
app.get('/health', (req, res) => res.send('API Gateway OK'));

// Proxies
app.use('/auth', createProxyMiddleware({ target: 'http://localhost:3001', changeOrigin: true }));
app.use('/products', createProxyMiddleware({ target: 'http://localhost:3002', changeOrigin: true }));
app.use('/orders', createProxyMiddleware({ target: 'http://localhost:3003', changeOrigin: true }));
app.use('/cart', createProxyMiddleware({ target: 'http://localhost:3003', changeOrigin: true }));
app.use('/inventory', createProxyMiddleware({ target: 'http://localhost:3004', changeOrigin: true }));
app.use('/payments', createProxyMiddleware({ target: 'http://localhost:3005', changeOrigin: true }));
app.use('/recommendations', createProxyMiddleware({ target: 'http://localhost:8000', changeOrigin: true }));

const PORT = 8080;
app.listen(PORT, () => {
    console.log(`Node.js API Gateway running on port ${PORT}`);
});
