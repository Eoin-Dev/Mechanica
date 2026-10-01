import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Preserve line numbers while skipping examples and comments. */
function visibleLines(source) {
  const lines = [];
  let fence = null;
  const clean = source.replace(/<!--[\s\S]*?-->/g, comment => comment.replace(/[^\r\n]/g, ""));
  for (const [index, line] of clean.split(/\r?\n/).entries()) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length &&
          !marker[2].trim()) fence = null;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    if (!/^(?: {4}|\t)/.test(line)) lines.push([index, line]);
  }
  return lines;
}

const normalizeLabel = label => label.trim().replace(/\s+/g, " ").toLowerCase();
const LINK = /\[[^\]]*\]\((<[^>]+>|(?:[^\s()]|\([^)]*\))+)(?:\s+["'][^"']*["'])?\)/g;

export function checkDocumentation(root) {
  const files = ["README.md", "CONTRIBUTING.md",
    ...readdirSync(path.join(root, "docs")).filter(name => name.endsWith(".md"))
      .map(name => `docs/${name}`)];
  const failures = [];
  let checked = 0;
  const cache = new Map();

  function anchors(file) {
    if (cache.has(file)) return cache.get(file);
    const result = new Set();
    for (const [, line] of visibleLines(readFileSync(file, "utf8"))) {
      const heading = line.match(/^#{1,6}\s+(.+?)(?:\s+#+)?$/);
      if (heading) {
        const slug = heading[1].replace(LINK, link => link.slice(1, link.indexOf("]")))
          .replace(/&amp;/g, "&").replace(/&(?:lt|gt|quot);/g, "")
          .toLowerCase().replace(/<[^>]*>/g, "")
          .replace(/[^\p{L}\p{N}\p{M}_\-\s]/gu, "").replace(/\s/g, "-");
        let unique = slug;
        for (let count = 1; result.has(unique); count++) unique = `${slug}-${count}`;
        result.add(unique);
      }
      for (const match of line.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) result.add(match[1]);
    }
    cache.set(file, result);
    return result;
  }

  for (const file of files) {
    const lines = visibleLines(readFileSync(path.join(root, file), "utf8"));
    const definitions = new Map();
    for (const [, line] of lines) {
      const definition = line.match(/^\s*\[([^\]]+)\]:\s*(<[^>]+>|\S+)/);
      if (definition) definitions.set(normalizeLabel(definition[1]), definition[2]);
    }
    for (const [index, original] of lines) {
      const line = original.replace(/(`+).*?\1/g, "");
      const links = [...line.matchAll(LINK)]
        .map(match => match[1]);
      const definition = line.match(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/);
      if (definition) links.push(definition[1]);
      else {
        for (const reference of line.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
          const label = normalizeLabel(reference[2] || reference[1]);
          if (!definitions.has(label)) failures.push(`${file}:${index + 1}: undefined reference [${label}]`);
        }
      }
      for (const link of links) {
        const href = link.replace(/^<|>$/g, "");
        if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(href)) continue;
        checked++;
        try {
          const [target, fragment = ""] = href.split("#");
          const destination = target ? path.resolve(root, path.dirname(file), decodeURIComponent(target))
            : path.join(root, file);
          const relative = path.relative(root, destination);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            throw new Error("outside repository");
          }
          if (!existsSync(destination)) throw new Error("missing file");
          let parent = root;
          for (const segment of relative.split(path.sep).filter(Boolean)) {
            if (!readdirSync(parent).includes(segment)) throw new Error("filename case mismatch");
            parent = path.join(parent, segment);
          }
          if (fragment && /\.md$/i.test(destination) && !anchors(destination).has(decodeURIComponent(fragment))) {
            throw new Error("missing heading");
          }
        } catch (error) {
          failures.push(`${file}:${index + 1}: ${link} (${error.message})`);
        }
      }
    }
  }

  return { checked, files: files.length, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocumentation(fileURLToPath(new URL("../../", import.meta.url)));
  if (result.failures.length) {
    console.error(result.failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Checked ${result.checked} local links and heading references in ${result.files} documentation files.`);
  }
}
