import { Router } from "express";
import path from "path";
import { fileURLToPath } from "url";

const router = Router();

// __dirname polyfill for ES module compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve the dashboard.html file
router.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/dashboard.html"));
});

export default router;
