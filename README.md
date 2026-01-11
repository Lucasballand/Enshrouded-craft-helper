# Enshrouded Craft Calc (vanilla)

Petit site statique (HTML/CSS/JS) qui calcule automatiquement les ressources **en incluant les crafts intermédiaires** (comme ton Rust Raid Calc).

## Lancer en local
Ouvre `index.html` (ou utilise un petit serveur local si tu préfères).

## Générer toutes les recettes (auto)
Ce repo contient un script qui scrape la base communautaire `enshrouded.vercel.app`.

### Prérequis
- Node.js 18+ (pour `fetch` natif)

### Commande
```bash
node tools/scrape_enshrouded_recipes.mjs
```

Options (si besoin):
```bash
MAX_ID=1500 CONCURRENCY=6 node tools/scrape_enshrouded_recipes.mjs
```

Le script génère:
- `data/enshrouded_data.json` (lisible)
- `data.js` (utilisé par le site)

Ensuite recharge la page et tu auras toutes les recettes.

## Notes
- Enshrouded est en accès anticipé → relance le script de temps en temps.
- Les images ne sont pas intégrées pour le moment (on les ajoute ensuite).
