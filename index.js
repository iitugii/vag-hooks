import { createServer } from 'http';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Lean and efficient Vagaro webhook handler
 * Minimal dependencies, optimized performance
 */

// Configuration
const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_BODY_SIZE = parseInt(process.env.MAX_BODY_SIZE || '1048576', 10); // 1MB default

/**
 * Verify webhook signature for security (timing-safe comparison)
 * @param {string} body - Raw request body
 * @param {string} signature - Signature from header
 * @param {string} secret - Webhook secret
 * @returns {boolean}
 */
function verifySignature(body, signature, secret) {
  if (!secret || !signature) return false;
  
  const expectedSignature = createHmac('sha256', secret)
    .update(body)
    .digest('hex');
  
  // Remove 'sha256=' prefix if present
  const cleanSignature = signature.startsWith('sha256=') 
    ? signature.slice(7) 
    : signature;
  
  // Use timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(expectedSignature, 'hex'),
      Buffer.from(cleanSignature, 'hex')
    );
  } catch (e) {
    // Buffer lengths don't match or invalid hex
    return false;
  }
}

/**
 * Parse JSON body efficiently
 * @param {Buffer[]} chunks - Body chunks
 * @returns {Object}
 */
function parseBody(chunks) {
  const body = Buffer.concat(chunks).toString();
  try {
    return { data: JSON.parse(body), raw: body };
  } catch (e) {
    return { data: null, raw: body, error: 'Invalid JSON' };
  }
}

/**
 * Handle webhook events
 * @param {Object} event - Parsed webhook event
 * @returns {Promise<Object>}
 */
async function handleWebhookEvent(event) {
  // Efficient event type routing
  const { type, data } = event;
  
  switch (type) {
    case 'appointment.created':
    case 'appointment.updated':
    case 'appointment.cancelled':
      return handleAppointmentEvent(type, data);
    
    case 'customer.created':
    case 'customer.updated':
      return handleCustomerEvent(type, data);
    
    case 'payment.completed':
    case 'payment.failed':
      return handlePaymentEvent(type, data);
    
    default:
      return { status: 'ignored', type };
  }
}

/**
 * Handle appointment events
 */
function handleAppointmentEvent(type, data) {
  console.log(`[Appointment] ${type}:`, data?.id);
  // Implement your appointment logic here
  return { status: 'processed', type };
}

/**
 * Handle customer events
 */
function handleCustomerEvent(type, data) {
  console.log(`[Customer] ${type}:`, data?.id);
  // Implement your customer logic here
  return { status: 'processed', type };
}

/**
 * Handle payment events
 */
function handlePaymentEvent(type, data) {
  console.log(`[Payment] ${type}:`, data?.id);
  // Implement your payment logic here
  return { status: 'processed', type };
}

/**
 * Create HTTP server with minimal overhead
 */
const server = createServer(async (req, res) => {
  // Only handle POST requests to /webhook
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  const chunks = [];
  let bodySize = 0;
  
  req.on('data', chunk => {
    bodySize += chunk.length;
    
    // Prevent memory exhaustion attacks
    if (bodySize > MAX_BODY_SIZE) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request body too large' }));
      req.destroy();
      return;
    }
    
    chunks.push(chunk);
  });
  
  req.on('end', async () => {
    const { data, raw, error } = parseBody(chunks);
    
    if (error) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
      return;
    }

    // Verify signature if secret is configured
    if (WEBHOOK_SECRET) {
      const signature = req.headers['x-vagaro-signature'] || req.headers['x-webhook-signature'];
      if (!verifySignature(raw, signature, WEBHOOK_SECRET)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }
    }

    try {
      // Process webhook event
      const result = await handleWebhookEvent(data);
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, result }));
    } catch (err) {
      console.error('Webhook processing error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Processing failed' }));
    }
  });

  req.on('error', (err) => {
    console.error('Request error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Request error' }));
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`Vagaro webhook server running on port ${PORT}`);
  console.log(`Signature verification: ${WEBHOOK_SECRET ? 'ENABLED' : 'DISABLED'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export { verifySignature, parseBody, handleWebhookEvent };
