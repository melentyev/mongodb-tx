import * as promisify from "es6-promisify";
import * as redis from "redis";
import {RedisClient} from "redis";
import {IDocLockingEngine} from "./IDocLockingEngine";

export class RedisDocLockingEngine implements IDocLockingEngine {
    private clients: RedisClient[] = [];
    private writer: RedisClient;
    constructor() {
        this.writer = this.createRedisClient();
        for (let i = 0; i < 30; i++) {
            this.clients.push(this.createRedisClient());
        }
    }
    public async acquire(name: string, lockWaitTimeout = 2) {
        const client = this.acquireRedisClient();
        const res = await promisify(client.blpop, {thisArg: client})(this.formatKey(name), lockWaitTimeout);
        // console.log(`ACQUIRED ${name} ${res ? res[1] : null}`);
        this.releaseRedisClient(client);
        return !!res;
    }
    public async release(name: string) {
        const key = this.formatKey(name);
        const token = "1"; // `${100 + Math.ceil(Math.random() * 200)}`;
        const multi = this.writer.batch().del(key).rpush(key, token).expire(key, 3);
        // console.log(`REL_     ${name} ${token}`);
        await promisify(multi.exec, {thisArg: multi})();
        // console.log(`RELEASED ${name} ${token}`);
    }
    private releaseRedisClient(client: RedisClient) {
        this.clients.push(client);
    }
    private acquireRedisClient() {
        if (this.clients.length) {
            return this.clients.pop() as RedisClient;
        }
        else { return this.createRedisClient(); }
    }
    private createRedisClient(): RedisClient {
        return redis.createClient();
    }
    private formatKey(name: string) {
        return `mtx:${name}`;
    }
}
