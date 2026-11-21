import pino from 'pino';
import { config } from './config.js';

/**
 * Structured JSON logs (one object per line) so a log platform can filter by
 * level, request id, instance, rfqId, etc. Secrets are redacted.
 */
export const logger = pino({
  level: config.logLevel,
  base: { instance: config.instanceId },
  redact: {
    paths: ['req.headers.cookie', 'res.headers["set-cookie"]', 'req.headers.authorization', '*.password', '*.password_hash'],
    censor: '[redacted]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});
