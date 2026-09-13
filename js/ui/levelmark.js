// levelmark.js — the level, drawn.
//
// A ring, not a medal. The streak badges are struck hexagons in bronze, silver, gold and diamond,
// and they mean "a run you kept". A level means "how far you have come", which is a different
// claim and needs a different object — so this is a circle, one colour, with the number inside and
// the ring itself showing how far through the level you are. The mark IS the bar, which is why the
// same drawing works at 18px beside a name and at 72px on a header.

/**
 * @param standing  from levelFor / lifetime: { level, pct, max }
 * @param size      px
 * @param opts.tip  0–100 extra, drawn fainter after the solid arc: today's XP, not yet banked
 */
export function levelMark(standing, size = 22, opts = {}) {
  const r = 45;
  const c = 2 * Math.PI * r;
  const solid = Math.max(0, Math.min(100, standing.max ? 100 : standing.pct));
  const tip = Math.max(0, Math.min(100 - solid, opts.tip || 0));
  const dash = (pct) => (c * pct) / 100 + " " + c;
  // Namespaced by hand: dom.el() makes HTML elements, and an <svg> made that way is an unknown
  // element that draws nothing.
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "lvl");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Level " + standing.level + (standing.max ? ", the top" : ", " + standing.pct + "% to the next"));
  svg.innerHTML =
    '<circle class="lvl-track" cx="50" cy="50" r="' + r + '"/>' +
    (tip ? '<circle class="lvl-tip" cx="50" cy="50" r="' + r + '" stroke-dasharray="' + dash(solid + tip)
      + '" transform="rotate(-90 50 50)"/>' : "") +
    '<circle class="lvl-arc" cx="50" cy="50" r="' + r + '" stroke-dasharray="' + dash(solid)
      + '" transform="rotate(-90 50 50)"/>' +
    '<text class="lvl-n" x="50" y="50" text-anchor="middle" dominant-baseline="central">' + standing.level + "</text>";
  if (standing.max) svg.setAttribute("class", "lvl is-max");
  return svg;
}
