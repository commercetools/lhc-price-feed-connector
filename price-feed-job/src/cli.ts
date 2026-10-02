import 'dotenv/config';
import { runPriceFeed } from './jobs/price-feed.job.js';
import { logger } from './utils/logger.utils.js';

/**
 * Local development only: run the job once, without the HTTP server — `npm run once`.
 * Exits non-zero when any row failed, so it can gate a script.
 */
runPriceFeed()
  .then((outcome) => {
    logger.info('Run outcome', { ...outcome });
    process.exitCode = outcome.status === 'failed' ? 1 : 0;
  })
  .catch((error: Error) => {
    logger.error('Price feed failed', { reason: error.message, stack: error.stack });
    process.exitCode = 1;
  });
