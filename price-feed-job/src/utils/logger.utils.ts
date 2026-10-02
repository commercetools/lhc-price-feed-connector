/**
 * Structured JSON logging. Connect's log viewer is the only window into a deployed application, and a
 * line nobody can filter is a line nobody reads — so every entry is one JSON object, and every entry
 * inside a request carries the correlation key (`X-Correlation-ID` for a service, `resource.id` +
 * `sequenceNumber` for an event).
 */
type Level = 'debug' | 'info' | 'warn' | 'error';

const THRESHOLD: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN = THRESHOLD[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? THRESHOLD.info;

function emit(level: Level, message: string, context: Record<string, unknown> = {}): void {
  if (THRESHOLD[level] < MIN) return;
  const line = JSON.stringify({ level, message, at: new Date().toISOString(), ...context });
  if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};
