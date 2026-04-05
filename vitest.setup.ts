import moment from "moment";

const window = {} as Window & typeof globalThis;
const windowAny = window as any;
windowAny.moment = moment;
globalThis.window = window;
