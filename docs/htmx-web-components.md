# Web Components + htmx

Research verdict (2026-10-04, sources at the bottom): **they do not conflict — this is an
officially supported combination.** Adopt selectively, not as a framework switch.

## TL;DR for this repo

- Our zero-build rule survives: web components are native browser tech, no bundler.
- Use **light-DOM "HTML web components"** (no Shadow DOM).
- Good candidates here: sidebar resizer, context gauge, collapsible tool-results —
  i.e. widgets with internal state, reused in more than one place.
- Not worth it for one-off glue: keep using `hx-on` / a few lines of inline JS.

## Why they compose

htmx swaps HTML strings into the DOM; custom elements react to insertion via
`connectedCallback`. Orthogonal mechanisms. htmx's own essay recommends web components
as "putting behavior back into HTML".

## Gotchas (all bite in practice)

1. **`connectedCallback` fires on every htmx swap** that inserts the element. Re-init is
   the feature; side effects (requests, subscriptions) must be cleaned up in
   `disconnectedCallback`, or you get duplicates/leaks.
2. **Content added by your own JS is invisible to htmx** until you call
   `htmx.process(element)`. htmx only processes its own swaps.
3. **Shadow DOM hides content from htmx** — requires manual `htmx.process(shadowRoot)`
   inside `connectedCallback`, and breaks global styles. The maintainers themselves call
   Shadow DOM support "occasionally frustrating" (htmx PRs #2846, #2866). Stay in light DOM.
4. Custom elements must be defined before insertion, or the browser treats them as
   plain unknown elements (upgrade later works, but initial paint may flash).

## Canonical demo (light DOM)

```js
class ResizablePanel extends HTMLElement {
	connectedCallback() {
		this.handle = this.querySelector("[data-handle]");
		this.onDown = (e) => { /* attach move/up on document */ };
		this.handle.addEventListener("mousedown", this.onDown);
	}
	disconnectedCallback() {
		this.handle?.removeEventListener("mousedown", this.onDown); // cleanup on every swap!
	}
}
customElements.define("resizable-panel", ResizablePanel);
```

```html
<resizable-panel>
	<aside>…</aside>
	<div data-handle></div>
	<main>…anything with hx-* attributes, styles apply normally…</main>
</resizable-panel>
```

## Prior art

- EisenbergEffect/server-first-web-components — DSD + htmx + islands architecture
- getludic/ludic — python server rendering + htmx + web components
- phantom-ui — skeleton-loader as a web component used with htmx

## Sources

- https://htmx.org/essays/webcomponents-work-great/
- https://htmx.org/docs/#web-components-and-htmx
- https://htmx.org/examples/web-components/
- https://github.com/bigskysoftware/htmx/pull/2075 (Shadow DOM support)
- https://github.com/bigskysoftware/htmx/pull/2846, #2866 (Shadow DOM friction)
- https://meyerweb.com/eric/thoughts/2023/11/01/blinded-by-the-light-dom/
