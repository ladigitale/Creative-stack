# sonic-qr

QR code dessiné en SVG dans la page : aucun service tiers, aucune requête. Pour montrer un lien à
scanner avec un téléphone (lien spectateur d'un run, appairage d'une télécommande, code de salon,
URL d'un artefact).

```json
{ "tagName": "sonic-qr", "attributes": { "text": "https://artifacts.tadaaa.space/mon-artefact", "link": true } }
```

Texte lu en direct dans un DataProvider (le code se redessine quand la valeur change) :

```json
{ "tagName": "sonic-qr", "attributes": { "text-from": "artifactRun.watchUrl", "placeholder": "Lien pas encore prêt", "size": 240 } }
```

| Attribut | Rôle |
|---|---|
| `text` | Texte à encoder |
| `text-from` | DataProvider ou `dp.chemin` dont la valeur (texte ou nombre) est encodée ; l'emporte sur `text` |
| `ecc` | Correction d'erreur `L`, `M` (défaut), `Q`, `H` : plus haut = plus robuste (écran sale, reflets) mais plus dense |
| `size` | Taille en px (défaut 192) ; la variable CSS `--qr-size` l'emporte (`style="--qr-size:40vmin"`) |
| `margin` | Zone de silence en modules (défaut 2 ; 4 pour l'impression) |
| `color`, `background` | Défaut `#000000` sur `#ffffff`. Garder un fort contraste et des modules sombres sur fond clair : beaucoup de lecteurs refusent un code inversé |
| `link` | Le code est aussi un lien quand le texte est une URL `http(s)` (jamais `javascript:` ni `data:`) |
| `label` | Texte lu par les lecteurs d'écran (défaut : « QR code : » suivi du texte) |
| `placeholder` | Affiché tant que le texte est vide |
| `out-data-provider` | État `{status: ready|empty|error, text, version, modules, error}` |

- 1200 caractères au plus (au-delà, `status: "error"`) : un lien court se lit de plus loin. Les
  accents et émojis sont encodés en UTF-8.
- Lisibilité à distance : un module doit faire au moins ~1 mm par mètre de distance de lecture ;
  pour un écran de salle, `--qr-size: 40vmin` et `ecc: "Q"`.
