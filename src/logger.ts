/**
 * Log lines carry a wall-clock `time`: they describe the run, never the data, so reading the clock
 * here does not affect determinism (§12).
 */
import type { HttpClientEvent, HttpRequest } from './http/index.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Keys the logger writes itself; a field never uses them (e.g. a territorial level is `territoryLevel`). */
type ReservedLogKey = 'time' | 'level' | 'msg';

export type LogFields = Record<string, unknown> & Partial<Record<ReservedLogKey, never>>;

export interface Logger {
  debug: (msg: string, fields?: LogFields) => void;
  info: (msg: string, fields?: LogFields) => void;
  warn: (msg: string, fields?: LogFields) => void;
  error: (msg: string, fields?: LogFields) => void;
}

export interface LoggerOptions {
  /** Receives one line, newline included. */
  write: (line: string) => void;
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
      const line: Record<string, unknown> = { time: new Date(now()).toISOString(), level, msg };
      // Reserved keys are refused by the types; untyped callers can still never replace them.
      for (const [key, value] of Object.entries(fields)) if (!(key in line)) line[key] = value;
      options.write(`${JSON.stringify(line, errorReplacer)}\n`);
    };
  return { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') };
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function errorReplacer(_key: string, value: unknown): unknown {
  return value instanceof Error ? { name: value.name, message: value.message } : value;
}

/** Log levels describe the run; anomaly severity is decided elsewhere (§6.1). */
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
        // Recoverable: requests of the family wait for a probe (§6.1).
        logger.warn(event.reopened ? 'http circuit reopened' : 'http circuit open', {
          event: event.type,
          family: event.family,
          reason: event.reason,
          retry_in_ms: event.retryInMs,
        });
        return;
      case 'circuit-closed':
        logger.info('http circuit closed', { event: event.type, family: event.family, open_ms: event.openMs });
        return;
      case 'circuit-lost':
        logger.error('http circuit lost', {
          event: event.type,
          family: event.family,
          reason: event.reason,
          open_ms: event.openMs,
        });
        return;
      case 'validation-error':
        // One line when the endpoint is disabled; later requests are refused silently (counted).
        (event.disabled ? logger.error : logger.debug)(
          event.disabled ? 'http endpoint disabled' : 'http validation error',
          {
            event: event.type,
            endpoint: event.endpoint,
            ...requestFields(event.request),
            error: event.error.message,
            issues: event.error.issues.slice(0, 10),
          },
        );
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
      case 'request-held':
        // Out of attempts while its family is failing: it waits for the family's verdict (§6.1).
        logger.info('http request held', {
          event: event.type,
          endpoint: event.endpoint,
          ...requestFields(event.request),
          attempts: event.attempts,
          reason: event.reason,
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

/** Both unencoded. */
function requestFields(request: HttpRequest): LogFields {
  return request.body === undefined ? { url: request.url } : { url: request.url, body: request.body };
}
