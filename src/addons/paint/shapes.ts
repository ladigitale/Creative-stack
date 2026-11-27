/**
 * Outils de forme de `sonic-paint` (annoter une image) : trait droit, flèche, rectangle, ellipse, texte,
 * pastille numérotée, pixellisation d'une zone. Une forme se tire du point d'appui au point courant ; elle est
 * redessinée à chaque mouvement sur l'image d'avant le geste, puis fondue dans la toile au lever.
 */

export const SHAPE_TOOLS = ["line", "arrow", "rect", "ellipse", "text", "badge", "pixelate"] as const;
export type ShapeTool = (typeof SHAPE_TOOLS)[number];

export function isShapeTool(v: unknown): v is ShapeTool {
  return typeof v === "string" && (SHAPE_TOOLS as readonly string[]).includes(v);
}

export type P = { x: number; y: number };

export type ShapeStyle = {
  color: string;
  /** Épaisseur du trait (le diamètre du pinceau). */
  size: number;
  opacity: number;
  /** Rectangle / ellipse pleins. */
  fill: boolean;
  /** Texte de l'outil `text`. */
  text: string;
  /** Numéro de la pastille. */
  n: number;
};

/** Les formes tirées (pas le texte ni la pastille, posés d'un clic) ne valent rien sans un vrai glissement. */
export function needsDrag(tool: ShapeTool): boolean {
  return tool !== "text" && tool !== "badge";
}

export function dragLength(a: P, b: P): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Rectangle normalisé (coin haut-gauche, tailles positives) entre deux points. */
export function box(a: P, b: P): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Taille des caractères de l'outil texte, et rayon de la pastille, déduits de l'épaisseur du trait. */
export function textSize(size: number): number {
  return Math.max(12, Math.round(size * 4));
}

export function badgeRadius(size: number): number {
  return Math.max(10, Math.round(size * 2.6));
}

/** Côté des blocs de la pixellisation. */
export function pixelBlock(size: number): number {
  return Math.max(4, Math.round(size * 2));
}

/**
 * Pointe de flèche en `b` pour un trait venu de `a` : `base` est le point où le trait s'arrête (il ne dépasse
 * pas sous la pointe), `left` et `right` les deux ailes. La pointe ne dépasse jamais la longueur du trait.
 */
export function arrowHead(a: P, b: P, size: number): { base: P; left: P; right: P } {
  const len = dragLength(a, b) || 1;
  const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const L = Math.min(len, Math.max(12, size * 4));
  const half = L * 0.42;
  const base = { x: b.x - ux * L, y: b.y - uy * L };
  return { base, left: { x: base.x - uy * half, y: base.y + ux * half }, right: { x: base.x + uy * half, y: base.y - ux * half } };
}

/** Noir ou blanc, le plus lisible sur `color` (couleur lue par le canvas : toute couleur CSS). */
export function contrastOn(ctx: CanvasRenderingContext2D, color: string): string {
  const keep = ctx.fillStyle;
  ctx.fillStyle = "#000000";
  ctx.fillStyle = color;
  const v = String(ctx.fillStyle);
  ctx.fillStyle = keep;
  let r = 0, g = 0, b = 0;
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v);
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(v);
  if (hex) { r = parseInt(hex[1], 16); g = parseInt(hex[2], 16); b = parseInt(hex[3], 16); }
  else if (rgb) { r = +rgb[1]; g = +rgb[2]; b = +rgb[3]; }
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#000000" : "#ffffff";
}

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Dessine la forme sur `ctx` (déjà remis à l'image d'avant le geste). `w`, `h` : taille de la toile.
 * Retourne faux quand il n'y a rien à dessiner (glissement trop court, texte vide).
 */
export function drawShape(ctx: CanvasRenderingContext2D, tool: ShapeTool, a: P, b: P, st: ShapeStyle, w: number, h: number): boolean {
  if (needsDrag(tool) && dragLength(a, b) < 3) return false;
  const lw = Math.max(1, st.size);
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = Math.max(0.02, Math.min(1, st.opacity));
  ctx.strokeStyle = st.color;
  ctx.fillStyle = st.color;
  ctx.lineWidth = lw;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  let drawn = true;
  switch (tool) {
    case "line": {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      break;
    }
    case "arrow": {
      const head = arrowHead(a, b, lw);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(head.base.x, head.base.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(b.x, b.y);
      ctx.lineTo(head.left.x, head.left.y);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.closePath();
      ctx.fill();
      break;
    }
    case "rect": {
      const r = box(a, b);
      if (st.fill) ctx.fillRect(r.x, r.y, r.w, r.h);
      else ctx.strokeRect(r.x, r.y, r.w, r.h);
      break;
    }
    case "ellipse": {
      const r = box(a, b);
      ctx.beginPath();
      ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
      if (st.fill) ctx.fill();
      else ctx.stroke();
      break;
    }
    case "text": {
      const lines = String(st.text ?? "").slice(0, 500).split("\n").filter((l, i, all) => l.trim() || all.length > 1);
      if (!lines.some((l) => l.trim())) { drawn = false; break; }
      const fs = textSize(lw);
      ctx.font = `600 ${fs}px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      // Liseré contrasté : lisible sur n'importe quel fond de capture.
      ctx.strokeStyle = contrastOn(ctx, st.color);
      ctx.lineWidth = Math.max(2, fs / 6);
      lines.forEach((line, i) => {
        const y = b.y + i * fs * 1.25;
        ctx.strokeText(line, b.x, y);
        ctx.fillText(line, b.x, y);
      });
      break;
    }
    case "badge": {
      const r = badgeRadius(lw);
      const ink = contrastOn(ctx, st.color);
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = ink;
      ctx.lineWidth = Math.max(1.5, r / 9);
      ctx.stroke();
      const label = String(Math.max(0, Math.round(st.n)));
      ctx.fillStyle = ink;
      ctx.font = `700 ${Math.round(r * (label.length > 2 ? 0.8 : label.length > 1 ? 1 : 1.25))}px ${FONT}`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      ctx.fillText(label, b.x, b.y + r * 0.06);
      break;
    }
    case "pixelate": {
      const r = box(a, b);
      const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
      const x1 = Math.min(w, Math.ceil(r.x + r.w)), y1 = Math.min(h, Math.ceil(r.y + r.h));
      const rw = x1 - x0, rh = y1 - y0;
      if (rw < 2 || rh < 2) { drawn = false; break; }
      const block = pixelBlock(lw);
      const tw = Math.max(1, Math.round(rw / block)), th = Math.max(1, Math.round(rh / block));
      const tmp = document.createElement("canvas");
      tmp.width = tw;
      tmp.height = th;
      const tg = tmp.getContext("2d");
      if (!tg) { drawn = false; break; }
      tg.imageSmoothingEnabled = true;
      tg.drawImage(ctx.canvas, x0, y0, rw, rh, 0, 0, tw, th);
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(tmp, 0, 0, tw, th, x0, y0, rw, rh);
      ctx.imageSmoothingEnabled = true;
      break;
    }
  }
  ctx.restore();
  return drawn;
}
