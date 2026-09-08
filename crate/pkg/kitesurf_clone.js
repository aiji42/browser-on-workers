/**
 * フォントを 1 本登録する。`render_png_rgba` より先に、フォントごとに 1 回ずつ呼ぶ。
 *
 * - `bytes` は TTF / OTF / TTC の中身
 * - `family` はこのフォントを入れる family の名前。**フォントファイルの中の名前は使わない**。
 *   同じ `family` で regular と bold を登録すると、1 つの family の中で weight が解決される。
 *   別の文字集合のフォント (Latin と日本語など) は必ず別の `family` にする。同じ family に
 *   入れると、weight の一致で 1 本だけが選ばれて、もう 1 本の文字が消える
 * - 登録した順が優先順位になる。CSS の `sans-serif` などは、先に登録した family から順に
 *   文字を探す。Latin を先、日本語を後に登録すればよい (どちらも持っている文字は Latin で出る)
 * - 戻り値は登録できた face の数。0 ならフォントとして読めなかった (何も登録されない)
 *
 * 登録は wasm インスタンスに残る。Workers では isolate が生きている間は有効なので、
 * 初期化のときに 1 度だけ呼ぶ (2 度呼ぶと同じ face が 2 つ入る)
 * @param {Uint8Array} bytes
 * @param {string} family
 * @returns {number}
 */
export function add_font(bytes, family) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(family, wasm.__wbindgen_export, wasm.__wbindgen_export2);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.add_font(ptr0, len0, ptr1, len1);
    return ret >>> 0;
}

/**
 * サブリソースを 1 つ登録する。`render_png_rgba` より先に、資源ごとに 1 回呼ぶ。
 *
 * - `url` は**絶対 URL**。HTML の中の `src` / `href` を `new URL(href, baseUrl)` で
 *   解決したものを渡す。相対 URL を渡しても、Blitz が組む URL とは一致しない
 * - `bytes` は取得した中身をそのまま。画像は PNG / JPEG / GIF / WebP / SVG、
 *   CSS と web font もこの表から返る
 * - 戻り値は実際に鍵にした文字列。JS 側で URL の正規化がずれていないかの確認に使える
 * - 同じ URL を 2 度渡すと後のほうが残る
 *
 * `data:` URL は表に入れなくてよい。Rust 側で解く
 * @param {string} url
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function add_resource(url, bytes) {
    let deferred3_0;
    let deferred3_1;
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(bytes, wasm.__wbindgen_export);
        const len1 = WASM_VECTOR_LEN;
        wasm.add_resource(retptr, ptr0, len0, ptr1, len1);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        deferred3_0 = r0;
        deferred3_1 = r1;
        return getStringFromWasm0(r0, r1);
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
        wasm.__wbindgen_export3(deferred3_0, deferred3_1, 1);
    }
}

/**
 * 登録したフォントを全部消す
 */
export function clear_fonts() {
    wasm.clear_fonts();
}

/**
 * 登録した資源を全部捨てる。ページごとに呼ぶ
 * (Workers の isolate はリクエストをまたいで生きるので、呼ばないと前のページの画像が残る)。
 * `missed_resources` の記録も一緒に捨てる
 */
export function clear_resources() {
    wasm.clear_resources();
}

/**
 * 登録済みの family 名を登録順に返す (確認用)
 * @returns {string[]}
 */
export function font_families() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.font_families(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * wasm-bindgen の init 時に呼ばれる。panic のメッセージを外に残す。
 *
 * wasm32-unknown-unknown は unwind できない (target 自体が abort 固定で、
 * `panic = "unwind"` にしても `catch_unwind` は何も捕まえない)。panic は最終的に
 * `unreachable` 命令でトラップし、JS 側には `RuntimeError: unreachable` しか届かない。
 * そこで abort の前に走る panic hook で
 *   1. `console.error` にメッセージ (発生箇所の file:line 入り) を流し、
 *   2. `LAST_PANIC` に控える。
 * 呼び出し側は `RuntimeError` を受けたら `last_panic()` で中身を取り出せる。
 *
 * hook の中から `wasm_bindgen::throw_str` で JS の例外を投げる手もあるが、hook から
 * 抜けないと std の「panic 処理中」フラグが立ったままになり、同じインスタンスでの
 * 2 度目の panic は hook を通らず即 abort になる。wasm-bindgen の glue は
 * インスタンスを 1 つしか持たず (`init` を呼び直しても同じものが返る) Workers の
 * isolate はリクエストをまたいで生きるので、hook は素直に return して abort に任せる。
 *
 * トラップの後も wasm のメモリは残っている。abort は hook の処理が終わってから
 * 呼ばれるので、`last_panic()` で `LAST_PANIC` を読むのは安全。ただし panic を
 * 起こした描画の途中状態 (借用中の RefCell 等) は捨てられずに残るので、
 * 次の描画が連鎖して panic する可能性はある。それも同じ経路でメッセージが出る
 */
export function init() {
    wasm.init();
}

/**
 * 直前の panic のメッセージを取り出す (取り出すと消える)。無ければ `None` (JS では `undefined`)。
 * `render_png_rgba` が `RuntimeError: unreachable` で落ちた直後に呼ぶ
 * @returns {string | undefined}
 */
export function last_panic() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.last_panic(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        let v1;
        if (r0 !== 0) {
            v1 = getStringFromWasm0(r0, r1);
            wasm.__wbindgen_export3(r0, r1 * 1, 1);
        }
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * **直前の `render_png_rgba` が要求したのに表に無かった** URL。
 *
 * これを fetch して `add_resource` で足し、もう 1 度描くと、CSS の中から
 * 参照される画像 (`background-image`) や `@import` した CSS、`@font-face` の
 * web font まで絵に入る。HTML を走査するだけでは集まらないもの。
 *
 * - `fetch` にそのまま渡せる絶対 URL (http / https)。要求された順、重複なし
 * - `data:` は Rust 側で解くので入らない
 * - 描画のたびに置き換わる。空になったら足すものは無い
 * - `render_png_rgba` を通らない描画 (native のテスト) では更新されない
 * @returns {string[]}
 */
export function missed_resources() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.missed_resources(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * HTML を `width` x `height` のビューポートに描き、RGBA8 のピクセル列を返す。
 *
 * - 戻り値は `width * height * 4` バイト。左上から行優先、1 ピクセル = R, G, B, A
 * - 背景は白で塗ってから描くので全ピクセルの A は 255。vello_cpu の出力は
 *   premultiplied RGBA だが、A = 255 なら straight と一致するので JS 側で
 *   そのまま PNG にできる
 * - `base_url` はページの URL。`<link href>` や `<img src>` の相対参照を解決する起点に
 *   なる。取得はしないが、解決できないと blitz-dom が panic するので必ず絶対 URL を渡す。
 *   インライン HTML のように URL が無いときは空文字でよい (内部で仮の URL を敷く)
 * - フォントは先に `add_font` で登録しておく。CSS の font-family が何を指していても、
 *   登録したフォントの中から文字を持つものに落ちる。何も登録していないと文字は描かれない
 * - vello_cpu の描画面は u16 なので、辺の長さは 65535 まで
 * - サブリソース (画像・外部 CSS・web font) は**先に `add_resource` で渡した表からだけ**
 *   届く。Rust 側から通信はしない。表に無いものは無かったものとして描く
 *   (画像はその場所が空き、CSS は当たらない)
 * - 表に無かった URL は `missed_resources` に残る。JS はそれを取ってきて
 *   `add_resource` で足し、もう 1 度これを呼ぶ (CSS の中から参照される画像は
 *   この 2 パスでしか拾えない)
 * @param {string} html
 * @param {string} base_url
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}
 */
export function render_png_rgba(html, base_url, width, height) {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        const ptr0 = passStringToWasm0(html, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(base_url, wasm.__wbindgen_export, wasm.__wbindgen_export2);
        const len1 = WASM_VECTOR_LEN;
        wasm.render_png_rgba(retptr, ptr0, len0, ptr1, len1, width, height);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v3 = getArrayU8FromWasm0(r0, r1).slice();
        wasm.__wbindgen_export3(r0, r1 * 1, 1);
        return v3;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}

/**
 * 登録済みの URL (確認用。順序は決まらない)
 * @returns {string[]}
 */
export function resource_urls() {
    try {
        const retptr = wasm.__wbindgen_add_to_stack_pointer(-16);
        wasm.resource_urls(retptr);
        var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true);
        var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true);
        var v1 = getArrayJsValueFromWasm0(r0, r1);
        wasm.__wbindgen_export3(r0, r1 * 4, 4);
        return v1;
    } finally {
        wasm.__wbindgen_add_to_stack_pointer(16);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_is_undefined_8c687d0b90d5b524: function(arg0) {
            const ret = getObject(arg0) === undefined;
            return ret;
        },
        __wbg___wbindgen_throw_5d9e815e6fdf150f: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_51dc455fc840bcbc: function(arg0, arg1) {
            console.error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_d1fb6650485d7f3e: function() {
            const ret = Date.now();
            return ret;
        },
        __wbg_now_e7c6795a7f81e10f: function(arg0) {
            const ret = getObject(arg0).now();
            return ret;
        },
        __wbg_performance_3fcf6e32a7e1ed0a: function(arg0) {
            const ret = getObject(arg0).performance;
            return addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_8eb4cd83130a11a0: function() {
            const ret = typeof global === 'undefined' ? null : global;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_GLOBAL_THIS_1e7044f654e934db: function() {
            const ret = typeof globalThis === 'undefined' ? null : globalThis;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_SELF_d8b50611246a6d92: function() {
            const ret = typeof self === 'undefined' ? null : self;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbg_static_accessor_WINDOW_fd0bc376bf0f8b42: function() {
            const ret = typeof window === 'undefined' ? null : window;
            return isLikeNone(ret) ? 0 : addHeapObject(ret);
        },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return addHeapObject(ret);
        },
        __wbindgen_object_clone_ref: function(arg0) {
            const ret = getObject(arg0);
            return addHeapObject(ret);
        },
        __wbindgen_object_drop_ref: function(arg0) {
            takeObject(arg0);
        },
    };
    return {
        __proto__: null,
        "./kitesurf_clone_bg.js": import0,
    };
}

function addHeapObject(obj) {
    if (heap_next === heap.length) heap.push(heap.length + 1);
    const idx = heap_next;
    heap_next = heap[idx];

    heap[idx] = obj;
    return idx;
}

function dropObject(idx) {
    if (idx < 1028) return;
    heap[idx] = heap_next;
    heap_next = idx;
}

function getArrayJsValueFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    const mem = getDataViewMemory0();
    const result = [];
    for (let i = ptr; i < ptr + 4 * len; i += 4) {
        result.push(takeObject(mem.getUint32(i, true)));
    }
    return result;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function getObject(idx) { return heap[idx]; }

let heap = new Array(1024).fill(undefined);
heap.push(undefined, null, true, false);

let heap_next = heap.length;

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeObject(idx) {
    const ret = getObject(idx);
    dropObject(idx);
    return ret;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('kitesurf_clone_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
