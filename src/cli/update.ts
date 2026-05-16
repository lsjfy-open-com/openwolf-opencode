/**
 * openwolf update — Update all registered OpenWolf projects.
 *
 * For each project:
 * 1. Creates a timestamped backup in .wolf/backups/
 * 2. Updates plugins, templates, protocol files
 * 3. Preserves all user data (cerebrum, memory, anatomy, buglog, ledger)
 * 4. Reports results per project
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getRegisteredProjects, registerProject, type RegisteredProject } from "./registry.js";
import { readJSON, writeJSON, readText, writeText } from "../utils/fs-safe.js";
import { ensureDir } from "../utils/paths.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "../../../package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

// Files that are safe to overwrite (protocol/config)
const ALWAYS_OVERWRITE = ["OPENWOLF.md", "config.json", "reframe-frameworks.md"];

// Files that contain user data — NEVER overwrite, only create if missing
const USER_DATA_FILES = [
  "identity.md", "cerebrum.md", "memory.md", "anatomy.md",
  "token-ledger.json", "buglog.json", "cron-manifest.json", "cron-state.json",
  "suggestions.json", "designqc-report.json",
];

// Files to include in backup
const BACKUP_FILES = [
  ...ALWAYS_OVERWRITE,
  ...USER_DATA_FILES,
];

interface UpdateResult {
  project: RegisteredProject;
  status: "updated" | "skipped" | "error";
  backupDir?: string;
  message: string;
}

export async function updateCommand(options: { dryRun?: boolean; force?: boolean; project?: string }): Promise<void> {
  const version = getVersion();
  const projects = getRegisteredProjects(true);

  if (projects.length === 0) {
    console.log("No registered OpenWolf projects found.");
    console.log("Run 'openwolf init' in a project directory to register it.");
    return;
  }

  // Filter to specific project if requested
  let targets = projects;
  if (options.project) {
    const search = options.project.toLowerCase();
    targets = projects.filter(p =>
      p.name.toLowerCase().includes(search) ||
      p.root.toLowerCase().includes(search)
    );
    if (targets.length === 0) {
      console.log(`No registered project matching "${options.project}".`);
      console.log("Registered projects:");
      for (const p of projects) {
        console.log(`  - ${p.name} (${p.root})`);
      }
      return;
    }
  }

  console.log(`OpenWolf v${version} — updating ${targets.length} project(s)${options.dryRun ? " (dry run)" : ""}...\n`);

  const results: UpdateResult[] = [];

  for (const project of targets) {
    const result = await updateProject(project, version, options.dryRun ?? false);
    results.push(result);
  }

  // Summary
  console.log("\n─── Update Summary ───");
  const updated = results.filter(r => r.status === "updated");
  const skipped = results.filter(r => r.status === "skipped");
  const errors = results.filter(r => r.status === "error");

  if (updated.length > 0) {
    console.log(`\n  ✓ Updated (${updated.length}):`);
    for (const r of updated) {
      console.log(`    ${r.project.name} — ${r.message}`);
    }
  }
  if (skipped.length > 0) {
    console.log(`\n  ○ Skipped (${skipped.length}):`);
    for (const r of skipped) {
      console.log(`    ${r.project.name} — ${r.message}`);
    }
  }
  if (errors.length > 0) {
    console.log(`\n  ✗ Errors (${errors.length}):`);
    for (const r of errors) {
      console.log(`    ${r.project.name} — ${r.message}`);
    }
  }
  console.log("");
}

async function updateProject(
  project: RegisteredProject,
  version: string,
  dryRun: boolean
): Promise<UpdateResult> {
  const { root, name } = project;
  const wolfDir = path.join(root, ".wolf");

  // Validate project still exists
  if (!fs.existsSync(wolfDir)) {
    return { project, status: "skipped", message: ".wolf/ directory not found" };
  }

  // Never update the openwolf source repo itself
  if (name === "openwolf") {
    return { project, status: "skipped", message: "openwolf source repo — skipped" };
  }

  console.log(`  ${name} (${root})`);

  // Already at this version?
  if (project.version === version) {
    console.log(`    Already at v${version} — updating hooks/templates anyway`);
  }

  if (dryRun) {
    console.log(`    [dry run] Would backup, update hooks, templates, rules`);
    return { project, status: "updated", message: `would update to v${version}` };
  }

  try {
    // 1. Create backup
    const backupDir = createBackup(wolfDir);
    console.log(`    ✓ Backup: ${path.basename(backupDir)}`);

    // 2. Update template files (OPENWOLF.md, config.json)
    const templatesDir = findTemplatesDir();
    for (const file of ALWAYS_OVERWRITE) {
      const srcPath = path.join(templatesDir, file);
      const destPath = path.join(wolfDir, file);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, destPath);
      }
    }
    console.log(`    ✓ Templates updated (${ALWAYS_OVERWRITE.join(", ")})`);

    // 3. Update hook scripts
    copyHookScripts(wolfDir);
    console.log(`    ✓ Hook scripts updated`);

    // 4. Update .opencode/plugins/openwolf.js
    const pluginsDir = path.join(root, ".opencode", "plugins");
    ensureDir(pluginsDir);
    const pluginDest = path.join(pluginsDir, "openwolf.js");
    // Try compiled plugin from dist first
    const pluginCandidates = [
      path.resolve(__dirname, "..", "plugin", "openwolf-plugin.js"),
      path.resolve(__dirname, "..", "..", "plugin", "openwolf-plugin.js"),
      path.resolve(__dirname, "..", "..", "dist", "plugin", "openwolf-plugin.js"),
    ];
    let pluginCopied = false;
    for (const src of pluginCandidates) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, pluginDest);
        pluginCopied = true;
        break;
      }
    }
    if (!pluginCopied) {
      // Fallback: try .wolf/hooks/
      const wolfPlugin = path.join(wolfDir, "hooks", "openwolf-plugin.js");
      if (fs.existsSync(wolfPlugin)) {
        fs.copyFileSync(wolfPlugin, pluginDest);
        pluginCopied = true;
      }
    }
    console.log(`    ✓ OpenCode plugin ${pluginCopied ? "updated" : "skipped (not found)"}`);

    // 5. Update .opencode/skills/openwolf/SKILL.md
    const skillsDir = path.join(root, ".opencode", "skills", "openwolf");
    ensureDir(skillsDir);
    const skillContent = readTemplateContent("opencode-skill.md", templatesDir);
    if (skillContent) {
      writeText(path.join(skillsDir, "SKILL.md"), skillContent);
      console.log(`    ✓ OpenCode skill updated`);
    }

    // 6. Update AGENTS.md snippet if it references OpenWolf
    const agentsMdPath = path.join(root, "AGENTS.md");
    const snippetContent = readTemplateContent("agents-md-snippet.md", templatesDir);
    if (fs.existsSync(agentsMdPath)) {
      const existing = readText(agentsMdPath);
      if (!existing.includes("OpenWolf")) {
        writeText(agentsMdPath, snippetContent + "\n\n" + existing);
        console.log(`    ✓ AGENTS.md updated`);
      }
    }

    // Also update CLAUDE.md for backward compatibility
    const claudeMdPath = path.join(root, "CLAUDE.md");
    if (fs.existsSync(claudeMdPath)) {
      const existing = readText(claudeMdPath);
      if (!existing.includes("OpenWolf")) {
        writeText(claudeMdPath, snippetContent + "\n\n" + existing);
      }
    }

    // 7. Clean up stale .tmp files
    try {
      const files = fs.readdirSync(wolfDir);
      let cleaned = 0;
      for (const f of files) {
        if (f.endsWith(".tmp")) {
          try { fs.unlinkSync(path.join(wolfDir, f)); cleaned++; } catch {}
        }
      }
      if (cleaned > 0) console.log(`    ✓ Cleaned ${cleaned} stale .tmp file(s)`);
    } catch {}

    // 8. Update registry entry
    registerProject(root, name, version);

    return {
      project,
      status: "updated",
      backupDir,
      message: `v${project.version} → v${version}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { project, status: "error", message: msg };
  }
}

/**
 * Create a timestamped backup of all .wolf files into .wolf/backups/YYYY-MM-DD_HHMMSS/
 */
function createBackup(wolfDir: string): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "").slice(0, 15); // 20260315T013000
  const backupDir = path.join(wolfDir, "backups", stamp);
  ensureDir(backupDir);

  // Backup all relevant files
  for (const file of BACKUP_FILES) {
    const src = path.join(wolfDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(backupDir, file));
    }
  }

  // Also backup hooks
  const hooksDir = path.join(wolfDir, "hooks");
  if (fs.existsSync(hooksDir)) {
    const hooksBackup = path.join(backupDir, "hooks");
    ensureDir(hooksBackup);
    try {
      const hookFiles = fs.readdirSync(hooksDir);
      for (const f of hookFiles) {
        const src = path.join(hooksDir, f);
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(hooksBackup, f));
        }
      }
    } catch {}
  }

  // Also backup .opencode/plugins/openwolf.js
  const projectRoot = path.dirname(wolfDir);
  const opencodePlugin = path.join(projectRoot, ".opencode", "plugins", "openwolf.js");
  if (fs.existsSync(opencodePlugin)) {
    const opencodeBackup = path.join(backupDir, ".opencode", "plugins");
    ensureDir(opencodeBackup);
    fs.copyFileSync(opencodePlugin, path.join(opencodeBackup, "openwolf.js"));
  }
  // Also backup AGENTS.md
  const agentsMd = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(agentsMd)) {
    fs.copyFileSync(agentsMd, path.join(backupDir, "AGENTS.md"));
  }

  return backupDir;
}

// ─── Shared helpers (extracted from init.ts patterns) ─────────────

function findTemplatesDir(): string {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", "src", "templates"),
    path.resolve(__dirname, "..", "..", "src", "templates"),
    path.resolve(__dirname, "..", "templates"),
    path.resolve(__dirname, "templates"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  return candidates[0];
}

function readTemplateContent(filename: string, templatesDir: string): string {
  const filePath = path.join(templatesDir, filename);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf-8");
  }
  const templates: Record<string, string> = {
    "agents-md-snippet.md": `# OpenWolf\n\n> This project uses OpenWolf for context management.\n\n## Instructions\n- Read and follow .wolf/OPENWOLF.md every session\n- Check .wolf/cerebrum.md before generating code\n- Check .wolf/anatomy.md before reading files`,
  };
  return templates[filename] ?? "";
}

function copyHookScripts(wolfDir: string): void {
  const hooksDir = path.join(wolfDir, "hooks");
  ensureDir(hooksDir);

  const candidates = [
    path.join(__dirname, "..", "hooks"),
    path.resolve(__dirname, "..", "..", "hooks"),
    path.resolve(__dirname, "..", "..", "dist", "hooks"),
  ];

  let sourceDir = "";
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, "shared.js"))) {
      sourceDir = candidate;
      break;
    }
  }

  const hookFiles = [
    "session-start.js", "pre-read.js", "pre-write.js",
    "post-read.js", "post-write.js", "stop.js", "shared.js",
  ];

  if (sourceDir) {
    for (const file of hookFiles) {
      const src = path.join(sourceDir, file);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(hooksDir, file));
      }
    }
  }

  // Always ensure package.json with type:module
  const hooksPkgPath = path.join(hooksDir, "package.json");
  fs.writeFileSync(hooksPkgPath, JSON.stringify({ type: "module" }, null, 2) + "\n", "utf-8");
}



/**
 * List all registered projects (for `openwolf update --list`)
 */
export function listProjects(): void {
  const projects = getRegisteredProjects(true);

  if (projects.length === 0) {
    console.log("No registered OpenWolf projects.");
    console.log("Run 'openwolf init' in a project directory to register it.");
    return;
  }

  console.log(`Registered OpenWolf projects (${projects.length}):\n`);
  for (const p of projects) {
    const age = Math.floor((Date.now() - new Date(p.last_updated).getTime()) / (1000 * 60 * 60 * 24));
    console.log(`  ${p.name}`);
    console.log(`    Path: ${p.root}`);
    console.log(`    Version: ${p.version} | Updated: ${age}d ago`);
    console.log("");
  }
}

/**
 * Restore a project's .wolf from a backup
 */
export function restoreCommand(backupName?: string): void {
  const wolfDir = path.join(process.cwd(), ".wolf");
  const backupsDir = path.join(wolfDir, "backups");

  if (!fs.existsSync(backupsDir)) {
    console.log("No backups found for this project.");
    return;
  }

  const backups = fs.readdirSync(backupsDir)
    .filter(d => fs.statSync(path.join(backupsDir, d)).isDirectory())
    .sort()
    .reverse();

  if (backups.length === 0) {
    console.log("No backups found.");
    return;
  }

  if (!backupName) {
    console.log(`Available backups (${backups.length}):\n`);
    for (const b of backups) {
      const files = fs.readdirSync(path.join(backupsDir, b)).filter(f => !fs.statSync(path.join(backupsDir, b, f)).isDirectory());
      console.log(`  ${b} (${files.length} files)`);
    }
    console.log(`\nTo restore: openwolf restore <backup-name>`);
    return;
  }

  const backupDir = path.join(backupsDir, backupName);
  if (!fs.existsSync(backupDir)) {
    console.log(`Backup "${backupName}" not found.`);
    return;
  }

  // Restore files
  const files = fs.readdirSync(backupDir).filter(f => fs.statSync(path.join(backupDir, f)).isFile());
  for (const file of files) {
    fs.copyFileSync(path.join(backupDir, file), path.join(wolfDir, file));
  }

  // Restore hooks if present
  const hooksBackup = path.join(backupDir, "hooks");
  if (fs.existsSync(hooksBackup)) {
    const hookFiles = fs.readdirSync(hooksBackup);
    const hooksDir = path.join(wolfDir, "hooks");
    ensureDir(hooksDir);
    for (const f of hookFiles) {
      fs.copyFileSync(path.join(hooksBackup, f), path.join(hooksDir, f));
    }
  }

  // Restore .opencode plugin if present
  const opencodeBackup = path.join(backupDir, ".opencode");
  if (fs.existsSync(opencodeBackup)) {
    const projectRoot = path.dirname(wolfDir);
    const pluginBackup = path.join(opencodeBackup, "plugins", "openwolf.js");
    if (fs.existsSync(pluginBackup)) {
      const dest = path.join(projectRoot, ".opencode", "plugins", "openwolf.js");
      ensureDir(path.dirname(dest));
      fs.copyFileSync(pluginBackup, dest);
    }
  }
  // Restore AGENTS.md if present
  const agentsBackup = path.join(backupDir, "AGENTS.md");
  if (fs.existsSync(agentsBackup)) {
    fs.copyFileSync(agentsBackup, path.join(path.dirname(wolfDir), "AGENTS.md"));
  }

  console.log(`Restored ${files.length} files from backup "${backupName}".`);
}
