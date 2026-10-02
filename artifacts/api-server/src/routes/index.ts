import { Router, type IRouter } from "express";
import healthRouter from "./health";
import categoriesRouter from "./categories";
import coursesRouter from "./courses";
import enrollmentsRouter from "./enrollments";
import announcementsRouter from "./announcements";
import announcementActivityReviewRouter from "./announcement-activity-review";
import usersRouter from "./users";
import dashboardRouter from "./dashboard";
import radiantAuditsRouter from "./radiant-audits";
import membershipRouter from "./membership";
import memberStoriesRouter from "./member-stories";
import routineGuideRouter from "./routine-guide";

const router: IRouter = Router();

router.use(healthRouter);
router.use(categoriesRouter);
router.use(coursesRouter);
router.use(enrollmentsRouter);
router.use(announcementActivityReviewRouter);
router.use(announcementsRouter);
router.use(usersRouter);
router.use(dashboardRouter);
router.use(radiantAuditsRouter);
router.use(membershipRouter);
router.use(memberStoriesRouter);
router.use(routineGuideRouter);

export default router;
