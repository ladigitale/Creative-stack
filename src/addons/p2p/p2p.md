# Salons temps réel (SDUI)

Addon `@supersoniks/creative-stack/p2p` : `sonic-p2p` met des visiteurs d'un même artefact en relation dans des **salons à places limitées** (jeux, tableau blanc), par l'API de salons Tadaaa (`/api/public/artifacts/{slug}/rooms`) et le hub Mercure. Aucun compte, aucun secret à échanger : on choisit un salon dans une liste, ou on tape un code court (« bakodu »).

```json
{ "tagName": "sonic-p2p", "attributes": {
  "id": "net", "artifact": "mon-jeu", "api": "https://api.tadaaa.space",
  "pseudo": "Ana", "share": "game.local", "rate": "20", "control": "net.ctl" } }
```

| Attribut | Rôle |
|---|---|
| `artifact` | Slug de l'artefact (obligatoire) |
| `api` | Origine de l'API Tadaaa (vide : même origine) |
| `link-token` | Jeton `?k=` d'un artefact « lien secret » |
| `pseudo` | Nom affiché (peut être surchargé par la commande) |
| `share` | DP dont la valeur locale est diffusée aux autres (au plus `rate` fois/s, la plus récente l'emporte) |
| `rate` | Envois par seconde (20, max 60) |
| `control` | DP de commandes `{ "cmd": { "n": 1, "type": "…" } }` : exécutée à chaque **hausse** de `n` |
| `store` + `message-action` | Chaque message reçu → action `{ type, payload: { from, pseudo, data } }` |
| `out-data-provider` / `peers-data-provider` | Noms de sortie (défauts `<id>State`, `<id>Peers`) |

## Commandes (`control.cmd.type`)

| Type | Paramètres |
|---|---|
| `refresh` | liste les salons publics → `rooms` |
| `create` | `name`, `access` (`open` \| `approval`), `code` (`true` = code généré, ou un mot de 3 à 24 lettres/chiffres), `listed`, `max` (2 à 32, défaut 8) |
| `join` | `roomId` (salon de la liste) ou `code` ; `pseudo` facultatif |
| `approve` / `reject` | `id` du membre en attente (hôte, salon `approval`) |
| `kick` | `id` du membre à exclure (hôte) |
| `leave` | quitte le salon (l'hôte qui part ferme le salon) |
| `send` | `data` : message libre (arrive dans le `store` via `message-action`) |

Un salon avec code n'est pas listé par défaut : le code se dicte. Un salon `approval` met chaque arrivant en attente jusqu'à la décision de l'hôte.

## État

`<id>State` : `{ status, error, rooms, room, me, members, pending, received }`

- `status` : `idle | connecting | pending | ready | rejected | kicked | closed | error`
- `room` : `{ id, name, access, hasCode, members, max, full, code? }` (`code` seulement pour le créateur)
- `me` / `members[]` : `{ id, pseudo, host }` ; `pending[]` : demandes à traiter (hôte)

`<id>Peers` : `{ "<idMembre>": valeur }` : la dernière valeur `share` de chaque autre membre. À écrire par composant à part pour ne pas relancer l'état à haute fréquence.

## Limites à connaître

- Messages ≤ 64 Ko ; débit pensé pour de l'état (quelques dizaines de Hz), pas du flux média.
- Une exclusion est effective au plus tard à l'expiration du jeton (5 min) pour l'envoi ; la lecture est coupée immédiatement côté client exclu.
- Un salon vit 6 h au plus, et disparaît quand son hôte part ou reste inactif 10 min.
- Les messages passent par le hub : ni chiffrés de bout en bout, ni authentifiés au-delà du pseudo. Ne pas y mettre de secret.

## Exemple : curseurs partagés

```json
{ "tagName": "div", "nodes": [
  { "tagName": "sonic-p2p", "attributes": { "id": "net", "artifact": "mon-jeu", "api": "https://api.tadaaa.space", "pseudo": "Ana", "share": "me", "control": "net.ctl" } },
  { "tagName": "sonic-action", "attributes": { "…": "écrit net.ctl = {cmd:{n:1,type:'join',code:'bakodu'}}" } }
] }
```

Les valeurs des autres se lisent dans `netPeers` (liste de curseurs à dessiner), les membres dans `netState.members`.
