import fs from "node:fs/promises";
import reporters from "./x-reporters.json" with { type: "json" };

const SCOREBOARD_URL = "https://openmarket-nfl-feed.openmarket-nfl-live.workers.dev/v1/scoreboard";
const NITTER_INSTANCES = ["https://nitter.net", "https://nitter.privacyredirect.com"];
const OUTPUT_PATH = process.env.X_PROXY_OUTPUT || "/tmp/x-proxy.json";
const MAX_AGE_MS = 7 * 86400000;
const MAX_ITEMS = 2500;
const USER_AGENT = "MarketWidget-RSS/1.0 (personal non-commercial RSS reader)";

function cleanText(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(x?[0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code.replace(/^x/i, ""), /^x/i.test(code) ? 16 : 10)))
    .replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim();
}

function xmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return cleanText(match?.[1]);
}

function normalizeRss(xml) {
  if (!/<rss\b/i.test(xml) || /RSS reader not yet whitelisted/i.test(xml)) throw new Error("not an RSS timeline");
  return (xml.match(/<item\b[\s\S]*?<\/item>/gi) || []).flatMap((block) => {
    const link = xmlValue(block, "link");
    let parsed;
    try { parsed = new URL(link); } catch { return []; }
    const match = parsed.pathname.match(/^\/([^/]+)\/status\/(\d+)/i);
    if (!match) return [];
    const handle = match[1];
    const title = xmlValue(block, "title").slice(0, 500);
    if (!title) return [];
    return [{
      id: `x:${match[2]}`,
      kind: "tweet",
      source: "X",
      sourceKey: "x",
      sourceUrl: `https://x.com/${handle}`,
      sourceLogo: "",
      handle,
      author: xmlValue(block, "dc:creator").replace(/^@/, "") || handle,
      authorAvatarUrl: `https://unavatar.io/x/${handle}`,
      title,
      text: xmlValue(block, "description").slice(0, 500) || title,
      url: `https://x.com/${handle}/status/${match[2]}`,
      publishedAt: xmlValue(block, "pubDate"),
      metrics: null
    }];
  });
}

async function fetchText(url) {
  const response = await fetch(url, { headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": USER_AGENT }, redirect: "follow" });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function fetchJson(url, fallback = null) {
  try {
    const response = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, redirect: "follow" });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    if (fallback !== null) return fallback;
    throw error;
  }
}

function feedUrl(instance, handles) {
  const joined = [...new Set(handles)].map(encodeURIComponent).join(",");
  return `${instance.replace(/\/$/, "")}/${joined}/rss`;
}

async function fetchGroup(handles) {
  let lastError;
  for (const instance of NITTER_INSTANCES) {
    try { return normalizeRss(await fetchText(feedUrl(instance, handles))); }
    catch (error) { lastError = error; }
  }
  throw new Error(`${handles.slice(0, 2).join(",")}: ${lastError?.message || lastError}`);
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

const scoreboardPayload = await fetchJson(SCOREBOARD_URL);
const games = scoreboardPayload?.scoreboard?.games || [];
if (!games.length) throw new Error("No current-week games returned by the managed feed");

const slot = Math.floor(Date.now() / 300000) % 3;
const selectedGames = games.filter((_, index) => index % 3 === slot);
const groups = [reporters.national, ...selectedGames.map((game) => [
  ...(reporters.teams[game.away?.abbreviation] || []),
  ...(reporters.teams[game.home?.abbreviation] || [])
].filter(Boolean))].filter((group) => group.length);

const errors = [];
const fetchedRows = await mapLimit(groups, 4, async (handles) => {
  try { return await fetchGroup(handles); }
  catch (error) { errors.push(String(error?.message || error)); return []; }
});
const cutoff = Date.now() - MAX_AGE_MS;
const items = [...new Map(fetchedRows.flat().map((item) => [item.id, item])).values()]
  .filter((item) => !Number.isFinite(Date.parse(item.publishedAt)) || Date.parse(item.publishedAt) >= cutoff)
  .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
  .slice(0, MAX_ITEMS);

if (!items.length) throw new Error(`All X proxy feeds failed: ${errors.join("; ")}`);
await fs.writeFile(OUTPUT_PATH, `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  slot,
  gamesCovered: selectedGames.map((game) => String(game.id)),
  errors,
  items
}, null, 2)}\n`);
console.log(JSON.stringify({ slot, groups: groups.length, fetched: fetchedRows.flat().length, retained: items.length, errors: errors.length }));
