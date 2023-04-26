import { webcrypto as crypto } from 'node:crypto';
import 'node:util';
import fs from 'node:fs';
import 'readline';
import { WebSocket } from 'ws';
/* ***************************************************************************/
/* WASM Loading. */
/* ***************************************************************************/
// for distribution we replace this line with inlined base64-encoded bytes
const wasmBase64 = "";
async function getWasmSource() {
    if (wasmBase64 === "") {
        
        let wasmBuffer = fs.readFileSync("skdb.wasm");
        return new Uint8Array(wasmBuffer);
    }
    // @ts-ignore
    let wasmBuffer = fs.readFileSync("skdb.wasm");
    let len = wasmBuffer.length;
    let typedArray = new Uint8Array(len);
    for (var i = 0; i < len; i++) {
        typedArray[i] = wasmBuffer.charCodeAt(i);
    }
    return typedArray;
}
/* ***************************************************************************/
/* Primitives to connect to indexedDB. */
/* ***************************************************************************/
function clearSKDBStore(dbName, storeName) {
    if (typeof indexedDB === 'undefined') {
        throw new Error("No indexedDB in this environment.");
    }
    return new Promise((resolve, reject) => {
        let open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = function () {
            let db = open.result;
            let store = db.createObjectStore(storeName, { keyPath: "pageid" });
        };
        open.onsuccess = function () {
            let db = open.result;
            let tx = db.transaction(storeName, "readwrite");
            let store = tx.objectStore(storeName);
            store.clear();
            tx.oncomplete = function () {
                resolve();
            };
            tx.onerror = function (err) {
                reject(err);
            };
        };
        open.onerror = function (err) {
            reject(err);
        };
    });
}
class RebootStatus {
    constructor() {
        this.isReboot = false;
    }
}
function makeSKDBStore(dbName, storeName, version, memory, memorySize, rebootStatus, pageSize) {
    if (typeof indexedDB === 'undefined') {
        throw new Error("No indexedDB in this environment.");
    }
    let memory32 = new Uint32Array(memory);
    // Let's round up the memorySize to be pageSize aligned
    memorySize = (memorySize + (pageSize - 1)) & ~(pageSize - 1);
    return new Promise((resolve, reject) => {
        let open = indexedDB.open(dbName, 1);
        open.onupgradeneeded = function () {
            let db = open.result;
            let store = db.createObjectStore(storeName, { keyPath: "pageid" });
        };
        open.onsuccess = function () {
            let db = open.result;
            let tx = db.transaction(storeName, "readwrite");
            let store = tx.objectStore(storeName);
            store.getAll().onsuccess = (event) => {
                let target = event.target;
                if (target == null) {
                    reject(new Error("Unexpected null target"));
                    return;
                }
                let pages = target.result;
                if (pages.length == 0) {
                    rebootStatus.isReboot = true;
                    let i;
                    let cursor = 0;
                    for (i = 0; i < memorySize / pageSize; i++) {
                        const content = memory.slice(cursor, cursor + pageSize);
                        store.put({ pageid: i, content: content });
                        cursor = cursor + pageSize;
                    }
                }
                else {
                    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
                        let page = pages[pageIdx];
                        const pageid = page.pageid;
                        if (pageid < 0)
                            continue;
                        let pageBuffer = new Uint32Array(page.content);
                        const start = pageid * (pageSize / 4);
                        for (let i = 0; i < pageBuffer.length; i++) {
                            memory32[start + i] = pageBuffer[i];
                        }
                    }
                }
            };
            tx.oncomplete = function () {
                resolve(db);
            };
            tx.onerror = function (err) {
                reject(err);
            };
        };
        open.onerror = function (err) {
            reject(err);
        };
    });
}
/* ***************************************************************************/
/* A few primitives to encode/decode. */
/* ***************************************************************************/
function encodeUTF8(exports, s) {
    let data = new Uint8Array(exports.memory.buffer);
    let i = 0, addr = exports.SKIP_Obstack_alloc(s.length * 4);
    for (let ci = 0; ci != s.length; ci++) {
        let c = s.charCodeAt(ci);
        if (c < 128) {
            data[addr + i++] = c;
            continue;
        }
        if (c < 2048) {
            data[addr + i++] = (c >> 6) | 192;
        }
        else {
            if (c > 0xd7ff && c < 0xdc00) {
                if (++ci >= s.length)
                    throw new Error("UTF-8 encode: incomplete surrogate pair");
                let c2 = s.charCodeAt(ci);
                if (c2 < 0xdc00 || c2 > 0xdfff)
                    throw new Error("UTF-8 encode: second surrogate character 0x" +
                        c2.toString(16) +
                        " at index " +
                        ci +
                        " out of range");
                c = 0x10000 + ((c & 0x03ff) << 10) + (c2 & 0x03ff);
                data[addr + i++] = (c >> 18) | 240;
                data[addr + i++] = ((c >> 12) & 63) | 128;
            }
            else
                data[addr + i++] = (c >> 12) | 224;
            data[addr + i++] = ((c >> 6) & 63) | 128;
        }
        data[addr + i++] = (c & 63) | 128;
    }
    return exports.sk_string_create(addr, i);
}
function decodeUTF8(bytes) {
    let i = 0, s = "";
    while (i < bytes.length) {
        let c = bytes[i++];
        if (c > 127) {
            if (c > 191 && c < 224) {
                if (i >= bytes.length)
                    throw new Error("UTF-8 decode: incomplete 2-byte sequence");
                c = ((c & 31) << 6) | (bytes[i++] & 63);
            }
            else if (c > 223 && c < 240) {
                if (i + 1 >= bytes.length)
                    throw new Error("UTF-8 decode: incomplete 3-byte sequence");
                c = ((c & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
            }
            else if (c > 239 && c < 248) {
                if (i + 2 >= bytes.length)
                    throw new Error("UTF-8 decode: incomplete 4-byte sequence");
                c =
                    ((c & 7) << 18) |
                        ((bytes[i++] & 63) << 12) |
                        ((bytes[i++] & 63) << 6) |
                        (bytes[i++] & 63);
            }
            else
                throw new Error("UTF-8 decode: unknown multibyte start 0x" +
                    c.toString(16) +
                    " at index " +
                    (i - 1));
        }
        if (c <= 0xffff)
            s += String.fromCharCode(c);
        else if (c <= 0x10ffff) {
            c -= 0x10000;
            s += String.fromCharCode((c >> 10) | 0xd800);
            s += String.fromCharCode((c & 0x3ff) | 0xdc00);
        }
        else
            throw new Error("UTF-8 decode: code point 0x" + c.toString(16) + " exceeds UTF-16 reach");
    }
    return s;
}
function wasmStringToJS(exports, wasmPointer) {
    let data32 = new Uint32Array(exports.memory.buffer);
    let size = exports["SKIP_String_byteSize"](wasmPointer);
    let data = new Uint8Array(exports.memory.buffer);
    return decodeUTF8(data.slice(wasmPointer, wasmPointer + size));
}
function stringify(obj) {
    if (obj === undefined) {
        obj = null;
    }
    return JSON.stringify(obj);
}
/* ***************************************************************************/
/* The type used to represent callables. */
/* ***************************************************************************/
class SKDBCallable {
    constructor(id) {
        this.id = id;
    }
    getId() {
        return this.id;
    }
}
/* ***************************************************************************/
/* The local database. */
/* ***************************************************************************/
export class SKDB {
    constructor(storeName) {
        this.subscriptionCount = 0;
        this.args = [];
        this.current_stdin = 0;
        this.stdin = "";
        this.stdout = new Array();
        this.stdout_objects = new Array();
        this.onRootChangeFuns = new Array();
        this.externalFuns = [];
        this.fileDescrs = new Map();
        this.fileDescrNbr = 2;
        this.files = new Array();
        this.changed_files = new Array();
        this.execOnChange = new Array();
        this.lineBuffer = [];
        this.nbrInitPages = -1;
        this.roots = new Map();
        this.pageSize = -1;
        this.db = null;
        this.dirtyPagesMap = [];
        this.dirtyPages = [];
        this.clientUuid = "";
        this.storeName = storeName;
    }
    static async clear(dbName, storeName) {
        await clearSKDBStore(dbName, storeName);
    }
    static async create(dbName = null) {
        let storeName = null;
        if (dbName != null) {
            storeName = "SKDBStore";
        }
        let client = new SKDB(storeName);
        let pageBitSize = 20;
        client.pageSize = 1 << pageBitSize;
        let env = client.makeWasmImports();
        const wasmBytes = await getWasmSource();
        let wasm = await WebAssembly.instantiate(wasmBytes, { env: env });
        let exports = wasm.instance.exports;
        client.exports = exports;
        exports.SKIP_skfs_init();
        exports.SKIP_initializeSkip();
        exports.SKIP_skfs_end_of_init();
        client.nbrInitPages = exports.SKIP_get_persistent_size() / client.pageSize + 1;
        let version = exports.SKIP_get_version();
        let rebootStatus = new RebootStatus();
        if (dbName != null && storeName != null) {
            client.db = await makeSKDBStore(dbName, storeName, version, exports.memory.buffer, exports.SKIP_get_persistent_size(), rebootStatus, client.pageSize);
        }
        client.exports.SKIP_init_jsroots();
        client.runSubscribeRoots(rebootStatus.isReboot);
        client.clientUuid = crypto.randomUUID();
        return client;
    }
    openFile(filename) {
        if (this.fileDescrs[filename] !== undefined) {
            return this.fileDescrs[filename];
        }
        let fd = this.fileDescrNbr;
        this.files[fd] = new Array();
        this.fileDescrs[filename] = fd;
        this.fileDescrNbr++;
        return fd;
    }
    watchFile(filename, f) {
        const fd = this.openFile(filename);
        this.execOnChange[fd] = f;
    }
    async connect(db, accessKey, privateKey, endpoint) {
        if (!endpoint) {
            if (typeof window === 'undefined') {
                throw new Error("No endpoint passed to connect and no window object to infer from.");
            }
            const loc = window.location;
            const scheme = loc.protocol === "https:" ? "wss://" : "ws://";
            endpoint = `${scheme}${loc.host}`;
        }
        const creds = {
            accessKey: accessKey,
            privateKey: privateKey,
            deviceUuid: this.clientUuid,
        };
        this.server = await SKDBServer.connect(this, endpoint, db, creds);
        return this.server;
    }
    makeWasmImports() {
        let data = this;
        let field_names = new Array();
        let objectIdx = 0;
        let object = {};
        return {
            abort: function (err) {
                throw new Error("abort " + err);
            },
            abortOnCannotGrowMemory: function (err) {
                throw new Error("abortOnCannotGrowMemory " + err);
            },
            __cxa_throw: function (ptr, type, destructor) {
                throw ptr;
            },
            SKIP_print_backtrace: function () {
                console.trace("");
            },
            SKIP_etry: function (f, exn_handler) {
                try {
                    return data.exports.SKIP_call0(f);
                }
                catch (_) {
                    return data.exports.SKIP_call0(exn_handler);
                }
            },
            __setErrNo: function (err) {
                throw new Error("ErrNo " + err);
            },
            SKIP_call_external_fun: function (funId, str) {
                return encodeUTF8(data.exports, stringify(data.externalFuns[funId](JSON.parse(wasmStringToJS(data.exports, str)))));
            },
            SKIP_print_error: function (str) {
                console.error(wasmStringToJS(data.exports, str));
            },
            SKIP_read_line_fill: function () {
                data.lineBuffer = [];
                const endOfLine = 10;
                if (data.current_stdin >= data.stdin.length) {
                    data.exports.SKIP_throw_EndOfFile();
                }
                while (data.stdin.charCodeAt(data.current_stdin) !== 10) {
                    if (data.current_stdin >= data.stdin.length) {
                        if (data.lineBuffer.length == 0) {
                            data.exports.SKIP_throw_EndOfFile();
                        }
                        else {
                            return data.lineBuffer;
                        }
                    }
                    data.lineBuffer.push(data.stdin.charCodeAt(data.current_stdin));
                    data.current_stdin++;
                }
                data.current_stdin++;
                return data.lineBuffer;
            },
            SKIP_read_line_get: function (i) {
                return data.lineBuffer[i];
            },
            SKIP_getchar: function (i) {
                if (data.current_stdin >= data.stdin.length) {
                    data.exports.SKIP_throw_EndOfFile();
                }
                let result = data.stdin.charCodeAt(data.current_stdin);
                data.current_stdin++;
                return result;
            },
            SKIP_clear_field_names: function () {
                field_names = new Array();
            },
            SKIP_push_field_name: function (str) {
                field_names.push(wasmStringToJS(data.exports, str));
            },
            SKIP_clear_object: function () {
                objectIdx = 0;
                object = {};
            },
            SKIP_push_object_field_null: function () {
                let field_name = field_names[objectIdx];
                object[field_name] = null;
                objectIdx++;
            },
            SKIP_push_object_field_int32: function (n) {
                let field_name = field_names[objectIdx];
                object[field_name] = n;
                objectIdx++;
            },
            SKIP_push_object_field_int64: function (str) {
                let field_name = field_names[objectIdx];
                object[field_name] = parseInt(wasmStringToJS(data.exports, str), 10);
                objectIdx++;
            },
            SKIP_push_object_field_float: function (str) {
                let field_name = field_names[objectIdx];
                object[field_name] = parseFloat(wasmStringToJS(data.exports, str));
                objectIdx++;
            },
            SKIP_push_object_field_string: function (str) {
                let field_name = field_names[objectIdx];
                object[field_name] = wasmStringToJS(data.exports, str);
                objectIdx++;
            },
            SKIP_push_object: function () {
                data.stdout_objects.push(object);
            },
            SKIP_print_raw: function (str) {
                data.stdout.push(wasmStringToJS(data.exports, str));
            },
            SKIP_getArgc: function (i) {
                return data.args.length;
            },
            SKIP_getArgN: function (n) {
                return encodeUTF8(data.exports, data.args[n]);
            },
            SKIP_unix_open: function (wasmFilename) {
                let filename = wasmStringToJS(data.exports, wasmFilename);
                return data.openFile(filename);
            },
            SKIP_write_to_file: function (fd, str) {
                let jsStr = wasmStringToJS(data.exports, str);
                if (jsStr == "")
                    return;
                data.files[fd].push(jsStr);
                data.changed_files[fd] = fd;
                if (data.execOnChange[fd] !== undefined) {
                    data.execOnChange[fd](data.files[fd].join(""));
                    data.files[fd] = [];
                }
            },
            SKIP_glock: function () { },
            SKIP_gunlock: function () { },
        };
    }
    runAddRoot(rootName, funId, arg) {
        this.args = [];
        this.stdin = "";
        this.stdout = new Array();
        this.current_stdin = 0;
        this.exports.SKIP_add_root(encodeUTF8(this.exports, rootName), funId, encodeUTF8(this.exports, stringify(arg)));
    }
    async copyPage(start, end) {
        let memory = this.exports.memory.buffer;
        return memory.slice(start, end);
    }
    async storePages() {
        if (this.storeName == null) {
            return new Promise((resolve, _) => resolve(true));
        }
        let storeName = this.storeName;
        return new Promise((resolve, reject) => (async () => {
            if (this.db == null) {
                resolve(true);
            }
            let pages = this.dirtyPages;
            let db = this.db;
            let tx = db.transaction(storeName, "readwrite");
            tx.onabort = (err) => {
                resolve(false);
            };
            tx.onerror = (err) => {
                console.log("Error sync db: " + err);
                resolve(false);
            };
            tx.oncomplete = () => {
                this.dirtyPages = [];
                this.dirtyPagesMap = [];
                resolve(true);
            };
            let copiedPages = new Array();
            for (let j = 0; j < pages.length; j++) {
                let page = pages[j];
                let start = page * this.pageSize;
                let end = page * this.pageSize + this.pageSize;
                let content = await this.copyPage(start, end);
                copiedPages.push({ pageid: page, content });
            }
            let store = tx.objectStore(storeName);
            for (let j = 0; j < copiedPages.length; j++) {
                store.put(copiedPages[j]);
            }
        })());
    }
    async save() {
        while (true) {
            let dirtyPage = this.exports.sk_pop_dirty_page();
            if (dirtyPage == -1)
                break;
            if (dirtyPage >= this.nbrInitPages) {
                if (this.dirtyPagesMap[dirtyPage] != dirtyPage) {
                    this.dirtyPagesMap[dirtyPage] = dirtyPage;
                    this.dirtyPages.push(dirtyPage);
                }
            }
        }
        for (let dirtyPage = 0; dirtyPage < this.nbrInitPages; dirtyPage++) {
            if (this.dirtyPagesMap[dirtyPage] != dirtyPage) {
                this.dirtyPagesMap[dirtyPage] = dirtyPage;
                this.dirtyPages.push(dirtyPage);
            }
        }
        await this.storePages();
    }
    runLocal(new_args, new_stdin) {
        console.assert(this.nbrInitPages >= 0);
        this.args = new_args;
        this.stdin = new_stdin;
        this.stdout = new Array();
        this.current_stdin = 0;
        this.exports.skip_main();
        return this.stdout.join("");
    }
    runSubscribeRoots(reboot) {
        this.roots = new Map();
        let fileName = "/subscriptions/jsroots";
        this.watchFile(fileName, (text) => {
            let changed = new Map();
            let updates = text.split("\n").filter((x) => x.indexOf("\t") != -1);
            for (const update of updates) {
                if (update.substring(0, 1) !== "0")
                    continue;
                let json = JSON.parse(update.substring(update.indexOf("\t") + 1));
                this.roots.delete(json.name);
                changed.set(json.name, true);
            }
            for (const update of updates) {
                if (update.substring(0, 1) === "0")
                    continue;
                let json = JSON.parse(update.substring(update.indexOf("\t") + 1));
                this.roots.set(json.name, json.value);
                changed.set(json.name, true);
            }
            for (const f of this.onRootChangeFuns) {
                for (const name of changed.keys()) {
                    f(name);
                }
            }
        });
        this.subscriptionCount++;
        if (reboot) {
            this.runLocal(["subscribe", "jsroots", "--format=json", "--updates", fileName], "");
        }
    }
    watermark(table) {
        return parseInt(this.runLocal(["watermark", table], ""));
    }
    cmd(new_args, new_stdin) {
        return this.runLocal(new_args, new_stdin);
    }
    registerFun(f) {
        let funId = this.externalFuns.length;
        this.externalFuns.push(f);
        return new SKDBCallable(funId);
    }
    trackedCall(callable, arg) {
        let result = this.exports.SKIP_tracked_call(callable.getId(), encodeUTF8(this.exports, stringify(arg)));
        return JSON.parse(wasmStringToJS(this.exports, result));
    }
    trackedQuery(request, start, end) {
        if (start === undefined)
            start = 0;
        if (end === undefined)
            end = -1;
        let result = this.exports.SKIP_tracked_query(encodeUTF8(this.exports, request), start, end);
        return wasmStringToJS(this.exports, result)
            .split("\n")
            .filter((x) => x != "")
            .map((x) => JSON.parse(x));
    }
    onRootChange(f) {
        this.onRootChangeFuns.push(f);
    }
    addRoot(rootName, callable, arg) {
        this.runAddRoot(rootName, callable.getId(), arg);
    }
    removeRoot(rootName) {
        this.exports.SKIP_remove_root(encodeUTF8(this.exports, rootName));
    }
    getRoot(rootName) {
        return this.roots.get(rootName);
    }
    subscribe(viewName, f) {
        const fileName = "/subscriptions/sub" + this.subscriptionCount;
        this.watchFile(fileName, f);
        this.subscriptionCount++;
        this.runLocal(["subscribe", viewName, "--format=csv", "--updates", fileName], "");
    }
    sqlRaw(stdin) {
        return this.runLocal([], stdin);
    }
    sql(stdin) {
        let stdout = this.runLocal(["--format=js"], stdin);
        if (stdout == "") {
            let result = this.stdout_objects;
            this.stdout_objects = new Array();
            return result;
        }
        return stdout;
    }
    tableExists(tableName) {
        return this.runLocal(["dump-table", tableName], "").trim() != "";
    }
    tableSchema(tableName) {
        return this.runLocal(["dump-table", tableName], "");
    }
    viewExists(viewName) {
        return this.runLocal(["dump-view", viewName], "") != "";
    }
    viewSchema(viewName) {
        return this.runLocal(["dump-view", viewName], "");
    }
    schema() {
        const tables = this.runLocal(["dump-tables"], "");
        const views = this.runLocal(["dump-views"], "");
        return tables + views;
    }
    insert(tableName, values) {
        values = values.map((x) => {
            if (typeof x == "string") {
                if (x == undefined) {
                    return "NULL";
                }
                return "'" + x + "'";
            }
            return x;
        });
        let stdin = "insert into " + tableName + " values (" + values.join(", ") + ");";
        this.runLocal([], stdin);
    }
}
function metadataTable(tableName) {
    return `skdb__${tableName}_sync_metadata`;
}
/* ***************************************************************************/
/* Stream MUX protocol */
/* ***************************************************************************/
var MuxedSocketState;
(function (MuxedSocketState) {
    MuxedSocketState[MuxedSocketState["IDLE"] = 0] = "IDLE";
    MuxedSocketState[MuxedSocketState["AUTH_SENT"] = 1] = "AUTH_SENT";
    MuxedSocketState[MuxedSocketState["CLOSING"] = 2] = "CLOSING";
    MuxedSocketState[MuxedSocketState["CLOSEWAIT"] = 3] = "CLOSEWAIT";
    MuxedSocketState[MuxedSocketState["CLOSED"] = 4] = "CLOSED";
})(MuxedSocketState || (MuxedSocketState = {}));
export class MuxedSocket {
    constructor(socket) {
        // state
        this.state = MuxedSocketState.IDLE;
        // streams in the open or closing state
        this.activeStreams = new Map();
        this.serverStreamWatermark = 0;
        this.nextStream = 1;
        // pre-condition: socket is open
        this.socket = socket;
    }
    openStream() {
        switch (this.state) {
            case MuxedSocketState.AUTH_SENT: {
                const streamId = this.nextStream;
                this.nextStream = this.nextStream + 2; // client uses odd-numbered streams
                const stream = new Stream(this, streamId);
                this.activeStreams.set(streamId, stream);
                return stream;
            }
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSEWAIT:
                throw new Error("Connection closing");
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSED:
                throw new Error("Connection not established");
        }
    }
    closeSocket() {
        switch (this.state) {
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.IDLE:
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
                this.socket.close();
                break;
            case MuxedSocketState.CLOSEWAIT: {
                for (const stream of this.activeStreams.values()) {
                    stream.close();
                }
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
                this.socket.close();
                break;
            }
            case MuxedSocketState.AUTH_SENT: {
                for (const stream of this.activeStreams.values()) {
                    stream.close();
                }
                this.state = MuxedSocketState.CLOSING;
                this.socket.close();
                break;
            }
        }
    }
    errorSocket(errorCode, msg) {
        switch (this.state) {
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSED:
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
                break;
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSEWAIT: {
                for (const stream of this.activeStreams.values()) {
                    stream.error(errorCode, msg);
                }
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
                const lastStream = Math.max(this.nextStream - 2, this.serverStreamWatermark);
                this.socket.send(this.encodeGoawayMsg(lastStream, errorCode, msg));
                this.socket.close(1002);
                break;
            }
        }
    }
    static async connect(uri, creds) {
        const auth = await MuxedSocket.encodeAuthMsg(creds);
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(uri);
            socket.binaryType = "arraybuffer";
            socket.onclose = (_event) => reject(new Error("Socket closed before open"));
            socket.onerror = (event) => reject(event);
            socket.onmessage = (_event) => reject(new Error("Socket messaged before open"));
            socket.onopen = (_event) => {
                const muxSocket = new MuxedSocket(socket);
                socket.onclose = (event) => muxSocket.onSocketClose(event);
                socket.onerror = (_event) => muxSocket.onSocketError(0, "socket error");
                socket.onmessage = (event) => muxSocket.onSocketMessage(event);
                resolve(muxSocket);
                muxSocket.sendAuth(auth);
            };
        });
    }
    // interface used by Stream //////////////////////////////////////////////////
    streamClose(stream, nowClosed) {
        switch (this.state) {
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSEWAIT: {
                this.socket.send(this.encodeStreamCloseMsg(stream));
                if (nowClosed) {
                    this.activeStreams.delete(stream);
                }
                break;
            }
        }
    }
    streamError(stream, errorCode, msg) {
        switch (this.state) {
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSEWAIT:
                this.socket.send(this.encodeStreamResetMsg(stream, errorCode, msg));
                this.activeStreams.delete(stream);
                break;
        }
    }
    streamSend(stream, data) {
        switch (this.state) {
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSEWAIT:
                this.socket.send(this.encodeStreamDataMsg(stream, data));
        }
    }
    // private ///////////////////////////////////////////////////////////////////
    onSocketClose(_event) {
        switch (this.state) {
            case MuxedSocketState.CLOSEWAIT:
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.IDLE:
            case MuxedSocketState.AUTH_SENT:
                for (const stream of this.activeStreams.values()) {
                    stream.onStreamClose();
                }
                if (this.onClose) {
                    this.onClose();
                }
                this.state = MuxedSocketState.CLOSEWAIT;
                break;
            case MuxedSocketState.CLOSING:
                for (const stream of this.activeStreams.values()) {
                    stream.onStreamClose();
                }
                if (this.onClose) {
                    this.onClose();
                }
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
                break;
        }
    }
    onSocketError(errorCode, msg) {
        switch (this.state) {
            case MuxedSocketState.CLOSED:
                break;
            case MuxedSocketState.IDLE:
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSING:
            case MuxedSocketState.CLOSEWAIT:
                for (const stream of this.activeStreams.values()) {
                    stream.onStreamError(0, msg);
                }
                if (this.onError) {
                    this.onError(errorCode, msg);
                }
                this.activeStreams.clear();
                this.state = MuxedSocketState.CLOSED;
        }
    }
    onSocketMessage(event) {
        switch (this.state) {
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSING:
                if (!(event.data instanceof ArrayBuffer)) {
                    throw new Error("Received unexpected text data");
                }
                const msg = this.decode(event.data);
                if (msg === null) {
                    // for robustness we ignore messages we don't understand
                    return;
                }
                switch (msg.type) {
                    case "auth":
                        throw new Error("Unexepected auth message from server");
                    case "goaway":
                        this.onSocketError(msg.errorCode, msg.msg);
                        break;
                    case "data": {
                        let stream = this.activeStreams.get(msg.stream);
                        if (stream == undefined && this.state == MuxedSocketState.CLOSING) {
                            // we don't accept new streams while closing
                            break;
                        }
                        // TODO: is the watermark condition necesary? we don't want to
                        // reuse streams but this doesn't allow for creating them with
                        // non-deterministic scheduling. if we don't accept them,
                        // should probably send a stream reset
                        if (stream === undefined && msg.stream % 2 == 0 && msg.stream > this.serverStreamWatermark) {
                            // new server-initiated stream
                            this.serverStreamWatermark = msg.stream;
                            stream = new Stream(this, msg.stream);
                            this.activeStreams.set(msg.stream, stream);
                            if (this.onStream) {
                                this.onStream(stream);
                            }
                        }
                        stream?.onStreamData(msg.payload);
                        break;
                    }
                    case "close":
                        const closed = this.activeStreams.get(msg.stream)?.onStreamClose();
                        if (closed) {
                            this.activeStreams.delete(msg.stream);
                        }
                        break;
                    case "reset":
                        this.activeStreams.get(msg.stream)?.onStreamError(msg.errorCode, msg.msg);
                        this.activeStreams.delete(msg.stream);
                        break;
                    default:
                        throw new Error("Unexpected message type");
                }
                break;
            case MuxedSocketState.IDLE:
            case MuxedSocketState.CLOSEWAIT:
            case MuxedSocketState.CLOSED:
                break;
        }
    }
    sendAuth(msg) {
        switch (this.state) {
            case MuxedSocketState.IDLE:
                this.state = MuxedSocketState.AUTH_SENT;
                this.socket.send(msg);
                break;
            case MuxedSocketState.AUTH_SENT:
            case MuxedSocketState.CLOSING:
                throw new Error("Tried to auth an established connection");
            case MuxedSocketState.CLOSEWAIT:
            case MuxedSocketState.CLOSED:
                break;
        }
    }
    static async encodeAuthMsg(creds) {
        const enc = new TextEncoder();
        const buf = new ArrayBuffer(96);
        const uint8View = new Uint8Array(buf);
        const dataView = new DataView(buf);
        const now = (new Date()).toISOString();
        const nonce = uint8View.subarray(28, 36);
        crypto.getRandomValues(nonce);
        const b64nonce = btoa(String.fromCharCode(...nonce));
        const bytesToSign = enc.encode("auth" + creds.accessKey + now + b64nonce);
        const sig = await crypto.subtle.sign("HMAC", creds.privateKey, bytesToSign);
        dataView.setUint8(0, 0x0); // type
        dataView.setUint8(4, 0x0); // version
        const encodeAccessKey = enc.encodeInto(creds.accessKey, uint8View.subarray(8));
        if (!encodeAccessKey.written || encodeAccessKey.written > 20) {
            throw new Error("Unable to encode access key");
        }
        uint8View.set(new Uint8Array(sig), 36);
        const encodeIsoDate = enc.encodeInto(now, uint8View.subarray(69));
        switch (encodeIsoDate.written) {
            case 24:
                return buf.slice(0, 93);
            case 27:
                dataView.setUint8(68, 0x1);
                return buf;
            default:
                throw new Error("Unexpected ISO date length");
        }
    }
    encodeGoawayMsg(lastStream, errorCode, msg) {
        if (lastStream >= 2 ** 24) {
            throw new Error("Cannot encode lastStream");
        }
        const buf = new ArrayBuffer(16 + msg.length * 3); // avoid resizing
        const uint8View = new Uint8Array(buf);
        const textEncoder = new TextEncoder();
        const encodeResult = textEncoder.encodeInto(msg, uint8View.subarray(16));
        const dataView = new DataView(buf);
        dataView.setUint8(0, 0x1); // type
        dataView.setUint32(4, lastStream, false);
        dataView.setUint32(8, errorCode, false);
        dataView.setUint32(12, encodeResult.written || 0, false);
        return buf.slice(0, 16 + (encodeResult.written || 0));
    }
    encodeStreamDataMsg(stream, data) {
        if (stream >= 2 ** 24) {
            throw new Error("Cannot encode stream");
        }
        const buf = new ArrayBuffer(4 + data.byteLength);
        const dataView = new DataView(buf);
        const uint8View = new Uint8Array(buf);
        dataView.setUint32(0, 0x2 << 24 | stream, false); // type and stream id
        uint8View.set(new Uint8Array(data), 4);
        return buf;
    }
    encodeStreamCloseMsg(stream) {
        if (stream >= 2 ** 24) {
            throw new Error("Cannot encode stream");
        }
        const buf = new ArrayBuffer(4);
        const dataView = new DataView(buf);
        dataView.setUint32(0, 0x3 << 24 | stream, false); // type and stream id
        return buf;
    }
    encodeStreamResetMsg(stream, errorCode, msg) {
        if (stream >= 2 ** 24) {
            throw new Error("Cannot encode stream");
        }
        const textEncoder = new TextEncoder();
        const buf = new ArrayBuffer(12 + msg.length * 3); // avoid resizing
        const uint8View = new Uint8Array(buf);
        const dataView = new DataView(buf);
        dataView.setUint32(0, 0x4 << 24 | stream, false); // type and stream id
        dataView.setUint32(4, errorCode, false);
        const encodeResult = textEncoder.encodeInto(msg, uint8View.subarray(12));
        dataView.setUint32(8, encodeResult.written || 0, false);
        return buf.slice(0, 12 + (encodeResult.written || 0));
    }
    decode(msg) {
        const dv = new DataView(msg);
        const typeAndStream = dv.getUint32(0, false);
        const type = typeAndStream >>> 24;
        const stream = typeAndStream & 0xFFFFFF;
        switch (type) {
            case 0: { // auth
                return {
                    type: "auth",
                };
            }
            case 1: { // goaway
                const msgLength = dv.getUint32(12, false);
                const errorMsgBytes = new Uint8Array(msg, 16, msgLength);
                const td = new TextDecoder();
                const errorMsg = td.decode(errorMsgBytes);
                return {
                    type: "goaway",
                    lastStream: dv.getUint32(4, false),
                    errorCode: dv.getUint32(8, false),
                    msg: errorMsg,
                };
            }
            case 2: { // stream data
                return {
                    type: "data",
                    stream: stream,
                    payload: msg.slice(4),
                };
            }
            case 3: { // stream close
                return {
                    type: "close",
                    stream: stream,
                };
            }
            case 4: { // stream reset
                const msgLength = dv.getUint32(8, false);
                const errorMsgBytes = new Uint8Array(msg, 12, msgLength);
                const td = new TextDecoder();
                const errorMsg = td.decode(errorMsgBytes);
                return {
                    type: "reset",
                    stream: stream,
                    errorCode: dv.getUint32(4, false),
                    msg: errorMsg,
                };
            }
            default:
                return null;
        }
    }
}
var StreamState;
(function (StreamState) {
    StreamState[StreamState["OPEN"] = 0] = "OPEN";
    StreamState[StreamState["CLOSING"] = 1] = "CLOSING";
    StreamState[StreamState["CLOSEWAIT"] = 2] = "CLOSEWAIT";
    StreamState[StreamState["CLOSED"] = 3] = "CLOSED";
})(StreamState || (StreamState = {}));
class Stream {
    close() {
        switch (this.state) {
            case StreamState.CLOSING:
            case StreamState.CLOSED:
                break;
            case StreamState.OPEN:
                this.state = StreamState.CLOSING;
                this.socket.streamClose(this.streamId, false);
                break;
            case StreamState.CLOSEWAIT:
                this.state = StreamState.CLOSED;
                this.socket.streamClose(this.streamId, true);
                break;
        }
    }
    error(errorCode, msg) {
        switch (this.state) {
            case StreamState.CLOSED:
            case StreamState.CLOSING:
                this.state = StreamState.CLOSED;
                break;
            case StreamState.OPEN:
            case StreamState.CLOSEWAIT:
                this.state = StreamState.CLOSED;
                this.socket.streamError(this.streamId, errorCode, msg);
                break;
        }
    }
    send(data) {
        switch (this.state) {
            case StreamState.CLOSING:
            case StreamState.CLOSED:
                break;
            case StreamState.OPEN:
            case StreamState.CLOSEWAIT:
                this.socket.streamSend(this.streamId, data);
        }
    }
    // interface used by MuxedSocket ///////////////////////////
    constructor(socket, streamId) {
        // state
        this.state = StreamState.OPEN;
        this.socket = socket;
        this.streamId = streamId;
    }
    onStreamClose() {
        switch (this.state) {
            case StreamState.CLOSED:
                return true;
            case StreamState.CLOSEWAIT:
                return false;
            case StreamState.OPEN:
                this.state = StreamState.CLOSEWAIT;
                if (this.onClose) {
                    this.onClose();
                }
                return false;
            case StreamState.CLOSING:
                this.state = StreamState.CLOSED;
                if (this.onClose) {
                    this.onClose();
                }
                return true;
        }
    }
    onStreamError(errorCode, msg) {
        switch (this.state) {
            case StreamState.CLOSED:
                break;
            case StreamState.CLOSING:
            case StreamState.OPEN:
            case StreamState.CLOSEWAIT:
                this.state = StreamState.CLOSED;
                if (this.onError) {
                    this.onError(errorCode, msg);
                }
        }
    }
    onStreamData(data) {
        switch (this.state) {
            case StreamState.CLOSED:
            case StreamState.CLOSEWAIT:
                break;
            case StreamState.CLOSING:
            case StreamState.OPEN:
                if (this.onData) {
                    this.onData(data);
                }
        }
    }
}
/* ***************************************************************************/
/* Server-side database. */
/* ***************************************************************************/
class SKDBServer {
    constructor(client, connection, creds) {
        this.replicationUid = "";
        this.mirroredTables = new Set();
        this.client = client;
        this.connection = connection;
        this.creds = creds;
    }
    static async connect(client, endpoint, db, creds) {
        const uri = SKDBServer.getDbSocketUri(endpoint, db);
        const conn = await MuxedSocket.connect(uri, creds);
        const server = new SKDBServer(client, conn, creds);
        server.replicationUid = client.runLocal(["uid"], "").trim();
        return server;
    }
    close() {
        this.connection.closeSocket();
    }
    static getDbSocketUri(endpoint, db) {
        return `${endpoint}/dbs/${db}/connection`;
    }
    async makeRequest(request) {
        const stream = this.connection.openStream();
        const acc = new Array();
        return new Promise((resolve, reject) => {
            stream.onData = function (data) {
                acc.push(data);
            };
            stream.onClose = () => {
                const decoder = new TextDecoder();
                let result = "";
                for (let i = 0; i < acc.length; i++) {
                    result = decoder.decode(acc[i], { stream: i < acc.length - 1 });
                }
                resolve(JSON.parse(result));
            };
            stream.onError = (_code, msg) => reject(msg);
            const encoder = new TextEncoder();
            stream.send(encoder.encode(JSON.stringify(request)));
            stream.close();
        });
    }
    establishServerTail(tableName) {
        const stream = this.connection.openStream();
        const client = this.client;
        stream.onError = (code, msg) => {
            // will go away when we re-introduce the resiliency abstraction
            console.error("server tail", tableName, "stream errored", code, msg);
        };
        stream.onClose = () => {
            // will go away when we re-introduce the resiliency abstraction
            console.error("server tail", tableName, "stream closed");
        };
        stream.onData = (data) => {
            const decoder = new TextDecoder();
            const pData = JSON.parse(decoder.decode(data));
            const msg = pData.data;
            client.runLocal(["write-csv", tableName, "--source", this.replicationUid], msg + '\n');
        };
        const encoder = new TextEncoder();
        stream.send(encoder.encode(JSON.stringify({
            request: "tail",
            table: tableName,
            since: this.client.watermark(tableName),
        })));
    }
    establishLocalTail(tableName) {
        const stream = this.connection.openStream();
        const client = this.client;
        stream.onError = (code, msg) => {
            // will go away when we re-introduce the resiliency abstraction
            console.error("local tail", tableName, "stream errored", code, msg);
        };
        stream.onClose = () => {
            // will go away when we re-introduce the resiliency abstraction
            console.error("local tail", tableName, "stream closed");
        };
        stream.onData = (data) => {
            const decoder = new TextDecoder();
            const pData = JSON.parse(decoder.decode(data));
            const msg = pData.data;
            // we only expect acks back in the form of checkpoints.
            // let's store these as a watermark against the table.
            client.runLocal(["write-csv", metadataTable(tableName)], msg + '\n');
        };
        const request = {
            request: "write",
            table: tableName,
        };
        const encoder = new TextEncoder();
        stream.send(encoder.encode(JSON.stringify(request)));
        let fileName = tableName + "_" + this.creds.accessKey;
        client.watchFile(fileName, change => {
            if (change == "") {
                return;
            }
            const encoder = new TextEncoder();
            stream.send(encoder.encode(JSON.stringify({
                request: "pipe",
                data: change,
            })));
        });
        const _session = client.runLocal([
            "subscribe", tableName, "--connect", "--format=csv",
            "--updates", fileName, "--ignore-source", this.replicationUid
        ], "").trim();
    }
    async mirrorTable(tableName) {
        if (this.mirroredTables.has(tableName)) {
            return;
        }
        this.mirroredTables.add(tableName);
        // TODO: just assumes that if it exists the schema is the same
        if (!this.client.tableExists(tableName)) {
            let createTable = await this.tableSchema(tableName, "");
            this.client.runLocal([], createTable);
            this.client.runLocal([], `CREATE TABLE ${metadataTable(tableName)} (
         key STRING PRIMARY KEY,
         value STRING
       )`);
        }
        this.establishServerTail(tableName);
        this.establishLocalTail(tableName);
    }
    // TODO: this currently just replicates the schema locally assuming
    // you have all source tables setup. is this what we want? we should
    // error if this doesn't succeed. it might be easier for the user
    // just to create this themselves - no need for mirroring. or we
    // could mirror down a read-only table and have the server keep it
    // in sync?
    async mirrorView(viewName, suffix) {
        if (!this.client.viewExists(viewName + suffix)) {
            suffix = suffix || "";
            let createRemoteTable = await this.viewSchema(viewName, suffix);
            this.client.runLocal([], createRemoteTable);
        }
    }
    castData(response) {
        if (response.request === "pipe") {
            return response;
        }
        if (response.request == "error") {
            console.error(response.msg);
        }
        else {
            console.error("Unexpected response", response);
        }
        throw new Error(`Unexpected response: ${response}`);
    }
    async sqlRaw(stdin) {
        let result = await this.makeRequest({
            request: "query",
            query: stdin,
            format: "raw",
        });
        return this.castData(result).data;
    }
    async sql(stdin) {
        let result = await this.makeRequest({
            request: "query",
            query: stdin,
            format: "json",
        });
        return this.castData(result)
            .data
            .split("\n")
            .filter((x) => x != "")
            .map((x) => JSON.parse(x));
    }
    async tableSchema(tableName, renameSuffix = "") {
        const resp = await this.makeRequest({
            request: "schema",
            table: tableName,
            suffix: renameSuffix,
        });
        return this.castData(resp).data;
    }
    async viewSchema(viewName, renameSuffix = "") {
        const resp = await this.makeRequest({
            request: "schema",
            view: viewName,
            suffix: renameSuffix,
        });
        return this.castData(resp).data;
    }
    async schema() {
        const resp = await this.makeRequest({
            request: "schema",
        });
        return this.castData(resp).data;
    }
    async createDatabase(dbName) {
        let result = await this.makeRequest({
            request: "createDatabase",
            name: dbName,
        });
        if (result.request !== "credentials") {
            throw new Error("Unexpected response.");
        }
        return result;
    }
    async createUser() {
        let result = await this.makeRequest({
            request: "createUser",
        });
        if (result.request !== "credentials") {
            throw new Error("Unexpected response.");
        }
        return result;
    }
}
//# sourceMappingURL=skdb.js.map