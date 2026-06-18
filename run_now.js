const fs = require("fs");
const path = require("path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const root = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(root, "job_search_config.json"), "utf8"));
const jobSources = JSON.parse(fs.readFileSync(path.join(root, "job_sources.json"), "utf8"));
const dryRun = process.env.JOB_RESEARCH_DRY_RUN === "1" || process.env.JOB_RESEARCH_DRY_RUN === "true";

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
const runDate = new Date().toISOString().slice(0, 10);
const maxPostingAgeDays = parseMaxPostingAgeDays(config.maxPostingAgeDays);

function parsePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 1 ? Math.floor(numeric) : fallback;
}

function parseMaxPostingAgeDays(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "0" || normalized === "all" || normalized === "unlimited") return null;
  }
  const parsed = parsePositiveInteger(value, null);
  return parsed === null ? null : parsed;
}

const httpTimeoutMs = parsePositiveInteger(process.env.JOB_RESEARCH_HTTP_TIMEOUT_MS, dryRun ? 5000 : 12000);
const genericKeywordLimit = dryRun ? parsePositiveInteger(process.env.JOB_RESEARCH_GENERIC_KEYWORD_LIMIT, 1) : parsePositiveInteger(process.env.JOB_RESEARCH_GENERIC_KEYWORD_LIMIT, null);
const genericResultLimit = parsePositiveInteger(process.env.JOB_RESEARCH_GENERIC_RESULT_LIMIT, dryRun ? 3 : 50);
const dryRunCandidateLimit = dryRun ? parsePositiveInteger(process.env.JOB_RESEARCH_DRY_RUN_CANDIDATE_LIMIT, 30) : null;
const dryRunMaxJobs = dryRun ? parsePositiveInteger(process.env.JOB_RESEARCH_DRY_RUN_MAX_JOBS, 5) : null;

const linkedinCountrySearches = {
  saudi_arabia: { label: "Saudi Arabia", sourceName: "LinkedIn Saudi Arabia", location: "Saudi Arabia" },
  qatar: { label: "Qatar", sourceName: "LinkedIn Qatar", location: "Qatar" },
  oman: { label: "Oman", sourceName: "LinkedIn Oman", location: "Oman" },
  bahrain: { label: "Bahrain", sourceName: "LinkedIn Bahrain", location: "Bahrain" },
  kuwait: { label: "Kuwait", sourceName: "LinkedIn Kuwait", location: "Kuwait" },
  united_arab_emirates: { label: "United Arab Emirates", sourceName: "LinkedIn United Arab Emirates", location: "United Arab Emirates" }
};

function progress(message) {
  process.stderr.write(`${message}\n`);
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

function formatMaxJobsPerRunForReport(value) {
  const parsed = parseMaxJobsPerRun(value);
  return parsed === null ? "all" : parsed;
}


function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, label = url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      progress(`${label}: request failed on attempt ${attempt}/${attempts}: ${error.message}`);
      if (attempt < attempts) await wait(1000 * attempt);
    }
  }
  throw new Error(`${label}: fetch failed after ${attempts} attempts (${lastError?.message || "unknown error"})`);
}

const skillSignals = [
  "python",
  "spark",
  "pyspark",
  "scala",
  "sql",
  "trino",
  "aws",
  "azure",
  "data",
  "etl",
  "elt",
  "pipeline",
  "bi",
  "power bi",
  "backend",
  "api",
  "ai",
  "machine learning",
  "ml",
  "computer vision",
  "docker",
  "kubernetes",
  "ci/cd",
  "automation",
  "finance",
  "automotive",
  "renewable"
];

const benefitSignals = [
  "remote",
  "hybrid",
  "home office",
  "work from home",
  "flexible",
  "flexitime",
  "health insurance",
  "insurance",
  "pension",
  "retirement",
  "vacation",
  "holiday",
  "paid time off",
  "pto",
  "learning",
  "training",
  "conference",
  "budget",
  "stock",
  "equity",
  "bonus",
  "relocation",
  "visa",
  "wellbeing",
  "wellness",
  "gym",
  "equipment",
  "laptop",
  "mobility",
  "ticket",
  "benefits"
];

const benefitCategories = [
  {
    label: "Remote or hybrid work",
    pattern: /\b(remote|hybrid|home office|homeoffice|work from home|telework|teletravail|travail a distance|travail à distance|mobiles arbeiten)\b/i
  },
  {
    label: "Flexible working hours",
    pattern: /\b(flexible|flexitime|flexi[- ]?time|flexible working|flexible hours|horaires flexibles|arbeitszeit|gleitzeit)\b/i
  },
  {
    label: "Training and learning budget",
    pattern: /\b(training|learning|development|certification|conference|formation|formations|career development|professional development|weiterbildung)\b/i
  },
  {
    label: "Bonus or variable compensation",
    pattern: /\b(bonus|variable compensation|profit sharing|prime|13th month|13e mois|13\. monat|performance award)\b/i
  },
  {
    label: "Health insurance or wellbeing support",
    pattern: /\b(health insurance|medical insurance|insurance|mutuelle|wellbeing|wellness|mental health|gym|sport|fitness|sante|santé|krankenversicherung)\b/i
  },
  {
    label: "Pension or retirement plan",
    pattern: /\b(pension|retirement|401k|pension scheme|plan de pension|retraite|altersvorsorge)\b/i
  },
  {
    label: "Extra paid leave or holidays",
    pattern: /\b(vacation|holiday|paid time off|pto|annual leave|conges|congés|urlaub|sabbatical)\b/i
  },
  {
    label: "Company equipment",
    pattern: /\b(laptop|equipment|phone|hardware|computer|materiel|matériel|ordinateur|ausstattung)\b/i
  },
  {
    label: "Meal, mobility, or transport allowance",
    pattern: /\b(meal vouchers?|lunch vouchers?|ticket restaurant|restaurant tickets?|transport|mobility|commuter|parking|car allowance|company car|leasing|ticket|mobilite|mobilité)\b/i
  },
  {
    label: "Relocation or visa support",
    pattern: /\b(relocation|visa|work permit|sponsorship|immigration|relocation package|demenagement|déménagement)\b/i
  },
  {
    label: "Stock or equity",
    pattern: /\b(stock|equity|shares|rsu|stock options|actions)\b/i
  }
];

const technologySignals = [
  ".net",
  "abap",
  "airflow",
  "aks",
  "angular",
  "ansible",
  "apache beam",
  "apache flink",
  "apache kafka",
  "apache spark",
  "argo",
  "aws",
  "azure",
  "azure data factory",
  "azure devops",
  "bigquery",
  "c#",
  "c++",
  "cassandra",
  "ci/cd",
  "clickhouse",
  "cloudformation",
  "cplusplus",
  "css",
  "databricks",
  "dataiku",
  "dbt",
  "docker",
  "dynamodb",
  "elasticsearch",
  "fastapi",
  "flask",
  "gcp",
  "git",
  "github actions",
  "gitlab ci",
  "go",
  "golang",
  "grafana",
  "graphql",
  "hadoop",
  "helm",
  "html",
  "java",
  "javascript",
  "jenkins",
  "jira",
  "kafka",
  "kotlin",
  "kubernetes",
  "lambda",
  "langchain",
  "llm",
  "looker",
  "matplotlib",
  "mlops",
  "mongodb",
  "mysql",
  "next.js",
  "node.js",
  "nosql",
  "numpy",
  "openai",
  "opencv",
  "openshift",
  "oracle",
  "pandas",
  "postgresql",
  "power bi",
  "powerbi",
  "prometheus",
  "pyspark",
  "python",
  "pytorch",
  "r",
  "rag",
  "react",
  "redshift",
  "redis",
  "rest",
  "rust",
  "s3",
  "sap",
  "scala",
  "scikit-learn",
  "scipy",
  "seaborn",
  "sklearn",
  "snowflake",
  "spark",
  "spring",
  "spring boot",
  "sql",
  "sql server",
  "sqlalchemy",
  "ssis",
  "ssas",
  "ssrs",
  "tableau",
  "terraform",
  "tensorflow",
  "trino",
  "typescript",
  "vba",
  "vector databases",
  "vue",
  "vue.js"
];

const technicalSkillPatterns = [
  { label: "Agile", pattern: /\bagile\b/i },
  { label: "Scrum", pattern: /\bscrum\b/i },
  { label: "Kanban", pattern: /\bkanban\b/i },
  { label: "ETL", pattern: /\betl\b/i },
  { label: "ELT", pattern: /\belt\b/i },
  { label: "Data Modeling", pattern: /\b(data model(?:ing|ling)?|mod[eè]le de donn[eé]es)\b/i },
  { label: "Data Warehousing", pattern: /\b(data warehouse|data warehousing|dwh)\b/i },
  { label: "Data Governance", pattern: /\b(data governance|gouvernance des donn[eé]es)\b/i },
  { label: "Data Visualization", pattern: /\b(data visualization|visualisation des donn[eé]es|reporting)\b/i },
  { label: "Business Intelligence", pattern: /\b(business intelligence|bi)\b/i },
  { label: "REST APIs", pattern: /\b(rest api|rest apis|restful|api rest)\b/i },
  { label: "Microservices", pattern: /\bmicroservices?\b/i },
  { label: "Unit Testing", pattern: /\b(unit tests?|tests? unitaires|junit|pytest)\b/i },
  { label: "CI/CD", pattern: /\b(ci\/cd|continuous integration|continuous deployment|devops)\b/i },
  { label: "MLOps", pattern: /\bmlops\b/i },
  { label: "LLM", pattern: /\b(llm|large language model)\b/i },
  { label: "RAG", pattern: /\b(rag|retrieval augmented generation)\b/i }
];

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#233;/g, "e")
    .replace(/&#232;/g, "e")
    .replace(/&#246;/g, "o")
    .replace(/&#252;/g, "u")
    .replace(/&#228;/g, "a")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value) {
  return decodeHtml(String(value || "").replace(/<[^>]*>/g, " "));
}

function pageToText(html) {
  return stripTags(decodeHtml(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h2|h3|section)>/gi, "\n"));
}

function existingRows() {
  if (dryRun) {
    progress("Dry run enabled: skipping duplicate check.");
    return { urls: new Set(), keys: new Set() };
  }
  progress("Loading existing rows from database...");
  const rows = db.prepare("SELECT url, title, company FROM jobs").all();
  const urls = new Set(rows.map(r => normalizeUrl(r.url)));
  const keys = new Set(rows.map(r => `${(r.title || "").trim().toLowerCase()}::${(r.company || "").trim().toLowerCase()}`));
  progress(`Existing rows loaded: ${rows.length}.`);
  return { urls, keys };
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    for (const param of [...parsed.searchParams.keys()]) {
      if (/^(utm_|trk|ref|source|cid|pvs|position|pageNum|refId|trackingId)/i.test(param)) parsed.searchParams.delete(param);
    }
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return String(url || "").trim().toLowerCase();
  }
}

function allowedByWorkMode(candidate) {
  const selected = config.workModes || {};
  if (candidate.workMode === "remote") return Boolean(selected.remote);
  if (candidate.workMode === "hybrid") return Boolean(selected.hybrid);
  if (candidate.workMode === "onsite") return Boolean(selected.onsite);
  return Boolean(selected.remote || selected.hybrid || selected.onsite);
}

function sourceEnabled(country, name) {
  const selected = config.enabledSources?.[country];
  if (!Array.isArray(selected) || selected.length === 0) return true;
  return selected.includes(name);
}

function textHasPhrase(text, phrase) {
  const escaped = String(phrase || "").trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
  if (!escaped) return false;
  return new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i").test(text);
}

function selectedSourceNames() {
  const countries = Object.entries(config.countries || {})
    .filter(([, enabled]) => enabled)
    .map(([country]) => country);
  return countries.flatMap(country => {
    const selected = config.enabledSources?.[country] || [];
    return selected.map(name => `${name} (${country})`);
  });
}

function createRunnableSourceDefinition(source, country) {
  const sourceName = source.name;
  let search;
  if (country === "luxembourg" && sourceName === "jobs.lu") {
    search = searchJobsLu;
  } else if (country === "luxembourg" && sourceName === "LinkedIn Luxembourg") {
    search = searchLinkedInLuxembourg;
  } else if (country === "germany" && sourceName === "LinkedIn Germany") {
    search = searchLinkedInGermany;
  } else if (country === "germany" && sourceName === "RemoteOK") {
    search = searchRemoteOk;
  } else if (linkedinCountrySearches[country]?.sourceName === sourceName) {
    search = () => searchConfiguredLinkedInCountry(country);
  } else {
    search = () => searchGenericSource(source, country);
  }

  return {
    name: sourceName,
    country,
    url: source.url,
    active: Boolean(config.countries?.[country] && sourceEnabled(country, sourceName)),
    search
  };
}

function runnableSourceDefinitions() {
  return Object.entries(jobSources || {}).flatMap(([country, sources]) => {
    if (!Array.isArray(sources)) return [];
    return sources.map(source => createRunnableSourceDefinition(source, country));
  });
}

function logSourceSelection() {
  const selected = selectedSourceNames();
  const runnable = runnableSourceDefinitions().filter(source => source.active);
  progress(`Selected sources in settings: ${selected.length ? selected.join("; ") : "none"}.`);
  progress(`Runnable sources for Run now: ${runnable.length ? runnable.map(source => `${source.name} (${source.country})`).join("; ") : "none"}.`);
}

function isRelevantTitle(text) {
  const lowered = text.toLowerCase();
  return (config.roleKeywords || []).some(keyword => textHasPhrase(lowered, String(keyword).toLowerCase()))
    || /\b(software|developer|backend|full.?stack|data|database|analytics|business intelligence|bi|ai|machine learning|ml|platform|cloud|devops|steward|modeler|engineer)\b/i.test(text);
}

function parseDateOnly(value) {
  if (!value) return null;
  const text = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function postingAgeDays(postedAt) {
  const posted = parseDateOnly(postedAt);
  if (!posted) return 0;
  const today = parseDateOnly(runDate);
  return Math.floor((today - posted) / 86400000);
}

function allowedByPostingAge(candidate) {
  if (maxPostingAgeDays === null) return true;
  const age = postingAgeDays(candidate.postedAt);
  return age >= 0 && age <= maxPostingAgeDays;
}

async function checkLink(url) {
  if (!config.strictLinkCheck) return { ok: true, status: "not_checked" };
  if (/^https:\/\/(www\.|de\.|lu\.)?linkedin\.com\/jobs\/view\//i.test(url)) {
    return { ok: true, status: "linkedin_search_verified" };
  }
  if (/^https:\/\/en\.jobs\.lu\/ApplyForJob\.aspx\?Id=\d+/i.test(url)) {
    return { ok: true, status: "jobs_lu_search_verified" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 JobSearchBot/1.0"
      }
    });
    const ok = response.status >= 200 && response.status < 400;
    return { ok, status: response.status };
  } catch (error) {
    return { ok: false, status: error.name || error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), httpTimeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 JobSearchBot/1.0"
      }
    });
    if (!response.ok) return "";
    return await response.text();
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function extractSalary(text) {
  const clean = text.replace(/\s+/g, " ");
  const patterns = [
    /\$\s?\d{2,3}(?:[.,]\d{3})?(?:\s?[-–]\s?\$?\s?\d{2,3}(?:[.,]\d{3})?)?(?:\s?(?:per|\/)\s?(?:year|annum|month|hour|day|week))?/gi,
    /\d{2,3}(?:[.,]\d{3})?\s?(?:USD|usd|\$)(?:\s?[-–]\s?\d{2,3}(?:[.,]\d{3})?\s?(?:USD|usd|\$)?)?(?:\s?(?:per|\/)\s?(?:year|annum|month|hour|day|week))?/gi,
    /(?:€|EUR|eur)\s?\d{2,3}(?:[.,]\d{3})?(?:\s?[-–]\s?(?:€|EUR|eur)?\s?\d{2,3}(?:[.,]\d{3})?)?(?:\s?(?:per|\/)\s?(?:year|annum|month|hour|day|week))?/gi,
    /\d{2,3}(?:[.,]\d{3})?\s?(?:€|EUR|eur)(?:\s?[-–]\s?\d{2,3}(?:[.,]\d{3})?\s?(?:€|EUR|eur)?)?(?:\s?(?:per|\/)\s?(?:year|annum|month|hour|day|week))?/gi,
    /\b\d{2,3}k\s?[-–]\s?\d{2,3}k\b/gi,
    /\b(?:salary|compensation|pay|gehalt|vergütung|bezahlung)\s?[:\-]\s?.{0,120}(?:€|EUR|USD|\$|\bk\b|\d)/gi
  ];
  const matches = [];
  for (const pattern of patterns) {
    for (const match of clean.matchAll(pattern)) {
      const value = match[0].trim();
      if (value.length >= 3 && !matches.some(item => item.toLowerCase() === value.toLowerCase())) {
        matches.push(value);
      }
    }
  }
  return matches.slice(0, 3).join("; ");
}

function extractBenefits(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  const sentences = normalized
    .split(/(?<=[.!?])\s+|[•·]\s+|\n+|(?:\s+-\s+)/)
    .map(sentence => sentence.trim())
    .filter(Boolean);

  const found = [];
  const addPoint = point => {
    if (!found.some(item => item.toLowerCase() === point.toLowerCase())) found.push(point);
  };

  for (const category of benefitCategories) {
    if (category.pattern.test(normalized)) addPoint(category.label);
    if (found.length >= 8) break;
  }

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!benefitSignals.some(signal => lower.includes(signal))) continue;
    if (/\b(requirements?|responsibilities|profile|qualification|skills?|experience required|your profile|votre profil|qualifications)\b/i.test(sentence)) continue;
    if (benefitCategories.some(category => category.pattern.test(sentence))) continue;
    const compact = sentence
      .replace(/\s+/g, " ")
      .replace(/^(benefits|what we offer|we offer|avantages|nous offrons|wir bieten)\s*[:\-]\s*/i, "")
      .slice(0, 160)
      .trim();
    if (compact.length >= 8) addPoint(compact);
    if (found.length >= 8) break;
  }

  return found.length ? found.slice(0, 8).map(point => `- ${point}`).join("\n") : "";
}

function extractTechnologies(text) {
  const normalized = ` ${text.toLowerCase().replace(/[\n\r\t,;:()[\]{}]/g, " ")} `;
  const found = [];
  for (const tech of technologySignals) {
    const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\ /g, "\\s+");
    const pattern = new RegExp(`(^|[^a-z0-9+#.])${escaped}([^a-z0-9+#.]|$)`, "i");
    if (pattern.test(normalized) && !found.some(item => item.toLowerCase() === tech.toLowerCase())) {
      found.push(tech);
    }
  }
  return found
    .map(tech => ({
      "cplusplus": "C++",
      "golang": "Go",
      "next.js": "Next.js",
      "node.js": "Node.js",
      "powerbi": "Power BI",
      "sql server": "SQL Server",
      "vue.js": "Vue.js",
      "ci/cd": "CI/CD",
      "llm": "LLM",
      "rest": "REST APIs",
      "s3": "AWS S3"
    }[tech] || tech))
    .slice(0, 30)
    .join(", ");
}

function extractTechnicalKeywords(text) {
  const found = [];
  const add = item => {
    if (item && !found.some(existing => existing.toLowerCase() === item.toLowerCase())) found.push(item);
  };

  for (const item of extractTechnologies(text).split(",")) {
    add(item.trim());
  }

  for (const skill of technicalSkillPatterns) {
    if (skill.pattern.test(text)) add(skill.label);
  }

  return found.slice(0, 40).join(", ");
}

function extractRequirementSummary(text, fallbackName = "") {
  const clean = pageToText(text)
    .replace(/\s+/g, " ")
    .replace(/\b(about the job|description du poste|qualifications|your profile|votre profil|requirements?|responsibilities)\b\s*:*/gi, " ")
    .trim();
  const sentences = clean
    .split(/(?<=[.!?])\s+|[•·]\s+|\n+|(?:\s+-\s+)/)
    .map(sentence => sentence.replace(/\s+/g, " ").trim())
    .filter(sentence => sentence.length >= 18 && sentence.length <= 260);
  const requirementSignals = [
    /\b(required|required|requirements?|experience|proven|strong|solid|knowledge|familiar|hands[- ]?on|expertise|mastery|maitrise|maîtrise|connaissance|exp[eé]rience)\b/i,
    /\b(responsible|responsibilities|mission|tasks?|role|design|develop|implement|build|maintain|support|manage|collaborate|deliver|assurer|concevoir|d[eé]velopper|impl[eé]menter)\b/i,
    /\b(sql|python|java|azure|aws|power bi|ssis|ssas|ssrs|spark|etl|data|api|cloud|docker|kubernetes|agile|jira)\b/i
  ];
  const banned = /\b(we offer|benefits|avantages|company|about us|our client|premium|apply|equal opportunity|privacy)\b/i;
  const picked = [];
  const add = phrase => {
    const compact = phrase
      .replace(/^(you will|you are|your mission|vos tâches|votre mission|requirements?|responsibilities)\s*:?\s*/i, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[.;,\s]+$/, "");
    if (compact.length < 12) return;
    if (picked.some(item => item.toLowerCase() === compact.toLowerCase())) return;
    picked.push(compact.slice(0, 180));
  };

  for (const sentence of sentences) {
    if (banned.test(sentence)) continue;
    if (!requirementSignals.some(pattern => pattern.test(sentence))) continue;
    add(sentence);
    if (picked.length >= 4) break;
  }

  if (picked.length < 4) {
    const keywords = extractTechnicalKeywords(`${fallbackName} ${text}`).split(",").map(item => item.trim()).filter(Boolean).slice(0, 8);
    if (keywords.length) add(`Technical stack includes ${keywords.join(", ")}`);
  }
  if (picked.length < 4 && fallbackName) add(`Role focused on ${fallbackName}`);

  return picked.slice(0, 4).map(item => `- ${item}`).join("\n") || "Not specified in posting";
}

function linkedinJobId(url) {
  const match = String(url || "").match(/-(\d{8,})\??|\/jobs\/view\/(?:[^/?#]+-)?(\d{8,})/);
  return match?.[1] || match?.[2] || "";
}

function extractLinkedInStructuredData(html) {
  const scripts = [...String(html || "").matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)];
  for (const script of scripts) {
    const raw = decodeHtml(script[1]);
    try {
      const data = JSON.parse(raw);
      const items = Array.isArray(data) ? data : [data];
      const job = items.find(item => item && item["@type"] === "JobPosting");
      if (job) return job;
    } catch {
      // Keep trying other JSON-LD blocks.
    }
  }
  return null;
}

async function fetchPostingDetail(candidate) {
  const isLinkedIn = /^https:\/\/(www\.|de\.|lu\.)?linkedin\.com\/jobs\/view\//i.test(candidate.url);
  const urls = [];
  if (isLinkedIn) {
    const id = linkedinJobId(candidate.url);
    if (id) urls.push(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
  }
  urls.push(candidate.url);

  for (const url of urls) {
    const html = await fetchText(url);
    if (!html) continue;

    if (isLinkedIn) {
      const structured = extractLinkedInStructuredData(html);
      if (structured?.description) {
        const location = structured.jobLocation?.address
          ? [structured.jobLocation.address.addressLocality, structured.jobLocation.address.addressCountry].filter(Boolean).join(", ")
          : candidate.location;
        const workMode = structured.jobLocationType === "TELECOMMUTE"
          ? "remote"
          : candidate.workMode;
        return {
          candidate: {
            ...candidate,
            name: stripTags(structured.title || candidate.name),
            company: stripTags(structured.hiringOrganization?.name || candidate.company),
            location: location || candidate.location,
            workMode,
            postedAt: structured.datePosted ? String(structured.datePosted).slice(0, 10) : candidate.postedAt
          },
          text: pageToText(structured.description)
        };
      }
    }

    const text = pageToText(html);
    if (text.length > 200) return { candidate, text };
  }

  return { candidate, text: candidate.descriptionText || "" };
}

async function analyzePosting(candidate) {
  const detail = await fetchPostingDetail(candidate);
  const base = detail.candidate;
  const text = detail.text || base.descriptionText || "";

  if (!text) return candidate;

  const salary = base.salary || extractSalary(text) || "Not specified in posting";
  const benefits = base.benefits || extractBenefits(text) || "Not specified in posting";
  const keywords = extractTechnicalKeywords(`${base.name} ${text}`);
  const summary = extractRequirementSummary(text, base.name);
  return {
    ...base,
    salary,
    benefits,
    keywords: keywords || "Not specified in posting",
    summary
  };
}

function parseJobsLu(html) {
  const candidates = [];
  const articleRegex = /<article class="job-list-item[\s\S]*?<\/article>/g;
  const articles = html.match(articleRegex) || [];
  for (const article of articles) {
    const titleMatch = article.match(/<a href="([^"]+)" class="job-title">([\s\S]*?)<\/a>/);
    if (!titleMatch) continue;
    const companyMatch = article.match(/class="recruiter-name">([\s\S]*?)<\/a>/);
    const locationMatch = article.match(/<span class="location">([\s\S]*?)<\/span>/);
    const dateMatch = article.match(/<span class="date">\s*([\s\S]*?)\s*<\/span>/);
    const name = decodeHtml(titleMatch[2]);
    if (!isRelevantTitle(name)) continue;
    const company = decodeHtml(companyMatch?.[1] || "Unknown");
    const location = decodeHtml(locationMatch?.[1] || "Luxembourg");
    const postedLabel = decodeHtml(dateMatch?.[1] || "");
    const url = titleMatch[1].startsWith("http") ? titleMatch[1] : `https://en.jobs.lu${titleMatch[1]}`;
    const lower = pageToText(article).toLowerCase();
    const workMode = /remote|home office|homeoffice|work from home/.test(lower)
      ? "remote"
      : /hybrid|hybride/.test(lower)
        ? "hybrid"
        : "onsite";
    const keywords = skillSignals.filter(signal => `${name} ${company}`.toLowerCase().includes(signal)).join(", ");
    candidates.push({
      name,
      company,
      location,
      country: "Luxembourg",
      workMode,
      salary: "",
      benefits: "",
      postedAt: postedLabel.toLowerCase() === "today" ? runDate : "",
      url,
      keywords: keywords || "Luxembourg, technology, software/data role",
      summary: `Luxembourg listing found on jobs.lu for ${name} at ${company}. Work mode not explicitly stated, treated as on-site unless the job page says otherwise.`
    });
  }
  return candidates;
}

async function searchJobsLu() {
  if (!config.countries?.luxembourg) return [];
  if (!sourceEnabled("luxembourg", "jobs.lu")) return [];
  const terms = (config.roleKeywords || []).slice(0, 10);
  const seen = new Set();
  const candidates = [];
  for (const term of terms) {
    progress(`jobs.lu: searching "${term}"...`);
    const url = `https://en.jobs.lu/jobs.aspx?query=${encodeURIComponent(term)}&location=Luxembourg`;
    const html = await fetchText(url);
    const before = candidates.length;
    for (const candidate of parseJobsLu(html)) {
      const key = normalizeUrl(candidate.url);
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
    progress(`jobs.lu: "${term}" added ${candidates.length - before} new candidates.`);
  }
  return candidates;
}

async function searchRemoteOk() {
  if (!sourceEnabled("germany", "RemoteOK")) return [];
  if (!config.countries?.germany && !config.workModes?.remote) return [];
  const html = await fetchText("https://remoteok.com/api");
  if (!html) return [];
  let jobs;
  try {
    jobs = JSON.parse(html);
  } catch {
    return [];
  }
  return jobs.slice(1).filter(job => {
    const text = `${job.position || ""} ${job.description || ""} ${(job.tags || []).join(" ")} ${job.location || ""}`;
    if (!isRelevantTitle(text)) return false;
    if (!config.countries?.germany) return false;
    return /germany|europe|emea|worldwide|remote/i.test(text);
  }).map(job => ({
    name: decodeHtml(job.position || "Remote role"),
    company: decodeHtml(job.company || "Unknown"),
    location: decodeHtml(job.location || "Remote, Germany/Europe"),
    country: "Germany",
    workMode: "remote",
    salary: [job.salary_min, job.salary_max].filter(Boolean).join(" - "),
    benefits: extractBenefits(pageToText(job.description || "")),
    postedAt: job.date ? String(job.date).slice(0, 10) : "",
    url: job.url || `https://remoteok.com/remote-jobs/${job.id}`,
    keywords: (job.tags || []).slice(0, 12).join(", "),
    summary: `RemoteOK listing for ${job.position || "a technology role"} at ${job.company || "Unknown"}. Filtered for Germany/Europe remote compatibility.`,
    descriptionText: pageToText(job.description || "")
  }));
}

function parseLinkedInCards(html, sourceName, country, defaultWorkMode) {
  const candidates = [];
  const cardRegex = /<div class="base-card[\s\S]*?<\/li>/g;
  const cards = html.match(cardRegex) || [];

  for (const card of cards) {
    const urlMatch = card.match(/href="([^"]*linkedin\.com\/jobs\/view\/[^"]+)"/);
    const titleMatch = card.match(/<h3 class="base-search-card__title">\s*([\s\S]*?)\s*<\/h3>/);
    const companyMatch = card.match(/<h4 class="base-search-card__subtitle">[\s\S]*?>([\s\S]*?)<\/a>/);
    const locationMatch = card.match(/<span class="job-search-card__location">\s*([\s\S]*?)\s*<\/span>/);
    const dateMatch = card.match(/<time[^>]*datetime="([^"]+)"/);
    if (!urlMatch || !titleMatch) continue;

    const name = stripTags(titleMatch[1]);
    if (!isRelevantTitle(name)) continue;

    const company = stripTags(companyMatch?.[1] || "Unknown");
    const location = stripTags(locationMatch?.[1] || country);
    const url = decodeHtml(urlMatch[1]);
    const lower = `${name} ${company} ${location}`.toLowerCase();
    const workMode = /remote|homeoffice|home office|work from home/.test(lower)
      ? "remote"
      : /hybrid/.test(lower)
        ? "hybrid"
        : defaultWorkMode;
    const keywords = skillSignals
      .filter(signal => `${name} ${company} ${location}`.toLowerCase().includes(signal))
      .join(", ");

    candidates.push({
      name,
      company,
      location,
      country,
      workMode,
      salary: "",
      benefits: extractBenefits(pageToText(card)),
      postedAt: dateMatch?.[1] || "",
      url,
      keywords: keywords || `${sourceName}, ${country}, technology role`,
      summary: `${sourceName} listing for ${name} at ${company}. Location: ${location}. Work mode inferred as ${workMode}.`,
      descriptionText: pageToText(card)
    });
  }

  return candidates;
}

async function searchLinkedInCountry({ country, sourceName, location, selectedRemoteOnly }) {
  const terms = dryRun ? (config.roleKeywords || []).slice(0, 8) : (config.roleKeywords || []);
  const candidates = [];
  const seenUrls = new Set();
  const maxPagesPerKeyword = 10;

  for (const term of terms) {
    progress(`${sourceName}: searching "${term}"...`);
    for (let start = 0; start < maxPagesPerKeyword * 25; start += 25) {
      const params = new URLSearchParams({
        keywords: term,
        location,
        start: String(start)
      });
      if (selectedRemoteOnly) params.set("f_WT", "2");
      if (maxPostingAgeDays !== null) {
        params.set("f_TPR", `r${maxPostingAgeDays * 86400}`);
      }
      const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?${params.toString()}`;
      const html = await fetchText(url);
      const batch = parseLinkedInCards(html, sourceName, country, selectedRemoteOnly ? "remote" : "onsite");
      const page = Math.floor(start / 25) + 1;
      progress(`${sourceName}: "${term}" page ${page}/${maxPagesPerKeyword} returned ${batch.length} cards.`);
      if (batch.length === 0) break;

      let newInBatch = 0;
      for (const candidate of batch) {
        const key = normalizeUrl(candidate.url);
        if (seenUrls.has(key)) continue;
        seenUrls.add(key);
        candidates.push(candidate);
        newInBatch += 1;
        if (dryRunCandidateLimit !== null && candidates.length >= dryRunCandidateLimit) break;
      }

      progress(`${sourceName}: "${term}" page ${page} added ${newInBatch} new candidates (total ${candidates.length}).`);
      if (dryRunCandidateLimit !== null && candidates.length >= dryRunCandidateLimit) {
        progress(`${sourceName}: dry run candidate limit reached (${dryRunCandidateLimit}); stopping LinkedIn source early.`);
        return candidates;
      }
      if (newInBatch === 0) break;
    }
  }

  return candidates;
}

async function searchLinkedInLuxembourg() {
  if (!config.countries?.luxembourg) return [];
  if (!sourceEnabled("luxembourg", "LinkedIn Luxembourg")) return [];
  const selectedRemoteOnly = config.workModes?.remote && !config.workModes?.hybrid && !config.workModes?.onsite;
  return searchLinkedInCountry({
    country: "Luxembourg",
    sourceName: "LinkedIn Luxembourg",
    location: "Luxembourg",
    selectedRemoteOnly
  });
}

async function searchLinkedInGermany() {
  if (!config.countries?.germany) return [];
  if (!sourceEnabled("germany", "LinkedIn Germany")) return [];
  const selectedRemoteOnly = config.workModes?.remote && !config.workModes?.hybrid && !config.workModes?.onsite;
  return searchLinkedInCountry({
    country: "Germany",
    sourceName: "LinkedIn Germany",
    location: "Germany",
    selectedRemoteOnly
  });
}

async function searchConfiguredLinkedInCountry(countryKey) {
  const meta = linkedinCountrySearches[countryKey];
  if (!meta) return [];
  if (!config.countries?.[countryKey]) return [];
  if (!sourceEnabled(countryKey, meta.sourceName)) return [];
  const selectedRemoteOnly = config.workModes?.remote && !config.workModes?.hybrid && !config.workModes?.onsite;
  return searchLinkedInCountry({
    country: meta.label,
    sourceName: meta.sourceName,
    location: meta.location,
    selectedRemoteOnly
  });
}

function countryLabel(countryKey) {
  return String(countryKey || "")
    .split("_")
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sourceDomain(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);
    if (/google\./i.test(parsed.hostname) && parsed.searchParams.get("q")) return "";
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function catalogSearchPhrase(source, country) {
  try {
    const parsed = new URL(source.url || "");
    const query = parsed.searchParams.get("q");
    if (query) return query;
  } catch {
    // Fall back to catalog name and notes.
  }
  return [source.name, countryLabel(country), source.notes || "", "jobs careers"].filter(Boolean).join(" ");
}

function genericSearchQuery(source, country, keyword) {
  const domain = sourceDomain(source.url);
  const base = catalogSearchPhrase(source, country);
  const parts = [];
  if (domain) parts.push(`site:${domain}`);
  parts.push(base, keyword, "job OR career OR vacancy OR hiring");
  return parts.filter(Boolean).join(" ");
}

function duckDuckGoResultUrl(rawHref) {
  const href = decodeHtml(rawHref || "");
  try {
    const parsed = new URL(href, "https://duckduckgo.com");
    const redirected = parsed.searchParams.get("uddg");
    if (redirected) return decodeURIComponent(redirected);
    if (/^https?:$/i.test(parsed.protocol)) return parsed.toString();
  } catch {
    // Ignore malformed result URLs.
  }
  return "";
}

function parseDuckDuckGoResults(html) {
  const results = [];
  const seen = new Set();
  const resultRegex = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(resultRegex)) {
    const url = duckDuckGoResultUrl(match[1]);
    const titleText = stripTags(match[2]);
    if (!url || !/^https?:\/\//i.test(url) || !titleText) continue;
    const key = normalizeUrl(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ url, title: titleText });
    if (results.length >= genericResultLimit) break;
  }
  return results;
}

function extractPageTitle(html) {
  const match = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return stripTags(match?.[1] || "");
}

function inferCompanyFromTitle(titleText, sourceName) {
  const cleaned = stripTags(titleText)
    .replace(/\s*\|\s*LinkedIn\s*$/i, "")
    .replace(/\s*\|\s*Indeed\.com?\s*$/i, "")
    .replace(/\s*\|\s*Jobs?\s*$/i, "")
    .replace(/\s*[-–]\s*Careers?\s*$/i, "")
    .trim();
  const parts = cleaned.split(/\s+[-–|]\s+/).map(part => part.trim()).filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1].slice(0, 120);
  return sourceName;
}

function inferJobTitleFromResult(titleText) {
  const cleaned = stripTags(titleText)
    .replace(/^\s*(job opening|job offer|vacancy|careers?)\s*[:\-–]\s*/i, "")
    .trim();
  const parts = cleaned.split(/\s+[-–|]\s+/).map(part => part.trim()).filter(Boolean);
  const roleLike = parts.find(part => isRelevantTitle(part));
  return (roleLike || parts[0] || cleaned).slice(0, 180);
}

function inferWorkMode(text) {
  const lower = String(text || "").toLowerCase();
  if (/\b(remote|work from home|home office|homeoffice|telecommute)\b/.test(lower)) return "remote";
  if (/\bhybrid\b/.test(lower)) return "hybrid";
  return "onsite";
}

function countryAliases(country) {
  const label = countryLabel(country);
  const aliases = [label];
  if (country === "united_arab_emirates") aliases.push("UAE", "Dubai", "Abu Dhabi", "United Arab Emirates");
  if (country === "saudi_arabia") aliases.push("Saudi", "KSA", "Riyadh", "Jeddah");
  if (country === "luxembourg") aliases.push("Luxembourg", "Luxembourg City");
  if (country === "germany") aliases.push("Germany", "Deutschland", "Berlin", "Munich", "Frankfurt", "Hamburg");
  return aliases.filter(Boolean);
}

function hasCountryEvidence(text, source, country) {
  const haystack = `${text || ""} ${source.url || ""}`.toLowerCase();
  return countryAliases(country).some(alias => haystack.includes(alias.toLowerCase()));
}

function hasJobPageEvidence(url, text) {
  const haystack = `${url || ""} ${text || ""}`.toLowerCase();
  return /\b(job|jobs|career|careers|vacanc|hiring|opening|opportunit|position|apply|employment|recruitment|workday|greenhouse|lever|smartrecruiters)\b/.test(haystack)
    && !/\b(homepage|contact us|privacy policy|terms of use)\b/.test(haystack.slice(0, 400));
}

async function buildGenericCandidate(result, source, country) {
  const html = await fetchText(result.url);
  const pageTitle = extractPageTitle(html) || result.title;
  const text = pageToText(html) || result.title;
  const combined = `${pageTitle} ${text}`;
  if (!hasJobPageEvidence(result.url, combined)) return null;
  if (!hasCountryEvidence(combined, source, country)) return null;
  if (!isRelevantTitle(combined)) return null;
  const name = inferJobTitleFromResult(pageTitle || result.title);
  if (!isRelevantTitle(name) && !isRelevantTitle(combined)) return null;
  const countryName = countryLabel(country);
  const location = countryAliases(country).find(alias => new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(combined)) || `${countryName} source`;
  return {
    sourceName: source.name,
    name,
    company: inferCompanyFromTitle(pageTitle || result.title, source.name),
    location,
    country: countryName,
    workMode: inferWorkMode(combined),
    salary: extractSalary(text),
    benefits: extractBenefits(text),
    postedAt: "",
    url: result.url,
    keywords: extractTechnicalKeywords(combined) || `${source.name}, ${countryName}, real public search result`,
    summary: extractRequirementSummary(text || result.title, name),
    descriptionText: text
  };
}

async function searchGenericSource(source, country) {
  if (!config.countries?.[country]) return [];
  if (!sourceEnabled(country, source.name)) return [];
  const terms = genericKeywordLimit === null ? (config.roleKeywords || []) : (config.roleKeywords || []).slice(0, genericKeywordLimit);
  const candidates = [];
  const seen = new Set();
  for (const term of terms) {
    const query = genericSearchQuery(source, country, term);
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    progress(`${source.name}: searching DuckDuckGo HTML for real public pages matching "${term}"...`);
    const html = await fetchText(url);
    if (!html) {
      progress(`${source.name}: DuckDuckGo HTML unavailable for "${term}"; continuing.`);
      continue;
    }
    const results = parseDuckDuckGoResults(html);
    progress(`${source.name}: "${term}" returned ${results.length} public result links.`);
    for (const result of results) {
      const key = normalizeUrl(result.url);
      if (seen.has(key)) continue;
      seen.add(key);
      const candidate = await buildGenericCandidate(result, source, country);
      if (candidate) candidates.push(candidate);
      if (dryRunCandidateLimit !== null && candidates.length >= dryRunCandidateLimit) return candidates;
    }
  }
  return candidates;
}

async function searchEnabledSources(onSourceDone) {
  const sources = runnableSourceDefinitions().filter(source => source.active);

  if (sources.length === 0) {
    progress("No runnable sources selected for the current country settings.");
    return;
  }

  progress(`Runnable sources selected: ${sources.length}.`);
  let totalCandidates = 0;
  for (const [index, source] of sources.entries()) {
    progress(`Searching source ${index + 1}/${sources.length}: ${source.name} (${source.country})`);
    const found = await source.search();
    totalCandidates += found.length;
    progress(`Finished source ${index + 1}/${sources.length}: ${source.name}. Found ${found.length}; total candidates so far ${totalCandidates}.`);
    const stop = await onSourceDone(found);
    if (stop) {
      progress(`Stopping source search early.`);
      break;
    }
  }
}

function insertJob(job) {
  if (dryRun) {
    progress(`Dry run enabled: would insert ${job.name} @ ${job.company}.`);
    return { name: job.name, company: job.company, dryRun: true };
  }
  const id = crypto.createHash("sha256").update(normalizeUrl(job.url)).digest("hex").slice(0, 16);
  db.prepare(`
    INSERT OR IGNORE INTO jobs
      (id, title, company, location, country, work_mode, salary, benefits, posted_at, url, keywords, summary, fit_score, match_level, run_date, found_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', ?, ?, 'new')
  `).run(
    id,
    job.name || "",
    job.company || "",
    job.location || "",
    job.country || "",
    job.workMode || "onsite",
    job.salary || "",
    job.benefits || "",
    job.postedAt || "",
    job.url,
    job.keywords || "",
    job.summary || "",
    runDate,
    new Date().toISOString()
  );
  return { name: job.name, company: job.company };
}

async function main() {
  progress(`Run date ${runDate}. Loading existing rows...`);
  logSourceSelection();
  const existing = existingRows();
  progress(`Existing rows loaded: ${existing.keys.size}. Searching enabled sources...`);

  let totalFound = 0;
  const inserted = [];
  const skippedDuplicates = [];
  const skippedLinks = [];
  const skippedWorkMode = [];
  const skippedAge = [];
  const skippedErrors = [];
  const max = dryRun && dryRunMaxJobs !== null ? dryRunMaxJobs : parseMaxJobsPerRun(config.maxJobsPerRun);
  const seenThisRun = new Set();

  await searchEnabledSources(async (candidates) => {
    totalFound += candidates.length;
    progress(`Processing ${candidates.length} candidates from this source...`);

    for (const candidate of candidates) {
      if (max !== null && inserted.length >= max) return true;

      if (!allowedByWorkMode(candidate)) {
        skippedWorkMode.push(`${candidate.name} @ ${candidate.company} (${candidate.workMode || "unknown"})`);
        continue;
      }
      if (!allowedByPostingAge(candidate)) {
        skippedAge.push(`${candidate.name} @ ${candidate.company} (${candidate.postedAt || "unknown date"})`);
        continue;
      }

      const urlKey = normalizeUrl(candidate.url);
      const rowKey = `${candidate.name.trim().toLowerCase()}::${candidate.company.trim().toLowerCase()}`;
      if (existing.urls.has(urlKey) || existing.keys.has(rowKey) || seenThisRun.has(urlKey) || seenThisRun.has(rowKey)) {
        skippedDuplicates.push(`${candidate.name} @ ${candidate.company}`);
        progress(`Skipped duplicate: ${candidate.name} @ ${candidate.company}`);
        continue;
      }

      progress(`Verifying link: ${candidate.url}`);
      const link = await checkLink(candidate.url);
      if (!link.ok) {
        skippedLinks.push(`${candidate.name} @ ${candidate.company} (${link.status})`);
        progress(`Skipped broken/unverified link: ${candidate.name} @ ${candidate.company} (${link.status})`);
        continue;
      }

      progress(`Analyzing full posting: ${candidate.name} @ ${candidate.company}`);
      const analyzed = await analyzePosting(candidate);
      progress(`Inserting: ${analyzed.name} @ ${analyzed.company}`);
      try {
        inserted.push(insertJob(analyzed));
        seenThisRun.add(urlKey);
        seenThisRun.add(rowKey);
        existing.urls.add(urlKey);
        existing.keys.add(rowKey);
      } catch (error) {
        const message = String(error.message || error);
        skippedErrors.push(`${analyzed.name} @ ${analyzed.company}: ${message}`);
        progress(`Insert failed: ${analyzed.name} @ ${analyzed.company} (${message})`);
      }
    }

    progress(`Source done. Inserted so far: ${inserted.length}.`);
    return max !== null && inserted.length >= max;
  });

  progress(`Finished. Inserted ${inserted.length}; duplicates skipped ${skippedDuplicates.length}; broken links ${skippedLinks.length}; errors ${skippedErrors.length}.`);

  const report = {
    runDate,
    config: {
      countries: config.countries,
      workModes: config.workModes,
      enabledSources: config.enabledSources,
      maxPostingAgeDays,
      maxJobsPerRun: dryRun && dryRunMaxJobs !== null ? `${max} (dry_run_default)` : formatMaxJobsPerRunForReport(config.maxJobsPerRun),
    },
    found: totalFound,
    insertedCount: inserted.length,
    skippedDuplicatesCount: skippedDuplicates.length,
    skippedBrokenLinksCount: skippedLinks.length,
    skippedWorkModeCount: skippedWorkMode.length,
    skippedAgeCount: skippedAge.length,
    skippedInsertErrorCount: skippedErrors.length,
    inserted,
    skippedDuplicates,
    skippedLinks,
    skippedWorkMode: skippedWorkMode.slice(0, 20),
    skippedAge: skippedAge.slice(0, 20),
    skippedErrors: skippedErrors.slice(0, 20)
  };

  fs.writeFileSync(path.join(root, "last_run_report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => {
  console.error(JSON.stringify({ error: error.message }, null, 2));
  process.exit(1);
});
