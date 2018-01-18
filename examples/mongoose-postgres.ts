import * as mongoose from "mongoose";
import * as Sequelize from "sequelize";
import {TransactionManager} from "../lib";

interface IUserInstance extends Sequelize.Instance<any> {
    karma: number;
}

interface ICommentDoc extends mongoose.Document {
    userId: number;
    text: string;
}

async function prepare() {
    process.on("unhandledRejection", (err) => console.error(err));
    await mongoose.connect(`${process.env.DB_CONNECTION_STRING}/TESTTX1`);
    const txMgr = new TransactionManager({mongoose});

    const Comment = mongoose.model<ICommentDoc>("Comment", new mongoose.Schema({
        userId: Number,
        text: String,
    }).plugin(txMgr.protect)); // notice "protect" plugin usage

    txMgr.addModels([Comment]);

    const sequelize = new Sequelize("testtx", "postgres", "xk1da91sd4Mash12asdjhHasd",
        {host: "localhost", dialect: "postgres"});
    await sequelize.authenticate();
    const User = sequelize.define<IUserInstance, any>("User", {karma: Sequelize.INTEGER});
    await sequelize.sync({alter: true});
    await User.destroy({truncate: true});
    await User.create({id: 42, karma: 10});

    return {sequelize, txMgr, Comment, User};
}

(async () => {
    const {sequelize, txMgr, Comment, User} = await prepare();
    const xaTx = {state: "PREPARING", id: "ctx1"}; // must be durably stored
    const userId = 42;

    await txMgr.transactionPrepare(xaTx.id, async (t) => {
        await t.create(Comment, {userId, text: "Hello, World!"});
    });

    await sequelize.transaction(async (t) => {
        const user = await User.findOne({where: {id: userId}, transaction: t, lock: t.LOCK.UPDATE});
        user.karma += 1;
        await user.save({transaction: t});
        // PostgreSQL specific
        await sequelize.query(`PREPARE TRANSACTION '${xaTx.id}'`, {transaction: t});
    });
    // Sequelize will issue "COMMIT" statement after PREPARE TRANSACTION,
    // but this is not a problem, since postgres will just prints warning to log like:
    // WARNING:  there is no transaction in progress

    // now transaction manager must marks ctx1 as PREPARED (must be durably stored)
    xaTx.state = "PREPARED";

    // now commit prepared transaction on Resource Managers (in terms of XA)
    await txMgr.commitPrepared(xaTx.id);
    await sequelize.query(`COMMIT PREPARED '${xaTx.id}'`); // PostgreSQL specific

    xaTx.state = "COMMITED"; // or just remove xaTx record from storage
})();
