#!/usr/bin/env bash
# Stages the whole webbox site for the Cloudflare Worker (static assets) into _cf_site/ (repo root). Needs csharp/dist (and csharp/dist-mt for ?threads=1) from dotnet publish.
set -euo pipefail
cd "$(dirname "$0")/../.."
rm -rf _cf_site && mkdir _cf_site
rsync -a --exclude '.git' --exclude '.github' --exclude '_site' --exclude '_cf_site' --exclude '_hexad' --exclude '/csharp' --exclude 'README.md' --exclude 'wrangler.jsonc' ./ _cf_site/
if [ -d _hexad/web/remote ]; then mkdir -p _cf_site/hexad && rsync -a --exclude 'README.md' _hexad/web/remote/ _cf_site/hexad/; fi
mt=(); [ -d csharp/dist-mt/wwwroot ] && mt=(--mt=csharp/dist-mt/wwwroot)
node csharp/tools/stage.mjs csharp/dist/wwwroot _cf_site/csharp --target=cloudflare "${mt[@]}"
