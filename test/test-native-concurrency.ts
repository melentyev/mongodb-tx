import test from "ava";
import {MongoClient} from "mongodb";

import {DelayDocLockingEngine, LocalDocLockingEngine, RedisDocLockingEngine} from "../lib/index";
import {TransactionManager} from "../lib/native";
import {transferFunds} from "./utils-native";

const USERS = "users";

async function multipleConcurrent(t, dbName, lockEngine, txCnt) {
    const client = await MongoClient.connect(`${process.env.DB_CONNECTION_STRING}`);
    const db = client.db(dbName);
    await db.dropDatabase();

    await db.collection(USERS).insertMany([
        {name: "user1", balance: 500},
        {name: "user2", balance: 100},
        {name: "user3", balance: 800},
    ]);

    const mongoTxSmallLockWait = new TransactionManager({
        db,
        lockWaitTimeout: 300 + 250 * txCnt,
        docLockEngine: new lockEngine(),
    });

    // console.time(`XXX ${dbName}`);
    await Promise.all([...new Array(txCnt)]
        .map(() => transferFunds(USERS, mongoTxSmallLockWait, "user1", "user2", 1)));
    t.pass();
    // console.timeEnd(`XXX ${dbName}`);
}

const conc = 30;
test("multiple-conc", multipleConcurrent, "TESTTX1-NATIVE-CL", LocalDocLockingEngine, conc);
test("multiple-conc", multipleConcurrent, "TESTTX1-NATIVE-CR", RedisDocLockingEngine, conc);
test("multiple-conc", multipleConcurrent, "TESTTX1-NATIVE-CD", DelayDocLockingEngine, conc);
