export interface IDocLockingEngine {
    acquire: (name: string, lockWaitTimeout: number) => PromiseLike<boolean>;
    release: (row) => PromiseLike<any>;
}
