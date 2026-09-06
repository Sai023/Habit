import { demoState } from './js/ui/demo.js';
import { buildSummary } from './js/summary.js';
const d = demoState();
const s = buildSummary(d.state, d.me, d.today);
const keys = new Set();
(function walk(o){ if (o && typeof o === 'object') { if (Array.isArray(o)) return o.forEach(walk);
  for (const k of Object.keys(o)) { keys.add(k); walk(o[k]); } } })(s);
console.log([...keys].sort().join(' '));
