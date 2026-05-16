/**
 * OpenWolf plugin for OpenCode.
 *
 * Replaces the legacy Claude Code hook system with OpenCode's plugin API.
 * Handles: session start/stop, pre/post read/write tool hooks.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

// ─── OpenCode Plugin types (inline to avoid npm dependency) ─────
interface PluginContext {
  project: unknown;
  client: unknown;
  $: unknown;
  directory: string;
  worktree: string;
}

interface ToolBeforeInput {
  tool: string;
  args: Record<string, unknown>;
}

interface ToolAfterInput {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
}

type PluginResult = Record<string, (...args: any[]) => void | Promise<void>>;
type PluginFn = (ctx: PluginContext) => Promise<PluginResult> | PluginResult;

// ─── Shared utilities inlined for self-contained deployment ─────

function getWolfDir(worktree: string): string {
  const projectDir = process.env.OPENCODE_PROJECT_DIR
    || process.env.CLAUDE_PROJECT_DIR
    || worktree
    || process.cwd();
  return path.join(projectDir, ".wolf");
}

function readJSON<T = unknown>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function writeJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  } catch {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8"); } catch {}
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function readMarkdown(filePath: string): string {
  try { return fs.readFileSync(filePath, "utf-8"); } catch { return ""; }
}

function appendMarkdown(filePath: string, line: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(filePath, line, "utf-8");
}

interface AnatomyEntry {
  file: string;
  description: string;
  tokens: number;
}

function parseAnatomy(content: string): Map<string, AnatomyEntry[]> {
  const sections = new Map<string, AnatomyEntry[]>();
  let currentSection = "";
  for (const line of content.split("\n")) {
    const sm = line.match(/^## (.+)/);
    if (sm) {
      currentSection = sm[1].trim();
      if (!sections.has(currentSection)) sections.set(currentSection, []);
      continue;
    }
    if (!currentSection) continue;
    const em = line.match(/^- `([^`]+)`(?:\s+—\s+(.+?))?\s*\(~(\d+)\s+tok\)$/);
    if (em) {
      sections.get(currentSection)!.push({
        file: em[1],
        description: em[2] || "",
        tokens: parseInt(em[3], 10),
      });
    }
  }
  return sections;
}

function serializeAnatomy(
  sections: Map<string, AnatomyEntry[]>,
  metadata: { lastScanned: string; fileCount: number; hits: number; misses: number }
): string {
  const lines: string[] = [
    "# anatomy.md",
    "",
    `> Auto-maintained by OpenWolf. Last scanned: ${metadata.lastScanned}`,
    `> Files: ${metadata.fileCount} tracked | Anatomy hits: ${metadata.hits} | Misses: ${metadata.misses}`,
    "",
  ];
  const keys = [...sections.keys()].sort();
  for (const key of keys) {
    lines.push(`## ${key}`);
    lines.push("");
    const entries = sections.get(key)!.sort((a, b) => a.file.localeCompare(b.file));
    for (const e of entries) {
      const desc = e.description ? ` — ${e.description}` : "";
      lines.push(`- \`${e.file}\`${desc} (~${e.tokens} tok)`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function extractDescription(filePath: string): string {
  const MAX_DESC = 150;
  const basename = path.basename(filePath);
  const ext = path.extname(basename).toLowerCase();
  const known: Record<string, string> = {
    "package.json": "Node.js package manifest",
    "tsconfig.json": "TypeScript configuration",
    ".gitignore": "Git ignore rules",
    "README.md": "Project documentation",
    "Dockerfile": "Docker container definition",
    "docker-compose.yml": "Docker Compose services",
    "Cargo.toml": "Rust package manifest",
    "go.mod": "Go module definition",
    "Gemfile": "Ruby dependencies",
  };
  if (known[basename]) return known[basename];

  let content: string;
  try {
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(12288);
    const n = fs.readSync(fd, buf, 0, 12288, 0);
    fs.closeSync(fd);
    content = buf.subarray(0, n).toString("utf-8");
  } catch {
    return "";
  }
  if (!content.trim()) return "";

  const cap = (s: string) => s.length <= MAX_DESC ? s : s.slice(0, MAX_DESC - 3) + "...";

  // Markdown heading
  if (ext === ".md" || ext === ".mdx") {
    const m = content.match(/^#{1,2}\s+(.+)$/m);
    if (m) return cap(m[1].trim());
  }

  // JSDoc / PHPDoc / Javadoc
  const jm = content.match(/\/\*\*\s*\n?\s*\*?\s*(.+)/);
  if (jm) {
    const l = jm[1].replace(/\*\/$/, "").trim();
    if (l && !l.startsWith("@") && l.length > 5) return cap(l);
  }

  // React component
  if (ext === ".tsx" || ext === ".jsx") {
    const comp = content.match(/(?:export\s+(?:default\s+)?)?(?:function|const)\s+(\w+)/);
    if (comp) return cap(comp[1]);
  }

  // Exports summary for TS/JS
  if (ext === ".ts" || ext === ".js" || ext === ".tsx" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") {
    const exports = (content.match(/export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+(\w+)/g) || [])
      .map(e => e.match(/(\w+)$/)?.[1]).filter(Boolean) as string[];
    if (exports.length > 0 && exports.length <= 5) return `Exports ${exports.join(", ")}`;
    if (exports.length > 5) return cap(`Exports ${exports.slice(0, 4).join(", ")} + ${exports.length - 4} more`);
  }

  // Header comment
  const hdrLines = content.split("\n");
  for (const line of hdrLines.slice(0, 15)) {
    const t = line.trim();
    if (!t || t === "<?php" || t.startsWith("#!") || t.startsWith("namespace") || t.startsWith("use ") || t.startsWith("import ") || t.startsWith("from ") || t.startsWith("require") || t.startsWith("module ")) continue;
    const cm = t.match(/^(?:\/\/|#|--)\s*(.+)/);
    if (cm) {
      const text = cm[1].trim();
      const lower = text.toLowerCase();
      if (text.length > 5 && !lower.startsWith("copyright") && !lower.startsWith("license") && !lower.startsWith("@") && !lower.startsWith("strict") && !lower.startsWith("generated") && !lower.startsWith("eslint-") && !lower.startsWith("nolint")) {
        return cap(text);
      }
    }
    if (!t.startsWith("//") && !t.startsWith("#") && !t.startsWith("/*") && !t.startsWith("*") && !t.startsWith("--")) break;
  }

  // Python
  if (ext === ".py") {
    const cls = content.match(/class\s+(\w+)/);
    const funcs = (content.match(/def\s+(\w+)/g) || []).map(f => f.match(/def\s+(\w+)/)?.[1]).filter(n => n && !n.startsWith("_")) as string[];
    if (cls && funcs.length > 0) return cap(`${cls[1]}: ${funcs.slice(0, 4).join(", ")}`);
    if (funcs.length > 0) return cap(funcs.slice(0, 4).join(", "));
  }

  // Go
  if (ext === ".go") {
    const structM = content.match(/type\s+(\w+)\s+struct\s*\{/);
    if (structM) return `Struct: ${structM[1]}`;
    const fns = (content.match(/^func\s+(\w+)/gm) || []).map(m => m.match(/func\s+(\w+)/)?.[1]).filter(n => n && n[0] === n[0].toUpperCase()) as string[];
    if (fns.length) return cap(fns.slice(0, 5).join(", "));
  }

  // Rust
  if (ext === ".rs") {
    const structM = content.match(/pub\s+struct\s+(\w+)/);
    if (structM) return `Struct: ${structM[1]}`;
  }

  // Java
  if (ext === ".java") {
    const cls = content.match(/(?:public\s+)?class\s+(\w+)/);
    if (cls) return `Class: ${cls[1]}`;
  }

  // CSS
  if (ext === ".css" || ext === ".scss" || ext === ".less") {
    const rules = (content.match(/^[.#@][^\n{]+/gm) || []).length;
    if (rules) return `Styles: ${rules} rules`;
  }

  // SQL
  if (ext === ".sql") {
    const creates = (content.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?(\w+)/gi) || []).length;
    if (creates) return `SQL: ${creates} tables`;
  }

  const declM = content.match(/(?:function|class|const|interface|type|enum)\s+(\w+)/);
  if (declM) return `Declares ${declM[1]}`;
  return "";
}

function estimateTokens(text: string, type: "code" | "prose" | "mixed" = "mixed"): number {
  const ratio = type === "code" ? 3.5 : type === "prose" ? 4.0 : 3.75;
  return Math.ceil(text.length / ratio);
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

function timeShort(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function summarizeEdit(oldStr: string, newStr: string, filename: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  const oldCount = oldLines.length;
  const newCount = newLines.length;

  if (newStr.includes("try") && newStr.includes("catch") && !oldStr.includes("catch")) {
    return "added error handling";
  }
  if (newStr.includes("?.") && !oldStr.includes("?.")) return "added optional chaining";
  if (newStr.includes("?? ") && !oldStr.includes("?? ")) return "added nullish coalescing";

  if (!newStr.trim() || newStr.trim().length < oldStr.trim().length * 0.2) {
    return `removed ${oldCount} lines`;
  }

  const oldImports = oldLines.filter(l => /^\s*(import|require|use |from )/.test(l)).length;
  const newImports = newLines.filter(l => /^\s*(import|require|use |from )/.test(l)).length;
  if (newImports > oldImports && Math.abs(newCount - oldCount) <= newImports - oldImports + 1) {
    return `added ${newImports - oldImports} import(s)`;
  }

  if (oldCount === 1 && newCount === 1) {
    const o = oldStr.trim();
    const n = newStr.trim();
    const oStr = o.match(/['"`]([^'"`]+)['"`]/);
    const nStr = n.match(/['"`]([^'"`]+)['"`]/);
    if (oStr && nStr && oStr[1] !== nStr[1]) {
      return `"${oStr[1].slice(0, 25)}" → "${nStr[1].slice(0, 25)}"`;
    }
    return "inline fix";
  }

  if (newCount > oldCount + 5) return `expanded (+${newCount - oldCount} lines)`;
  if (oldCount > newCount + 5) return `reduced (-${oldCount - newCount} lines)`;
  return `${oldCount}→${newCount} lines`;
}

// ─── Session State ──────────────────────────────────────────────

interface SessionData {
  session_id: string;
  started: string;
  files_read: Record<string, { count: number; tokens: number; first_read: string }>;
  files_written: Array<{ file: string; action: string; tokens: number; at: string }>;
  edit_counts: Record<string, number>;
  anatomy_hits: number;
  anatomy_misses: number;
  repeated_reads_warned: number;
  cerebrum_warnings: number;
  stop_count: number;
}

interface SessionEntry {
  id: string;
  started: string;
  ended: string;
  reads: Array<{ file: string; tokens_estimated: number; was_repeated: boolean; anatomy_had_description: boolean }>;
  writes: Array<{ file: string; tokens_estimated: number; action: string }>;
  totals: {
    input_tokens_estimated: number;
    output_tokens_estimated: number;
    reads_count: number;
    writes_count: number;
    repeated_reads_blocked: number;
    anatomy_lookups: number;
  };
}

interface BugEntry {
  id: string;
  timestamp: string;
  error_message: string;
  file: string;
  root_cause: string;
  fix: string;
  tags: string[];
  related_bugs: string[];
  occurrences: number;
  last_seen: string;
}

interface BugLog {
  version: number;
  bugs: BugEntry[];
}

// ─── Plugin ─────────────────────────────────────────────────────

export const OpenWolfPlugin: PluginFn = async ({ directory, worktree }) => {
  const projectRoot = directory || worktree;
  let initialized = false;

  function wolfDir(): string {
    return getWolfDir(projectRoot);
  }

  function ensureWolfDir(): boolean {
    const wd = wolfDir();
    if (!fs.existsSync(wd)) return false;
    return true;
  }

  function sessionFile(): string {
    return path.join(wolfDir(), "hooks", "_session.json");
  }

  function initSession(): void {
    if (initialized) return;
    initialized = true;
    const wd = wolfDir();
    if (!fs.existsSync(wd)) return;

    // Clean stale tmp files
    try {
      const files = fs.readdirSync(wd);
      for (const f of files) {
        if (f.endsWith(".tmp")) {
          try { fs.unlinkSync(path.join(wd, f)); } catch {}
        }
      }
    } catch {}

    // Create _session.json
    const hooksDir = path.join(wd, "hooks");
    if (!fs.existsSync(hooksDir)) fs.mkdirSync(hooksDir, { recursive: true });
    const sf = sessionFile();
    const now = new Date();
    const sessionId = `session-${now.toISOString().slice(0, 10)}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;

    writeJSON(sf, {
      session_id: sessionId,
      started: timestamp(),
      files_read: {},
      files_written: [],
      edit_counts: {},
      anatomy_hits: 0,
      anatomy_misses: 0,
      repeated_reads_warned: 0,
      cerebrum_warnings: 0,
      stop_count: 0,
    });

    // Append session header to memory.md
    const memoryPath = path.join(wd, "memory.md");
    const header = `\n## Session: ${now.toISOString().slice(0, 10)} ${timeShort()}\n\n| Time | Action | File(s) | Outcome | ~Tokens |\n|------|--------|---------|---------|--------|\n`;
    appendMarkdown(memoryPath, header);

    // Increment total_sessions
    const ledgerPath = path.join(wd, "token-ledger.json");
    const ledger = readJSON(ledgerPath, { version: 1, lifetime: { total_sessions: 0 } }) as {
      version: number;
      lifetime: { total_sessions: number };
    };
    ledger.lifetime.total_sessions++;
    writeJSON(ledgerPath, ledger);

    // Cerebrum freshness check
    try {
      const cerebrumPath = path.join(wd, "cerebrum.md");
      const cerebrumContent = fs.readFileSync(cerebrumPath, "utf-8");
      const stat = fs.statSync(cerebrumPath);
      const daysSinceUpdate = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
      const entryLines = cerebrumContent.split("\n").filter(l => {
        const t = l.trim();
        return t.startsWith("- ") || t.startsWith("* ") || (t.startsWith("[") && t.includes("]"));
      });

      if (entryLines.length < 3) {
        console.error(`OpenWolf: cerebrum.md has only ${entryLines.length} entries. Record user preferences, project conventions, and mistakes.`);
      } else if (daysSinceUpdate > 3) {
        console.error(`OpenWolf: cerebrum.md hasn't been updated in ${Math.floor(daysSinceUpdate)} days.`);
      }
    } catch {}

    // Buglog check
    try {
      const buglog = readJSON<BugLog>(path.join(wd, "buglog.json"), { version: 1, bugs: [] });
      if (buglog.bugs.length === 0) {
        console.error("OpenWolf: buglog.json is empty. If you encounter bugs, log them.");
      }
    } catch {}
  }

  return {
    // ─── Event hook: session lifecycle + tool events ─────────
    "event": async (evt: { event?: { type?: string; properties?: Record<string, unknown> }; type?: string; properties?: Record<string, unknown> }) => {
      // Handle both shapes: {event: {type, properties}} and {type, properties}
      const eventType = evt.event?.type || evt.type || "";
      const props = evt.event?.properties || evt.properties || {};

      if (eventType === "session.created") {
        initSession();
      }

      if (eventType === "session.idle") {
        await handleSessionStop();
      }

      // tool.execute events also come through the event bus
      if (eventType === "tool.execute.before") {
        const toolName = (props.tool as string) || "";
        if (toolName === "read") {
          // pre-read: we can only init session here, the actual file check happens in after
          initSession();
        }
        if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
          initSession();
        }
      }

      if (eventType === "tool.execute.after") {
        const toolName = (props.tool as string) || "";
        const args = (props.args || {}) as Record<string, unknown>;
        const result = props.result as string | undefined;
        
        if (!ensureWolfDir()) return;

        if (toolName === "read") {
          await handlePostRead(args, result);
        }
        if (toolName === "write" || toolName === "edit" || toolName === "apply_patch") {
          await handlePostWrite(toolName, args);
        }
      }
    },

    // ─── Tool execute hooks (direct registration) ────────────
    "tool.execute.after": async (input: ToolAfterInput) => {
      if (!ensureWolfDir()) return;
      initSession();

      const tool = input.tool;
      const args = input.args || {} as Record<string, unknown>;
      const result = input.result;

      if (tool === "read") {
        await handlePostRead(args, result);
      }
      if (tool === "write" || tool === "edit" || tool === "apply_patch") {
        await handlePostWrite(tool, args);
      }
    },
  };

  // ─── Helper functions for tool event handling ──────────

  async function handlePostRead(args: Record<string, unknown>, result?: string) {
    const wd = wolfDir();
    const filePath = (args.filePath as string) || (args.path as string) || "";
    if (!filePath) return;
    const normalizedFile = normalizePath(filePath);
    const root = normalizePath(projectRoot);
    const relToProject = normalizedFile.startsWith(root) ? normalizedFile.slice(root.length).replace(/^\//, "") : "";
    if (relToProject.startsWith(".wolf/") || relToProject.startsWith(".wolf\\")) return;

    const content = result ?? "";
    const ext = path.extname(filePath).toLowerCase();
    const codeExts = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".rs", ".go", ".java", ".c", ".cpp", ".css", ".json", ".yaml", ".yml"]);
    const proseExts = new Set([".md", ".txt", ".rst"]);
    const type = codeExts.has(ext) ? "code" : proseExts.has(ext) ? "prose" : "mixed";
    let tokens = content ? estimateTokens(content, type as "code" | "prose" | "mixed") : 0;

    if (tokens === 0) {
      const anatomyContent = readMarkdown(path.join(wd, "anatomy.md"));
      const sections = parseAnatomy(anatomyContent);
      for (const entries of sections.values()) {
        for (const entry of entries) {
          const entryRelPath = normalizePath(path.join("", entry.file));
          if (normalizedFile.endsWith(entryRelPath) || normalizedFile.endsWith("/" + entryRelPath)) {
            tokens = entry.tokens;
            break;
          }
        }
        if (tokens > 0) break;
      }
    }

    const sf = sessionFile();
    const session = readJSON<{ files_read: Record<string, { count: number; tokens: number; first_read: string }>; anatomy_hits: number; anatomy_misses: number; repeated_reads_warned: number }>(sf, { files_read: {}, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_warned: 0 });

    // Check for repeated read
    if (session.files_read[normalizedFile]) {
      const prev = session.files_read[normalizedFile];
      console.error(`OpenWolf: ${path.basename(normalizedFile)} was already read this session (~${prev.tokens} tokens).`);
      session.files_read[normalizedFile].count++;
      session.repeated_reads_warned++;
      writeJSON(sf, session);
      return;
    }

    // Check anatomy
    const anatomyContent = readMarkdown(path.join(wd, "anatomy.md"));
    const sections = parseAnatomy(anatomyContent);
    let found = false;
    for (const [sectionKey, entries] of sections) {
      for (const entry of entries) {
        const entryRelPath = normalizePath(path.join(sectionKey, entry.file));
        if (normalizedFile.endsWith(entryRelPath) || normalizedFile.endsWith("/" + entryRelPath)) {
          console.error(`OpenWolf anatomy: ${entry.file} — ${entry.description} (~${entry.tokens} tok)`);
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (found) session.anatomy_hits++;
    else session.anatomy_misses++;

    session.files_read[normalizedFile] = { count: 1, tokens, first_read: new Date().toISOString() };
    writeJSON(sf, session);
  }

  async function handlePostWrite(tool: string, args: Record<string, unknown>) {
    const wd = wolfDir();
    const filePathArg = (args.filePath as string) || (args.path as string) || "";
    if (!filePathArg) return;
    const absolutePath = path.isAbsolute(filePathArg) ? filePathArg : path.join(projectRoot, filePathArg);
    const relPath = normalizePath(path.relative(projectRoot, absolutePath));
    if (relPath.startsWith(".wolf/")) return;

    const baseName = path.basename(absolutePath);
    if (baseName === ".env" || baseName.startsWith(".env.")) return;

    const content = (args.content as string) || "";
    const oldStr = (args.oldString as string) || (args.old_string as string) || "";
    const newStr = (args.newString as string) || (args.new_string as string) || "";

    // Update anatomy
    try {
      const anatomyPath = path.join(wd, "anatomy.md");
      let anatomyContent: string;
      try { anatomyContent = fs.readFileSync(anatomyPath, "utf-8"); } catch { anatomyContent = "# anatomy.md\n\n> Auto-maintained by OpenWolf.\n"; }
      const sections = parseAnatomy(anatomyContent);
      const dir = path.dirname(relPath);
      const fileName = path.basename(relPath);
      const sectionKey = dir === "." ? "./" : dir + "/";
      let fileContent = "";
      try { fileContent = fs.readFileSync(absolutePath, "utf-8"); } catch { fileContent = content; }
      const desc = extractDescription(absolutePath).slice(0, 100);
      const ext = path.extname(absolutePath).toLowerCase();
      const codeExts = new Set([".ts", ".js", ".tsx", ".jsx", ".py", ".json", ".yaml", ".yml", ".css"]);
      const proseExts = new Set([".md", ".txt", ".rst"]);
      const fType = codeExts.has(ext) ? "code" : proseExts.has(ext) ? "prose" : "mixed";
      const tokens = estimateTokens(fileContent, fType as "code" | "prose" | "mixed");
      if (!sections.has(sectionKey)) sections.set(sectionKey, []);
      const entries = sections.get(sectionKey)!;
      const idx = entries.findIndex((e) => e.file === fileName);
      if (idx !== -1) entries[idx] = { file: fileName, description: desc, tokens };
      else entries.push({ file: fileName, description: desc, tokens });
      let fileCount = 0;
      for (const [, list] of sections) fileCount += list.length;
      const serialized = serializeAnatomy(sections, { lastScanned: new Date().toISOString(), fileCount, hits: 0, misses: 0 });
      const tmp = anatomyPath + "." + crypto.randomBytes(4).toString("hex") + ".tmp";
      try { fs.writeFileSync(tmp, serialized, "utf-8"); fs.renameSync(tmp, anatomyPath); } catch { try { fs.writeFileSync(anatomyPath, serialized, "utf-8"); } catch {} try { fs.unlinkSync(tmp); } catch {} }
    } catch {}

    // Memory
    try {
      const action = tool === "write" ? "Created" : "Edited";
      const writeTokens = estimateTokens(content || newStr, "code");
      let changeDesc = "";
      if (oldStr && newStr) changeDesc = summarizeEdit(oldStr, newStr, baseName);
      const memoryPath = path.join(wd, "memory.md");
      const outcome = changeDesc || "—";
      appendMarkdown(memoryPath, `| ${timeShort()} | ${action} ${relPath} | ${outcome} | ~${writeTokens} |\n`);
    } catch {}

    // Session tracker
    try {
      const sf = sessionFile();
      const session = readJSON<SessionData>(sf, { session_id: "", files_read: {}, anatomy_hits: 0, anatomy_misses: 0, repeated_reads_warned: 0, files_written: [], edit_counts: {}, cerebrum_warnings: 0, stop_count: 0, started: "" });
      if (!session.edit_counts) session.edit_counts = {};
      const action = tool === "write" ? "create" : "edit";
      const tok = estimateTokens(content || newStr, "code");
      session.files_written.push({ file: normalizePath(filePathArg), action, tokens: tok, at: new Date().toISOString() });
      session.edit_counts[relPath] = (session.edit_counts[relPath] || 0) + 1;
      writeJSON(sf, session);
      if (session.edit_counts[relPath] >= 3) {
        console.error(`OpenWolf: ${baseName} has been edited ${session.edit_counts[relPath]} times this session. If you're fixing a bug, log it to .wolf/buglog.json.`);
      }
    } catch {}
  }

  async function handleSessionStop() {
    if (!ensureWolfDir()) return;
    if (!initialized) return;
    // (stop logic remains inline for now - will be refactored)
  }
};

export default OpenWolfPlugin;
