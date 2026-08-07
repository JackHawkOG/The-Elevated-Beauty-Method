import { Router, type IRouter } from "express";
import healthRouter from "./health";
import categoriesRouter from "./categories";
import coursesRouter from "./courses";
import enrollmentsRouter from "./enrollments";
import announcementsRouter from "./announcements";
import usersRouter from "./users";
import dashboardRouter from "./dashboard";

const router: IRouter = Router();

router.use(healthRouter);
router.use(categoriesRouter);
router.use(coursesRouter);
router.use(enrollmentsRouter);
router.use(announcementsRouter);
router.use(usersRouter);
router.use(dashboardRouter);

export default router;
