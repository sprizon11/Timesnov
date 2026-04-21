require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs/promises");
const session = require("express-session");
const nodemailer = require("nodemailer");

const app = express();

const PORT = Number(process.env.PORT) || 5000;
const allowedOrigin = process.env.CLIENT_ORIGIN || "*";
const LEADS_FILE = path.join(__dirname, "data", "leads.json");
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-session-secret";

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpSecure = String(process.env.SMTP_SECURE || "false") === "true";
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const mailTo = process.env.MAIL_TO;

const transporter =
  smtpHost && smtpUser && smtpPass && mailTo
    ? nodemailer.createTransport({
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
      })
    : null;

async function ensureLeadsFile() {
  await fs.mkdir(path.join(__dirname, "data"), { recursive: true });
  try {
    await fs.access(LEADS_FILE);
  } catch {
    await fs.writeFile(LEADS_FILE, "[]", "utf-8");
  }
}

async function readLeads() {
  await ensureLeadsFile();
  const content = await fs.readFile(LEADS_FILE, "utf-8");
  return JSON.parse(content);
}

async function writeLeads(leads) {
  await ensureLeadsFile();
  await fs.writeFile(LEADS_FILE, JSON.stringify(leads, null, 2), "utf-8");
}

function toCsv(leads) {
  const headers = [
    "id",
    "name",
    "email",
    "phone",
    "service",
    "message",
    "status",
    "receivedAt",
  ];
  const escape = (value) =>
    `"${String(value ?? "")
      .replace(/"/g, '""')
      .replace(/\r?\n/g, " ")}"`;
  const rows = leads.map((lead) =>
    headers.map((header) => escape(lead[header])).join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

function normalizeLead(lead) {
  return {
    ...lead,
    phone: lead.phone || "",
    service: lead.service || "",
    status: lead.status || "new",
  };
}

function filterLeads(leads, query) {
  const status = String(query.status || "all").toLowerCase();
  const search = String(query.search || "").trim().toLowerCase();
  const from = query.from ? new Date(String(query.from)) : null;
  const to = query.to ? new Date(String(query.to)) : null;

  return leads.filter((lead) => {
    const leadDate = new Date(lead.receivedAt);
    const leadStatus = String(lead.status || "new").toLowerCase();

    if (status !== "all" && leadStatus !== status) return false;
    if (from && !Number.isNaN(from.getTime()) && leadDate < from) return false;
    if (to && !Number.isNaN(to.getTime())) {
      const end = new Date(to);
      end.setHours(23, 59, 59, 999);
      if (leadDate > end) return false;
    }
    if (search) {
      const haystack = `${lead.name} ${lead.email} ${lead.phone || ""} ${lead.service || ""} ${lead.message}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function buildReportFileName(query) {
  const sanitizeDate = (value) => {
    const d = new Date(String(value || ""));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  };

  const from = sanitizeDate(query.from);
  const to = sanitizeDate(query.to);

  if (from && to) {
    if (from === to) return `timenov-report-${from}.csv`;
    return `timenov-report-${from}-to-${to}.csv`;
  }
  if (from) return `timenov-report-from-${from}.csv`;
  if (to) return `timenov-report-until-${to}.csv`;
  return `timenov-report-${new Date().toISOString().slice(0, 10)}.csv`;
}

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    return next();
  }
  return res.status(401).json({ ok: false, message: "Unauthorized" });
}

app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin,
    credentials: true,
  })
);
app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 24 * 60 * 60 * 1000,
    },
  })
);
app.use(express.static(path.join(__dirname)));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "timenov_v2.html"));
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({
    ok: true,
    message: "Backend is running",
  });
});

app.post("/api/contact", async (req, res) => {
  const { name, email, phone, service, message } = req.body || {};

  const errors = {};

  if (!name || typeof name !== "string" || name.trim().length < 2) {
    errors.name = "Name must be at least 2 characters.";
  }

  if (!email || typeof email !== "string") {
    errors.email = "Email is required.";
  } else {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email.trim())) {
      errors.email = "Please provide a valid email address.";
    }
  }

  if (!message || typeof message !== "string" || message.trim().length < 10) {
    errors.message = "Message must be at least 10 characters.";
  }

  if (!phone || typeof phone !== "string") {
    errors.phone = "Phone number is required.";
  } else {
    const cleanPhone = phone.replace(/[^\d+]/g, "");
    if (cleanPhone.length < 10) {
      errors.phone = "Please provide a valid phone number.";
    }
  }

  const allowedServices = new Set([
    "web-development",
    "software-development",
    "app-development",
    "ai-automation",
    "chatbot-development",
    "website-optimization",
  ]);
  if (!service || typeof service !== "string" || !allowedServices.has(service)) {
    errors.service = "Please select a valid service.";
  }

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      ok: false,
      message: "Validation failed",
      errors,
    });
  }

  const lead = {
    id: Date.now().toString(),
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone.trim(),
    service: service.trim(),
    message: message.trim(),
    status: "new",
    receivedAt: new Date().toISOString(),
  };

  try {
    const leads = await readLeads();
    leads.unshift(lead);
    await writeLeads(leads);
  } catch (error) {
    console.error("Failed to save lead:", error);
    return res.status(500).json({
      ok: false,
      message: "Could not save your inquiry. Please try again.",
    });
  }

  if (transporter) {
    try {
      await transporter.sendMail({
        from: smtpUser,
        to: mailTo,
        subject: `New Timenov lead from ${lead.name}`,
        text: `Name: ${lead.name}\nEmail: ${lead.email}\nPhone: ${lead.phone}\nService: ${lead.service}\nReceived: ${lead.receivedAt}\n\nMessage:\n${lead.message}`,
      });
    } catch (error) {
      console.error("Failed to send lead email:", error);
    }
  } else {
    console.log("Mail transporter not configured. Lead stored locally only.");
  }

  console.log("New contact inquiry saved:", lead);

  return res.status(201).json({
    ok: true,
    message: "Thanks! We received your inquiry.",
  });
});

app.post("/api/admin/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.json({ ok: true, message: "Login successful" });
  }
  return res.status(401).json({ ok: false, message: "Invalid credentials" });
});

app.post("/api/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get("/api/admin/me", (req, res) => {
  res.json({ ok: true, isAdmin: Boolean(req.session?.isAdmin) });
});

app.get("/api/admin/leads", requireAdmin, async (req, res) => {
  const leads = (await readLeads()).map(normalizeLead);
  const filtered = filterLeads(leads, req.query);
  res.json({ ok: true, leads: filtered });
});

app.patch("/api/admin/leads/:id/status", requireAdmin, async (req, res) => {
  const allowed = ["new", "in_progress", "completed"];
  const status = String(req.body?.status || "").toLowerCase();
  if (!allowed.includes(status)) {
    return res.status(400).json({ ok: false, message: "Invalid status value" });
  }

  const leads = await readLeads();
  const index = leads.findIndex((lead) => String(lead.id) === String(req.params.id));
  if (index === -1) {
    return res.status(404).json({ ok: false, message: "Lead not found" });
  }
  leads[index] = { ...leads[index], status };
  await writeLeads(leads);
  return res.json({ ok: true, lead: normalizeLead(leads[index]) });
});

app.get("/api/admin/leads/export.csv", requireAdmin, async (req, res) => {
  const leads = (await readLeads()).map(normalizeLead);
  const filtered = filterLeads(leads, req.query);
  const csv = toCsv(filtered);
  const fileName = buildReportFileName(req.query);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.status(200).send(csv);
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
