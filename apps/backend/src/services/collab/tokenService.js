import crypto from 'crypto';
import { COLLAB_TOKEN_SECRET, COLLAB_TOKEN_TTL } from '../../config/constants.js';

const TOKEN_VERSION = 1;

function base64UrlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, 'base64');
}

function sign(data) {
  return crypto.createHmac('sha256', COLLAB_TOKEN_SECRET).update(data).digest();
}

export function issueToken({ projectId, role = 'admin', ttlSeconds = COLLAB_TOKEN_TTL }) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = { v: TOKEN_VERSION, pid: projectId, role, exp };
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(sign(body));
  return `op1.${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [prefix, body, sig] = parts;
  if (prefix !== 'op1') return null;
  const expected = base64UrlEncode(sign(body));
  const expectedBuf = Buffer.from(expected);
  const sigBuf = Buffer.from(sig);
  if (expectedBuf.length !== sigBuf.length) return null;
  if (!crypto.timingSafeEqual(expectedBuf, sigBuf)) return null;
  try {
    const payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
    if (payload.v !== TOKEN_VERSION) return null;
    if (!payload.pid || payload.role !== 'admin') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { projectId: payload.pid, role: payload.role, exp: payload.exp };
  } catch {
    return null;
  }
}
