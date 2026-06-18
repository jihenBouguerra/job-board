const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const configPath = path.join(root, "job_search_config.json");
const sourcesPath = path.join(root, "job_sources.json");
const pagePath = path.join(root, "settings.html");
const indexPath = path.join(root, "index.html");

const db = new DatabaseSync(path.join(root, "jobs.db"));
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    location TEXT DEFAULT '',
    country TEXT DEFAULT '',
    work_mode TEXT DEFAULT 'onsite',
    salary TEXT DEFAULT '',
    benefits TEXT DEFAULT '',
    posted_at TEXT DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    keywords TEXT DEFAULT '',
    summary TEXT DEFAULT '',
    fit_score INTEGER DEFAULT 0,
    match_level TEXT DEFAULT 'no_match',
    run_date TEXT NOT NULL DEFAULT '',
    found_at TEXT NOT NULL DEFAULT '',
    status TEXT DEFAULT 'new'
  )
`);
db.exec("PRAGMA journal_mode=WAL;");
try { db.exec("ALTER TABLE jobs ADD COLUMN notes TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE jobs ADD COLUMN applied_at TEXT DEFAULT ''"); } catch {}
let currentRun = null;
let runSerial = 0;
let runState = {
  runId: 0,
  active: false,
  stopping: false,
  logs: [],
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null
};

let scheduleTimer = null;
let lastScheduledRunDate = null;

function getNextRunTime(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.toISOString();
}

function setupSchedule() {
  if (scheduleTimer) { clearInterval(scheduleTimer); scheduleTimer = null; }
  let cfg;
  try { cfg = readJson(configPath).schedule; } catch { return; }
  if (!cfg?.enabled) return;
  const { hour = 8, minute = 0 } = cfg;
  scheduleTimer = setInterval(() => {
    const now = new Date();
    if (now.getHours() !== hour || now.getMinutes() !== minute) return;
    const today = now.toISOString().slice(0, 10);
    if (lastScheduledRunDate === today) return;
    lastScheduledRunDate = today;
    if (currentRun) return;
    try { runNow(); } catch (e) { console.error("Scheduled run failed:", e.message); }
  }, 60_000);
  console.log(`Scheduler enabled: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseMaxJobsPerRun(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "all" || normalized === "unlimited") return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : null;
}

function parseMinimumFitScore(value) {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(100, numeric)) : 0;
}

function parseMaxPostingAgeDays(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "all" || normalized === "unlimited") return null;
    const numeric = Number(normalized);
    return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : null;
}

function resetRunState(runId) {
  runState = {
    runId,
    active: true,
    stopping: false,
    logs: [],
    startedAt: new Date().toISOString(),
    finishedAt: null,
    result: null,
    error: null
  };
}

function clearRunState() {
  runSerial += 1;
  runState = {
    runId: runSerial,
    active: false,
    stopping: false,
    logs: [],
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null
  };
}

function addRunLog(message, runId = runState.runId) {
  if (runId !== runState.runId) return;
  const lines = String(message)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    runState.logs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
  }
  if (runState.logs.length > 500) {
    runState.logs = runState.logs.slice(-500);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function runNow() {
  if (currentRun) throw new Error("A run is already in progress");

  clearRunState();
  const runId = runSerial + 1;
  runSerial = runId;
  resetRunState(runId);
  addRunLog("Worker started.", runId);
  const node = process.execPath;
  let resolveDone;
  const done = new Promise(doneResolve => {
    resolveDone = doneResolve;
  });
  const stdoutChunks = [];
  const stderrChunks = [];
  const child = spawn(node, [path.join(root, "run_now.js")], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", chunk => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", chunk => {
    stderrChunks.push(chunk);
    addRunLog(chunk, runId);
  });
  child.on("error", error => {
    if (currentRun?.id === runId) currentRun = null;
    resolveDone();
    if (runState.runId !== runId) return;
    runState.active = false;
    runState.stopping = false;
    runState.finishedAt = new Date().toISOString();
    runState.error = error.message;
    addRunLog(runState.error, runId);
  });
  child.on("close", (code, signal) => {
    if (currentRun?.id === runId) currentRun = null;
    resolveDone();
    if (runState.runId !== runId) return;
    runState.active = false;
    runState.stopping = false;
    runState.finishedAt = new Date().toISOString();
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (signal === "SIGTERM" || signal === "SIGKILL" || runState.stopping) {
      runState.error = "Run stopped by user";
      addRunLog(runState.error, runId);
      return;
    }
    if (code !== 0) {
      runState.error = stderr || `Worker exited with code ${code}`;
      addRunLog(runState.error, runId);
      return;
    }

    try {
      runState.result = JSON.parse(stdout);
      addRunLog("Worker finished.", runId);
    } catch {
      runState.result = { raw: stdout.trim() };
      addRunLog("Worker finished with raw output.", runId);
    }
  });

  currentRun = { child, id: runId, done, resolveDone };
  return runState;
}

function stopRun() {
  if (!currentRun) return false;
  const run = currentRun;
  addRunLog("Stop requested.", run.id);
  if (runState.runId === run.id) runState.stopping = true;
  const child = run.child;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (!currentRun || currentRun.id !== run.id) return;
    addRunLog("Worker did not stop quickly; forcing stop.", run.id);
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    currentRun = null;
    run.resolveDone();
    if (runState.runId === run.id) {
      runState.active = false;
      runState.stopping = false;
      runState.finishedAt = new Date().toISOString();
      runState.error = "Run stopped by user";
    }
  }, 2500).unref();
  return true;
}

async function prepareFreshRun() {
  if (currentRun) {
    const run = currentRun;
    stopRun();
    await Promise.race([run.done, wait(5000)]);
  }
  clearRunState();
}

function normalizeConfig(input) {
  const current = readJson(configPath);
  const sources = readJson(sourcesPath);
  const countries = input.countries || {};
  const workModes = input.workModes || {};
  const enabledSources = input.enabledSources || current.enabledSources || {};
  const roleKeywords = Array.isArray(input.roleKeywords)
    ? input.roleKeywords
    : String(input.roleKeywords || "")
        .split(/\n|,/)
        .map(item => item.trim())
        .filter(Boolean);

  const normalizeSourceList = country => {
    const available = new Set((sources[country] || []).map(source => source.name));
    const selected = Array.isArray(enabledSources[country]) ? enabledSources[country] : [];
    return selected.filter(name => available.has(name));
  };

  const countryKeys = Array.from(new Set([
    ...Object.keys(sources || {}),
    ...Object.keys(current.countries || {}),
    ...Object.keys(countries || {})
  ]));

  const normalizedCountries = Object.fromEntries(
    countryKeys.map(country => [country, Boolean(countries[country])])
  );

  const normalizedEnabledSources = Object.fromEntries(
    countryKeys.map(country => [country, normalizeSourceList(country)])
  );

  const next = {
    ...current,
    countries: normalizedCountries,
    workModes: {
      remote: Boolean(workModes.remote),
      hybrid: Boolean(workModes.hybrid),
      onsite: Boolean(workModes.onsite)
    },
    enabledSources: normalizedEnabledSources,
    roleKeywords,
    maxJobsPerRun: parseMaxJobsPerRun(Object.prototype.hasOwnProperty.call(input, "maxJobsPerRun") ? input.maxJobsPerRun : current.maxJobsPerRun),
    minimumFitScore: parseMinimumFitScore(Object.prototype.hasOwnProperty.call(input, "minimumFitScore") ? input.minimumFitScore : current.minimumFitScore),
    maxPostingAgeDays: parseMaxPostingAgeDays(Object.prototype.hasOwnProperty.call(input, "maxPostingAgeDays") ? input.maxPostingAgeDays : current.maxPostingAgeDays),
    strictLinkCheck: Boolean(input.strictLinkCheck),
    dedupe: {
      byApplyUrl: true,
      byNameAndCompany: true,
      byNearDuplicate: true
    }
  };

  for (const country of countryKeys) {
    if (next.countries[country] && next.enabledSources[country].length === 0) {
      next.enabledSources[country] = (sources[country] || []).map(source => source.name);
    }
  }

  const inSched = input.schedule || {};
  const curSched = current.schedule || {};
  next.schedule = {
    enabled: Boolean(Object.prototype.hasOwnProperty.call(inSched, "enabled") ? inSched.enabled : curSched.enabled ?? false),
    hour: Math.max(0, Math.min(23, Math.floor(Number(Object.prototype.hasOwnProperty.call(inSched, "hour") ? inSched.hour : curSched.hour ?? 8)))),
    minute: Math.max(0, Math.min(59, Math.floor(Number(Object.prototype.hasOwnProperty.call(inSched, "minute") ? inSched.minute : curSched.minute ?? 0))))
  };

  return next;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/") {
      send(res, 200, fs.readFileSync(indexPath, "utf8"), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && req.url === "/settings") {
      send(res, 200, fs.readFileSync(pagePath, "utf8"), "text/html; charset=utf-8");
      return;
    }

    if (req.method === "GET" && (req.url === "/api/jobs" || req.url.startsWith("/api/jobs?"))) {
      const urlObj = new URL(req.url, "http://localhost");
      const sp = urlObj.searchParams;
      const country  = sp.get("country")  || "";
      const workMode = sp.get("workMode") || "";
      const status   = sp.get("status")   || "";
      const q        = sp.get("q")        || "";
      const after    = sp.get("after")    || "";
      const limit    = Math.min(Number(sp.get("limit")) || 200, 5000);
      const offset   = Number(sp.get("offset")) || 0;

      let where = "WHERE 1=1";
      const params = [];
      if (country)  { where += " AND country = ?";   params.push(country); }
      if (workMode) { where += " AND work_mode = ?"; params.push(workMode); }
      if (status)   { where += " AND status = ?";    params.push(status); }
      if (after)    { where += " AND found_at >= ?"; params.push(after); }
      if (q) {
        where += " AND (title LIKE ? OR company LIKE ? OR keywords LIKE ? OR location LIKE ?)";
        const like = `%${q}%`;
        params.push(like, like, like, like);
      }

      const total    = db.prepare(`SELECT COUNT(*) as cnt FROM jobs ${where}`).get(...params)?.cnt || 0;
      const jobs     = db.prepare(`SELECT * FROM jobs ${where} ORDER BY found_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset);
      const countries = db.prepare("SELECT DISTINCT country FROM jobs WHERE country != '' ORDER BY country").all().map(r => r.country);
      const countsRaw = db.prepare("SELECT status, COUNT(*) as cnt FROM jobs GROUP BY status").all();
      const counts   = { new: 0, saved: 0, applied: 0, rejected: 0 };
      for (const row of countsRaw) if (counts[row.status] !== undefined) counts[row.status] = row.cnt;

      send(res, 200, JSON.stringify({ ok: true, jobs, total, countries, counts, hasMore: offset + limit < total }));
      return;
    }

    const statusMatch = req.url.match(/^\/api\/jobs\/([^/]+)\/status$/);
    if (req.method === "POST" && statusMatch) {
      const id = statusMatch[1];
      const body = await collectBody(req);
      const { status } = JSON.parse(body);
      const allowed = ["new", "saved", "applied", "rejected"];
      if (!allowed.includes(status)) {
        send(res, 400, JSON.stringify({ error: "Invalid status" }));
        return;
      }
      const appliedAt = status === "applied" ? new Date().toISOString() : "";
      db.prepare("UPDATE jobs SET status = ?, applied_at = ? WHERE id = ?").run(status, appliedAt, id);
      send(res, 200, JSON.stringify({ ok: true }));
      return;
    }

    const notesMatch = req.url.match(/^\/api\/jobs\/([^/]+)\/notes$/);
    if (req.method === "POST" && notesMatch) {
      const id = notesMatch[1];
      const body = await collectBody(req);
      const { notes } = JSON.parse(body);
      db.prepare("UPDATE jobs SET notes = ? WHERE id = ?").run(String(notes || ""), id);
      send(res, 200, JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/config") {
      const config = normalizeConfig(readJson(configPath));
      send(res, 200, JSON.stringify({
        config,
        sources: readJson(sourcesPath)
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/config") {
      const body = await collectBody(req);
      const next = normalizeConfig(JSON.parse(body));
      fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n");
      setupSchedule();
      send(res, 200, JSON.stringify({ ok: true, config: next }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/run-now") {
      const run = runNow();
      send(res, 202, JSON.stringify({ ok: true, run }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/run-status") {
      let schedCfg = null;
      try { schedCfg = readJson(configPath).schedule || null; } catch { /* ignore */ }
      const nextRun = schedCfg?.enabled ? getNextRunTime(schedCfg.hour, schedCfg.minute) : null;
      send(res, 200, JSON.stringify({ ok: true, run: runState, schedule: schedCfg, nextRun }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/clear-run-log") {
      clearRunState();
      send(res, 200, JSON.stringify({ ok: true, cleared: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/prepare-run") {
      await prepareFreshRun();
      send(res, 200, JSON.stringify({ ok: true, prepared: true, run: runState }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/stop-run") {
      const stopped = stopRun();
      send(res, 200, JSON.stringify({ ok: true, stopped }));
      return;
    }

    send(res, 404, JSON.stringify({ error: "Not found" }));
  } catch (error) {
    send(res, 500, JSON.stringify({ error: error.message }));
  }
});

const port = Number(process.env.PORT || 8765);
setupSchedule();
server.listen(port, "127.0.0.1", () => {
  console.log(`Job Board:  http://127.0.0.1:${port}`);
  console.log(`Settings:   http://127.0.0.1:${port}/settings`);
});
