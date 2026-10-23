// Everything `npm run fetch` puts in third_party/ (gitignored) and in the two generated runtime
// modules: where each input comes from, its sha256, and the sha256 every generated output must
// have. THIRD_PARTY_NOTICES.md is the human-readable version of this file.

const JSD = 'https://cdn.jsdelivr.net/npm';
const GH = 'https://raw.githubusercontent.com';
export const COMMITS = Object.freeze({
  brotli: '1260a29899b26294923075309cb31349bd05a14d',
  harfbuzz: 'cb56bae96106e1f76c98c9940bba34d720ad7298',
  sourceSerif: '2823e993c53fca27c5c8749f529b56a5a7c77b6b',
  inter: 'e3a3d4c57d5ecc01453a575621882a384c1995a3', // rsms/inter v4.1
  woff2Tests: 'dd31222b7fde98552efa3b2d56fb3f4bd2554e4a',
});
export const UNICODE_VERSION = '15.1.0';

/**
 * Downloads: [path under third_party/, sha256, url | { zip, member, zipSha256 }, ...more sources].
 * Sources are tried in order; whatever arrives must have the sha256.
 * @type {ReadonlyArray<{ path: string, sha256: string, sources: ReadonlyArray<string | { zip: string, member: string, zipSha256: string }>, runtime?: boolean }>}
 */
export const DOWNLOADS = Object.freeze([
  // ---- fonts (SIL OFL 1.1, GUST Font License)
  { path: 'fonts/inter-latin-400.woff2', sha256: '8909904ab6c872eb994093482a88a28eca2cd95912d7b6fecd72103b0dc07edc', sources: [`${JSD}/@fontsource/inter@5.3.0/files/inter-latin-400-normal.woff2`] },
  { path: 'fonts/source-serif-4-regular.otf.woff2', sha256: '42aa010dbb82d90764a28f6cc7d809a9395999b7390eb3b212028c6975e97402', sources: [`${GH}/adobe-fonts/source-serif/${COMMITS.sourceSerif}/WOFF2/OTF/SourceSerif4-Regular.otf.woff2`] },
  { path: 'fonts/jetbrains-mono-latin-400.woff2', sha256: '7c53386f55c866c1b4c9309c4bcf74eda10896aab3a1780b0af5cc4976e27a27', sources: [`${JSD}/@fontsource/jetbrains-mono@5.1.0/files/jetbrains-mono-latin-400-normal.woff2`] },
  {
    path: 'fonts/latinmodern-math.otf', sha256: '6075562b771f8b82f0c179e363389684f2dd09de30038269e2628e504bd7be0f', sources: [
      { zip: 'https://www.gust.org.pl/projects/e-foundry/lm-math/download/latinmodern-math-1959.zip', member: 'latinmodern-math-1959/otf/latinmodern-math.otf', zipSha256: 'aaaa060b4ffc091461e875efb9498b9abfa7c7a48f38eb33882868839903a4f8' },
      'https://mirrors.ctan.org/fonts/lm-math/opentype/latinmodern-math.otf', // CTAN carries the identical file (a redirector, so second)
    ],
  },
  // ---- licence texts, kept with the files they cover
  { path: 'licenses/inter-OFL.txt', sha256: '262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a', sources: [`${GH}/rsms/inter/${COMMITS.inter}/LICENSE.txt`] },
  { path: 'licenses/source-serif-4-OFL.md', sha256: '75784a295293a8992f5a8d99210566e0064a012e6dab6731305e3787f15896c7', sources: [`${GH}/adobe-fonts/source-serif/${COMMITS.sourceSerif}/LICENSE.md`] },
  { path: 'licenses/jetbrains-mono-OFL.txt', sha256: 'bb1c26eb6fe1839e3759548777c8a35b9495ce4878a4b833b1b63d43ff313a4b', sources: [`${JSD}/@fontsource/jetbrains-mono@5.1.0/LICENSE`] },
  {
    path: 'licenses/latinmodern-math-GUST-FONT-LICENSE.txt', sha256: '2bd69affc3da00715116f713f57eab9707e96daf3562ad0215987b15b9c16f73', sources: [
      { zip: 'https://www.gust.org.pl/projects/e-foundry/lm-math/download/latinmodern-math-1959.zip', member: 'latinmodern-math-1959/doc/GUST-FONT-LICENSE.txt', zipSha256: 'aaaa060b4ffc091461e875efb9498b9abfa7c7a48f38eb33882868839903a4f8' },
    ],
  },
  { path: 'licenses/brotli-LICENSE', sha256: '3d180008e36922a4e8daec11c34c7af264fed5962d07924aea928c38e8663c94', sources: [`${GH}/google/brotli/${COMMITS.brotli}/LICENSE`], runtime: true },
  { path: 'licenses/harfbuzz-COPYING', sha256: 'ba8f810f2455c2f08e2d56bb49b72f37fcf68f1f4fade38977cfd7372050ad64', sources: [`${GH}/harfbuzz/harfbuzz/${COMMITS.harfbuzz}/COPYING`], runtime: true },
  { path: 'licenses/unicode-license.txt', sha256: 'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96', sources: ['https://www.unicode.org/license.txt'], runtime: true },
  // ---- sources of the generated runtime modules
  ...['transform.c:47f229a79c3542ea57ec07145d7eaf77300a02816d95695332f9911ea19d6ab3', 'transform.h:b79dd99d1dcc618c1a4284b74dd04adda099fc3f65f906924991a736e09c125c',
    'context.c:c9aa1acb35af38c90c4a38ba168885b649838236b2d57adb5e76d687bdbe252e', 'dictionary.c:0890056e4ae595efab6bbf3bf1fd244332e2cfad3adcb9f5793ee29a8f3a18c5',
    'dictionary.bin:20e42eb1b511c21806d4d227d07e5dd06877d8ce7b3a817f378f313653f35c70']
    .map((x) => x.split(':')).map(([f, h]) => ({ path: `src/brotli/${f}`, sha256: h, sources: [`${GH}/google/brotli/${COMMITS.brotli}/c/common/${f}`], runtime: true })),
  { path: 'src/harfbuzz/hb-unicode.cc', sha256: '2c4825a02154815244c971f23078066e8322c4a3d662936b368c7135ac624b94', sources: [`${GH}/harfbuzz/harfbuzz/${COMMITS.harfbuzz}/src/hb-unicode.cc`], runtime: true },
  { path: 'src/harfbuzz/hb-unicode.hh', sha256: '8c15f338fe6e3cb11315d2cf9368abac64525c6d84f391353f78e9d4518655a4', sources: [`${GH}/harfbuzz/harfbuzz/${COMMITS.harfbuzz}/src/hb-unicode.hh`], runtime: true },
  { path: 'src/unicode/UnicodeData.txt', sha256: '2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86', sources: [`https://www.unicode.org/Public/${UNICODE_VERSION}/ucd/UnicodeData.txt`], runtime: true },
  // ---- the W3C WOFF 2.0 test generators (their outputs are built below)
  ...[
    'README.md:05df16455e96baed1ec3addc0679d6d967569418d41ed67afbb60d8f6678ff45',
    'generators/DecoderTestCaseGenerator.py:7dd6bdeb275e7cf6f1270c1b0b3f84219c733d4d789f7d6818191cef2592ad71',
    'generators/UserAgentTestCaseGenerator.py:d6a31db942d18a12fdd6a0b2285a1a0361c9cc697f28d26a93315ec44438ec03',
    'generators/testCaseGeneratorLib/__init__.py:fbd27ddc8badf2fb84507e12f31d20db3dd83fb1c09bde42536386c792551f89',
    'generators/testCaseGeneratorLib/defaultData.py:9a67b2e206363538c8a582f55e5eedd5045e5495f1df937fef76897ffbb6edcf',
    'generators/testCaseGeneratorLib/html.py:3c84939b33f7b57c258a3637dab96651c54a682d0f6ffd59a6e1791eb8591085',
    'generators/testCaseGeneratorLib/paths.py:fde43eebd1c20416c59f9b877bd12eea86b54141e1c800c67626adf6549a6b81',
    'generators/testCaseGeneratorLib/sfnt.py:466cae0f891c17efd8b2af58e1ce92e257e02d035b9fe069734a220577e42dc2',
    'generators/testCaseGeneratorLib/sharedCases.py:44bc071b8a4895a16133a6f6c7ad306f1e324710ad2262cfe5ecc18933a177c9',
    'generators/testCaseGeneratorLib/utilities.py:ee01b5bf76c8d9c9c7c5a3d5159f6e99e6bcc5379d4e1bf8a0c43a8c60df8d2f',
    'generators/testCaseGeneratorLib/woff.py:7837367c4dcf424fa91635c841f4eca6738c8066ab8ceaba9b1e7cf476964bbd',
    'generators/resources/index.css:09f7e316b1f4e68df104bd54c6897c751b4c56f7d3391c0a4e096292fc96447d',
    'generators/resources/notes.txt:4fede131aa1d5109a9796a7368684ae0ac222bff13a7c6ed2f3b8232a3122d49',
    'generators/resources/test-fonts.css:013c35b607b809beb3884fbc3b479c1abf219def93681e871dee94c834c8708b',
    'generators/resources/SFNT-CFF-Fallback.otf:3f65dc109a5f0ab5a6d1b8ae419c025ae3bda88b4942e71b6e5151087d48e3d1',
    'generators/resources/SFNT-CFF-Reference.otf:5673677e8028c3be7b5459ef5d911d5da5903f9f5d8de447c16c8cfabaa372dc',
    'generators/resources/SFNT-CFF.otf:56d1f6d122424879f1386c779bf6ff13ebcbafd575a318c285e9fdbe44883f3d',
    'generators/resources/SFNT-TTF-Composite.ttf:23563441682dcf9887daa8acd5a094934329cfeebbb5eb0544b404e6a5b1d6e1',
    'generators/resources/SFNT-TTF-Fallback.ttf:c06d6886640d6af32995b3e31eedae98c1a04ef244e8e5751fe282aa453b8ba8',
    'generators/resources/SFNT-TTF-Reference.ttf:81147c9a2419338631e311fbc9ba524ba4828b33d2c6e5fd4e7703876ebbfefb',
    'generators/resources/SFNT-TTF.ttf:3eb550bb7b834f32ed9e10a7b38a7677462e03ae8aec80fe1d3e78f7490c58ab',
  ].map((x) => x.split(':')).map(([f, h]) => ({ path: `src/woff2-tests/${f}`, sha256: h, sources: [`${GH}/w3c/woff2-tests/${COMMITS.woff2Tests}/${f}`] })),
]);

/** Generated runtime modules (repo paths, gitignored): imported by the library and the Worker. */
export const RUNTIME = Object.freeze([
  { path: 'woff2/src/brotli-data.js', sha256: 'cde597e1be3d5d8dd0f40441009a99258b0d5fabd12e074221953489dbec2d23' },
  { path: 'shape/src/ccc-data.js', sha256: '0ee4b44ecba4d4e93c0d8135597bfe8ec14e3f8bf0a24e6a24551671c9bca356' },
]);

/**
 * Built with the pinned Python tools (scripts/fetch.js `python` step), under third_party/.
 * Each sha256 is that of the file this repo used to commit, so a rebuild is checked bit for bit.
 */
export const PYTHON_PACKAGES = Object.freeze(['fonttools==4.66.1', 'brotli==1.2.1', 'uharfbuzz==0.56.3', 'freetype-py==2.5.1']);
export const BUILT = Object.freeze([
  // fontTools 4.66.1 re-containers (ref/make_derived_fonts.py)
  { path: 'fonts/inter-latin-400.woff', sha256: '3f2ddb7b5d9f68efc2e7ebc9165d0baff7e42eb0394562ededbdd9b4915427bd', by: 'derived' },
  { path: 'fonts/source-serif-4-regular.otf', sha256: '2ed0b2cf1e10c0385c33a08b51a0c96fe802e6f1fe85b6635f5df9d13ee4e8cc', by: 'derived' },
  // W3C WOFF 2.0 suite cases glyph once failed (w3c/woff2-tests generators, fontTools + Brotli)
  ...[
    'blocks-extraneous-data-003.woff2:96e0cc09a77aa2f7c812ddec1bb198a7aa84a8abd9ce82466d55e0d1a7d7e316:UserAgent/WOFF2/support',
    'blocks-extraneous-data-007.woff2:bbe93103e26cce27ca35aadff8b0e8a750b894081deb5612c4731798dd9ff429:UserAgent/WOFF2/support',
    'blocks-overlap-003.woff2:e9e92323910c87338d11682284a9de0379bb5e7abe1d81d8422bc8185657cec2:UserAgent/WOFF2/support',
    'datatypes-alt-255uint16-001.woff2:2fef95c1139fb246460d1c2489684038884bd468c53a22f7bc863c1f066137cd:UserAgent/WOFF2/support',
    'roundtrip-collection-order-001.woff2:25b049b4d264941f8c20413d3c12e3a7e2c6f3571747ece856ecf47fbc9ce31d:Decoder/Tests/xhtml1',
    'roundtrip-hmtx-lsb-001.ttf:dce1cef405e00a13be7444b9cfa1742663590fb3e21025ff7581c124318a635a:Decoder/Tests/xhtml1',
    'roundtrip-hmtx-lsb-001.woff2:9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea:Decoder/Tests/xhtml1',
    'tabledata-bad-origlength-loca-001.woff2:5a6ec32914e9fca1b0bcf91d0f4fbc6301e82f3f87f1d0274811e9aebdc16d29:UserAgent/WOFF2/support',
    'tabledata-transform-hmtx-001.woff2:9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea:UserAgent/WOFF2/support',
    'valid-005.woff2:9c13f9e5611a05858f5340f38139b97d5b856f98a34e660548efe9a87ac806ea:UserAgent/WOFF2/support',
  ].map((x) => x.split(':')).map(([f, h, from]) => ({ path: `w3c/${f}`, sha256: h, by: 'w3c', from: `src/woff2-tests/${from}/${f}` })),
  // Oracle outputs: fontTools, HarfBuzz (uharfbuzz) and FreeType (freetype-py) over the fonts
  ...[
    'fonttools-inter.json:3154dedaa1fdd3743bf01a9e1acb30f72aacd325c97f097a7698b17851a35b75',
    'fonttools-sourceSerif.json:48b93f6035e124b3e2703f461380513811d6d25f3cdf1cac1fec14b9b4890520',
    'hb-shape.json:6d1a5f985b27b8e08013d8e01f9dd1bae3216227a3f525582d79ab284d375f45',
    'ft-inter-AVAToWaYo-40.pgm:306c4b90d5440383980782f5ef87be3a7d97097a0607a4b250085d6c29a056b4',
    'ft-inter-Cloudflare-24.pgm:500972e63d8201a9a06991aa42d99144a0650ae202aeacf1aa462dfd3086cff2',
    'ft-inter-Cloudflare-96.pgm:9c8ca10e9c29d5f4b8f632a0dff64efceebefc84852c421d358fd4a7e1ea7ec1',
    'ft-inter-Workers-13.pgm:3705cfa919b228c95afb9b266dd762d9131cd4b3c32854edff1af8a256fe1651',
    'ft-sourceSerif-AVAToWaYo-40.pgm:1b3874d0d223406d075c5ecacfd17b601aa830219346a00fa63e1258f592fabf',
    'ft-sourceSerif-Cloudflare-24.pgm:82575c8afa51fe630b3c3d790523424ab0307f43517f891f8db418ed1d6096b6',
    'ft-sourceSerif-Cloudflare-96.pgm:3e51950a3394d7121a69a544fab874ed4d582aa3f452bc69ee930cdf01eb5f48',
    'ft-sourceSerif-Workers-13.pgm:47748db0aa738bde8884ec8be76c34172513aef132a1a69905b1973bf086b8f9',
  ].map((x) => x.split(':')).map(([f, h]) => ({ path: `ref/${f}`, sha256: h, by: 'refs' })),
  // Identical to the formerly committed ref/fonttools-lmmath.json (dbb910aa...) except its "font" path.
  { path: 'ref/fonttools-lmmath.json', sha256: '947db12a8ac9a17e702c479912b098082318e63e864be0b70834196ef00becaf', by: 'mathref' },
]);
