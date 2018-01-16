import * as _ from "lodash";
import {IRowLockingEngine} from "./IRowLockingEngine";

export class LocalRowLockingEngine implements IRowLockingEngine {
    private tokens: {[propName: string]: boolean} = {};
    private subscribers: {[propName: string]: any[]} = {};
    constructor() {}
    public async acquire(name: string, lockWaitTimeout) {
        if (this.tokens[name]) {
            delete this.tokens[name];
            return true;
        }
        return new Promise<boolean>((resolve) => {
            const subscriber = () => {
                resolve(true);
            };

            if (!this.subscribers[name]) {
                this.subscribers[name] = [];
            }
            this.subscribers[name].push(subscriber);

            setTimeout(() => {
                if (this.pullSubscriber(name, subscriber)) {
                    resolve(false);
                }
            }, lockWaitTimeout * 1000);
        });
    }
    public async release(name: string) {
        if (this.subscribers[name] && this.subscribers[name].length) {
            const subscriber = this.subscribers[name].pop();
            delete this.tokens[name];

            // TODO remove
            // if (!subscriber) { throw new Error("UNEXPECTED"); }

            subscriber();
        }
        else {
            this.tokens[name] = true;
            delete this.subscribers[name];
        }
    }
    private pullSubscriber(name: string, subscriber) {
        if (this.subscribers[name] && this.subscribers[name]) {
            const prevLen = this.subscribers[name].length;

            // TODO remove
            // if (prevLen === 0) { throw new Error("UNEXPECTED 2"); }
            _.pull(this.subscribers[name], subscriber);
            if (this.subscribers[name].length !== prevLen) {
                if (!this.subscribers[name].length) {
                    delete this.subscribers[name];
                }
                return true;
            }
        }
    }
}
