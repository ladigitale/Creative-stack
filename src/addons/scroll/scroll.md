# Addon `scroll` — animer au défilement

`sonic-scroll` lit le défilement de la page (ou d'un conteneur) et le publie dans un DataProvider : position, **avancement de 0 à 1**, vitesse, sens, et l'**avancement de chaque section**. Une animation, une timeline ou un shader n'ont plus qu'à lire ces valeurs. Il **ne détourne pas** le défilement : la molette, le clavier et le tactile gardent leur comportement natif.

```json
{ "tagName": "sonic-scroll", "attributes": { "sections": "section", "smooth": "0.1", "control": "defCtl", "out-data-provider": "defil" } }
{ "tagName": "sonic-timeline", "attributes": { "descriptor-dp": "histoire", "time-source": "defil.smoothProgress" } }
```

## Attributs

| Attribut | Rôle |
|---|---|
| `target` | `#id` d'un conteneur défilant ; vide : le plus proche ancêtre qui défile (la visionneuse d'artefacts défile dans son propre conteneur, pas dans la page), sinon la page |
| `sections` | Sélecteur CSS des sections à suivre (`section`, `[data-etape]`) ; 100 au plus. Un élément sans `id` est nommé `section-1`, `section-2`… |
| `smooth` | Inertie des valeurs lissées : 1 sans retard, 0,05 très doux (défaut 0,1). Sans effet si l'utilisateur demande moins d'animations (`prefers-reduced-motion`) |
| `control` | DP de commande `{ to: "#id" \| px, n: compteur }` : fait défiler jusqu'à l'élément ou la position quand `n` augmente (animation douce, sauf `prefers-reduced-motion`) |
| `out-data-provider` | Reçoit l'état |

## État

| Champ | Sens |
|---|---|
| `y`, `max`, `progress` | Position (px), position maximale, avancement global 0..1 |
| `smoothY`, `smoothProgress` | Les mêmes, **lissées** : à donner aux animations pour un mouvement doux qui rattrape le défilement |
| `velocity`, `direction` | Vitesse lissée en px/s (signée) ; sens −1 (haut), 0, 1 (bas) |
| `atTop`, `atEnd` | Haut et bas de page atteints |
| `active` | Section qui contient le milieu de l'écran : `{ index, id, progress, pin }` |
| `sections[]` | Pour chacune : `id`, `index`, `progress`, `pin`, `visible`, `inView` |

- `progress` d'une section : 0 quand son haut touche le bas de l'écran, 1 quand son bas quitte le haut de l'écran.
- `pin` : pour une section **plus haute que l'écran** contenant un bloc `position: sticky; top: 0`, avancement pendant que le bloc reste épinglé (0 avant, 1 après). C'est la mesure des histoires au défilement : une scène de 300 vh dont l'avancement `pin` fait avancer une timeline.
- `visible` : part de l'écran couverte par la section.

## Recette : scène épinglée

Une section `style="height:300vh"` avec `sections="section"`, contenant un `div` `position: sticky; top: 0; height: 100vh`. L'état `sections[0].pin` va de 0 à 1 pendant que la scène reste à l'écran ; on le lit via `active.pin` (la section active est celle de l'écran) ou en suivant son indice.

## Limites

Un seul `sonic-scroll` par défilement suivi est nécessaire. Les mesures utilisent la géométrie des éléments à chaque image pendant le mouvement (puis s'arrêtent) : au-delà de quelques dizaines de sections, mieux vaut en suivre moins. Les valeurs lissées ne retardent pas le défilement lui-même, seulement ce qui est animé à partir d'elles.
