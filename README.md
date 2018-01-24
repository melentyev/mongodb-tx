# mongodb-tx [![Build Status](https://travis-ci.org/melentyev/mongodb-tx.svg?branch=master)](https://travis-ci.org/melentyev/mongodb-tx) [![npm version](https://badge.fury.io/js/mongodb-tx.svg)](https://badge.fury.io/js/mongodb-tx)

This library for Node.js allows you to implement transactional semantics
for MongoDB at the application level.

The implementation is based on the two-phase commit algorithm, with particular attention paid to
control of document-level locks (similar to row-level locking in RDBMS)
to provide and manage transaction isolation.

Currently `mongodb-tx` only works with mongoose. Native MongoDB driver support coming soon.

Install with:
```
npm install mongodb-tx
```

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
    await User.create({name: "b", balance: 20});

    await txMgr.transaction(async (t) => {
        const userA = await t.findOneForUpdate(User, {name: "a"});
        const userB = await t.findOneForUpdate(User, {name: "b"});
        if (!userA || !userB || userA.balance < 1) {
            throw new Error("conditions not satisfied");
        }
        t.update(userA, {balance: {$inc: -1}});
        t.update(userB, {balance: {$inc: 1}});
    });
})();
```

The library also provides an ability to implement a distributed transaction
(for example between different DBMS) using an external transaction manager:

```typescript
const xaTx = {state: "PREPARING", id: "ctx1"}; // must be durably stored
const userId = 42;

await txMgr.transactionPrepare(xaTx.id, async (t) => {
    t.create(Comment, {userId, text: "Hello, World!"});
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
- TypeScript support

## <a name="api"></a>API
TODO api description
- [TransactionManager](#TransactionManager)
    * [constructor](#TransactionManager-constructor)
    * [protect](#TransactionManager-protect)
    * [transaction](#TransactionManager-transaction)
    * [regularRecovery](#TransactionManager-regularRecovery)
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
This is the main class, the entry point to `mongodb-tx`.
#### <a name="TransactionManager-constructor">constructor(config)

Instantiate `TransactionManager` with your configuration.
Possible`config` fields:
- `mongoose` - pass your mongoose instance 
- `mongooseConn (optional)` - pass your mongoose connection instance (if you are using `mongoose.createConnection()`)
- `rowLockEngine (optional)` - row locking engine instance (see [row locking](#implementation-row-locking) section). Default is [DelayRowLockingEngine](#DelayRowLockingEngine). 
I recommend to use [RedisRowLockingEngine](#RedisRowLockingEngine) if multiple concurrent 
transactions updating the same document is frequent situation in your application
(it's only a performance recommendation).

- `appId: string (optional)` - specify `appId` to apply [recovery](#implementation-recovery) on startup only to application's own transactions.
- `lockWaitTimeout: number (optional)` 
- `txFieldName: string (optional)` - (default is `"__m__t"`)

#### <a name="TransactionManager-protect">protect
Use this mongoose plugin on models, that will participate in transactions.
Plugin adds reference to transaction that locks the document. 
```typescript
const txMgr = new TransactionManager(...);
const schema = new mongoose.Schema({name: String}).plugin(txMgr.protect);
const model = mongoose.model("Sample", schema);
```

#### <a name="TransactionManager-transaction">transaction(body)
- `body: (t: Transaction) => Promise<void>|void`

Transaction body is defined as callback function (maybe async). 
This function can lock and load documents 
from database using `findOneForUpdate` method, 
and enqueue modifications with `update`, `remove` and `create`.
```typescript
// following transactions are equivalent, but the first one is faster 
await txMgr.transaction((t) => {
    t.update(User, 
        {userId, balance: {$gte: sum}}, 
        {$inc: {balance: -sum}}, 
        {throwIfMissing: "NOT_ENOUGH_BALANCE"});
    t.create(Order, {userId, sum});
});
await txMgr.transaction(async (t) => {
    const user = await t.findOneForUpdate(User, {userId});
    if (!user || user.balance < sum) {
        throw new Error("NOT_ENOUGH_BALANCE");
    }
    t.update(user, {$inc: {balance: -sum}});
    t.create(Order, {userId, sum});
});
```

#### <a name="TransactionManager-regularRecovery">regularRecovery(run: boolean)
Start to continually check interrupted transactions, and apply recovery operations.
Promise is resolved when one iteration of txMgr.recovery() finishes. 
(for example, you can wait for this promise, before `listen` call on http server).

#### <a name="TransactionManager-transactionPrepare">transactionPrepare(xaId, body)
- `xaId: string`
- `body: (t: Transaction) => Promise<void>|void`

Prepare transaction for two-phase commit (external). Similar to PostgreSQL `PREPARE TRANSACTION` https://www.postgresql.org/docs/10/static/sql-prepare-transaction.html

#### <a name="TransactionManager-commitPrepared">commitPrepared(xaId)
- `xaId: string`

#### <a name="TransactionManager-rollbackPrepared">rollbackPrepared(xaId)
- `xaId: string`

### <a name="Transaction">Transaction
#### <a name="Transaction-findOneForUpdate">findOneForUpdate(model, cond)
- `model: mongoose.Model`
- `condition`

Find and set lock on a single document, matching `condition`.

#### <a name="Transaction-create">create(model, values): mongoose.Document
- `model: mongoose.Model`
- `values`

Create single document. (operation is enqueued)

#### <a name="Transaction-update">update(doc, updates)
- `doc: mongoose.Document`
- `update` - the modifications to apply

Enqueue single document update operation. Accepts fetched document.

#### <a name="Transaction-remove">remove(doc)
- `doc: mongoose.Document`

Enqueue single document remove operation. Accepts fetched document.

#### <a name="Transaction-remove-model">remove(model, condition)

- `model: mongoose.Model`
- `condition` selection filter ([query operators](https://docs.mongodb.com/manual/reference/operator/))

Same as [remove](#Transaction-remove), but accepts model and deletion criteria instean of prefetched document object.

### <a name="DelayRowLockingEngine">DelayRowLockingEngine
### <a name="RedisRowLockingEngine">RedisRowLockingEngine
### <a name="LocalRowLockingEngine">LocalRowLockingEngine

## <a name="implementation"></a>Implementation notes
TODO durability considerations, write concern, appId and recovery,
performance

#### <a name="implementation-recovery"></a>Recovery
Transaction can be interrupted by different reasons, like application restart, crash, lost connection.
Recovery operation return database into consistent state. Two situations is possible:
- transaction (doc stored in transactions collection) has `state` == `"CREATED"`. Such transaction must be rolled back.
- transaction has `state` == `"COMMITED"`. Such transaction must be applied. 

#### <a name="implementation-row-locking"></a>Row locking
