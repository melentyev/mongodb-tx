import {IDocLockingEngine} from "./IDocLockingEngine";

export const delayAsync = (delay: number) =>
    new Promise((resolve) => setTimeout(resolve, delay));

export class DelayDocLockingEngine implements IDocLockingEngine {
    constructor() {}
    public async acquire(name: string, lockWaitTimeout: number) {
        const delay = Math.min(Math.ceil(lockWaitTimeout * 1000), 90 + Math.floor(Math.random() * 50));
        await delayAsync(delay);
        return false;
    }
    public async release(name: string) {}
}
