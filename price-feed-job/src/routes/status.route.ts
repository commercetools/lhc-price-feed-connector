import { Router } from 'express';

const statusRouter: Router = Router();
statusRouter.get('/', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});
export default statusRouter;
