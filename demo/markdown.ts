/** Démo « markdown » : un prompt à variables et une réponse rendue en flux (`?vitesse=ms`). */
import "@supersoniks/concorde/index";
import "../src/addons/markdown";
import { get, set } from "@supersoniks/concorde/core/utils/PublisherProxy";

const prompt = `---
title: Fiche prompt
tags: [rédaction]
---
# Résumer un document

Tu es un assistant de rédaction. Résume le texte ci-dessous en **{{longueur|5 lignes}}**, en {{langue}}, sur un ton {{ton|neutre}}.

- Garde les chiffres exacts
- [x] Cite les sources
- [ ] Ajoute un titre

\`\`\`text
{{texte}}
\`\`\`

Les accolades littérales s'écrivent \\{{ainsi}}.
`;

const answer = `# Réponse

Voici un **résumé** avec un [lien](https://concorde.supersoniks.org) et une formule $E = mc^2$.

## Points clés

| Indicateur | Valeur | Évolution |
| :--------- | -----: | :-------: |
| Visiteurs  | 12 430 | +8 %      |
| Ventes     | 1 204  | +3 %      |

1. Premier point
2. Second point, avec \`du code\`

\`\`\`ts
export function somme(a: number, b: number): number {
  return a + b; // commentaire
}
\`\`\`

$$
\\int_0^1 x^2\\,dx = \\frac{1}{3}
$$

> Une citation pour finir[^1].

[^1]: Et une note de bas de page.
`;

set("demoMd", { prompt, vars: { langue: "français" }, answer: { text: "", done: false } });

const speed = Number(new URLSearchParams(location.search).get("vitesse") ?? 15);
let i = 0;
const tick = () => {
  i = Math.min(answer.length, i + 3 + Math.floor(Math.random() * 6));
  set("demoMd.answer", { text: answer.slice(0, i), done: i >= answer.length });
  if (i < answer.length) setTimeout(tick, speed);
  else document.title = "ready";
};
setTimeout(tick, 300);

(window as unknown as Record<string, unknown>).__get = (k: string) => JSON.parse(JSON.stringify(get(k) ?? null));
