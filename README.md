# mongodb-tx

This library for Node.js allows you to implement transactional semantics
for MongoDB at the application level.

The implementation is based on the 2 phase commit algorithm, with particular attention paid to
control of document level locks (similar to row-level locking in RDBMS)
to provide and manage transaction isolation.

Work in progress...

## Contents
- [Examples](#examples)
- [Features](#features)
- [API](#api)
- [Implementation notes](#implementation)
- [External Transaction Manager](#xa)

## <a name="examples"></a>Examples
Classical 2 phase commit example - transfer funds between 2 accounts:
```typescript
import * as mongoose from "mongoose";
import {TransactionManager} from "mongodb-tx";

interface IUserDoc extends mongoose.Document {
    name: string;
    balance: number;
}

(async () => {
    await mongoose.connect(process.env.DB_CONNECTION_STRING);
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
```

The library also provides an ability to implement a distributed transaction
(for example between different DBMS) using an external transaction manager:

```typescript

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
```

## <a name="features"></a>Features
- Transaction data stored in DB, so recovery is ([almost always*](#note-durability)) possible. 
- Document-level locking for isolation
    * Customizable document locking 
- SQL-like findOneForUpdate
- API for external Transaction Manager

## <a name="api"></a>API
TODO api description
- [TransactionManager](#TransactionManager)
    * [constructor](#TransactionManager-constructor)
    * [protect](#TransactionManager-protect)
    * [transaction](#TransactionManager-transaction)
    * [transactionPrepare](#TransactionManager-transactionPrepare)
    * [commitPrepared](#TransactionManager-commitPrepared)
    * [rollbackPrepared](#TransactionManager-rollbackPrepared)
- [Transaction](#Transaction)
    * [findOneForUpdate](#Transaction-findOneForUpdate)
    * [create](#Transaction-create)
    * [update](#Transaction-update)
    * [remove](#Transaction-remove)    
- [RedisRowLockingEngine](#RedisRowLockingEngine)
- [LocalRowLockingEngine](#LocalRowLockingEngine)
- [DelayRowLockingEngine](#DelayRowLockingEngine)

### <a name="TransactionManager">TransactionManager
#### <a name="TransactionManager-constructor">constructor(...)
#### <a name="TransactionManager-protect">protect(...)
#### <a name="TransactionManager-transaction">transaction(body)
- `body`
#### <a name="TransactionManager-transactionPrepare">transactionPrepare(xaId, body)
- `xaId`
- `body`
#### <a name="TransactionManager-commitPrepared">commitPrepared(xaId)
- `xaId`
#### <a name="TransactionManager-rollbackPrepared">rollbackPrepared(xaId)
- `xaId`

### <a name="Transaction">Transaction
#### <a name="Transaction-findOneForUpdate">findOneForUpdate(model, cond)
- `model`
- `cond`
#### <a name="Transaction-create">create(model, values)
- `model`
- `values`
#### <a name="Transaction-create">update(doc, updates)
- `doc`
- `updates`
#### <a name="Transaction-create">remove(doc)
- `doc`

## <a name="implementation"></a>Implementation notes
TODO durability considerations, write concern, appId and recovery,
performance