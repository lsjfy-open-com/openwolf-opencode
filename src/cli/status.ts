import * as fs from "node:fs";
import * as path from "node:path";
import { findProjectRoot } from "../scanner/project-root.js";
import { readJSON, readText } from "../utils/fs-safe.js";

export async function statusCommand(): Promise<void> {
  const projectRoot = findProjectRoot();
  const wolfDir = path.join(projectRoot, ".wolf");

  if (!fs.existsSync(wolfDir)) {
    console.log("OpenWolf not initialized. Run: openwolf init");
    return;
  }

  console.log("OpenWolf Status");
  console.log("===============\n");

  // File integrity check
  const requiredFiles = [
    "OPENWOLF.md", "identity.md", "cerebrum.md", "memory.md",
    "anatomy.md", "config.json", "token-ledger.json", "buglog.json",
    "cron-manifest.json", "cron-state.json",
  ];

  let missingCount = 0;
  for (const file of requiredFiles) {
    const exists = fs.existsSync(path.join(wolfDir, file));
    if (!exists) {
      console.log(`  ✗ Missing: .wolf/${file}`);
      missingCount++;
    }
  }
  if (missingCount === 0) {
    console.log(`  ✓ All ${requiredFiles.length} core files present`);
  }

  // Hook scripts check
  const hookFiles = [
    "session-start.js", "pre-read.js", "pre-write.js",
    "post-read.js", "post-write.js", "stop.js", "shared.js",
  ];
  const hooksDir = path.join(wolfDir, "hooks");
  let hooksMissing = 0;
  for (const file of hookFiles) {
    if (!fs.existsSync(path.join(hooksDir, file))) hooksMissing++;
  }
  if (hooksMissing === 0) {
    console.log(`  ✓ All ${hookFiles.length} hook scripts present`);
  } else {
    console.log(`  ✗ Missing ${hooksMissing} hook scripts`);
  }

  // OpenCode plugin check
  const pluginPath = path.join(projectRoot, ".opencode", "plugins", "openwolf.js");
  if (fs.existsSync(pluginPath)) {
    console.log("  ✓ OpenCode plugin installed (.opencode/plugins/openwolf.js)");
  } else {
    console.log("  ✗ .opencode/plugins/openwolf.js not found — run 'openwolf init'");
  }

  // OpenCode skill check
  const skillPath = path.join(projectRoot, ".opencode", "skills", "openwolf", "SKILL.md");
  if (fs.existsSync(skillPath)) {
    console.log("  ✓ OpenCode skill installed (.opencode/skills/openwolf/SKILL.md)");
  }

  // AGENTS.md check
  const agentsMdPath = path.join(projectRoot, "AGENTS.md");
  if (fs.existsSync(agentsMdPath)) {
    const agentsContent = readText(agentsMdPath);
    if (agentsContent.includes("OpenWolf")) {
      console.log("  ✓ AGENTS.md includes OpenWolf snippet");
    }
  }

  // Token ledger stats
  const ledger = readJSON<{
    lifetime: {
      total_sessions: number;
      total_reads: number;
      total_writes: number;
      total_tokens_estimated: number;
      token_savings_estimated: number;
    };
  }>(path.join(wolfDir, "token-ledger.json"), {
    lifetime: { total_sessions: 0, total_reads: 0, total_writes: 0, total_tokens_estimated: 0, token_savings_estimated: 0 },
  });

  console.log(`\nToken Stats:`);
  console.log(`  Sessions: ${ledger.lifetime.total_sessions}`);
  console.log(`  Total reads: ${ledger.lifetime.total_reads}`);
  console.log(`  Total writes: ${ledger.lifetime.total_writes}`);
  console.log(`  Tokens tracked: ~${ledger.lifetime.total_tokens_estimated.toLocaleString()}`);
  console.log(`  Estimated savings: ~${ledger.lifetime.token_savings_estimated.toLocaleString()} tokens`);

  // Anatomy stats
  const anatomyContent = readText(path.join(wolfDir, "anatomy.md"));
  const entryCount = (anatomyContent.match(/^- `/gm) || []).length;
  console.log(`\nAnatomy: ${entryCount} files tracked`);

  // Cron state
  const cronState = readJSON<{ engine_status: string; last_heartbeat: string | null }>(
    path.join(wolfDir, "cron-state.json"),
    { engine_status: "unknown", last_heartbeat: null }
  );
  console.log(`\nDaemon: ${cronState.engine_status}`);
  if (cronState.last_heartbeat) {
    const elapsed = Date.now() - new Date(cronState.last_heartbeat).getTime();
    const mins = Math.floor(elapsed / 60000);
    console.log(`  Last heartbeat: ${mins} minutes ago`);
  }

  console.log("");
}
