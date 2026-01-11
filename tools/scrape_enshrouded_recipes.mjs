#!/usr/bin/env node
/**
 * tools/scrape_enshrouded_recipes.mjs (fix v4)
 * - Corrige les quantités "index Nuxt" (ex: 2585) -> valeur réelle via payload[idx]
 * - Récupère à nouveau NPC + Atelier (requirements) comme le v1, mais sans casser les qty.
 *
 * Usage:
 *   node tools/scrape_enshrouded_recipes.mjs
 *
 * Options (CLI):
 *   --max 1200
 *   --concurrency 6
 *   --base https://enshrouded.vercel.app
 *   --only 350,351
 *   --debug 350
 *
 * Options (ENV) équivalentes:
 *   MAX_ID, CONCURRENCY, BASE_URL, ONLY_ID, DEBUG_ID
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function argValue(name, fallback=null){
  const idx = process.argv.findIndex(a => a === name || a.startsWith(name + "="));
  if (idx === -1) return fallback;
  const a = process.argv[idx];
  if (a.includes("=")) return a.split("=").slice(1).join("=");
  return process.argv[idx+1] ?? fallback;
}

const BASE_URL = (argValue("--base", process.env.BASE_URL) || "https://enshrouded.vercel.app").replace(/\/$/, "");
const MAX_ID = Number(argValue("--max", process.env.MAX_ID) || 1200);
const CONCURRENCY = Number(argValue("--concurrency", process.env.CONCURRENCY) || 6);

const ONLY_RAW = argValue("--only", process.env.ONLY_ID) || "";
const ONLY = ONLY_RAW
  .split(",")
  .map(s => Number(String(s).trim()))
  .filter(n => Number.isFinite(n) && n > 0);

const DEBUG_ID = Number(argValue("--debug", process.env.DEBUG_ID) || 0);

const OUT_JSON = path.join(__dirname, "..", "data", "enshrouded_data.json");
const OUT_JS = path.join(__dirname, "..", "data.js");

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function mapLimit(inputs, concurrency, worker){
  const res = new Array(inputs.length);
  let i = 0;
  async function runOne(){
    while (i < inputs.length){
      const idx = i++;
      res[idx] = await worker(inputs[idx], idx);
    }
  }
  const workers = Array.from({length: Math.max(1, concurrency)}, () => runOne());
  await Promise.all(workers);
  return res;
}

function extractJsonScripts(html){
  const out = [];
  const re = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))){
    const raw = (m[1] || "").trim();
    if (raw.startsWith("[") || raw.startsWith("{")) out.push(raw);
  }
  return out;
}

function isNuxtPayloadArray(x){
  return Array.isArray(x) && x.length > 1000;
}

function resolve(payload, maybeIdx){
  if (Array.isArray(payload) && typeof maybeIdx === "number"){
    return payload[maybeIdx];
  }
  return maybeIdx;
}

function deepFirstNumber(v, maxDepth=3){
  const seen = new Set();
  function walk(x, depth){
    if (x == null) return null;
    if (typeof x === "number" && Number.isFinite(x)) return x;
    if (typeof x === "string"){
      const n = Number(x);
      if (Number.isFinite(n)) return n;
      return null;
    }
    if (depth <= 0) return null;
    if (typeof x === "object"){
      if (seen.has(x)) return null;
      seen.add(x);
    }
    if (Array.isArray(x)){
      for (const it of x){
        const r = walk(it, depth-1);
        if (r != null) return r;
      }
      return null;
    }
    for (const k of ["value","val","amount","qty","count","quantity","q","n","num","data"]){
      if (k in x){
        const r = walk(x[k], depth-1);
        if (r != null) return r;
      }
    }
    const keys = Object.keys(x).slice(0, 25);
    for (const k of keys){
      const r = walk(x[k], depth-1);
      if (r != null) return r;
    }
    return null;
  }
  return walk(v, maxDepth);
}

function resolveNumber(payload, maybeIdxOrValue){
  if (Array.isArray(payload) && typeof maybeIdxOrValue === "number"){
    const v = payload[maybeIdxOrValue];
    const found = deepFirstNumber(v, 4);
    if (found != null) return found;
  }
  const found2 = deepFirstNumber(maybeIdxOrValue, 3);
  if (found2 != null) return found2;
  return null;
}

function resolveName(payload, itemObj){
  const v = itemObj?.name ?? itemObj?.title ?? itemObj?.displayName ?? itemObj?.localizedName ?? null;
  if (typeof v === "string" && v.trim()) return v.trim();
  const vv = resolve(payload, v);
  if (typeof vv === "string" && vv.trim()) return vv.trim();
  return `Item #${itemObj?.id ?? "?"}`;
}

function findRecipeObject(payload){
  for (const x of payload){
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    if ("outputItem" in x && ("ingredients" in x || "materials" in x || "requirements" in x)){
      return x;
    }
  }
  return null;
}

function saneQty(n, fallback=1){
  const q = Math.floor(Number(n));
  if (!Number.isFinite(q) || q <= 0) return fallback;
  if (q > 100000) return fallback; // sécurité très large
  return q;
}

function parseRecipeFromHtml(html, pageId){
  const scripts = extractJsonScripts(html);

  let payload = null;
  for (const s of scripts){
    try{
      const j = JSON.parse(s);
      if (isNuxtPayloadArray(j)) { payload = j; break; }
    }catch{}
  }
  if (!payload) return null;

  const recipeObj = findRecipeObject(payload);
  if (!recipeObj) return null;

  const outputItemObj = resolve(payload, recipeObj.outputItem);
  const output = {
    itemId: outputItemObj?.id,
    name: resolveName(payload, outputItemObj),
    qty: saneQty(resolveNumber(payload, recipeObj.outputQuantity), 1),
  };

  const ingField = recipeObj.ingredients ?? recipeObj.materials ?? [];
  const ingList = resolve(payload, ingField) || [];
  const ingredients = [];

  for (const ingIdx of ingList){
    const ingObj = resolve(payload, ingIdx);
    const itemObj = resolve(payload, ingObj?.item);
    const qty = saneQty(resolveNumber(payload, ingObj?.quantity), 1);

    if (itemObj?.id != null){
      ingredients.push({
        itemId: itemObj.id,
        name: resolveName(payload, itemObj),
        qty
      });
    }
  }

  // ✅ Requirements (NPC + Atelier) comme le v1 (mais avec resolve() safe)
  const requirements = { npcs: [], stations: [] };
  const reqList = resolve(payload, recipeObj.requirements) || [];
  if (Array.isArray(reqList)){
    for (const reqIdx of reqList){
      const reqObj = resolve(payload, reqIdx);
      const srcObj = resolve(payload, reqObj?.source);
      if (!srcObj) continue;

      // npc
      if (srcObj.npc != null){
        const npcObj = resolve(payload, srcObj.npc);
        if (npcObj?.id != null) requirements.npcs.push({ id: npcObj.id, name: resolveName(payload, npcObj) });
      }
      // station (stockée comme "item" dans cette base)
      if (srcObj.item != null){
        const stObj = resolve(payload, srcObj.item);
        if (stObj?.id != null) requirements.stations.push({ id: stObj.id, name: resolveName(payload, stObj) });
      }
    }
  }

  if (DEBUG_ID && Number(pageId) === Number(DEBUG_ID)){
    const dbgPath = path.join(__dirname, "..", "data", `debug_recipe_${pageId}.json`);
    fs.mkdirSync(path.dirname(dbgPath), { recursive: true });
    fs.writeFileSync(dbgPath, JSON.stringify({
      pageId,
      output,
      ingredients,
      requirements,
      recipeObj,
      hint: "Vérifie output.qty + ingredients[].qty : ils doivent être petits (1..50)."
    }, null, 2), "utf-8");
    console.log(`[enshrouded] DEBUG wrote ${dbgPath}`);
  }

  return { id: pageId, output, ingredients, requirements };
}

async function fetchRecipePage(id){
  const url = `${BASE_URL}/recipes/${id}`;
  const r = await fetch(url, { headers: { "user-agent": "enshrouded-craft-calc/1.0" }});
  if (!r.ok) return { ok:false, status:r.status, url };
  const html = await r.text();
  return { ok:true, html, url };
}

async function main(){
  const list = ONLY.length ? ONLY : Array.from({length: MAX_ID}, (_,i)=> i+1);

  console.log(`[enshrouded] base=${BASE_URL} ids=${list.length} (maxId=${MAX_ID}) concurrency=${CONCURRENCY}${ONLY.length ? ` only=[${ONLY.join(",")}]` : ""}${DEBUG_ID ? ` debug=${DEBUG_ID}` : ""}`);

  const items = {};
  const npcs = {};
  const stations = {};
  const recipes = {};

  let okCount = 0;
  let failCount = 0;
  let last = 0;

  await mapLimit(list, CONCURRENCY, async (id) => {
    last = id;
    try{
      const page = await fetchRecipePage(id);
      if (!page.ok){
        failCount++;
        if (failCount % 50 === 0) console.log(`[enshrouded] OK ${okCount} | FAIL ${failCount} | last #${last}`);
        return null;
      }
      const parsed = parseRecipeFromHtml(page.html, id);
      if (!parsed){
        failCount++;
        if (failCount % 50 === 0) console.log(`[enshrouded] OK ${okCount} | FAIL ${failCount} | last #${last}`);
        return null;
      }

      recipes[String(id)] = {
        id: parsed.id,
        output: parsed.output.itemId,
        outputQty: parsed.output.qty,
        station: parsed.requirements.stations[0]?.name ?? "",
        npc: parsed.requirements.npcs[0]?.name ?? "",
        inputs: parsed.ingredients.map(x => ({ itemId: x.itemId, qty: x.qty })),
      };

      // items catalog
      if (parsed.output?.itemId != null){
        items[String(parsed.output.itemId)] = { id: parsed.output.itemId, name: parsed.output.name };
      }
      for (const ing of parsed.ingredients){
        items[String(ing.itemId)] = { id: ing.itemId, name: ing.name };
      }

      for (const n of parsed.requirements.npcs){
        npcs[String(n.id)] = n;
      }
      for (const st of parsed.requirements.stations){
        stations[String(st.id)] = st;
      }

      okCount++;
      if (okCount % 50 === 0) console.log(`[enshrouded] OK ${okCount} | FAIL ${failCount} | last #${last}`);

      await sleep(15);
      return true;
    }catch(e){
      failCount++;
      if (failCount % 50 === 0) console.log(`[enshrouded] OK ${okCount} | FAIL ${failCount} | last #${last}`);
      return null;
    }
  });

  console.log(`\n[enshrouded] done. OK=${okCount} FAIL=${failCount}`);
  console.log(`[enshrouded] items=${Object.keys(items).length} npcs=${Object.keys(npcs).length} stations=${Object.keys(stations).length}`);

  const payload = { items, recipes, npcs, stations, meta: { base: BASE_URL, maxId: MAX_ID, only: ONLY } };

  fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`[enshrouded] wrote ${OUT_JSON}`);

  const js = `// data.js (auto-generated)\n// Source: ${BASE_URL}\nwindow.ENSHROUDED = ${JSON.stringify(payload, null, 2)};\n`;
  fs.writeFileSync(OUT_JS, js, "utf-8");
  console.log(`[enshrouded] wrote ${OUT_JS}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
