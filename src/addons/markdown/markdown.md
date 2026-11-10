# Addon `markdown` — rendu Markdown

`sonic-markdown` rend du Markdown (GFM) en DOM natif, aux couleurs du thème Concorde. Il sert à afficher de la doc, à partager des prompts à compléter et à afficher des réponses LLM en flux. Aucun HTML n'est jamais injecté : le HTML brut écrit dans le Markdown s'affiche comme du texte.

```json
{ "tagName": "sonic-markdown", "attributes": { "text": "# Titre\n\nUn paragraphe **gras** et une liste :\n\n- un\n- deux" } }
{ "tagName": "sonic-markdown", "attributes": { "src": "https://concorde.supersoniks.org/llms.txt", "features": "gfm highlight copy anchors toc", "out-data-provider": "doc" } }
{ "tagName": "sonic-markdown", "attributes": { "source": "chat.answer", "streaming": "", "features": "gfm highlight math copy", "out-data-provider": "answerState" } }
```

## Attributs

| Attribut | Rôle |
|---|---|
| `text` | Markdown à rendre ; vide : le texte contenu dans l'élément (indentation commune retirée) |
| `source` | Chemin DataProvider d'une chaîne Markdown, ou d'un objet `{ text, done }` ; remplace `text` |
| `src` | URL `https:` d'un fichier Markdown (ex. `llms.txt`), lue une fois |
| `refresh` | Relecture de `src` toutes les `refresh` secondes (0 : jamais, minimum 10) |
| `streaming` | Le texte grandit par la fin (réponse LLM) : rendu incrémental, voir plus bas |
| `features` | Liste parmi `gfm highlight math copy vars toc anchors` (défaut `gfm copy anchors`) |
| `vars` | Chemin DataProvider des valeurs de variables `{ nom: valeur }` (feature `vars`) |
| `link-target` | `_blank` (défaut, liens externes) ou `_self` |
| `heading-offset` | Décale les titres (1 : `#` devient `h2`), 0..5 |
| `max-length` | Coupe le texte au-delà (défaut 200 000 caractères) ; `truncated: true` publié |
| `control` | Chemin DataProvider `{ n, action, id }` : la hausse de `n` lance `action` |
| `params` | Chemin DataProvider de réglages en direct `{ text, features, linkTarget, headingOffset, streaming }` : chaque clé présente remplace l'attribut, une clé retirée (ou `null`) rend la main à l'attribut |
| `out-data-provider` | Reçoit l'état complet (voir Sortie) |

Priorité des sources : `params.text` > `source` > `src` > `text` > contenu de l'élément.

### Features

| Feature | Effet |
|---|---|
| `gfm` | Tableaux, barré `~~x~~`, listes de tâches `- [x]` (cases en lecture seule), notes `[^1]`, liens automatiques |
| `highlight` | Coloration syntaxique (Prism 1.30.0, chargé à la demande depuis jsDelivr avec empreinte d'intégrité) pour `js ts jsx tsx html xml svg css scss json sh bash py php sql yaml md diff c cpp java rust go glsl cs ini toml dockerfile` ; couleurs prises dans les tokens du thème |
| `math` | Formules `$…$` et blocs `$$…$$` (KaTeX 0.19.1 chargé à la demande, sortie MathML, commandes de confiance désactivées) ; `5$ et 10$` reste du texte |
| `copy` | Bouton « Copier » sur chaque bloc de code (copie le texte brut, variables remplies) |
| `vars` | Variables de prompt `{{nom}}` ou `{{nom\|défaut}}`, dans le texte comme dans le code ; `\{{` s'écrit `{{` sans être une variable |
| `toc` | Sommaire cliquable en tête (dès 2 titres) |
| `anchors` | Lien `#` au survol de chaque titre |

Le plan (`toc`) est publié dans la sortie même sans la feature `toc`.

## Sortie (`out-data-provider`)

```json
{
  "status": "ready",
  "error": null,
  "source": "text",
  "length": 1532,
  "truncated": false,
  "stats": { "words": 240, "readingMinutes": 2, "blocks": 18 },
  "frontmatter": { "title": "Fiche prompt", "tags": ["rédaction"] },
  "title": "Fiche prompt",
  "toc": [{ "level": 1, "text": "Fiche prompt", "id": "fiche-prompt" }],
  "code": [{ "index": 0, "lang": "ts", "info": "ts", "text": "const x = 1;", "lines": 1 }],
  "links": [{ "text": "doc", "href": "https://exemple.org", "external": true }],
  "vars": [{ "name": "langue", "default": null, "value": "français", "filled": true }],
  "missingVars": [],
  "resolved": "# Fiche prompt\n\nRéponds en français…",
  "lastAction": { "n": 3, "action": "copy", "ok": true },
  "settings": { "features": ["gfm", "vars", "copy"], "linkTarget": "_blank", "headingOffset": 0, "streaming": false }
}
```

- `status` : `idle` (aucun texte), `loading` (`src` en cours), `streaming` (flux pas terminé), `ready`, `error` (feature inconnue, valeur `params` refusée, URL `src` refusée ou injoignable : message dans `error`, le dernier rendu reste affiché).
- `frontmatter` : bloc `---` en tête, YAML simple (`clé: valeur`, listes `[a, b]` ou en tirets) ; `title` vient du frontmatter, sinon du premier `#`.
- `toc[].id` : identifiant du titre, préfixé par l'`id` de l'élément s'il en a un (`doc-intro`), dédupliqué (`-2`, `-3`).
- `vars` / `missingVars` : variables trouvées et celles qui n'ont ni valeur ni défaut. De quoi générer un formulaire et griser un bouton tant qu'il manque une valeur.
- `resolved` : le Markdown source avec les variables remplacées. C'est ce que copie l'action `copy`.
- En flux, la sortie est publiée au plus toutes les 100 ms (la dernière valeur l'est toujours).

## Pilotage (`control`)

```json
{ "doc": { "ctl": { "n": 4, "action": "scroll-to", "id": "installation" } } }
```

| `action` | Effet |
|---|---|
| `copy` (défaut) | Copie `resolved` (Markdown, variables remplies) |
| `copy-rendered` | Copie le texte affiché |
| `scroll-to` | Fait défiler jusqu'au titre `id` (avec ou sans le préfixe de l'élément) |
| `refresh` | Relit `src`, ou ré-analyse le texte |

Le résultat est publié dans `lastAction` (`ok: false` et `error` si le presse-papiers est refusé ou l'id introuvable).

## Prompts à compléter

```json
{ "tagName": "sonic-markdown", "attributes": { "source": "prompt.md", "vars": "prompt.vars", "control": "prompt.ctl", "features": "gfm copy vars", "out-data-provider": "promptState" } }
```

```json
{ "prompt": { "md": "Réponds en {{langue}}, ton {{ton|neutre}}.", "vars": { "langue": "français" }, "ctl": { "n": 0 } } }
```

Chaque variable s'affiche comme une puce (sa valeur, ou son nom en pointillés si elle n'en a pas). Les champs qui écrivent dans `prompt.vars` se construisent à partir de `promptState.vars` ; un bouton qui incrémente `prompt.ctl.n` copie le prompt complété.

## Réponses LLM en flux

Avec `streaming`, publier dans `source` le texte cumulé à chaque morceau, puis `done: true` à la fin :

```json
{ "chat": { "answer": { "text": "## Résumé\n\nLe composant…", "done": false } } }
```

Seul le dernier bloc (paragraphe, liste, bloc de code…) est ré-analysé à chaque ajout ; les blocs précédents gardent leur DOM (sélection et défilement préservés). Un bloc de code non fermé s'affiche déjà comme du code. À `done: true`, un rendu complet résout les liens par référence et les notes. Un texte qui ne prolonge pas le précédent repart de zéro. `aria-busy="true"` tant que le flux n'est pas terminé.

## Sécurité

- Pas de `innerHTML` : tout le texte passe par le rendu Lit, échappé.
- Liens : `https:`, `http:`, `mailto:`, ancres `#…` et chemins relatifs ; tout autre schéma (`javascript:`, `data:`…) est rendu comme texte. Liens externes en `rel="noopener noreferrer"`.
- Images : `https:`, `blob:` et `data:image/(png|jpeg|gif|webp|avif)` seulement, `loading="lazy"`, `referrerpolicy="no-referrer"`.
- `src` : `https:` seulement, sans cookies (`credentials: "omit"`).
- Prism et KaTeX : versions exactes, empreintes SRI, rien n'est chargé sans la feature ni sans bloc concerné.

## Style

Tokens Concorde (`--sc-base-content`, `--sc-primary`, `--sc-base`, `--sc-font-family-*`, `--sc-rounded-*`…). Largeur de lecture : `--sc-markdown-measure` (défaut `72ch`). Parties stylables : `::part(root)`, `::part(heading)` (et `h1`…`h6`), `::part(code)`, `::part(code-inline)`, `::part(copy-button)`, `::part(table)`, `::part(blockquote)`, `::part(var)`, `::part(toc)`, `::part(image)`, `::part(math)`, `::part(footnotes)`.

## Accessibilité

Vraie hiérarchie de titres (réglable avec `heading-offset`), en-têtes de tableau `scope="col"`, boutons de copie étiquetés avec annonce « Copié » en région `aria-live`, ancres de titres masquées à la lecture et étiquetées.
