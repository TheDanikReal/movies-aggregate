wget \
    --timeout=30 \
    --tries=1 \
    --user-agent="Mozilla/5.0 (compatible; KinoSlon/1.0)" \
    --output-document="./tools/page.html" \
    "http://kinoteatr.megamag.by/index.php?cPath=353299"
node --experimental-strip-types ./tools/parse.ts