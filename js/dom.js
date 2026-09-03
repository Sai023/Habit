// dom.js — the smallest element helper that makes rendering readable.
//
// No framework and no virtual DOM. The dashboard is three screens rebuilt from derived state on
// each change; on a phone that is a handful of nodes and well under a frame, so a diffing library
// would cost more (in bytes, in build steps, in a thing to keep on version) than it saves.

/**
 * el("div.card", { onclick }, ...children)
 *
 * The tag accepts a CSS-ish shorthand — "div.card.is-hit" — because class names carry almost all
 * the meaning in this UI and writing them inline keeps the structure legible.
 */
export function el(spec, attrs, ...children) {
  const [tag, ...classes] = String(spec).split(".");
  const node = document.createElement(tag || "div");
  if (classes.length) node.className = classes.join(" ");

  // Anything that is not a plain object is a CHILD, not an attributes bag — and the test has to be
  // on the type rather than on truthiness. `el("b", 0)` is a perfectly ordinary way to render a
  // zero, and treating a falsy value as "no attributes given" silently swallowed it: a streak of
  // 0 rendered as an empty element, so the line read "🔥 days" with the number simply gone.
  const isAttrs = attrs != null && typeof attrs === "object" && !attrs.nodeType && !Array.isArray(attrs);
  if (!isAttrs) {
    if (attrs !== undefined) children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = [node.className, v].filter(Boolean).join(" ");
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  add(node, children);
  return node;
}

function add(node, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) add(node, c);
    else node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

/** Replace a container's contents in one go. */
export function render(root, ...children) {
  root.replaceChildren();
  add(root, children);
  return root;
}
