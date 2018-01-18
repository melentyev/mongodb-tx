import * as mongoose from "mongoose";
import {TransactionManager} from "../lib";

interface IUserDoc extends mongoose.Document {
    name: string;
    balance: number;
}

(async () => {
    await mongoose.connect(`${process.env.DB_CONNECTION_STRING}/TESTTX1`);
    const txMgr = new TransactionManager({mongoose});

    // define "User" model and prepare test DB data
    const User = mongoose.model<IUserDoc>("User", new mongoose.Schema({
        name: String,
        balance: Number,
    }).plugin(txMgr.protect)); // notice "protect" plugin usage
    txMgr.addModels([User]);
    await User.create({name: "a", balance: 10});
    await User.create({name: "a", balance: 20});

    await txMgr.transaction(async (t) => {
        const userA = await t.findOneForUpdate(User, {name: "a"});
        const userB = await t.findOneForUpdate(User, {name: "b"});
        if (!userA || !userB || userA.balance < 1) {
            throw new Error("conditions not satisfied");
        }
        await t.update(userA, {balance: {$inc: -1}});
        await t.update(userB, {balance: {$inc: 1}});
    });
})();
