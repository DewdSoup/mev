// services/arb-mm/src/types/shims.d.ts
declare module "@mev/risk" {
    export function initRisk(): void;
}
declare module "@mev/storage" {
    export const logger: { log: (name: string, obj?: any) => void };
}
declare module "@mev/phoenix" {
    const anything: any;
    export default anything;
}
