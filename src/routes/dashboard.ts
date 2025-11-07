import { Router } from "express";
import path from "path";

const router = Router();

// Serve the dashboard.html file from /public
router.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../../public/dashboard.html"));
});

export default router;
