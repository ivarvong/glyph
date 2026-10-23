# Third-party notices

glyph's code is MIT (`LICENSE`). **This repository contains no third-party fonts or data.**
`npm run fetch` (`scripts/fetch.js`, inputs and hashes in `scripts/manifest.js`) downloads the
files below from pinned URLs into `third_party/` (gitignored), rejects any whose sha256 differs,
and builds the derived files, each of which must also match its sha256. Each part keeps its own
licence; the licence texts are fetched alongside, into `third_party/licenses/`.

| part | licence | licence text |
|---|---|---|
| Inter 4.001 (`@fontsource/inter@5.3.0`) | SIL Open Font License 1.1 | `third_party/licenses/inter-OFL.txt` (rsms/inter v4.1) |
| Source Serif 4 4.005 (adobe-fonts/source-serif @ 2823e99) | SIL OFL 1.1, Reserved Font Name "Source" | `third_party/licenses/source-serif-4-OFL.md` |
| JetBrains Mono 2.211 (`@fontsource/jetbrains-mono@5.1.0`) | SIL OFL 1.1 | `third_party/licenses/jetbrains-mono-OFL.txt` |
| Latin Modern Math 1.959 (GUST e-foundry) | GUST Font License (an instance of the LPPL 1.3c) | `third_party/licenses/latinmodern-math-GUST-FONT-LICENSE.txt` |
| Brotli static dictionary, transforms, context tables (google/brotli @ 1260a29) | MIT | `third_party/licenses/brotli-LICENSE` |
| HarfBuzz modified combining classes (harfbuzz @ cb56bae) | "Old MIT" | `third_party/licenses/harfbuzz-COPYING` |
| Unicode Character Database 15.1.0 (`UnicodeData.txt`) | Unicode License v3 | `third_party/licenses/unicode-license.txt` |
| W3C WOFF 2.0 test generators (w3c/woff2-tests @ dd31222) | W3C 3-clause BSD License (W3C test suites); the repo carries no licence file | https://www.w3.org/copyright/3-clause-bsd-license-2008/ |

Two generated files are **runtime** modules, imported by the library and the Worker:
`woff2/src/brotli-data.js` (the Brotli dictionary and tables, MIT) and `shape/src/ccc-data.js`
(HarfBuzz's combining classes over Unicode data). They are generated, not committed (`node
scripts/fetch.js --runtime`, Node only); the Worker build and `npm run demo` generate them first,
so the deployed bundle carries them as Brotli (MIT) and HarfBuzz/Unicode-derived code.

The deployed playground serves no fonts: the page fetches the three WOFF2 files above from the
same jsDelivr URLs (Source Serif via `cdn.jsdelivr.net/gh/adobe-fonts/source-serif@2823e99…`),
with subresource integrity.

## Downloaded

| file (under third_party/) | licence | source | sha256 |
|---|---|---|---|
| `fonts/inter-latin-400.woff2` | SIL OFL 1.1 | https://cdn.jsdelivr.net/npm/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2 | `8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc` |
| `fonts/source-serif-4-regular.otf.woff2` | SIL OFL 1.1 (RFN "Source") | https://raw.githubusercontent.com/adobe-fonts/source-serif/2823e993c53fca27c5c8749f529b56a5a7c77b6b/WOFF2/OTF/SourceSerif4-Regular.otf.woff2 | `42aa010dbb82d90764a28f6cc7d809a9395999b7390eb3b212028c6975e97402` |
| `fonts/jetbrains-mono-latin-400.woff2` | SIL OFL 1.1 | https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2 | `7c53386f55c866c1b4c9309c4bcf74eda10896aab3a1780b0af5cc4976e27a27` |
| `fonts/latinmodern-math.otf` | GUST Font License | https://www.gust.org.pl/projects/e-foundry/lm-math/download/latinmodern-math-1959.zip → latinmodern-math-1959/otf/latinmodern-math.otf (zip sha256 aaaa060b4ffc091461e875efb9498b9abfa7c7a48f38eb33882868839903a4f8); or https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf | `6075562b771f8b82f0c179e363389684f2dd09de30038269e2628e504bd7be0f` |
| `licenses/inter-OFL.txt` | (licence text) | https://raw.githubusercontent.com/rsms/inter/e3a3d4c57d5ecc01453a575621882a384c1995a3/LICENSE.txt | `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a` |
| `licenses/source-serif-4-OFL.md` | (licence text) | https://raw.githubusercontent.com/adobe-fonts/source-serif/2823e993c53fca27c5c8749f529b56a5a7c77b6b/LICENSE.md | `75784a295293a8992f5a8d99210566e0064a012e6dab6731305e3787f15896c7` |
| `licenses/jetbrains-mono-OFL.txt` | (licence text) | https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5.1.0/LICENSE | `bb1c26eb6fe1839e3759548777c8a35b9495ce4878a4b833b1b63d43ff313a4b` |
| `licenses/latinmodern-math-GUST-FONT-LICENSE.txt` | (licence text) | https://www.gust.org.pl/projects/e-foundry/lm-math/download/latinmodern-math-1959.zip → latinmodern-math-1959/doc/GUST-FONT-LICENSE.txt (zip sha256 aaaa060b4ffc091461e875efb9498b9abfa7c7a48f38eb33882868839903a4f8) | `2bd69affc3da00715116f713f57eab9707e96daf3562ad0215987b15b9c16f73` |
| `licenses/brotli-LICENSE` | (licence text) | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/LICENSE | `3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94` |
| `licenses/harfbuzz-COPYING` | (licence text) | https://raw.githubusercontent.com/harfbuzz/harfbuzz/cb56bae96106e1f76c98c9940bba34d720ad7298/COPYING | `ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64` |
| `licenses/unicode-license.txt` | (licence text) | https://www.unicode.org/license.txt | `e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96` |
| `src/brotli/transform.c` | MIT | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/c/common/transform.c | `47f229a79c3542ea57ec07145d7eaf77300a02816d95695332f9911ea19d6ab3` |
| `src/brotli/transform.h` | MIT | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/c/common/transform.h | `b79dd99d1dcc618c1a4284b74dd04adda099fc3f65f906924991a736e09c125c` |
| `src/brotli/context.c` | MIT | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/c/common/context.c | `c9aa1acb35af38c90c4a38ba168885b649838236b2d57adb5e76d687bdbe252e` |
| `src/brotli/dictionary.c` | MIT | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/c/common/dictionary.c | `0890056e4ae595efab6bbf3bf1fd244332e2cfad3adcb9f5793ee29a8f3a18c5` |
| `src/brotli/dictionary.bin` | MIT | https://raw.githubusercontent.com/google/brotli/1260a29899b26294923075309cb31349bd05a14d/c/common/dictionary.bin | `20e42eb1b511c21806d4d227d07e5dd06877d8ce7b3a817f378f313653f35c70` |
| `src/harfbuzz/hb-unicode.cc` | Old MIT | https://raw.githubusercontent.com/harfbuzz/harfbuzz/cb56bae96106e1f76c98c9940bba34d720ad7298/src/hb-unicode.cc | `2c4825a02154815244c971f23078066e8322c4a3d662936b368c7135ac624b94` |
| `src/harfbuzz/hb-unicode.hh` | Old MIT | https://raw.githubusercontent.com/harfbuzz/harfbuzz/cb56bae96106e1f76c98c9940bba34d720ad7298/src/hb-unicode.hh | `8c15f338fe6e3cb11315d2cf9368abac64525c6d84f391353f78e9d4518655a4` |
| `src/unicode/UnicodeData.txt` | Unicode License v3 | https://www.unicode.org/Public/15.1.0/ucd/UnicodeData.txt | `2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86` |
| `src/woff2-tests/README.md` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/README.md | `05df16455e96baed1ec3addc0679d6d967569418d41ed67afbb60d8f6678ff45` |
| `src/woff2-tests/generators/DecoderTestCaseGenerator.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/DecoderTestCaseGenerator.py | `7dd6bdeb275e7cf6f1270c1b0b3f84219c733d4d789f7d6818191cef2592ad71` |
| `src/woff2-tests/generators/UserAgentTestCaseGenerator.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/UserAgentTestCaseGenerator.py | `d6a31db942d18a12fdd6a0b2285a1a0361c9cc697f28d26a93315ec44438ec03` |
| `src/woff2-tests/generators/testCaseGeneratorLib/__init__.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/__init__.py | `fbd27ddc8badf2fb84507e12f31d20db3dd83fb1c09bde42536386c792551f89` |
| `src/woff2-tests/generators/testCaseGeneratorLib/defaultData.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/defaultData.py | `9a67b2e206363538c8a582f55e5eedd5045e5495f1df937fef76897ffbb6edcf` |
| `src/woff2-tests/generators/testCaseGeneratorLib/html.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/html.py | `3c84939b33f7b57c258a3637dab96651c54a682d0f6ffd59a6e1791eb8591085` |
| `src/woff2-tests/generators/testCaseGeneratorLib/paths.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/paths.py | `fde43eebd1c20416c59f9b877bd12eea86b54141e1c800c67626adf6549a6b81` |
| `src/woff2-tests/generators/testCaseGeneratorLib/sfnt.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/sfnt.py | `466cae0f891c17efd8b2af58e1ce92e257e02d035b9fe069734a220577e42dc2` |
| `src/woff2-tests/generators/testCaseGeneratorLib/sharedCases.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/sharedCases.py | `44bc071b8a4895a16133a6f6c7ad306f1e324710ad2262cfe5ecc18933a177c9` |
| `src/woff2-tests/generators/testCaseGeneratorLib/utilities.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/utilities.py | `ee01b5bf76c8d9c9c7c5a3d5159f6e99e6bcc5379d4e1bf8a0c43a8c60df8d2f` |
| `src/woff2-tests/generators/testCaseGeneratorLib/woff.py` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/testCaseGeneratorLib/woff.py | `7837367c4dcf424fa91635c841f4eca6738c8066ab8ceaba9b1e7cf476964bbd` |
| `src/woff2-tests/generators/resources/index.css` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/index.css | `09f7e316b1f4e68df104bd54c6897c751b4c56f7d3391c0a4e096292fc96447d` |
| `src/woff2-tests/generators/resources/notes.txt` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/notes.txt | `4fede131aa1d5109a9796a7368684ae0ac222bff13a7c6ed2f3b8232a3122d49` |
| `src/woff2-tests/generators/resources/test-fonts.css` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/test-fonts.css | `013c35b607b809beb3884fbc3b479c1abf219def93681e871dee94c834c8708b` |
| `src/woff2-tests/generators/resources/SFNT-CFF-Fallback.otf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-CFF-Fallback.otf | `3f65dc109a5f0ab5a6d1b8ae419c025ae3bda88b4942e71b6e5151087d48e3d1` |
| `src/woff2-tests/generators/resources/SFNT-CFF-Reference.otf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-CFF-Reference.otf | `5673677e8028c3be7b5459ef5d911d5da5903f9f5d8de447c16c8cfabaa372dc` |
| `src/woff2-tests/generators/resources/SFNT-CFF.otf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-CFF.otf | `56d1f6d122424879f1386c779bf6ff13ebcbafd575a318c285e9fdbe44883f3d` |
| `src/woff2-tests/generators/resources/SFNT-TTF-Composite.ttf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-TTF-Composite.ttf | `23563441682dcf9887daa8acd5a094934329cfeebbb5eb0544b404e6a5b1d6e1` |
| `src/woff2-tests/generators/resources/SFNT-TTF-Fallback.ttf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-TTF-Fallback.ttf | `c06d6886640d6af32995b3e31eedae98c1a04ef244e8e5751fe282aa453b8ba8` |
| `src/woff2-tests/generators/resources/SFNT-TTF-Reference.ttf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-TTF-Reference.ttf | `81147c9a2419338631e311fbc9ba524ba4828b33d2c6e5fd4e7703876ebbfefb` |
| `src/woff2-tests/generators/resources/SFNT-TTF.ttf` | W3C 3-clause BSD (test suite) | https://raw.githubusercontent.com/w3c/woff2-tests/dd31222b7fde98552efa3b2d56fb3f4bd2554e4a/generators/resources/SFNT-TTF.ttf | `3eb550bb7b834f32ed9e10a7b38a7677462e03ae8aec80fe1d3e78f7490c58ab` |


## Built from the downloads

Python tools for the step that builds them (a venv at `third_party/venv`):
`fonttools==4.66.1 brotli==1.2.1 uharfbuzz==0.56.3 freetype-py==2.5.1` (FreeType 2.13.2).
Each sha256 is that of the file this repository used to commit (`ref/fonttools-lmmath.json`
differs only in its `"font"` path), so the oracle references, the re-containered fonts and the
W3C cases are the exact bytes the tests were written against.

| file | built from | licence | sha256 |
|---|---|---|---|
| `third_party/fonts/inter-latin-400.woff` | fontTools from the WOFF2 above (ref/make_derived_fonts.py) | derived from Inter (OFL) | `3f2ddb7b5d9f68efc2e7ebc9165d0baff7e42eb0394562ededbdd9b4915427bd` |
| `third_party/fonts/source-serif-4-regular.otf` | fontTools from the WOFF2 above (ref/make_derived_fonts.py) | derived from Source Serif 4 (OFL) | `2ed0b2cf1e10c0385c33a08b51a0c96fe802e6f1fe85b6635f5df9d13ee4e8cc` |
| `third_party/w3c/blocks-extraneous-data-003.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `96e0cc09a77aa2f7c812ddec1bb198a7aa84a8abd9ce82466d55e0d1a7d7e316` |
| `third_party/w3c/blocks-extraneous-data-007.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `bbe93103e26cce27ca35aadff8b0e8a750b894081deb5612c4731798dd9ff429` |
| `third_party/w3c/blocks-overlap-003.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `e9e92323910c87338d11682284a9de0379bb5e7abe1d81d8422bc8185657cec2` |
| `third_party/w3c/datatypes-alt-255uint16-001.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `2fef95c1139fb246460d1c2489684038884bd468c53a22f7bc863c1f066137cd` |
| `third_party/w3c/roundtrip-collection-order-001.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `25b049b4d264941f8c20413d3c12e3a7e2c6f3571747ece856ecf47fbc9ce31d` |
| `third_party/w3c/roundtrip-hmtx-lsb-001.ttf` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `dce1cef405e00a13be7444b9cfa1742663590fb3e21025ff7581c124318a635a` |
| `third_party/w3c/roundtrip-hmtx-lsb-001.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea` |
| `third_party/w3c/tabledata-bad-origlength-loca-001.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `5a6ec32914e9fca1b0bcf91d0f4fbc6301e82f3f87f1d0274811e9aebdc16d29` |
| `third_party/w3c/tabledata-transform-hmtx-001.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea` |
| `third_party/w3c/valid-005.woff2` | w3c/woff2-tests generators (Decoder, UserAgent) | W3C test suite | `9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea` |
| `third_party/ref/fonttools-inter.json` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter (OFL) | `3154dedaa1fdd3743bf01a9e1acb30f72aacd325c97f097a7698b17851a35b75` |
| `third_party/ref/fonttools-sourceSerif.json` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Source Serif 4 (OFL) | `48b93f6035e124b3e2703f461380513811d6d25f3cdf1cac1fec14b9b4890520` |
| `third_party/ref/hb-shape.json` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter and Source Serif 4 (OFL) | `6d1a5f985b27b8e08013d8e01f9dd1bae3216227a3f525582d79ab284d375f45` |
| `third_party/ref/ft-inter-AVAToWaYo-40.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter (OFL) | `306c4b90d5440383980782f5ef87be3a7d97097a0607a4b250085d6c29a056b4` |
| `third_party/ref/ft-inter-Cloudflare-24.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter (OFL) | `500972e63d8201a9a06991aa42d99144a0650ae202aeacf1aa462dfd3086cff2` |
| `third_party/ref/ft-inter-Cloudflare-96.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter (OFL) | `9c8ca10e9c29d5f4b8f632a0dff64efceebefc84852c421d358fd4a7e1ea7ec1` |
| `third_party/ref/ft-inter-Workers-13.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Inter (OFL) | `3705cfa919b228c95afb9b266dd762d9131cd4b3c32854edff1af8a256fe1651` |
| `third_party/ref/ft-sourceSerif-AVAToWaYo-40.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Source Serif 4 (OFL) | `1b3874d0d223406d075c5ecacfd17b601aa830219346a00fa63e1258f592fabf` |
| `third_party/ref/ft-sourceSerif-Cloudflare-24.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Source Serif 4 (OFL) | `82575c8afa51fe630b3c3d790523424ab0307f43517f891f8db418ed1d6096b6` |
| `third_party/ref/ft-sourceSerif-Cloudflare-96.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Source Serif 4 (OFL) | `3e51950a3394d7121a69a544fab874ed4d582aa3f452bc69ee930cdf01eb5f48` |
| `third_party/ref/ft-sourceSerif-Workers-13.pgm` | ref/make_refs.py: fontTools, uharfbuzz, freetype-py over Inter and Source Serif 4 | derived from Source Serif 4 (OFL) | `47748db0aa738bde8884ec8be76c34172513aef132a1a69905b1973bf086b8f9` |
| `third_party/ref/fonttools-lmmath.json` | ref/make_math_ref.py: fontTools over Latin Modern Math | derived from Latin Modern Math (GUST) | `947db12a8ac9a17e702c479912b098082318e63e864be0b70834196ef00becaf` |
| `third_party/fuzz/hang-4be24461356f.bin` | fuzz/regressions/hang-4be24461356f.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `4be24461356f537efe885219c0b9030d71d17128bf9a10952ff82d3e675b7f72` |
| `third_party/fuzz/slow-langsys-fanout-7066c49e74b9.bin` | fuzz/regressions/slow-langsys-fanout-7066c49e74b9.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `7066c49e74b9f05a50c84c2272d70acefe166c25d7437b06f9798f5a012e1987` |
| `third_party/fuzz/slow-tiny-upem-35d6d4188c01.bin` | fuzz/regressions/slow-tiny-upem-35d6d4188c01.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `35d6d4188c0108b7c23d3eb945f3ee4ae78e0bdb037d0667f4ae070851eb9b60` |
| `third_party/fuzz/throw-37e6b898de96.bin` | fuzz/regressions/throw-37e6b898de96.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `37e6b898de969a7faa95993f3a3d5756707fb520d236ce49582afcfccee9b10f` |
| `third_party/fuzz/throw-71bb4ebb7d91.bin` | fuzz/regressions/throw-71bb4ebb7d91.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `71bb4ebb7d91864d92039a6cb04bb84764c723cfb08ffb01e2d1285cf7fc5cbd` |
| `third_party/fuzz/throw-bb93cc3f510a.bin` | fuzz/regressions/throw-bb93cc3f510a.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `bb93cc3f510a41dbd702301424575a09ad25a21e0cb0be9404ccaba647778729` |
| `third_party/fuzz/throw-c15d4a4febae.bin` | fuzz/regressions/throw-c15d4a4febae.recipe.json (fuzz/recipe.js) | derived from the fonts above (OFL) | `c15d4a4febae49b0e963a55c126cee460c16a3802ce1e51325209dd536e96058` |
| `woff2/src/brotli-data.js` (repo path, gitignored) | tools/gen_brotli_data.js over src/brotli/* | MIT (google/brotli) | `cde597e1be3d5d8dd0f40441009a99258b0d5fabd12e074221953489dbec2d23` |
| `shape/src/ccc-data.js` (repo path, gitignored) | tools/gen_ccc.js over src/harfbuzz/* and src/unicode/UnicodeData.txt | Old MIT (HarfBuzz) + Unicode License v3 | `0ee4b44ecba4d4e93c0d8135597bfe8ec14e3f8bf0a24e6a24551671c9bca356` |
