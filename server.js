const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const swaggerUi = require("swagger-ui-express");
const swaggerDoc = require("./swagger.json");

const app = express();
const PORT = 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

// ─────────────────────────────────────────────
// Public products API (unrelated, keep as-is)
// ─────────────────────────────────────────────
app.get("/products", (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const filePath = path.join(__dirname, "products_converted.json");

  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      return res.status(500).json({ message: "Error reading file" });
    }
    const products = JSON.parse(data);
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedData = products.slice(startIndex, endIndex);
    return res.json({
      page,
      limit,
      totalRecords: products.length,
      totalPages: Math.ceil(products.length / limit),
      data: paginatedData
    });
  });
});

// ─────────────────────────────────────────────
// In-memory data stores
// ─────────────────────────────────────────────
const CLIENT = {
  id: crypto.randomUUID(),
  name: "Your Company"
};

const SITES = [
  {
    id: crypto.randomUUID(),
    name: "Store-1",
    location: "Demo Location"
  }
];

const ESL_TAGS = new Map();    // id -> tag
const JOBS = new Map();        // id -> job
const JOB_TASKS = new Map();   // jobId -> tasks[]
const ACCESS_TOKENS = new Map();  // token -> { expiresAt }
const REFRESH_TOKENS = new Map(); // refresh -> { expiresAt }
const TEMPLATES = new Map();   // id -> template

const ACCESS_EXPIRES_SEC = 300; // 5 minutes
const REFRESH_EXPIRES_SEC = 60 * 60 * 24 * 7; // 7 days
const DUMMY_CLIENT_ID = "apl54_demo_client";
const DUMMY_CLIENT_SECRET = "apl54_demo_secret";

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function nowIso() {
  return new Date().toISOString();
}

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sendError(res, httpStatus, code, message, details) {
  return res.status(httpStatus).json({
    error: {
      code,
      message,
      details: details || {}
    }
  });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token || !ACCESS_TOKENS.has(token)) {
    return sendError(res, 401, "UNAUTHORIZED", "Missing or invalid token");
  }
  const { expiresAt } = ACCESS_TOKENS.get(token);
  if (Date.now() > expiresAt) {
    ACCESS_TOKENS.delete(token);
    return sendError(res, 401, "UNAUTHORIZED", "Token expired");
  }
  return next();
}

function buildJob(jobType, siteId, tasks) {
  const id = crypto.randomUUID();
  const job = {
    id,
    site_id: siteId,
    job_type: jobType,
    status: "pending",
    total_count: tasks.length,
    completed_count: 0,
    failed_count: 0,
    cancelled_count: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
    finished_at: null
  };
  JOBS.set(id, job);
  JOB_TASKS.set(id, tasks);

  setTimeout(() => {
    job.status = "running";
    job.updated_at = nowIso();
  }, 200);

  setTimeout(() => {
    job.status = "completed";
    job.completed_count = tasks.length;
    job.updated_at = nowIso();
    job.finished_at = nowIso();
    JOBS.set(id, job);
  }, 1200);

  return job;
}

function validateSiteId(siteId) {
  return SITES.some((s) => s.id === siteId);
}

function ensureTemplates() {
  if (TEMPLATES.size > 0) return;
  const t1 = {
    id: crypto.randomUUID(),
    name: "price-barcode-184x88",
    display_type: "184x88",
    version: 1,
    is_active_by_site: {}
  };
  const t2 = {
    id: crypto.randomUUID(),
    name: "price-basic-400x300",
    display_type: "400x300",
    version: 1,
    is_active_by_site: {}
  };
  TEMPLATES.set(t1.id, t1);
  TEMPLATES.set(t2.id, t2);
}

// ─────────────────────────────────────────────
// OAuth2 — POST /oauth/token
// ─────────────────────────────────────────────
app.post("/oauth/token", (req, res) => {
  const { grant_type, client_id, client_secret, refresh_token } = req.body;

  if (grant_type === "client_credentials") {
    if (!client_id || !client_secret) {
      return sendError(res, 400, "VALIDATION_ERROR", "client_id and client_secret required", {
        client_id: !client_id ? "required" : undefined,
        client_secret: !client_secret ? "required" : undefined
      });
    }
    if (client_id !== DUMMY_CLIENT_ID || client_secret !== DUMMY_CLIENT_SECRET) {
      return sendError(res, 401, "UNAUTHORIZED", "Invalid client credentials");
    }
    const accessToken = randomToken();
    const newRefreshToken = randomToken();
    ACCESS_TOKENS.set(accessToken, { expiresAt: Date.now() + ACCESS_EXPIRES_SEC * 1000 });
    REFRESH_TOKENS.set(newRefreshToken, { expiresAt: Date.now() + REFRESH_EXPIRES_SEC * 1000 });
    return res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      expires_in: ACCESS_EXPIRES_SEC,
      token_type: "Bearer"
    });
  }

  if (grant_type === "refresh_token") {
    if (!refresh_token) {
      return sendError(res, 400, "VALIDATION_ERROR", "refresh_token required", {
        refresh_token: "required"
      });
    }
    const tokenInfo = REFRESH_TOKENS.get(refresh_token);
    if (!tokenInfo || Date.now() > tokenInfo.expiresAt) {
      return sendError(res, 401, "UNAUTHORIZED", "Invalid or expired refresh token");
    }
    const accessToken = randomToken();
    ACCESS_TOKENS.set(accessToken, { expiresAt: Date.now() + ACCESS_EXPIRES_SEC * 1000 });
    return res.json({
      access_token: accessToken,
      refresh_token: refresh_token,
      expires_in: ACCESS_EXPIRES_SEC,
      token_type: "Bearer"
    });
  }

  return sendError(res, 400, "VALIDATION_ERROR", "Unsupported grant_type", {
    grant_type: "Use client_credentials or refresh_token"
  });
});

// ─────────────────────────────────────────────
// Swagger docs
// ─────────────────────────────────────────────
app.get("/swagger.json", (req, res) => res.json(swaggerDoc));
app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));

// ─────────────────────────────────────────────
// API v1 Router (all routes require auth)
// ─────────────────────────────────────────────
const api = express.Router();
api.use(requireAuth);

// ── GET /me ──────────────────────────────────
api.get("/me", (req, res) => {
  res.json({
    data: {
      client: CLIENT,
      sites: SITES
    }
  });
});

// ── GET /sites ───────────────────────────────
api.get("/sites", (req, res) => {
  res.json({ data: SITES });
});

// ─────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────

// GET /templates?site_id=&page=&page_size=
api.get("/templates", (req, res) => {
  ensureTemplates();
  const { site_id } = req.query;
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.page_size, 10) || 20;

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  const all = Array.from(TEMPLATES.values()).map((t) => ({
    id: t.id,
    name: t.name,
    display_type: t.display_type,
    version: t.version,
    is_active: Boolean(t.is_active_by_site[site_id])
  }));

  const start = (page - 1) * pageSize;
  const data = all.slice(start, start + pageSize);

  return res.json({
    data,
    meta: { page, page_size: pageSize, total: all.length }
  });
});

// POST /templates/:template_id/preview
// Body: { site_id, payload: { currency, price, product_id, ... } }
api.post("/templates/:template_id/preview", (req, res) => {
  ensureTemplates();
  const template = TEMPLATES.get(req.params.template_id);
  if (!template) {
    return sendError(res, 404, "NOT_FOUND", "Template not found");
  }

  const { site_id, payload } = req.body || {};

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }
  if (!payload || typeof payload !== "object") {
    return sendError(res, 400, "VALIDATION_ERROR", "payload required", { payload: "required" });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  const previewPayload = Buffer.from(
    `template:${template.id};site:${site_id};ts:${Date.now()}`,
    "utf8"
  ).toString("base64");

  return res.json({
    data: {
      template_id: template.id,
      content_type: "image/png",
      image_base64: previewPayload
    }
  });
});

// POST /templates/:template_id/activate
// Body: { site_id }
api.post("/templates/:template_id/activate", (req, res) => {
  ensureTemplates();
  const template = TEMPLATES.get(req.params.template_id);
  if (!template) {
    return sendError(res, 404, "NOT_FOUND", "Template not found");
  }

  const { site_id } = req.body || {};

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  // Only one template per display_type active per site
  Array.from(TEMPLATES.values()).forEach((t) => {
    if (t.display_type === template.display_type) {
      t.is_active_by_site[site_id] = false;
    }
  });
  template.is_active_by_site[site_id] = true;

  return res.json({
    data: {
      template_id: template.id,
      display_type: template.display_type,
      is_active: true,
      activated_at: nowIso()
    }
  });
});

// ─────────────────────────────────────────────
// ESL TAGS
// ─────────────────────────────────────────────

// GET /esl?site_id=&page=&page_size=
api.get("/esl", (req, res) => {
  const { site_id } = req.query;
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.page_size, 10) || 50;

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }

  const all = Array.from(ESL_TAGS.values()).filter((t) => t.site_id === site_id);
  const start = (page - 1) * pageSize;
  const data = all.slice(start, start + pageSize);

  return res.json({
    data,
    meta: { page, page_size: pageSize, total: all.length }
  });
});

// POST /esl — Register ESL tag
// Body: { site_id, ap_id?, mac_address, display_type, metadata? }
api.post("/esl", (req, res) => {
  const { site_id, ap_id, mac_address, display_type, metadata } = req.body || {};

  if (!site_id || !mac_address || !display_type) {
    return sendError(res, 400, "VALIDATION_ERROR", "Missing required fields", {
      site_id: !site_id ? "required" : undefined,
      mac_address: !mac_address ? "required" : undefined,
      display_type: !display_type ? "required" : undefined
    });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  const id = crypto.randomUUID();
  const tag = {
    id,
    site_id,
    ap_id: ap_id || null,
    mac_address,
    display_type,
    status: "inactive",
    battery_level: null,
    firmware_version: null,
    metadata: metadata || {},
    created_at: nowIso(),
    updated_at: nowIso()
  };
  ESL_TAGS.set(id, tag);

  return res.status(201).json({ data: tag });
});

// PATCH /esl/:id — Update ESL tag
// Body: { ap_id?, status?, metadata? }
api.patch("/esl/:id", (req, res) => {
  const tag = ESL_TAGS.get(req.params.id);
  if (!tag) {
    return sendError(res, 404, "NOT_FOUND", "ESL tag not found");
  }

  const { ap_id, status, metadata } = req.body || {};
  if (ap_id !== undefined) tag.ap_id = ap_id;
  if (status !== undefined) tag.status = status;
  if (metadata !== undefined) tag.metadata = metadata;
  tag.updated_at = nowIso();

  ESL_TAGS.set(tag.id, tag);
  return res.json({ data: tag });
});

// POST /esl/:id/reset — Reset ESL tag (device reset)
// Body: { site_id, reason? }
api.post("/esl/:id/reset", (req, res) => {
  const tag = ESL_TAGS.get(req.params.id);
  if (!tag) {
    return sendError(res, 404, "NOT_FOUND", "ESL tag not found");
  }

  const { site_id, reason } = req.body || {};

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }
  if (tag.ap_id == null) {
    return sendError(res, 409, "AP_NOT_ASSIGNED", "Tag has no assigned AP");
  }

  const tasks = [
    {
      id: crypto.randomUUID(),
      esl_id: tag.id,
      reason: reason || null,
      status: "pending"
    }
  ];
  const job = buildJob("reset", site_id, tasks);

  return res.status(202).json({
    data: {
      job_id: job.id,
      status: job.status,
      total_count: job.total_count
    }
  });
});

// DELETE /esl/:id?site_id= — Delete ESL tag from DB
api.delete("/esl/:id", (req, res) => {
  const { site_id } = req.query;

  if (!site_id) {
    return sendError(res, 400, "VALIDATION_ERROR", "site_id required", { site_id: "required" });
  }

  const tag = ESL_TAGS.get(req.params.id);
  if (!tag) {
    return sendError(res, 404, "NOT_FOUND", "ESL tag not found");
  }

  const hasActiveJob = Array.from(JOBS.values()).some((job) => {
    if (job.status === "completed" || job.status === "failed") return false;
    const tasks = JOB_TASKS.get(job.id) || [];
    return tasks.some((t) => t.esl_id === req.params.id);
  });

  if (hasActiveJob) {
    return sendError(res, 409, "CONFLICT", "Tag has active jobs");
  }

  ESL_TAGS.delete(req.params.id);
  return res.status(204).send();
});

// ─────────────────────────────────────────────
// ESL UPDATE JOBS
// ─────────────────────────────────────────────

// POST /esl/update — Single ESL update
// Body: { site_id, esl_id, template_id, payload: { name, price, ean, ... } }
api.post("/esl/update", (req, res) => {
  const { site_id, esl_id, template_id, payload } = req.body || {};

  if (!site_id || !esl_id || !template_id || !payload) {
    return sendError(res, 400, "VALIDATION_ERROR", "Missing required fields", {
      site_id: !site_id ? "required" : undefined,
      esl_id: !esl_id ? "required" : undefined,
      template_id: !template_id ? "required" : undefined,
      payload: !payload ? "required" : undefined
    });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  const tasks = [
    {
      id: crypto.randomUUID(),
      esl_id,
      template_id,
      payload,
      status: "pending"
    }
  ];
  const job = buildJob("single", site_id, tasks);

  return res.status(202).json({
    data: {
      job_id: job.id,
      status: job.status,
      total_count: job.total_count
    }
  });
});

// POST /esl/batch-update — Batch ESL update (up to 1000)
// Body: { site_id, items: [{ esl_id, template_id, payload }] }
api.post("/esl/batch-update", (req, res) => {
  const { site_id, items } = req.body || {};

  if (!site_id || !Array.isArray(items)) {
    return sendError(res, 400, "VALIDATION_ERROR", "Missing required fields", {
      site_id: !site_id ? "required" : undefined,
      items: !items ? "required" : undefined
    });
  }
  if (items.length === 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "items must not be empty", {
      items: "at least 1 item required"
    });
  }
  if (items.length > 1000) {
    return sendError(res, 400, "VALIDATION_ERROR", "items exceeds limit", {
      items: "max 1000"
    });
  }
  if (!validateSiteId(site_id)) {
    return sendError(res, 404, "NOT_FOUND", "site_id not found");
  }

  // Validate each item
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.esl_id || !item.template_id || !item.payload) {
      return sendError(res, 400, "VALIDATION_ERROR", `Item at index ${i} is missing required fields`, {
        esl_id: !item.esl_id ? "required" : undefined,
        template_id: !item.template_id ? "required" : undefined,
        payload: !item.payload ? "required" : undefined
      });
    }
  }

  const tasks = items.map((item) => ({
    id: crypto.randomUUID(),
    esl_id: item.esl_id,
    template_id: item.template_id,
    payload: item.payload,
    status: "pending"
  }));
  const job = buildJob("batch", site_id, tasks);

  return res.status(202).json({
    data: {
      job_id: job.id,
      status: job.status,
      total_count: job.total_count
    }
  });
});

// ─────────────────────────────────────────────
// JOBS
// ─────────────────────────────────────────────

// GET /jobs/:id — Job summary
api.get("/jobs/:id", (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) {
    return sendError(res, 404, "NOT_FOUND", "Job not found");
  }
  return res.json({ data: job });
});

// GET /jobs/:id/tasks — Task-level details
api.get("/jobs/:id/tasks", (req, res) => {
  const jobId = req.params.id;
  if (!JOBS.has(jobId)) {
    return sendError(res, 404, "NOT_FOUND", "Job not found");
  }

  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.page_size, 10) || 50;
  const tasks = JOB_TASKS.get(jobId) || [];
  const start = (page - 1) * pageSize;
  const data = tasks.slice(start, start + pageSize);

  return res.json({
    data,
    meta: { page, page_size: pageSize, total: tasks.length }
  });
});

// ─────────────────────────────────────────────
// Mount router
// ─────────────────────────────────────────────
app.use("/api/v1", api);

app.listen(PORT, () => {
  console.log(`Mock ESL API running on port ${PORT}`);
  console.log(`Swagger UI: http://localhost:${PORT}/docs`);
});
