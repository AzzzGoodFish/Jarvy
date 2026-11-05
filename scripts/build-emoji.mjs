// Generates src/web/channel/emoji/data.json from the Unicode emoji list and the CLDR annotations, in English and Chinese.
// Run by hand when the emoji list is updated; the output is committed, so a build never reaches the network. Unicode
// License v3 (see THIRD_PARTY_NOTICE.md).
//
//   node scripts/build-emoji.mjs <emoji-test.txt> <annotations dir>
//
// The annotations dir holds, for each language, CLDR's annotations and derived annotations (the latter name the
// sequences: people with a profession, flags, keycaps), from unicode-org/cldr-json:
//   en/annotations.json  en/derived.json  zh/annotations.json  zh/derived.json
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , testFile, dir] = process.argv;
if (!testFile || !dir) {
  console.error("usage: node scripts/build-emoji.mjs <emoji-test.txt> <annotations dir>");
  process.exit(1);
}

/** The nine groups of the panel, in order, as the Unicode list names them. */
const GROUPS = ["Smileys & Emotion", "People & Body", "Animals & Nature", "Food & Drink", "Travel & Places", "Activities", "Objects", "Symbols", "Flags"];
const LANGUAGES = ["en", "zh"];

const read = (file) => { const json = JSON.parse(readFileSync(file, "utf8")); return (json.annotations ?? json.annotationsDerived).annotations; };
// Annotations win over derived ones for the emoji both name.
const tables = Object.fromEntries(LANGUAGES.map((language) => [language,
  { ...read(join(dir, language, "derived.json")), ...read(join(dir, language, "annotations.json")) }]));
// CLDR keys the text form (a heart without the emoji selector), so both spellings are looked up.
const entry = (language, emoji) => tables[language][emoji] ?? tables[language][emoji.replace(/\uFE0F/g, "")];
/** Skin tones are not listed: the system's own picker offers them, and they would double the data. */
const toned = (emoji) => /[\u{1F3FB}-\u{1F3FF}]/u.test(emoji);

const byGroup = new Map(GROUPS.map((group) => [group, []]));
let group = "", unnamed = 0;
for (const line of readFileSync(testFile, "utf8").split("\n")) {
  if (line.startsWith("# group:")) { group = line.slice(8).trim(); continue; }
  if (!line.includes("; fully-qualified")) continue;
  const emoji = line.split(";")[0].trim().split(" ").map((code) => String.fromCodePoint(parseInt(code, 16))).join("");
  const row = byGroup.get(group);
  if (toned(emoji) || !row) continue;
  // Per language: the name, then the other keywords (the name's own words are left out of them).
  const names = LANGUAGES.flatMap((language) => {
    const found = entry(language, emoji), name = found?.tts?.[0] ?? "";
    if (!name) unnamed++;
    return [name, (found?.default ?? []).filter((word) => word.toLowerCase() !== name.toLowerCase()).join(" ")];
  });
  row.push([emoji, ...names]);
}
if (unnamed) { console.error(`${unnamed} names missing: are the derived annotations there?`); process.exit(1); }

// JSON, not a module: search words are data, not interface copy.
const groups = [...byGroup].filter(([, row]) => row.length).map(([name, emoji]) => ({ name, emoji }));
writeFileSync("src/web/channel/emoji/data.json", JSON.stringify({ version: "15.1", groups }) + "\n");
const total = groups.reduce((sum, item) => sum + item.emoji.length, 0);
console.log(`${total} emoji in ${groups.length} groups`);
