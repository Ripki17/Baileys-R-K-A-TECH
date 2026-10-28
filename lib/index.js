import makeWASocket from './Socket/index.js';
import chalk from "chalk";
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const reset = '\x1b[0m';

console.log(`
${cyan}██████╗ ██╗  ██╗ █████╗     ████████╗███████╗ ██████╗██╗  ██╗${reset}
${cyan}██╔══██╗██║ ██╔╝██╔══██╗    ╚══██╔══╝██╔════╝██╔════╝██║  ██║${reset}
${cyan}██████╔╝█████╔╝ ███████║       ██║   █████╗  ██║     ███████║${reset}
${cyan}██╔══██╗██╔═██╗ ██╔══██║       ██║   ██╔══╝  ██║     ██╔══██║${reset}
${cyan}██║  ██║██║  ██╗██║  ██║       ██║   ███████╗╚██████╗██║  ██║${reset}
${cyan}╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝       ╚═╝   ╚══════╝ ╚═════╝╚═╝  ╚═╝${reset}

${yellow}✨ My baileys ✨${reset}

Hi, thanks for using my modified baileys

${cyan}Developer : ${reset}t.me/Rkadesign17
${cyan}Follow    : ${reset}@InpoRkadesign17
${cyan}Status    : ${reset}${green}Baileys Berhasil Terinstall${reset}
`);
export * from '../WAProto/index.js';
export * from './Utils/index.js';
export * from './Types/index.js';
export * from './Defaults/index.js';
export * from './WABinary/index.js';
export * from './WAM/index.js';
export * from './WAUSync/index.js';
export * from './Store/index.js';
export { makeWASocket };
export default makeWASocket;
//# sourceMappingURL=index.js.map