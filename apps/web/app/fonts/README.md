# Atkinson Hyperlegible Next webfont

SeniorSocial self-hosts the upright variable WOFF2 from the authoritative
`googlefonts/atkinson-hyperlegible-next` project. The single variable file is
smaller than separate Regular, SemiBold, and Bold webfonts while covering the
product's 400, 600, and 700 UI weights.

- Upstream revision: `7925f50f649b3813257faf2f4c0b381011f434f1`
- Source file: `fonts/webfonts/AtkinsonHyperlegibleNext[wght].woff2`
- Source URL: <https://github.com/googlefonts/atkinson-hyperlegible-next/blob/7925f50f649b3813257faf2f4c0b381011f434f1/fonts/webfonts/AtkinsonHyperlegibleNext%5Bwght%5D.woff2>
- Local filename: `atkinson-hyperlegible-next-variable.woff2`
- SHA-256: `abde1ad5cf78b9ac575ef90d991f2e9101eb0b3b6668bde9a00e2e1e27d99afd`
- Embedded family: `Atkinson Hyperlegible Next`
- Embedded upright weight axis: `wght` 200–800, default 400
- License: SIL Open Font License 1.1; the upstream `OFL.txt` is included beside
  the font (with one trailing space removed for repository hygiene).

## Spanish coverage evidence

The upstream variable TTF and WOFF2 are builds of the same upright variable
source. Inspecting the pinned variable TTF cmap with fontTools 4.56.0 reports
362 encoded code points and includes every Spanish character required by the
product: `U+00A1` (¡), `U+00BF` (¿), `U+00E1` (á), `U+00E9` (é), `U+00ED`
(í), `U+00F1` (ñ), `U+00F3` (ó), `U+00FA` (ú), and `U+00FC` (ü).

Reproduce the inspection from the pinned upstream checkout with:

```text
python -c "from fontTools.ttLib import TTFont; f=TTFont('fonts/variable/AtkinsonHyperlegibleNext[wght].ttf'); cps=set().union(*(set(t.cmap) for t in f['cmap'].tables if t.isUnicode())); required={0xA1,0xBF,0xE1,0xE9,0xED,0xF1,0xF3,0xFA,0xFC}; print(len(cps), sorted(required-cps))"
```

Expected output: `362 []`.
