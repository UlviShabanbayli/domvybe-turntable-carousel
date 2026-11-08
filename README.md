# Turntable carousel — UI component

**[Live demo](https://domvybe.com/components/turntable-carousel/)** · [Step-by-step tutorial](https://domvybe.com/library/turntable-carousel/) · [Download the ZIP](https://github.com/UlviShabanbayli/domvybe-turntable-carousel/releases/latest/download/turntable-carousel-source.zip)

A product carousel on a black lacquer turntable: the arrows, the keys or a flick spin the platter, the glass flacons refract as they pass, and a laser engraves the name into the silver rim.

Open `index.html` through any local static server (for example `python3 -m http.server`) and try it with a mouse,
a finger or the keyboard. Plain HTML, CSS and JavaScript; no build step, no libraries.

- `index.html` — the product page: the skip link, the header with the bag and its popover, the copy (kicker, name, notes, price, Add to bag and the arrows), the stage with its canvas, SVG fallback and tabs over the flacons, the counter, the caption
- `css` — turntable.css: the page on the 1600 x 1000 grid, the stage, the tabs and their tags, the bag, the one-column phone and tablet layout, the short-landscape layout, reduced motion
- `js` — app.js (the products, the weighted spring, arrows, keys, drag and swipe, the tabs, the bag, the copy that cross-fades), renderer.js (the WebGL 2 renderer: a live pass while moving, full-resolution bands at rest, then sleep), shaders.js (the refracting flacons, the lacquer, the engraved rim, the laser and the bloom), fallback.js (the SVG turntable without WebGL 2)

ONDINE, its four fragrances and their prices are made up, and the bag sells nothing (3 of one fragrance at most). Everything
is made in code: the glass flacons, their liquids, the black lacquer and the engraved silver rim are a real-time WebGL 2
raymarch (refracting glass, coloured liquids, a laser pass that engraves the name, a soft bloom); every word is HTML;
no AI pictures. While the platter moves it renders a fast live pass, at rest it fills in at full resolution in bands
and then sleeps. The flacons are real tabs, so a click, the arrow keys, a drag or a swipe all turn it. Only the bag is
kept in `localStorage` (`dv77.bag`). Without WebGL 2 (or with `?nofx`, or when the context is lost) the turntable is
SVG (`js/fallback.js`). The page reads Google Fonts (Cormorant Garamond, Manrope).

It respects `prefers-reduced-motion`. Made by Ulvi (Code with Ulvi) · domvybe.com

## Licence

MIT — see [LICENSE](LICENSE). Use it in your own projects, commercial ones included.
