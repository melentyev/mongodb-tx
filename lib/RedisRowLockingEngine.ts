import * as promisify from "es6-promisify";
import * as redis from "redis";
import {RedisClient} from "redis";
import {IRowLockingEngine} from "./IRowLockingEngine";

export class RedisRowLockingEngine implements IRowLockingEngine {
    private clients: RedisClient[] = [];
    private writer: RedisClient;
    constructor() {
        for (let i = 0; i < 5; i++) {
            this.clients.push(this.createRedisClient());
        }
    }
    public async acquire(name: string, lockWaitTimeout = 2) {
        const client = this.acquireRedisClient();
        const res = await promisify(client.blpop)(this.formatKey(name), lockWaitTimeout);
        this.releaseRedisClient(client);
        return !!res;
    }
    public async release(name: string) {
        await promisify(this.writer.rpush)(this.formatKey(name), "1");
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
        return redis.createClient() as any as RedisClient;
    }
    private formatKey(name: string) {
        return `mtx:${name}`;
    }
}
