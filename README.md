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

Take a look at the samples in [examples](https://github.com/melentyev/mongodb-tx/tree/master/examples) for examples of usage.

## <a name="features"></a>Features
- Transaction data stored in DB, so recovery is ([almost always*](#note-durability)) possible. 
- Document-level locking for isolation
    * Customizable document locking 
- SQL-like findOneForUpdate
- API for external Transaction Manager
- TypeScript support

## <a name="api"></a>API
**The API description is not yet complete.**
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
    
- [native.TransactionManager](#native-TransactionManager)
    * [constructor](#native-TransactionManager-constructor)
    * [transaction](#native-TransactionManager-transaction)
    * [regularRecovery](#native-TransactionManager-regularRecovery)
    * [transactionPrepare](#native-TransactionManager-transactionPrepare)
    * [commitPrepared](#native-TransactionManager-commitPrepared)
    * [rollbackPrepared](#native-TransactionManager-rollbackPrepared)
- [native.Transaction](#native-Transaction)
    * [findOneForUpdate](#native-Transaction-findOneForUpdate)
    * [create](#native-Transaction-create)
    * [update](#native-Transaction-update)
    * [remove](#native-Transaction-remove)    
        
- [RedisRowLockingEngine](#RedisRowLockingEngine)
- [LocalRowLockingEngine](#LocalRowLockingEngine)
- [DelayRowLockingEngine](#DelayRowLockingEngine)

### <a name="TransactionManager">TransactionManager
This is the main class, the entry point to `mongodb-tx` (when using this library with mongoose).
#### <a name="TransactionManager-constructor">constructor(config)

Instantiate `TransactionManager` with your configuration.
Possible `config` fields:
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

#### <a name="TransactionManager-protect">addModels

In order for TransactionManager to access your collections involved in transactions, pass the corresponding models to the manager. 

```typescript
const txMgr = new TransactionManager(...);

const User = mongoose.model("user", ...);
const Order = mongoose.model("order", ...);
const ChatMessage = mongoose.model("chatMessage", ...);

txMgr.addModels([User, Order]);
// User and Order models will be used in transactions, but ChatMessage won't.
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
- `condition` - selection filter ([query operators](https://docs.mongodb.com/manual/reference/operator/))
- *returns* `Promise<mongoose.Document>`

Find and set lock on a single document, matching `condition`.

#### <a name="Transaction-create">create(model, values) 
- `model: mongoose.Model`
- `values`
- *returns* `mongoose.Document`

Create single document. (operation is enqueued)

#### <a name="Transaction-update">update(doc, updates)
- `doc: mongoose.Document`
- `updates` - the modifications to apply

Enqueue single document update operation. Accepts fetched document.

#### <a name="Transaction-update-model">update(model, condition, updates)
- `model: mongoose.Model`
- `condition` - selection filter ([query operators](https://docs.mongodb.com/manual/reference/operator/))
- `updates` - the modifications to apply

Same as [update](#Transaction-update), but accepts model and selection criteria instead of prefetched document object.

#### <a name="Transaction-remove">remove(doc)
- `doc: mongoose.Document`

Enqueue single document remove operation. Accepts fetched document.

#### <a name="Transaction-remove-model">remove(model, condition)
- `model: mongoose.Model`
- `condition` selection filter ([query operators](https://docs.mongodb.com/manual/reference/operator/))

Same as [remove](#Transaction-remove), but accepts model and selection criteria instead of prefetched document object.


### <a name="native-TransactionManager">native.TransactionManager
This is the main class, the entry point to `mongodb-tx` (when using this library with native mongodb driver).
#### <a name="native-TransactionManager-constructor">constructor(config)

Instantiate `TransactionManager` with your configuration.
Possible `config` fields:
- `db: Db` - your [mongodb.Db](http://mongodb.github.io/node-mongodb-native/3.0/api/Db.html) class instance.
- `rowLockEngine (optional)` - same as in mongoose TransactionManager.
- `appId: string (optional)` - same as in mongoose TransactionManager.
- `lockWaitTimeout: number (optional)` - same as in mongoose TransactionManager.
- `txFieldName: string (optional)` - same as in mongoose TransactionManager.

#### <a name="native-TransactionManager-transaction">transaction(body)
- `body: (t: Transaction) => Promise<void>|void`

#### <a name="native-TransactionManager-regularRecovery">regularRecovery(run: boolean)

#### <a name="native-TransactionManager-transactionPrepare">transactionPrepare(xaId, body)
- `xaId: string`
- `body: (t: native.Transaction) => Promise<void>|void`

#### <a name="native-TransactionManager-commitPrepared">commitPrepared(xaId)
- `xaId: string`

#### <a name="native-TransactionManager-rollbackPrepared">rollbackPrepared(xaId)
- `xaId: string`

### <a name="native-Transaction">native.Transaction

#### <a name="native-Transaction-findOneForUpdate">findOneForUpdate(collection, cond)

#### <a name="native-Transaction-create">create(collection, values) 

#### <a name="native-Transaction-update">update(doc, updates)

#### <a name="native-Transaction-update-model">update(collection, condition, updates)

#### <a name="native-Transaction-remove">remove(doc)

#### <a name="native-Transaction-remove-model">remove(collection, condition)


### <a name="DelayRowLockingEngine">DelayRowLockingEngine
### <a name="RedisRowLockingEngine">RedisRowLockingEngine
### <a name="LocalRowLockingEngine">LocalRowLockingEngine

## <a name="implementation"></a>Implementation notes
TODO durability considerations, write concern, appId and recovery,
performance

#### <a name="implementation-algo"></a>Algorithm
The library implements a variation of two phase commit algorithm.

General transaction steps:
1. First, create document in a transaction collection (`mongotxs` by default), with `"CREATED"` state.
2. Application can lock some documents using `findOneForUpdate` method (lock info is stored in transaction doc), 
then enqueue modifications (`create`, `update`, `remove` methods).
Each lock and modification is stored inside the transaction document.
3. For each `update` or `remove` operation, corresponding document is locked using `findOneForUpdate` algorithm (if they were not previously locked in this transaction by calling `findOneForUpdate` method).
All `create` operations are actually performed (each created object contains a reference to the transaction, for possible rollback)
4. Update transactions status = `"COMMITED"`.
Now transaction can't be rolled back. Since all locks are held, conditions are checked, new documents created (unique constraint can't be violated), we can assume, that transaction will eventually succeed. 
5. Apply [commit algorithm](#implementation-algo-commit)

###### <a name="implementation-algo-commit"> Commit algorithm:
1. Apply all operations, drop locks. 
2. Delete transaction document.

###### <a name="implementation-algo-rollback"> Rollback algorithm:
1. Release locks, remove created documents.
2. Delete transaction document.

###### <a name="implementation-algo-locking"> Locking algorithm (findOneForUpdate):
* *A document is considered to be locked if it contains a `__m__t` reference to an existing transaction document.*
1. Assuming that the target document is free, try to block it via `findAndModify`:
    ```
    doc = findAndModify({query: {...condition, __m__t: null}, update: {__m__t: txId}, new: true})
    ```
    If the document was found and updated, the lock was acquired. Done.
2. Otherwise, there are two possible reasons why the document was not updated:
    1. Document is locked by another transaction
    2. Document that satisfies the `condition` does not exist.
    Let's make sure that the document exists:
    ```
    doc = findOne({query: {condition}})
    ```
    If `doc` is `null` - return `null`.
3. The document exists and is locked by another transaction (or has just been released). Request the locking engine to *"wake current thread"* when the document is unlocked.
    * *In fact, the document could be unlocked at some point between steps 1 and 3. In this case, the lock-engine immediately "wakes thread"*  
4. Return to step 1.

#### <a name="implementation-recovery"></a>Recovery
Transaction can be interrupted by different reasons, like application restart, crash, lost connection.
Recovery operation return database into consistent state. Two situations is possible:
- transaction (doc stored in transactions collection) has `state` == `"CREATED"`. Such transaction must be rolled back.
- transaction has `state` == `"COMMITED"`. Such transaction must be applied. 

#### <a name="implementation-row-locking"></a>Row locking
