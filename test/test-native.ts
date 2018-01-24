import * as ava from "ava";
import {Db, MongoClient} from "mongodb";
import {TransactionManager} from "../lib/native";
import {transferFunds} from "./utils-native";

const test = ava.test as ava.RegisterContextual<{client: MongoClient, db: Db, txMgr: TransactionManager}>;

const USERS = "users";

test.beforeEach(async (t) => {
    t.context.client = await MongoClient.connect(`${process.env.DB_CONNECTION_STRING}`);
    t.context.db = t.context.client.db("TEST-TX-NATIVE-1");
    await t.context.db.dropDatabase();

    t.context.txMgr = new TransactionManager({db: t.context.db});

    await t.context.db.collection(USERS).insertMany([
        {name: "user1", balance: 500},
        {name: "user2", balance: 100},
        {name: "user3", balance: 800},
    ]);
});

test.serial("transferFunds-simple", async (t) => {
    await transferFunds(USERS, t.context.txMgr, "user1", "user2", 1);
    t.is((await t.context.db.collection(USERS).findOne({name: "user1"})).balance, 499);
    t.is((await t.context.db.collection(USERS).findOne({name: "user2"})).balance, 101);
});

test.serial("create-remove", async (t) => {
    await t.context.txMgr.transaction((tx) => tx.create(USERS, {name: "new_user", balance: 1000}));
    t.is((await t.context.db.collection(USERS).findOne({name: "new_user"})).balance, 1000);

    await t.context.txMgr.transaction(async (tx) => {
        const doc = await tx.findOneForUpdate(USERS, {name: "new_user"});
        tx.remove(doc);
    });
    t.is(await t.context.db.collection(USERS).findOne({name: "new_user"}), null);
});

test.afterEach(async (t) => {
    await t.context.client.close();
});
