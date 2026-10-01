/**
 * Minimal NDJSON logger (§12.0 Logging): one JSON object per line, written to stderr by the CLI.
 * Levels `debug|info|warn|error`; `debug` lines are written only with `--verbose`.
 *
 * Log lines carry a wall-clock `time`: they describe the run, never the data, so reading the
 * clock here does not affect determinism.
 */
import type { HttpClientEvent, HttpRequest } from './http/index.ts';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
}

export interface LoggerOptions {
  /** Receives one line, newline included. */
  write: (line: string) => void;
  /** Enables `debug`. */
  verbose?: boolean;
  /** Milliseconds since the epoch. */
  now?: () => number;
}

export function createLogger(options: LoggerOptions): Logger {
  const now = options.now ?? (() => Date.now());
  const log =
    (level: LogLevel) =>
    (msg: string, fields: LogFields = {}): void => {
      if (level === 'debug' && options.verbose !== true) return;
      const line = { time: new Date(now()).toISOString(), level, msg, ...fields };
      options.write(`${JSON.stringify(line, errorReplacer)}\n`);
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

/** A logger that drops everything. */
export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

/**
 * `onEvent` handler of the HTTP client that logs its notifications. Log levels describe the run;
 * anomaly severity is decided elsewhere (§6.1).
 */
export function logHttpEvents(logger: Logger): (event: HttpClientEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'retry':
        logger.info('http retry', {
          event: event.type,
          endpoint: event.endpoint,
          ...requestFields(event.request),
          attempt: event.attempt,
          reason: event.reason,
          delay_ms: event.delayMs,
        });
        return;
      case 'concurrency':
        logger.debug('http concurrency', { event: event.type, host: event.host, limit: event.limit });
        return;
      case 'circuit-open':
        logger.error('http circuit open', { event: event.type, family: event.family, reason: event.reason });
        return;
      case 'validation-error':
        logger.error('http validation error', {
          event: event.type,
          endpoint: event.endpoint,
          ...requestFields(event.request),
          error: event.error.message,
          issues: event.error.issues.slice(0, 10),
        });
        return;
      case 'changed':
        logger.warn('http content changed', {
          event: event.type,
          endpoint: event.endpoint,
          ...requestFields(event.request),
          previous_content_hash: event.previousContentHash,
          content_hash: event.contentHash,
        });
        return;
      case 'degraded':
        logger.warn('http degraded to stale cache', {
          event: event.type,
          endpoint: event.endpoint,
          ...requestFields(event.request),
          fetched_at: event.fetchedAt,
          reason: event.reason,
        });
        return;
    }
  };
}

/** URL and, for internal reports, the body carrying the report URL (both unencoded). */
function requestFields(request: HttpRequest): LogFields {
  return request.body === undefined ? { url: request.url } : { url: request.url, body: request.body };
}
