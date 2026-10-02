import 'dotenv/config';
import express, { type Express } from 'express';
import { readConfiguration } from './utils/config.utils.js';
import { logger } from './utils/logger.utils.js';
import jobRouter from './routes/job.route.js';
import statusRouter from './routes/status.route.js';

// Fail fast on configuration at boot (e.g. FEED_URL missing), not at 02:00 when the scheduler calls.
readConfiguration();

/**
 * A Connect JOB application is still an HTTP application: the scheduler provisioned at deployment sends
 * a `POST` to the `endpoint` declared in connect.yaml on every cron tick, and expects a `200`. There is
 * no request body. A job that runs at process start and exits would never be called.
 */
export const app: Express = express();
app.disable('x-powered-by');

app.use('/status', statusRouter);
// Must match `endpoint` in connect.yaml.
app.use('/price-feed', jobRouter);

const PORT = Number(process.env.PORT ?? 8080);
/* c8 ignore start */
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => logger.info('price-feed-job listening', { port: PORT }));
}
/* c8 ignore stop */
export default app;
