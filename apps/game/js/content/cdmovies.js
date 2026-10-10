// The original Red Alert mission movies from the freeware Red Alert CDs
// that Electronic Arts released in 2008: movies1.mix (MAIN.MIX of the
// Allied disc) and movies2.mix (MAIN.MIX of the Soviet disc), as OpenRA's
// content installer takes them (movies-allied, movies-soviet).
//
// Everyone: drop a freeware CD image (content/install.js reads the movies
// out of it by slices). Selected accounts (the content_autoinstall flag,
// and admins): an optional one-click download through WebRA's server, which
// reads only the movie archive out of the disc image on the Internet
// Archive by HTTP range and streams it on without keeping a copy
// (apps/server/src/cdmusic.js moviesRange). The archives are hundreds of
// megabytes, so the game never holds one whole: every 8 MiB piece is
// checked against its pinned SHA-256 (MOVIE_ARCHIVES pieces) as it arrives
// and kept in the content store (store.js partials), the installer reads
// the archive piece by piece from there (archiveFile), and the pieces are
// forgotten once the movies are installed. A cut off download goes on
// where it stopped.

import { downloadPieces, SCORES_PIECE } from './cdmusic.js';
import { ALLIED_MOVIES, SOVIET_MOVIES } from './movies.js';

/**
 * The two movie archives: where the relay serves them, their size, the
 * movies in them, the SHA-256 of the whole archive (for reference) and of
 * each SCORES_PIECE piece (what the game checks). The pins were
 * measured once from the discs with range requests (docs/security.md); the
 * server pins the same sizes.
 */
export const MOVIE_ARCHIVES = Object.freeze([
  Object.freeze({
    id: 'allied',
    name: 'movies1.mix',
    url: '/api/content/ra-movies/allied',
    partial: 'ra-movies1',
    bytes: 369_362_336,
    movies: ALLIED_MOVIES,
    sha256: '62701f097a39c435a377689c86c54d1bb6cc87d28dba9537f6e80b3d0b52a501',
    pieces: Object.freeze([
      'bdfe1ce08991de4e3d6441b1ff79b3b55d9d109022817ed228396a8928f3061a',
      '060b959cf505689aeb8107cfa80e816122c0350ad09d969842ec8d4e97a82cc2',
      '3c8c041da9ebd0c026095208294547701b7ae3a31ac016f2d10129be972ccc0f',
      '39fe7b2261884ca9344f074163e9cb4183d93a8323d732e029d5338fbd04a37d',
      'b5612add5f7f55f5369c8aa92a23c3bb32d732d520163cf5f30729cbef018704',
      '5fd477c82ab0adf4dfc5199a7f55c9bbd01bd1007f452fee75481f01a3c4909b',
      '8ffc41995ce497de3a684c0672730b3d034ee0b4cc2eb0b12ac59df66833b237',
      '0e1b6a585625526bfb243ad20cf61dac1ff7a17f11314c8bd242d1512315ae00',
      '7dd7c0b9e45ca1ab781c331c95f6d6a9ae079d0dfa3a6287860431cf9bf0e286',
      'e7e1f02abdb97fd7afb457b5415b6bec894267548f13847df15fb7fe64ea963f',
      '4a2673962b035ba307559b66d20e32c1d37051923076f33e1c8d8205dc17f43f',
      '188087f24d4c26ceed9397d701330d12fb6283562326f6b0d6f0b3ec72edb23f',
      '085653fb22edae82a570600ed5640c5823fd33c2ed2183b8804c01399cc8fa01',
      'df9cba890c4d17203f625afda1f865ec820e3b6d477b3e02c04575b966785190',
      '8d54cebdd99a975b0dd14c140110554676d090c2292c02c3648297d61ce8dac9',
      '647bc45c26d79141a1f6f2d9dbe7361d32a91c96b0e6177d3805a9ba9a660efb',
      'f9c48e556944dcd397e09f78afa8af3daacee5d8c18a24e821c21cf2d16e57f1',
      '581c350005fb5d0d0df58f0442cd1ebd59eaca0b2fc6c855c49238b5f0c153c4',
      '59b85003345c4f058c1229e736e7c33f74d08cad3186482d7ff7ccefe3f590f4',
      'acfb4129889f69b41ef29c64c57a64e6e5cdf487afe5d252c151556f3c651f27',
      '85666ae2b6250af645f27d2f0342686dd7a008d6a857e391940556a3043876a9',
      '02e91b41f0835e11472c15ed8a69dc89376bdca8659c56a0eeec00d17b008b00',
      '0db98544e63f6121b4c0cf2b624dc0e26ef3ad84c5d563b58a718cc385b324fe',
      '2d7de50cdb928bc47d9e1cfff6bbb0d1bee18eeb59dde285516576032d3b5a06',
      'be62f7cff2c5758ff88386df8c34bae6cd60a28b5cdafe61cbc5d9967646d886',
      '28822e33ec9273c155b74ce36bd1090ddf29a5c55202a4f26bf5dbb8c6597ec9',
      '50ffa4c14ed7744678d99ebad927d5566f3c2a9cf6bd47718061b1bcbc83bd71',
      '616f54af8cca89d81800d14d2d9149ad7c52c63d69836c7dfb4578a9f3e0e746',
      'b48ebb95eb0b1041b94e09c1e6e2824ca19bfea201875e98634c85016fcbdf6f',
      'b11b4d079979fdecc72a5702f4f600f61ea7a18838982f401e32c7591e3dda30',
      '2733dd9a80a69c4d036ba0bfa9c70e82318bfd3e2c2ac3b1d6937730c19a4a88',
      '48e358d1c67bc8b8aa34acdeabeae70a5868755ac2722fe917ad88545345a47d',
      'ce40a07640a52b681625022d47707a20f4d7403c57a86dbfa5b14a10e8516a07',
      'abdd81ed62f48bd169afdcf8148820ad924450f770bec13b2fa39dc20388166b',
      '44db16bc4db22afc1b4521ad4843a27b370030bf5a74b45590645b6a4213153e',
      'd604e43e6e21d582735588ea704c719d9e0dae6fadbd201c4b91df4d03547c69',
      '2cd091c6f7f1e593d468ba240f1e51c165ff8d955c0dbf4dee7180a4ed5c5730',
      '04888da4263220c17a43ed8e011257d5d3d6538f5ab0c333900ec7330b7fb299',
      '00658a33801db6c73487237595e74f3afeab219f45ba1dc6aeab3ddd917504ce',
      '046283b1d2808981e1e874ab38a5fb32b63a8d529f8f3584c52eb9b53fa0638b',
      'b793423c0cdaddbe1f79503c2a85cb5ab666dd4b9012dcd2a3e128c268c37f9d',
      'b12c36223bfebfbb8c67a57a37ba7da85ed9b2a94201a13288ac2730ad5fec53',
      'dd55f3464b014d1fc5317d9544cb94c058bc55fe6777bebf34b31bba491a519d',
      'd0339bd1fbbf4402f1474e0a7dc51d2f61a79f087689e793a66d6a8860798c96',
      '559ccf54c8107fb27f1ccf864eaafabb565af9cb314b00e35fe806984706b893',
    ]),
  }),
  Object.freeze({
    id: 'soviet',
    name: 'movies2.mix',
    url: '/api/content/ra-movies/soviet',
    partial: 'ra-movies2',
    bytes: 415_334_456,
    movies: SOVIET_MOVIES,
    sha256: '3f2c8711d0f9978b47b9365b1a8d41a12f7d873d352fb2b0253c4deb06d76f35',
    pieces: Object.freeze([
      'fd0e3d8ba730e354d67c85c648c7e5c8bb1f30aea999881d27c1d489ef79b33d',
      '83dd2a3f023b695e518f23cbc982c082fbbe33f0568ee6caa3db43caee674a9d',
      'ba862aa1191c1ea4dd0b33768af645a39636341820660c3982eff58b9ec66aaa',
      'ad56484f6963489206a8fb8b1ea931c8357fc3ab772f3d3226b303a00a49a08d',
      'bf19ef226fbdca3dd2a3e395a894d3dcafff57a83af42a433011f61c0c484b1d',
      '6f2b90a17d3b116805b0024cd74865b4b1bb61b684a88870a5a4dc012785c67e',
      '1e604eddd1a327213a211bc9cf5eaaaa3a84e91e227cdc4db7192f15a1fc1cf4',
      'a493576dfeb6992500608a01499df9dcd4062e0cf02e9b2f5d20da08d886987d',
      '11280b9ce9b92c56e99d3e444a6c29fd93455a6311c725276d3a178eda912244',
      '7f76cd08ffd49366a9f4712f669eed8f4d98d77eb083424d3ab2a5244340f032',
      'f43e0fb4f2ff461d6023accead800a87b20c2842cf5c9de9e88e61b441158cc8',
      '366691b082f8bd03f94daf49490a53cdf26629c6b02d101337540bc666390354',
      '71226747c1bbb713d1ec34cab08b1237d6739edfa4776182892e12604d4aacb0',
      'ae3f72997862fc44e9f07adeb19fac75994c13ea580aace0185dbc709625efeb',
      '9b92a923d8212057bcbc0d0676bfa7fa3b203784c5592d3399856c06ecde112d',
      '90f2f184f4bbbbc97428dd8fa3a2104155de533132e23cc5dbf75d5c769115c7',
      'facb37596a51ca50711a24b2f3caf2b594d22a02809e0c39f7f97a6cad54d740',
      '8bb05af958b3ccfb4fb0c56105e1be61f795cdda875e61e3c6db08d4897f64de',
      '13fa5f44a27e42d020d94b64d564ff910197ea60e11c89bd80b1417a07d4ef12',
      'fca5e39c7bfe7637f60f22a463cb05d11e9ad5752179fe5a5eeaa639f33fa3d5',
      '9b6a5b357de76189bcf9b0c884424da5fab8a4fd0872e4ea3b761dfc797b422c',
      '89a54beac0a638501b600538a9d7dd27b4da24014b3e454ac7bee54864366209',
      '7d50fa326d8a42f6e99dcef2e9a023a6b8cea5ccf0c0a07392424d838bc9c333',
      '563ade9cdd0a34db72c8fdee3085e13ea39bcdec7208ef29f0266eb21bae6d48',
      'f2b88e6299f3bc556e5cd2717109123dffb458d98549ea395ab71a19c2464ce2',
      'bff1523024c52f9111496fdcedeab53540929a7033399c7e4405f636f52102e3',
      '16ba398d153b71898ef7db4e7180ad6581c45631680c701f62f013ac5b0c5856',
      'b740f886870f12680a0fb7d1ef775227a5dbd709bc3ce9d450bb92021a2a2ffb',
      '905ca7a0b63888690aa3d5f3f639787122402731a7a57f11f70e95b3febaacd9',
      '2a131473f7e8b73828618cc90f1ce911566bf242d10e531cee576fc10ddbd16f',
      '46c9fc08af6f806cb980317435a0e02ce67c0e49134582280ff2f61183ca9f09',
      '87753c2f862abecdecd63a6b4d84dd12dbc0bc2ab6559e6eb29caa4a9cddd10e',
      'b78531ea8d923582313c9a06d3a01accc309ce8270ece98f308a9ebba0db3789',
      'db5fa509a74508dcdd1276d7bcd270f0455b596be57b090f1c60b3c47ba8c822',
      '2fee87efe45a7e72ccacf6177e6efd76ca71972567186c3556a3be46ae6fab3d',
      'd5c07d9fc75a66707ad15bb001630ee4c60a7e9475aa986d9f41bb767540fd71',
      '1f87c91e70648775a53b98a403ec4b97cd46a378012ce248426e0dad8e0dfa20',
      '583a4bdfe03088f9f4cedea729aeb71c9c3742408fe54352254b2a738022f666',
      '470d3776b64642cc508105c9e3a9e09e9a45a60bb041ecf4519820b4d6622175',
      'd608997fb09638bdc8ce97674e930bf12ad5a4e350380ba5d8cad3fa2aad362f',
      '289092904112d63847178231adafdbe87a9c4b155447620cf679ceffecd9e672',
      'a4746b11f19a8b168f5a98058b7e5f1dbd47252e863783fd3cb3d48f68302e5e',
      '335146fadd980c706b76684004c96aa724dd40a6ad5ddddd15125fad7945b159',
      'dbf53a7599b24f071e3c0c8cc31f4636933ef776641bd4e5c557df0f14e2bf3c',
      'b88a54e08ccffe4d6826f5531e5de2ce51666465f4de857ffcfbdf7dce3f175d',
      'a42710f5351a1fb87657a32269dad41862225becf2eef696535af217c24966b6',
      '49b24d6fd8d72d98582c6676dcd9f0154e07fe0d1b3c8dc49cdcaab7c7965a0d',
      '5bc20fc0d3e53853131d66ec22c610e023dbae3ce3754752e10c2166b9f57123',
      '8f6ce734e91c4f210ab329afea30d6b64d2b8be082079d707fa226534b3023d2',
      'e5971a4542fb663c363c7b7f9f8ce26a6b5ec9abb73656faf5f347b3ef18b79d',
    ]),
  }),
]);

/** Both archives. */
export const MOVIES_BYTES = MOVIE_ARCHIVES.reduce((n, a) => n + a.bytes, 0);

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/**
 * A File-like view of an archive whose pieces are kept in `store` (what the
 * installer's blobSource reads): `slice(a, b).arrayBuffer()` reads only the
 * pieces it needs (the last two stay in memory for the many small reads of
 * a MIX index). A piece that is missing or of the wrong size fails the read.
 */
export function archiveFile(store, archive, piece = SCORES_PIECE) {
  const cache = new Map();
  const pieceOf = async (i) => {
    if (cache.has(i)) return cache.get(i);
    const want = Math.min(piece, archive.bytes - i * piece);
    const bytes = await store.getPartial(archive.partial, i);
    if (!bytes || bytes.byteLength !== want) throw new Error(`${archive.name} is not complete on this device; download it again`);
    const view = new Uint8Array(bytes);
    cache.set(i, view);
    if (cache.size > 2) cache.delete(cache.keys().next().value);
    return view;
  };
  const read = async (start, end) => {
    const out = new Uint8Array(Math.max(0, end - start));
    for (let at = start; at < end; ) {
      const i = Math.floor(at / piece);
      const p = await pieceOf(i);
      const from = at - i * piece;
      const n = Math.min(p.length - from, end - at);
      out.set(p.subarray(from, from + n), at - start);
      at += n;
    }
    return out.buffer;
  };
  return {
    name: archive.name,
    size: archive.bytes,
    webkitRelativePath: '',
    slice(a = 0, b = archive.bytes) {
      const start = Math.max(0, Math.min(a, archive.bytes));
      const end = Math.max(start, Math.min(b, archive.bytes));
      return { size: end - start, arrayBuffer: () => read(start, end) };
    },
  };
}

/**
 * Download one movie archive through the relay into `store`, checking every
 * piece against its pin before it is kept; resumes from kept pieces.
 * Returns archiveFile() for the installer; throws with a readable message
 * (CancelledError when `signal` aborts, RelayLimitError for a used up
 * budget).
 * @param {{ archive: typeof MOVIE_ARCHIVES[number], store: object, onProgress?(received: number, total: number): void,
 *   fetchImpl?: typeof fetch, signal?: AbortSignal, digest?(bytes: Uint8Array): Promise<ArrayBuffer>, piece?: number }} o
 *   piece: the piece size (tests use small synthetic archives)
 */
export async function downloadMovieArchive({
  archive,
  store,
  onProgress = () => {},
  fetchImpl = globalThis.fetch,
  signal,
  digest = (b) => globalThis.crypto.subtle.digest('SHA-256', b),
  piece = SCORES_PIECE,
}) {
  await downloadPieces({
    url: archive.url,
    total: archive.bytes,
    key: archive.partial,
    store,
    piece,
    check: async (i, bytes) =>
      hex(await digest(bytes)) === archive.pieces[i] ? null : `part ${i + 1} of ${archive.name} does not match the freeware CDs (checksum), so it was not kept; try again later`,
    onProgress,
    fetchImpl,
    signal,
  });
  return archiveFile(store, archive, piece);
}

/** Bytes of the archive already kept on this device (from the pieces' keys, nothing is read). */
export async function keptMovieBytes(store, archive, piece = SCORES_PIECE) {
  const count = Math.ceil(archive.bytes / piece);
  let n = 0;
  for (const i of (await store.partialIndexes?.(archive.partial)) ?? []) if (Number.isInteger(i) && i >= 0 && i < count) n += Math.min(piece, archive.bytes - i * piece);
  return n;
}

/** Forget the kept pieces of an archive (after the install, or when they turn out wrong). */
export function forgetMovieDownload(store, archive) {
  return store.clearPartials(archive.partial);
}
