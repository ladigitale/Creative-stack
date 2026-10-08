# creative-stack — notes pour agents

- Un addon = `src/addons/<id>/` avec `index.ts` + `manifest.json`. Le catalogue (`dist/catalog.json`) est généré, ne jamais l'écrire à la main.
- Concorde **classique** est une peer dependency (5.x, plus de branche visual-stack). Les comportements que visual-stack ajoutait au cœur (`sonic-if` en mode attributs, `sonic-value format`, garde JSON du Subscriber, `$cosine`/`$rankBySimilarity`/`$mediaUrl` dans `sonic-jsonata`) sont portés dans `src/shared/concorde-compat.ts` et `src/shared/jsonata-shim.ts` : compléter ces fichiers plutôt que de dépendre d'un fork. N'importer que `@supersoniks/concorde/...` public ; pas d'import entre addons sauf via leur `index.ts` (exception historique : `webgpu` réutilise le runtime GL de `shader`).
- Tout nouveau composant exposé à l'agent doit éviter `innerHTML`, l'évaluation de code et les URL de script libres : les artefacts sont générés par un LLM.
- Avant de pousser : `yarn typecheck && yarn test:ci && yarn build`.
