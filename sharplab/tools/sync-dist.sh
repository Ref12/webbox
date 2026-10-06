#!/bin/bash
cd "$(dirname "$0")/.."
for f in share.js syntaxpath.js jit.js main.js app.css index.html; do cp src/SharpLab.Wasm/wwwroot/$f dist/wwwroot/$f; rm -f dist/wwwroot/$f.br dist/wwwroot/$f.gz; done
