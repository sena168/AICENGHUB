import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();
const ROOT_JSON_PATH = path.join(ROOT_DIR, "link-list.json");
const EXTERNAL_JSON_PATH = path.join(ROOT_DIR, "externals", "link-list.json");
const MARKDOWN_PATH = path.join(ROOT_DIR, "externals", "link-list.md");

const FROM_JSON = process.argv.includes("--from-json");
const FROM_MD = process.argv.includes("--from-md") || !FROM_JSON;

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeAbility(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeTool(raw) {
  const abilities = Array.isArray(raw.abilities)
    ? raw.abilities.map(normalizeAbility).filter(Boolean)
    : [];

  return {
    name: normalizeText(raw.name),
    url: normalizeText(raw.url),
    description: normalizeText(raw.description),
    abilities: [...new Set(abilities)]
  };
}

function assertValidTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    throw new Error("No tools found.");
  }

  const seen = new Set();
  for (const tool of tools) {
    if (!tool.name || !tool.url || !tool.description) {
      throw new Error(`Invalid tool entry: ${JSON.stringify(tool)}`);
    }
    if (!Array.isArray(tool.abilities) || tool.abilities.length === 0) {
      throw new Error(`Tool has no abilities: ${tool.name}`);
    }

    const key = tool.name.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Duplicate tool name found: ${tool.name}`);
    }
    seen.add(key);
  }
}

function sortTools(tools) {
  return [...tools].sort((a, b) => a.name.localeCompare(b.name));
}

function renderMarkdown(tools) {
  const lines = [
    "# AICENGHUB Link List (Markdown Source)",
    "",
    "Update this file as the human-readable source, then sync JSON with:",
    "`node scripts/sync-link-list.mjs --from-md`",
    "",
    "## Tools",
    ""
  ];

  for (const tool of tools) {
    lines.push(`- **${tool.name}**`);
    lines.push(`  URL: ${tool.url}`);
    lines.push(`  Description: ${tool.description}`);
    lines.push(`  Abilities: ${tool.abilities.join(", ")}`);
    lines.push("");
  }

  return lines.join("\n");
}

function parseMarkdown(markdown) {
  const lines = markdown.split(/\r?\n/);
  const tools = [];
  let current = null;

  function finalizeCurrent() {
    if (!current) return;
    tools.push(normalizeTool(current));
    current = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const nameMatch = line.match(/^- \*\*(.+)\*\*$/);
    if (nameMatch) {
      finalizeCurrent();
      current = {
        name: nameMatch[1],
        url: "",
        description: "",
        abilities: []
      };
      continue;
    }

    if (!current) continue;

    const urlMatch = line.match(/^URL:\s*(.+)$/i);
    if (urlMatch) {
      current.url = urlMatch[1];
      continue;
    }

    const descMatch = line.match(/^Description:\s*(.+)$/i);
    if (descMatch) {
      current.description = descMatch[1];
      continue;
    }

    const abilityMatch = line.match(/^Abilities:\s*(.+)$/i);
    if (abilityMatch) {
      current.abilities = abilityMatch[1]
        .split(",")
        .map((ability) => normalizeAbility(ability))
        .filter(Boolean);
    }
  }

  finalizeCurrent();
  return tools;
}

async function writeJsonFiles(tools) {
  const json = `${JSON.stringify(tools, null, 2)}\n`;
  await fs.writeFile(ROOT_JSON_PATH, json, "utf8");
  await fs.writeFile(EXTERNAL_JSON_PATH, json, "utf8");
}

async function syncFromJson() {
  const raw = await fs.readFile(ROOT_JSON_PATH, "utf8");
  const tools = sortTools(JSON.parse(raw).map(normalizeTool));
  assertValidTools(tools);

  await writeJsonFiles(tools);
  const md = renderMarkdown(tools);
  await fs.writeFile(MARKDOWN_PATH, `${md}\n`, "utf8");

  console.log(`Synced ${tools.length} tools from JSON -> markdown + both JSON files.`);
}

async function syncFromMd() {
  const raw = await fs.readFile(MARKDOWN_PATH, "utf8");
  const tools = sortTools(parseMarkdown(raw));
  assertValidTools(tools);
  await writeJsonFiles(tools);

  console.log(`Synced ${tools.length} tools from markdown -> both JSON files.`);
}

async function main() {
  if (FROM_JSON) {
    await syncFromJson();
    return;
  }
  if (FROM_MD) {
    await syncFromMd();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
