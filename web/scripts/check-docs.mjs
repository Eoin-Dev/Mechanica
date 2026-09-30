import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const files = ["README.md", "CONTRIBUTING.md",
  ...readdirSync(path.join(root, "docs")).filter(name => name.endsWith(".md"))
    .map(name => `docs/${name}`)];
const failures = [];
let checked = 0;
const cache = new Map();

function anchors(file) {
  if (cache.has(file)) return cache.get(file);
  const result = new Set();
  const counts = new Map();
  let fence = "";
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
    if (heading) {
      const slug = heading[1].toLowerCase().replace(/<[^>]*>/g, "")
        .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
      const count = counts.get(slug) ?? 0;
      counts.set(slug, count + 1);
      result.add(count ? `${slug}-${count}` : slug);
    }
    for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
  }
  cache.set(file, result);
  return result;
}

for (const file of files) {
  let fence = "";
  for (const [index, line] of readFileSync(path.join(root, file), "utf8").split(/\r?\n/).entries()) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1][0];
      else if (marker[1][0] === fence) fence = "";
      continue;
    }
    if (fence) continue;
    const links = [...line.matchAll(/\[[^\]]*\]\((<[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/g)]
      .map(match => match[1]);
    const definition = line.match(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/);
    if (definition) links.push(definition[1]);
    for (const link of links) {
      const href = link.replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
      checked++;
      try {
        const [target, fragment = ""] = href.split("#");
        const destination = target ? path.resolve(root, path.dirname(file), decodeURIComponent(target))
          : path.join(root, file);
        if (!existsSync(destination)) throw new Error("missing file");
        if (fragment && destination.endsWith(".md") && !anchors(destination).has(decodeURIComponent(fragment))) {
          throw new Error("missing heading");
        }
      } catch (error) {
        failures.push(`${file}:${index + 1}: ${link} (${error.message})`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${checked} local links and heading references in ${files.length} documentation files.`);
}
