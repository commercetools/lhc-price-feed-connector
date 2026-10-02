import { Router } from 'express';
import { runPriceFeed } from '../jobs/price-feed.job.js';
import { logger } from '../utils/logger.utils.js';

/**
 * The scheduler's trigger. The whole run happens inside this request (a job request may take up to
 * 30 minutes), and the answer is:
 *
 * - **200** when the run completed — including a run where some rows failed. Those are already logged
 *   at ERROR one by one, and the body says `failed`; the run itself did its job of reporting them.
 * - **500** when the run could not complete at all (the feed host was down, credentials were rejected).
 *   That is the red the deployment log should show.
 */
const jobRouter: Router = Router();

jobRouter.post('/', async (_req, res) => {
  try {
    const outcome = await runPriceFeed();
    res.status(200).json(outcome);
  } catch (error) {
    logger.error('Price feed failed', { reason: (error as Error).message, stack: (error as Error).stack });
    res.status(500).json({ status: 'error', reason: (error as Error).message });
  }
});

export default jobRouter;
