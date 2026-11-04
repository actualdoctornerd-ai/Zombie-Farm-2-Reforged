// Source inventory and Chinese coverage gate. This reads syntax/data, never executes
// the game, changes catalogs or requires the proprietary IPA.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const found = new Map();
const displayFields = new Set([
  "name", "label", "title", "description", "say", "hint", "intro", "body",
  "eyebrow", "flavorText", "info", "messageComplete", "tip", "typeName",
  "bossName", "text", "desc", "note", "xpHint", "effect", "blurb", "line", "message", "stoneWhen", "goldenWhen",
]);
const presentation = /(?:\/ui\/|\/hud\.ts$|\/tutorial\/steps\.ts$|\/statsView\.ts$|\/zombie\/(?:almanac|statDisplay)|\/raid\/(?:raidTips|settlementNotice|sessionExpiry|RaidCatalog|RaidScene|dropTable)|\/(?:storeRules|playMode|updateCheck|shellUpdate)\.ts$|\/net\/(?:serviceStatus|auth)\.ts$|\/epicBoss\/market\.ts$)/;
const technical = new Set(["EpicBossAttack", "VideoGameZombieBite", "galacticBlast"]);

function add(key, file) {
  key = key.trim();
  if (!/[A-Za-z]{2}/.test(key) || /\.(?:png|json|webp|mp3)$|assets\//.test(key) || technical.has(key)) return;
  if (!found.has(key)) found.set(key, new Set());
  found.get(key).add(path.relative(root, file));
}

function templateKey(node) {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return node.head.text + node.templateSpans.map((span, i) => `{${i}}` + span.literal.text).join("");
}

function htmlKeys(key, file) {
  for (const match of key.matchAll(/(?:^|>)([^<>]+)(?=<|$)/g)) add(match[1], file);
  for (const match of key.matchAll(/\b(?:title|alt|aria-label|placeholder)="([^"]*)"/g)) add(match[1], file);
}

// Concatenated prose is one message; translating fragments hides omissions and
// prevents translators from changing word order. Dynamic pieces become arguments.
function expressionKey(node) {
  let slot = 0;
  function read(n) {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
    if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(s => `{${slot++}}` + s.literal.text).join("");
    if (ts.isTaggedTemplateExpression(n) && /^(?:trMsg|trHtml|msg|html)$/.test(n.tag.getText())) return read(n.template);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return read(n.left) + read(n.right);
    return `{${slot++}}`;
  }
  return read(node);
}

function scanSource(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (!["i18n", "devtools"].includes(item.name)) scanSource(file);
      continue;
    }
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node) {
      if (ts.isVariableDeclaration(node) && /_(?:LABELS?|NAMES?)$/.test(node.name.getText(source)) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const item of node.initializer.properties) {
          if (ts.isPropertyAssignment(item) && (ts.isStringLiteral(item.initializer) || ts.isNoSubstitutionTemplateLiteral(item.initializer))) add(item.initializer.text, file);
        }
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isPropertyAccessExpression(node.left) && /^(?:className|src|href|id|fillStyle)$/.test(node.left.name.text)) return;
      if (ts.isPropertyAssignment(node) && /^(?:panelClass|bgClass|className|sprite|icon)$/.test(node.name.getText(source))) return;
      if (ts.isCallExpression(node) && /^(?:tr|t|message)$/.test(node.expression.getText(source)) && node.arguments[0] && (ts.isStringLiteral(node.arguments[0]) || ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))) add(node.arguments[0].text, file);
      if (ts.isTaggedTemplateExpression(node) && /^(?:trMsg|trHtml|msg|html)$/.test(node.tag.getText(source))) {
        const key = templateKey(node.template);
        if (/html/i.test(node.tag.getText(source))) {
          htmlKeys(key, file);
          if (ts.isTemplateExpression(node.template)) {
            let prefix = node.template.head.text;
            for (const span of node.template.templateSpans) {
              const inTag = prefix.lastIndexOf("<") > prefix.lastIndexOf(">");
              if (!inTag || /(?:title|alt|aria-label|placeholder)=["'][^"']*$/.test(prefix)) visit(span.expression);
              prefix += "{argument}" + span.literal.text;
            }
          }
          return;
        } else add(key, file);
      }
      if (ts.isPropertyAssignment(node) && displayFields.has(node.name.getText(source))) {
        const key = expressionKey(node.initializer);
        if (!/^\{\d+\}$/.test(key) && !/^[a-z][\w-]*$/.test(key)) add(key, file);
      }
      if (presentation.test(file)) {
        const parent = node.parent;
        const prose = parent && (ts.isVariableDeclaration(parent) || ts.isReturnStatement(parent) || ts.isArrayLiteralExpression(parent) || (ts.isConditionalExpression(parent) && node !== parent.condition) || (file.endsWith("/raidTips.ts") && ts.isPropertyAssignment(parent)));
        if (prose && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken))) {
          const key = expressionKey(node);
          if (/^[A-Z][a-z]+$/.test(key) || (/\s/.test(key) && /[A-Za-z]{3}/.test(key) && !/^(?:\.|#)|px|\[data-|(?:^|\s)(?:on|off)$/.test(key))) {
            if (key.includes("<")) htmlKeys(key, file);
            else add(key, file);
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
}

function scanData(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  function visit(v) {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") for (const [key, child] of Object.entries(v)) {
      if (typeof child === "string" && displayFields.has(key) && !(key === "name" && file.endsWith("/attacks.json")) && !(key === "effect" && /^[a-z][\w-]*$/.test(child))) add(child, file);
      else if (typeof child === "object") visit(child);
    }
  }
  visit(value);
}

scanSource(path.join(root, "src"));
// The splash screen is a classic script for CSP and startup ordering.
const bootFile = path.join(root, "public/boot.js");
const boot = ts.createSourceFile(bootFile, fs.readFileSync(bootFile, "utf8"), ts.ScriptTarget.Latest, true);
function visitBoot(node) {
  if (ts.isStringLiteral(node) && ((ts.isCallExpression(node.parent) && node.parent.expression.getText(boot) === "translate") || ts.isArrayLiteralExpression(node.parent))) add(node.text, bootFile);
  ts.forEachChild(node, visitBoot);
}
visitBoot(boot);
for (const file of ["plants.json", "zombies.json", "placeables.json", "boosts.json", "farmer.json", "upgrades.json", "quests.json", "quests_reforged.json", "pets/catalog.json", "raids/raids.json", "raids/attacks.json"]) scanData(path.join(root, "public/assets", file));
for (const item of fs.readdirSync(path.join(root, "public/assets/epic-bosses"), { withFileTypes: true })) {
  if (!item.isDirectory()) continue;
  const file = path.join(root, "public/assets/epic-bosses", item.name, "catalog.json");
  if (fs.existsSync(file)) scanData(file);
}

export const sourceMessages = [...found].map(([key, files]) => ({ key, files: [...files] })).sort((a, b) => a.key.localeCompare(b.key));
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const original = JSON.parse(fs.readFileSync(path.join(root, "src/i18n/locales/zh-CN.json")));
  const extra = JSON.parse(fs.readFileSync(path.join(root, "src/i18n/locales/zh-CN-extra.json")));
  const missing = sourceMessages.filter(({ key }) => !(extra[key] ?? original[key])?.trim());
  if (process.argv.includes("--missing")) console.log(JSON.stringify(missing, null, 2));
  else {
    console.log(`Chinese: ${sourceMessages.length - missing.length}/${sourceMessages.length} source messages translated.`);
    if (missing.length) {
      console.error(`${missing.length} missing Chinese translations. Run node tools/i18n-messages.mjs --missing`);
      process.exitCode = 1;
    }
    const slots = (text) => [...new Set(text.match(/\{\d+\}/g) ?? [])].sort().join(",");
    for (const { key } of sourceMessages) {
      const translated = extra[key] ?? original[key];
      if (translated && slots(key) !== slots(translated)) {
        console.error(`Placeholder mismatch: ${JSON.stringify(key)}`);
        process.exitCode = 1;
      }
    }
  }
}
