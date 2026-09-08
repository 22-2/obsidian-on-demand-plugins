import moment from "moment";

// Production code uses both browser globals and the active window object. Keep
// them identical in the Node test environment so tests exercise that contract.
const window = globalThis as Window & typeof globalThis;
const windowAny = window as any;
windowAny.moment = moment;
globalThis.window = window;
