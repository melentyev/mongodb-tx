import {MongoClient} from "mongodb";
import {native} from "../lib";

(async () => {
    const client = await MongoClient.connect(`${process.env.DB_CONNECTION_STRING}`);
    const db = client.db("TESTTX1-NAT");
    await db.dropDatabase();

    const col = db.collection("User");
    await col.insertMany([{name: "a", balance: 10}, {name: "b", balance: 20}]);
    const txMgr = new native.TransactionManager({db});

    await txMgr.transaction(async (t) => {
        const userA = await t.findOneForUpdate<any>("User", {name: "a"});
        const userB = await t.findOneForUpdate<any>("User", {name: "b"});
        if (!userA || !userB || userA.balance < 1) {
            throw new Error("conditions not satisfied");
        }
        t.update(userA, {$inc: {balance: -1}});
        t.update(userB, {$inc: {balance: 1}});
    });
    process.exit(0);
})();
