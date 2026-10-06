// MathJax 3 (TeX in, SVG out) with no DOM, for any bare JavaScript engine.
//
// The problem: xochitl embeds Qt's V4 engine (QJSEngine, and WorkerScript threads) but no browser,
// so KaTeX, whose output is HTML laid out by CSS, cannot be displayed there. MathJax's liteAdaptor
// does its own layout and emits self-contained SVG (glyphs as filled paths with fontCache 'none'),
// which QtSvg, already loaded in xochitl (libQt6Svg, imageformats/libqsvg), can draw.
//
// Bundle (docs/investigations/latex-on-tablet.md, spike 3):
//   pnpm add mathjax-full@3 esbuild
//   esbuild mathjax_entry.js --bundle --format=iife --minify --target=es2016 --outfile=mathjax-v4.js
// V4 has no `globalThis` (an ES2020 name), so the loader prepends `var globalThis = this;`.
import {mathjax} from 'mathjax-full/js/mathjax.js';
import {TeX} from 'mathjax-full/js/input/tex.js';
import {SVG} from 'mathjax-full/js/output/svg.js';
import {liteAdaptor} from 'mathjax-full/js/adaptors/liteAdaptor.js';
import {RegisterHTMLHandler} from 'mathjax-full/js/handlers/html.js';
import {AllPackages} from 'mathjax-full/js/input/tex/AllPackages.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const doc = mathjax.document('', {
  InputJax: new TeX({packages: AllPackages}),
  OutputJax: new SVG({fontCache: 'none'}),
});

/** TeX math (no `$` delimiters) to an SVG string; `display` selects display style. */
globalThis.tex2svg = function (tex, display) {
  return adaptor.innerHTML(doc.convert(tex, {display: !!display}));
};
