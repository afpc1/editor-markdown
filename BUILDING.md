# Building ftnMDReader

Running the app needs no build step — just open `index.html` in Chrome,
Edge, or another Chromium-based browser. This file is only relevant if
you want to **edit the editor's JavaScript**.

## Source vs. bundled files

| Edit this...   | To change...                                          | Never edit this directly |
|-----------------|--------------------------------------------------------|---------------------------|
| `app.src.js`    | App logic, CodeMirror setup, keybindings, etc.          | `app.js` (generated)      |
| `style.scss`     | Colors, layout, any CSS                                | `style.css` (generated)   |

`app.js` and `style.css` are the files the browser actually loads.
They're committed to the repo so the app works immediately without a
build step — but they're generated files. If you edit `app.src.js` or
`style.scss`, you need to rebuild the corresponding output, or your
changes won't show up when you open the app.

## Why `app.src.js` is bundled at all

CodeMirror 6 (the code editor) is distributed as several npm packages
(`@codemirror/state`, `@codemirror/view`, etc.) rather than one file.
Bundling them into `app.js` ahead of time means the app has **no
runtime dependency on npm, a CDN, or an internet connection** to edit
files — everything CodeMirror needs ships locally in `app.js`.

(Preview's syntax-highlighted code blocks are a separate, smaller
dependency — highlight.js, still loaded from a CDN via a `<script>` tag
in `index.html`. That one's unaffected by any of this.)

## Rebuilding after an edit

```bash
npm install     # first time only — installs esbuild + CodeMirror
npm run build   # bundles app.src.js -> app.js
```

To rebuild the stylesheet after editing `style.scss`:

```bash
npm install -g sass    # first time only
sass style.scss style.css
```

## Regenerating the keyboard shortcuts PDF

The keyboard shortcuts reference (`keyboard-shortcuts.pdf`) is built
from a separate Python script, not part of this npm project. If you
add or change a shortcut, that script needs updating and re-running
too — ask Claude to regenerate it, or see the ReportLab-based script
used in earlier conversation turns.
