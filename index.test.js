import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { verifySignature, parseBody, handleWebhookEvent } from './index.js';
import { createHmac } from 'crypto';

test('verifySignature validates correct signature', () => {
  const secret = 'test-secret';
  const body = '{"type":"test"}';
  const signature = createHmac('sha256', secret).update(body).digest('hex');
  
  assert.ok(verifySignature(body, signature, secret));
  assert.ok(verifySignature(body, `sha256=${signature}`, secret));
});

test('verifySignature rejects invalid signature', () => {
  const secret = 'test-secret';
  const body = '{"type":"test"}';
  const wrongSignature = 'invalid';
  
  assert.ok(!verifySignature(body, wrongSignature, secret));
});

test('verifySignature returns false for empty secret or signature', () => {
  const body = '{"type":"test"}';
  
  assert.ok(!verifySignature(body, 'signature', ''));
  assert.ok(!verifySignature(body, '', 'secret'));
});

test('verifySignature handles invalid hex in signature', () => {
  const secret = 'test-secret';
  const body = '{"type":"test"}';
  
  assert.ok(!verifySignature(body, 'not-valid-hex', secret));
  assert.ok(!verifySignature(body, 'sha256=not-valid-hex', secret));
});

test('parseBody parses valid JSON', () => {
  const data = { type: 'test', id: 123 };
  const chunks = [Buffer.from(JSON.stringify(data))];
  
  const result = parseBody(chunks);
  
  assert.deepEqual(result.data, data);
  assert.ok(result.raw);
  assert.equal(result.error, undefined);
});

test('parseBody handles invalid JSON', () => {
  const chunks = [Buffer.from('not json')];
  
  const result = parseBody(chunks);
  
  assert.equal(result.data, null);
  assert.equal(result.error, 'Invalid JSON');
});

test('parseBody handles multiple chunks', () => {
  const data = { type: 'test', id: 123 };
  const json = JSON.stringify(data);
  const mid = Math.floor(json.length / 2);
  const chunks = [
    Buffer.from(json.slice(0, mid)),
    Buffer.from(json.slice(mid))
  ];
  
  const result = parseBody(chunks);
  
  assert.deepEqual(result.data, data);
});

test('handleWebhookEvent processes appointment events', async () => {
  const event = {
    type: 'appointment.created',
    data: { id: 'apt-123' }
  };
  
  const result = await handleWebhookEvent(event);
  
  assert.equal(result.status, 'processed');
  assert.equal(result.type, 'appointment.created');
});

test('handleWebhookEvent processes customer events', async () => {
  const event = {
    type: 'customer.updated',
    data: { id: 'cust-456' }
  };
  
  const result = await handleWebhookEvent(event);
  
  assert.equal(result.status, 'processed');
  assert.equal(result.type, 'customer.updated');
});

test('handleWebhookEvent processes payment events', async () => {
  const event = {
    type: 'payment.completed',
    data: { id: 'pay-789' }
  };
  
  const result = await handleWebhookEvent(event);
  
  assert.equal(result.status, 'processed');
  assert.equal(result.type, 'payment.completed');
});

test('handleWebhookEvent ignores unknown events', async () => {
  const event = {
    type: 'unknown.event',
    data: { id: 'unk-999' }
  };
  
  const result = await handleWebhookEvent(event);
  
  assert.equal(result.status, 'ignored');
  assert.equal(result.type, 'unknown.event');
});
