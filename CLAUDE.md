# creative-stack — notes pour agents

- Un addon = `src/addons/<id>/` avec `index.ts` + `manifest.json`. Le catalogue (`dist/catalog.json`) est généré, ne jamais l'écrire à la main.
- Concorde est une peer dependency (^5). N'importer que `@supersoniks/concorde/...` public ; pas d'import entre addons sauf via leur `index.ts` (exception historique : `webgpu` réutilise le runtime GL de `shader`).
- Tout nouveau composant exposé à l'agent doit éviter `innerHTML`, l'évaluation de code et les URL de script libres : les artefacts sont générés par un LLM.
- Avant de pousser : `yarn typecheck && yarn test:ci && yarn build`.
