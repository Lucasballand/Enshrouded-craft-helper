// Enshrouded Craft Calc - app.js (v4.3)
// Patch: lecture explicite des champs `npc` et `station` (string) générés par le scraper v4.
// Objectif: ne plus afficher "Atelier ? / NPC ?" quand la data les contient bien.

const $ = (id) => document.getElementById(id);

const state = {
  itemId: null,
  recipeId: null,
  inv: {},
  lastPlan: null,
};

function clampInt(v) {
  const n = Math.floor(Number(v || 0));
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

let DATA = null; // { itemsById, recipesById }
let OUTPUT_INDEX = null; // Map(itemId -> recipeIds[])

function toId(x) {
  if (x == null) return null;
  if (typeof x === "object") {
    const cand = x.itemId ?? x.item_id ?? x.id ?? x.key ?? x.slug ?? x.nameId;
    return cand != null ? String(cand) : null;
  }
  return String(x);
}

function normalizeItems(itemsRaw) {
  const itemsById = {};
  if (!itemsRaw) return itemsById;

  if (Array.isArray(itemsRaw)) {
    for (const it of itemsRaw) {
      const id = toId(it);
      if (!id) continue;
      const name = it.name ?? it.title ?? it.localizedName ?? it.displayName ?? it.label ?? String(id);
      itemsById[id] = { ...it, id, name };
    }
    return itemsById;
  }

  for (const [k, v] of Object.entries(itemsRaw)) {
    const id = String(v?.id ?? k);
    const name = v?.name ?? v?.title ?? v?.localizedName ?? v?.displayName ?? v?.label ?? String(id);
    itemsById[id] = { ...v, id, name };
  }
  return itemsById;
}

function normalizeRecipes(recipesRaw) {
  const recipesById = {};
  if (!recipesRaw) return recipesById;

  if (Array.isArray(recipesRaw)) {
    for (const r of recipesRaw) {
      const rid = String(r.id ?? r.recipeId ?? r.recipe_id ?? r.key ?? "");
      if (!rid) continue;
      recipesById[rid] = r;
    }
    return recipesById;
  }

  for (const [k, v] of Object.entries(recipesRaw)) {
    const rid = String(v?.id ?? k);
    recipesById[rid] = v;
  }
  return recipesById;
}

function normalizeData() {
  const raw = window.ENSHROUDED;
  const itemsById = normalizeItems(raw?.items);
  const recipesById = normalizeRecipes(raw?.recipes);
  return { itemsById, recipesById };
}

function getItem(id) {
  const key = String(id);
  return DATA.itemsById[key] || { id: key, name: `Item #${key}` };
}
function getItemName(id) { return getItem(id).name; }
function getRecipe(rid) { return DATA.recipesById[String(rid)] || null; }

function getOutputItemId(r) {
  if (!r) return null;
  const direct =
    r.output ?? r.item ?? r.result ?? r.outputItem ?? r.output_item ??
    r.outputItemId ?? r.output_item_id ?? r.outputId;
  const dId = toId(direct);
  if (dId) return dId;

  const p = r.product ?? r.produces ?? r.out ?? r.outputData ?? null;
  const pId = toId(p?.itemId ?? p?.item_id ?? p?.id ?? p?.item ?? p);
  if (pId) return pId;

  return null;
}

function getOutputQty(r) {
  if (!r) return 1;
  const candidates = [
    r.outputQty, r.output_qty,
    r.outputAmount, r.output_amount,
    r.qty, r.amount, r.count, r.quantity,
    r.product?.amount, r.product?.qty, r.product?.count,
    r.produces?.amount, r.produces?.qty, r.produces?.count,
  ].map(clampInt).filter(n => n > 0);

  let n = candidates.length ? candidates[0] : 1;

  // quantités "saines" : 1..500 (munitions/consommables peuvent être 25/50/100)
  const sane = candidates.filter(x => x <= 500);
  if (sane.length) n = Math.min(...sane);

  if (n <= 0) n = 1;
  if (n > 5000) n = 1; // garde-fou
  return n;
}

// ✅ v4.3: priorité à r.npc / r.station (strings générées par le scraper v4)
function getNpc(r) {
  if (!r) return "";
  const v =
    r.npc ?? r.npcName ?? r.crafter ?? r.vendor ?? r.character ??
    r.npc_name ?? r.crafter_name ??
    r.requiredNpc ?? r.required_npc ??
    (r.npc?.name ?? r.crafter?.name ?? r.vendor?.name ?? r.character?.name) ??
    "";
  return typeof v === "string" ? v : (v?.name ?? "");
}
function getStation(r) {
  if (!r) return "";
  const v =
    r.station ?? r.workstation ?? r.craftingStation ??
    r.stationName ?? r.workstationName ??
    r.station_name ??
    (r.station?.name ?? r.workstation?.name ?? r.craftingStation?.name) ??
    "";
  return typeof v === "string" ? v : (v?.name ?? "");
}

// IMPORTANT: on privilégie itemId / item_id AVANT id (id est souvent un id de ligne)
function getInputs(r) {
  const src = r.inputs ?? r.ingredients ?? r.requirements ?? r.materials ?? r.components ?? r.cost ?? r.resources ?? [];
  const arr = Array.isArray(src) ? src : (src?.items ?? src?.ingredients ?? src?.materials ?? src?.resources ?? []);
  if (!Array.isArray(arr)) return [];

  const out = [];
  for (const x of arr) {
    const itemCand =
      x.itemId ?? x.item_id ??
      x.ingredientId ?? x.ingredient_id ??
      x.materialId ?? x.material_id ??
      x.resourceId ?? x.resource_id ??
      x.item ?? x.ingredient ?? x.material ?? x.resource ?? x.target ??
      null;

    let itemId = toId(itemCand);
    if (!itemId && x.item && typeof x.item === "object") itemId = toId(x.item);

    // dernier recours seulement:
    if (!itemId) itemId = toId(x.id);

    const qtyCandidates = [
      x.amount, x.qty, x.count, x.quantity, x.value,
      x.required, x.requiredAmount, x.required_amount,
      x.amountRequired, x.amount_required,
    ].map(clampInt).filter(n => n > 0);

    let qty = qtyCandidates.length ? qtyCandidates[0] : 0;
    const saneQty = qtyCandidates.filter(n => n <= 5000);
    if (saneQty.length) qty = Math.min(...saneQty);

    if (itemId && qty > 0) out.push({ item: String(itemId), qty });
  }
  return out;
}

function buildOutputIndex() {
  const map = new Map();
  for (const rid of Object.keys(DATA.recipesById)) {
    const r = DATA.recipesById[rid];
    const outId = getOutputItemId(r);
    if (!outId) continue;
    if (!map.has(outId)) map.set(outId, []);
    map.get(outId).push(String(rid));
  }
  for (const [k, arr] of map.entries()) {
    arr.sort((a, b) => Number(a) - Number(b));
  }
  return map;
}

function setTab(tabId) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("is-active", b.dataset.tab === tabId));
  document.querySelectorAll(".panel").forEach(p => p.classList.toggle("is-active", p.id === tabId));
}
function setSub(sub) {
  document.querySelectorAll(".subtab").forEach(b => b.classList.toggle("is-active", b.dataset.sub === sub));
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("is-active", v.id === `view-${sub}`));
}

function loadInv() {
  try {
    const raw = localStorage.getItem("enshrouded_inv_v1");
    state.inv = raw ? JSON.parse(raw) : {};
  } catch { state.inv = {}; }
}
function saveInv() {
  try { localStorage.setItem("enshrouded_inv_v1", JSON.stringify(state.inv)); } catch { }
}

function craftableItems() {
  const ids = Array.from(OUTPUT_INDEX.keys());
  ids.sort((a, b) => getItemName(a).localeCompare(getItemName(b), "fr"));
  return ids;
}

function renderItemSelect(filter = "") {
  const sel = $("selItem");
  const f = filter.trim().toLowerCase();

  const ids = craftableItems().filter(id => {
    const name = getItemName(id).toLowerCase();
    return !f || name.includes(f) || String(id).includes(f);
  });

  sel.innerHTML = ids.map(id => `<option value="${escapeHtml(id)}">${escapeHtml(getItemName(id))} (#${escapeHtml(id)})</option>`).join("");

  if (ids.length) {
    if (!state.itemId || !ids.includes(state.itemId)) state.itemId = ids[0];
    sel.value = state.itemId;
  } else {
    state.itemId = null;
    sel.innerHTML = "";
  }

  renderRecipeSelect();
}

function renderRecipeSelect() {
  const sel = $("selRecipe");
  sel.innerHTML = "";
  if (!state.itemId) {
    state.recipeId = null;
    $("miniInfo").innerHTML = "Aucun objet sélectionné.";
    return;
  }

  const recipes = OUTPUT_INDEX.get(state.itemId) || [];
  if (!recipes.length) {
    state.recipeId = null;
    $("miniInfo").innerHTML = "Aucune recette trouvée pour cet objet.";
    return;
  }

  sel.innerHTML = recipes.map(rid => {
    const r = getRecipe(rid);
    const outQty = getOutputQty(r);
    const npc = getNpc(r);
    const st = getStation(r);
    const meta = [
      `sortie: ${outQty}/craft`,
      st ? `atelier: ${st}` : "",
      npc ? `npc: ${npc}` : "",
    ].filter(Boolean).join(" • ");
    return `<option value="${escapeHtml(rid)}">#${escapeHtml(rid)} — ${escapeHtml(meta)}</option>`;
  }).join("");

  if (!state.recipeId || !recipes.includes(state.recipeId)) state.recipeId = recipes[0];
  sel.value = state.recipeId;

  updateMiniInfo();
}

function updateMiniInfo() {
  const r = state.recipeId ? getRecipe(state.recipeId) : null;
  if (!r) {
    $("miniInfo").innerHTML = "Sélectionne un objet.";
    return;
  }
  const outQty = getOutputQty(r);
  const npc = getNpc(r);
  const st = getStation(r);
  const ins = getInputs(r);

  $("miniInfo").innerHTML = `
    <div><b>${escapeHtml(getItemName(state.itemId))}</b></div>
    <div class="muted">Recette #${escapeHtml(state.recipeId)} • sortie ${outQty} / craft</div>
    <div class="muted">${st ? `Atelier: ${escapeHtml(st)}` : "Atelier: —"} • ${npc ? `NPC: ${escapeHtml(npc)}` : "NPC: —"}</div>
    <div class="muted" style="margin-top:6px">Ingrédients: ${ins.map(x => `${escapeHtml(getItemName(x.item))}×${x.qty}`).join(", ") || "—"}</div>
  `;
}

function renderInventory(filter = "") {
  const grid = $("invGrid");
  const f = filter.trim().toLowerCase();

  const ids = Object.keys(DATA.itemsById)
    .filter(id => {
      const name = getItemName(id).toLowerCase();
      return !f || name.includes(f) || String(id).includes(f);
    })
    .sort((a, b) => getItemName(a).localeCompare(getItemName(b), "fr"))
    .slice(0, 220);

  grid.innerHTML = ids.map(id => {
    const val = clampInt(state.inv[id] || 0);
    return `
      <div class="card" style="padding:12px">
        <div style="display:flex;gap:10px;align-items:center;">
          <div style="flex:1;min-width:0">
            <div style="font-weight:900">${escapeHtml(getItemName(id))}</div>
            <div class="muted" style="font-size:12px">#${escapeHtml(id)}</div>
          </div>
          <input class="input invInput" data-item="${escapeHtml(id)}" type="number" min="0" value="${val}" style="width:120px" />
        </div>
      </div>
    `;
  }).join("");

  grid.querySelectorAll(".invInput").forEach(inp => {
    inp.addEventListener("input", () => {
      const id = inp.dataset.item;
      state.inv[id] = clampInt(inp.value);
      saveInv();
    });
  });
}

function buildPlan({ targetItemId, targetRecipeId, qty, qtyMode, useInventory }) {
  const invRemaining = new Map(Object.entries(state.inv || {}).map(([k, v]) => [String(k), clampInt(v)]));
  const rawTotals = new Map();
  const crafts = new Map();
  const visiting = new Set();
  const tree = [];

  function invConsume(itemId, need) {
    if (!useInventory) return need;
    const have = invRemaining.get(itemId) || 0;
    if (have <= 0) return need;
    const used = Math.min(have, need);
    invRemaining.set(itemId, have - used);
    return need - used;
  }
  function addRaw(itemId, qty) {
    rawTotals.set(itemId, (rawTotals.get(itemId) || 0) + qty);
  }
  function addCraft(key, node) {
    const cur = crafts.get(key);
    if (!cur) { crafts.set(key, node); return; }
    cur.need += node.need;
    cur.crafts += node.crafts;
    cur.produced += node.produced;
    cur.surplus += node.surplus;
  }
  function chooseRecipe(itemId, recipeIds) {
    if (itemId === String(targetItemId) && targetRecipeId) return String(targetRecipeId);
    return recipeIds[0];
  }

  function resolve(itemId, needQty, depth, opts = {}) {
    const indent = "  ".repeat(depth);
    let need = clampInt(needQty);

    if (!opts.ignoreInventory) {
      need = invConsume(String(itemId), need);
    }

    if (need <= 0) {
      tree.push(`${indent}- ${getItemName(itemId)} x0 (inventaire)`);
      return;
    }

    const recipeIds = OUTPUT_INDEX.get(String(itemId));
    if (!recipeIds || recipeIds.length === 0) {
      addRaw(String(itemId), need);
      tree.push(`${indent}- [RAW] ${getItemName(itemId)} × ${need}`);
      return;
    }

    const rid = chooseRecipe(String(itemId), recipeIds);
    const r = getRecipe(rid);
    if (!r) {
      addRaw(String(itemId), need);
      tree.push(`${indent}- [RAW] ${getItemName(itemId)} × ${need} (recette introuvable)`);
      return;
    }

    const outQty = getOutputQty(r);
    const craftsCount = opts.forceCrafts ? clampInt(opts.forceCrafts) : Math.ceil(need / outQty);
    const produced = craftsCount * outQty;
    const surplus = opts.forceCrafts ? 0 : Math.max(0, produced - need);

    const key = `${String(itemId)}::${String(rid)}`;
    addCraft(key, {
      key,
      itemId: String(itemId),
      recipeId: String(rid),
      name: getItemName(itemId),
      need,
      crafts: craftsCount,
      outQty,
      produced,
      surplus,
      npc: getNpc(r) || "",
      station: getStation(r) || "",
      inputs: getInputs(r),
    });

    tree.push(`${indent}- [CRAFT] ${getItemName(itemId)} besoin ${need} → crafts ${craftsCount} ×${outQty} = ${produced}${surplus ? ` (+${surplus})` : ""}`);

    if (visiting.has(key)) {
      tree.push(`${indent}  ⚠ boucle détectée, arrêt.`);
      return;
    }
    visiting.add(key);

    for (const ing of getInputs(r)) {
      resolve(String(ing.item), ing.qty * craftsCount, depth + 1);
    }

    visiting.delete(key);
  }

  const topRecipe = getRecipe(targetRecipeId);
  const topOut = getOutputQty(topRecipe);

  if (qtyMode === "crafts") {
    resolve(String(targetItemId), topOut * qty, 0, { forceCrafts: qty, ignoreInventory: true });
  } else {
    resolve(String(targetItemId), qty, 0);
  }

  const nodes = Array.from(crafts.values());
  const byKey = new Map(nodes.map(n => [n.key, n]));
  const memoDepth = new Map();

  function depthOf(key) {
    if (memoDepth.has(key)) return memoDepth.get(key);
    const node = byKey.get(key);
    if (!node) { memoDepth.set(key, 0); return 0; }
    let d = 0;
    for (const ing of node.inputs || []) {
      const recs = OUTPUT_INDEX.get(String(ing.item));
      if (!recs || recs.length === 0) continue;
      const childRid = chooseRecipe(String(ing.item), recs);
      const childKey = `${String(ing.item)}::${String(childRid)}`;
      d = Math.max(d, 1 + depthOf(childKey));
    }
    memoDepth.set(key, d);
    return d;
  }
  for (const n of nodes) depthOf(n.key);

  const groups = new Map();
  for (const n of nodes) {
    const label = `${n.station || "Atelier ?"} • ${n.npc || "NPC ?"}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(n);
  }
  for (const [label, arr] of groups.entries()) {
    arr.sort((a, b) => (memoDepth.get(a.key) - memoDepth.get(b.key)) || a.name.localeCompare(b.name, "fr"));
  }

  const raw = Array.from(rawTotals.entries())
    .filter(([, q]) => q > 0)
    .sort((a, b) => getItemName(a[0]).localeCompare(getItemName(b[0]), "fr"))
    .map(([itemId, q]) => ({ itemId, name: getItemName(itemId), qty: q }));

  const craftsSorted = nodes.sort((a, b) => (memoDepth.get(a.key) - memoDepth.get(b.key)) || a.name.localeCompare(b.name, "fr"));

  const topKey = `${String(targetItemId)}::${String(targetRecipeId)}`;
  const topNode = byKey.get(topKey) || craftsSorted.find(x => x.itemId === String(targetItemId)) || null;

  return { raw, crafts: craftsSorted, groups, tree: tree.join("\n"), topNode, topOut };
}

function renderPlan(plan, { targetName, qty, qtyMode }) {
  state.lastPlan = plan;

  const pills = [];
  pills.push(`<span class="pill"><b>Cible</b> ${escapeHtml(targetName)}</span>`);
  pills.push(`<span class="pill"><b>Demandé</b> ${escapeHtml(String(qty))} ${qtyMode === "crafts" ? "craft(s)" : "objet(s)"}</span>`);

  if (plan.topNode) {
    const tn = plan.topNode;
    const info = qtyMode === "items"
      ? `crafts: <b>${tn.crafts}</b> • tu obtiens: <b>${tn.produced}</b>${tn.surplus ? ` (surplus ${tn.surplus})` : ""}`
      : `tu obtiens: <b>${tn.produced}</b> • sortie ${tn.outQty}/craft`;
    pills.push(`<span class="pill">${info}</span>`);
  }

  pills.push(`<span class="pill"><b>À récolter</b> ${plan.raw.length}</span>`);
  pills.push(`<span class="pill"><b>À fabriquer</b> ${plan.crafts.length}</span>`);
  $("planTop").innerHTML = pills.join("");

  let html = `
    <div class="step">
      <h3><span class="stepNum">1</span> Récolter / loot</h3>
      ${plan.raw.length ? `
        <ul class="clean">
          ${plan.raw.map(x => `<li>${escapeHtml(x.name)} <span class="qty">× ${x.qty}</span></li>`).join("")}
        </ul>
      ` : `<div class="muted">Rien à récolter.</div>`}
    </div>
  `;

  let stepN = 2;
  for (const [label, arr] of plan.groups.entries()) {
    html += `
      <div class="step">
        <h3><span class="stepNum">${stepN++}</span> ${escapeHtml(label)}</h3>
        <ul class="clean">
          ${arr.map(n => {
      const extra = `${n.crafts} craft(s) × ${n.outQty} = ${n.produced}${n.surplus ? ` (surplus ${n.surplus})` : ""}`;
      return `<li>${escapeHtml(n.name)} <span class="qty">× ${n.need}</span> <span class="muted">— ${escapeHtml(extra)}</span></li>`;
    }).join("")}
        </ul>
      </div>
    `;
  }

  $("view-do").innerHTML = html;
  $("view-lists").innerHTML = `<div class="muted" style="margin-bottom:8px">Totaux : ressources brutes + composants à fabriquer.</div>`;
  $("view-tree").innerHTML = `<pre>${escapeHtml(plan.tree || "")}</pre>`;
}

function renderRecipes(filter = "") {
  const grid = $("recipesGrid");
  const f = filter.trim().toLowerCase();

  const cards = [];
  for (const rid of Object.keys(DATA.recipesById)) {
    const r = getRecipe(rid);
    const outId = getOutputItemId(r);
    if (!outId) continue;

    const outName = getItemName(outId);
    if (f && !outName.toLowerCase().includes(f) && !String(rid).includes(f)) continue;

    cards.push({
      rid,
      outId,
      outName,
      station: getStation(r),
      npc: getNpc(r),
      outQty: getOutputQty(r),
    });
  }
  cards.sort((a, b) => a.outName.localeCompare(b.outName, "fr"));

  grid.innerHTML = cards.slice(0, 180).map(c => `
    <div class="card recipeCard" data-out="${escapeHtml(c.outId)}" data-recipe="${escapeHtml(c.rid)}">
      <div class="recipeTitle">${escapeHtml(c.outName)}</div>
      <div class="recipeMeta">Recette #${escapeHtml(c.rid)} • sortie ${c.outQty}/craft</div>
      <div class="recipeMeta">${escapeHtml(c.station || "Atelier —")} • ${escapeHtml(c.npc || "NPC —")}</div>
      <div class="recipeMeta muted">Clique pour utiliser comme cible</div>
    </div>
  `).join("");

  grid.querySelectorAll("[data-recipe]").forEach(el => {
    el.addEventListener("click", () => {
      const outId = el.dataset.out;
      const rid = el.dataset.recipe;

      state.itemId = outId;
      state.recipeId = rid;

      $("q").value = "";
      renderItemSelect("");
      $("selItem").value = state.itemId;
      renderRecipeSelect();
      $("selRecipe").value = state.recipeId;
      updateMiniInfo();

      setTab("tab-craft");
    });
  });
}

function onCompute() {
  if (!state.itemId || !state.recipeId) {
    alert("Choisis un objet + une recette.");
    return;
  }
  const qty = Math.max(1, clampInt($("qty").value));
  const qtyMode = $("qtyMode").value;
  const useInv = $("useInv").checked;

  const plan = buildPlan({
    targetItemId: state.itemId,
    targetRecipeId: state.recipeId,
    qty,
    qtyMode,
    useInventory: useInv,
  });

  renderPlan(plan, { targetName: getItemName(state.itemId), qty, qtyMode });
}

function onReset() {
  $("q").value = "";
  $("qty").value = 1;
  $("qtyMode").value = "items";
  $("useInv").checked = true;

  state.itemId = null;
  state.recipeId = null;

  renderItemSelect("");
  $("planTop").innerHTML = "";
  $("view-do").innerHTML = `<div class="muted">Choisis un objet puis clique sur “Calculer”.</div>`;
  $("view-lists").innerHTML = "";
  $("view-tree").innerHTML = "";
}

function init() {
  if (!window.ENSHROUDED) {
    document.body.innerHTML = "<pre>Erreur: window.ENSHROUDED introuvable. Vérifie data.js</pre>";
    return;
  }

  DATA = normalizeData();
  if (!DATA || !DATA.recipesById || Object.keys(DATA.recipesById).length === 0) {
    document.body.innerHTML = "<pre>Erreur: aucune recette détectée. Vérifie le format de data.js</pre>";
    return;
  }

  OUTPUT_INDEX = buildOutputIndex();
  loadInv();

  document.querySelectorAll(".tab").forEach(btn => btn.addEventListener("click", () => setTab(btn.dataset.tab)));
  document.querySelectorAll(".subtab").forEach(btn => btn.addEventListener("click", () => setSub(btn.dataset.sub)));

  $("q").addEventListener("input", (e) => renderItemSelect(e.target.value));
  $("selItem").addEventListener("change", () => {
    state.itemId = $("selItem").value;
    state.recipeId = null;
    renderRecipeSelect();
  });
  $("selRecipe").addEventListener("change", () => {
    state.recipeId = $("selRecipe").value;
    updateMiniInfo();
  });

  $("btnCompute").addEventListener("click", onCompute);
  $("btnReset").addEventListener("click", onReset);

  $("qInv").addEventListener("input", (e) => renderInventory(e.target.value));
  $("btnInvClear").addEventListener("click", () => {
    state.inv = {};
    saveInv();
    renderInventory($("qInv").value || "");
  });

  $("qRecipes").addEventListener("input", (e) => renderRecipes(e.target.value));

  renderItemSelect("");
  renderInventory("");
  renderRecipes("");
  $("view-do").innerHTML = `<div class="muted">Choisis un objet puis clique sur “Calculer”.</div>`;
  updateMiniInfo();
}

document.addEventListener("DOMContentLoaded", init);
